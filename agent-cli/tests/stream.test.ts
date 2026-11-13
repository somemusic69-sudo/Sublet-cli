import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { PROBED_POSITIONS, SseParser, simulateChat, streamChat } from '../src/network/streamProxy.js';

const streamJob = { jobId: 'j', messages: [], maxTokens: 8, temperature: 0 };
const sseFetch = (body: string): typeof fetch => (async () => new Response(body)) as typeof fetch;

test('truncated or malformed SSE cannot report successful completion', async () => {
  for (const body of ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'data: not-json\n\ndata: [DONE]\n\n', 'data: null\n\ndata: [DONE]\n\n']) {
    await assert.rejects(streamChat('http://localhost', streamJob, { fetchImpl: sseFetch(body) }), /stream|JSON/);
  }
});

test('final unterminated SSE events use the same delta/error handling', async () => {
  const result = await streamChat('http://localhost', streamJob, { fetchImpl: sseFetch('data: {"choices":[{"delta":{"content":"last"},"finish_reason":"length"}]}\n\ndata: [DONE]') });
  assert.equal(result.text, 'last');
  assert.equal(result.finishReason, 'length');
  await assert.rejects(streamChat('http://localhost', streamJob, { fetchImpl: sseFetch('data: {"error":{"message":"final failure"}}') }), /final failure/);
});

test('malformed probability values are omitted rather than coerced into evidence', async () => {
  const seen: unknown[] = [];
  const content = [null, ...[null, '0', true, 1, -9999].map((logprob) => ({ token: 'bad', logprob })), { token: 'good', logprob: -0.2, top_logprobs: [null, { token: 'bad', logprob: null }, { token: 'good', logprob: -0.2 }] }];
  await streamChat('http://localhost', streamJob, { fetchImpl: sseFetch(`data: ${JSON.stringify({ choices: [{ delta: { content: 'good' }, logprobs: { content } }] })}\n\ndata: [DONE]\n\n`), onChunk: (_text, positions) => seen.push(...positions) });
  assert.deepEqual(seen, [{ t: 'good', l: -0.2, top: [['good', -0.2]] }]);
});

test('SSE buffers are bounded and early completion cancels the reader', async () => {
  assert.throws(() => new SseParser().push('x'.repeat(2 * 1024 * 1024 + 1)), /limit/);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); }, cancel() { cancelled = true; } });
  await streamChat('http://localhost', streamJob, { fetchImpl: (async () => new Response(body)) as typeof fetch });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('the SSE parser survives arbitrary chunk boundaries', () => {
  const parser = new SseParser();
  const events: string[] = [];
  const payload = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
  for (const char of payload) events.push(...parser.push(char));
  assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
  const second = new SseParser();
  assert.deepEqual(second.push('data: hello\r'), []);
  assert.deepEqual(second.push('\n\r\n'), ['hello']);
});

test('streamChat pipes deltas, usage, and finish reason', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.stream, true);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n');
      res.end('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const chunks: string[] = [];
    const result = await streamChat(`http://127.0.0.1:${port}`, {
      jobId: 'j1',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
      temperature: 0.7,
    }, { onChunk: (text) => chunks.push(text) });
    assert.equal(result.text, 'Hi there');
    assert.deepEqual(chunks, ['Hi', ' there']);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage?.completion_tokens, 2);
    assert.equal(result.completionTokens, 2);
  } finally {
    (server as Server).close();
  }
});

test('every job asks llama-server for token probabilities and sends them with the first positions only', async () => {
  let request: Record<string, unknown> = {};
  const entry = (token: string, logprob: number) => ({
    id: 1, token, bytes: [], logprob,
    top_logprobs: [{ token, logprob }, { token: ' x', logprob: -2.5 }, { token: ' y', logprob: -3.1 }],
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      request = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n');
      for (let i = 0; i < PROBED_POSITIONS + 3; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ` w${i}` }, logprobs: { content: [entry(` w${i}`, -0.1 * (i % 5))] } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const chunks: Array<[string, number]> = [];
    const firsts: unknown[] = [];
    await streamChat(`http://127.0.0.1:${port}`, { jobId: 'j', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, temperature: 0.7 }, {
      onChunk: (text, positions) => {
        chunks.push([text, positions.length]);
        if (positions.length) firsts.push(positions[0]);
      },
    });
    assert.equal(request.logprobs, true);
    assert.equal(request.top_logprobs, 5);
    assert.equal(chunks.length, PROBED_POSITIONS + 3);
    assert.equal(chunks.filter(([, n]) => n === 1).length, PROBED_POSITIONS);
    assert.deepEqual(chunks.slice(PROBED_POSITIONS).map(([, n]) => n), [0, 0, 0]);
    assert.deepEqual(firsts[1], { t: ' w1', l: -0.1, top: [[' w1', -0.1], [' x', -2.5], [' y', -3.1]] });
  } finally {
    (server as Server).close();
  }
});

test('simulated jobs carry stand-in probabilities in the same shape', async () => {
  const seen: number[] = [];
  const result = await simulateChat({ jobId: 'j', messages: [{ role: 'user', content: 'hello there' }], maxTokens: 64, temperature: 0.7 }, {
    tokPerSec: 1_000,
    onChunk: (_text, positions) => seen.push(positions.length),
  });
  assert.match(result.text, /On sublera-simulator,/);
  assert.match(result.text, /Run sublera doctor/);
  assert.doesNotMatch(result.text, /sublet/i);
  assert.ok(seen.length > 3);
  assert.ok(seen.every((n, i) => n === (i < PROBED_POSITIONS ? 1 : 0)));
});

test('a job cancelled before the stream starts never reaches llama-server', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error('Cancelled by server'));
  await assert.rejects(
    streamChat('http://127.0.0.1:1', { jobId: 'j', messages: [], maxTokens: 5, temperature: 0 }, {
      signal: controller.signal,
      fetchImpl: (async () => { calls++; throw new Error('unreachable'); }) as typeof fetch,
    }),
    /Cancelled by server/,
  );
  assert.equal(calls, 0);
});
