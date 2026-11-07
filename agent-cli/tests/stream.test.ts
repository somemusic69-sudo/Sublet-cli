import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { runCanary, SseParser, streamChat } from '../src/network/streamProxy.js';

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

test('canary collects deterministic tokens and logprobs', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: { content: 'Paris' },
        logprobs: { content: [{ token: 'Paris', logprob: -0.01 }] },
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const result = await runCanary(`http://127.0.0.1:${port}`, 'The capital of France is');
    assert.deepEqual(result.tokens, ['Paris']);
    assert.deepEqual(result.logprobs, [-0.01]);
  } finally {
    (server as Server).close();
  }
});
