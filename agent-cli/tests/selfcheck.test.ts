import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { compareFingerprints, FINGERPRINT_TOLERANCE, probeEngine, type EngineFingerprint } from '../src/engine/selfCheck.js';
import { engineEnv } from '../src/engine/llamaRunner.js';

const base: EngineFingerprint = { tokens: ['One', ',', ' two', ',', ' three'], logprobs: [-0.02, -0.01, -0.03, -0.01, -0.9] };

test('fingerprints: rounding noise is the same answer, a real change is not', () => {
  const noisy = { tokens: [...base.tokens], logprobs: base.logprobs.map((l) => l - 0.004) };
  assert.deepEqual(compareFingerprints(base, base), { same: true, compared: 5, maxDelta: 0, reason: null });
  assert.equal(compareFingerprints(base, noisy).same, true);

  const moved = { tokens: [...base.tokens], logprobs: [-0.02, -0.01, -0.03 - FINGERPRINT_TOLERANCE - 0.1, -0.01, -0.9] };
  const drift = compareFingerprints(base, moved);
  assert.equal(drift.same, false);
  assert.match(drift.reason || '', /token 3 .* moved by 0\.60/);

  // A confident token change is measurable, but does not identify a model or hardware cause.
  const other = { tokens: ['One', ',', ' TWO', ',', ' three'], logprobs: base.logprobs };
  const changed = compareFingerprints(base, other);
  assert.equal(changed.same, false);
  assert.match(changed.reason || '', /token 3 changed from " two" to " TWO"/);

  // A different token at a near-tie (the last one, p = 0.41) can be rounding: stop comparing, do not accuse.
  const tie = { tokens: ['One', ',', ' two', ',', ' four'], logprobs: base.logprobs };
  assert.equal(compareFingerprints(base, tie).same, null);
  assert.equal(compareFingerprints(base, tie).compared, 4);

  assert.equal(compareFingerprints(base, { tokens: [], logprobs: [] }).compared, 0);
  assert.equal(compareFingerprints(base, { tokens: [], logprobs: [] }).same, null);
});

test('incomplete, malformed, or unmeasurable fingerprints never pass or diagnose a failure', () => {
  const invalid: unknown[] = [
    null, undefined, {}, { tokens: [], logprobs: [] },
    { tokens: ['One'], logprobs: [] }, { tokens: ['One'], logprobs: [null] },
    { tokens: ['One'], logprobs: ['-0.02'] }, { tokens: ['One'], logprobs: [false] },
    { tokens: ['One'], logprobs: [NaN] }, { tokens: ['One'], logprobs: [Infinity] },
    { tokens: ['One'], logprobs: [-9999] },
    { tokens: ['One'], logprobs: [-Infinity] }, { tokens: ['One'], logprobs: [0.1] },
    { tokens: [5], logprobs: [-0.02] }, { tokens: new Array(1), logprobs: [-0.02] },
    { tokens: ['One'], logprobs: new Array(1) },
  ];
  for (const value of invalid) {
    for (const diff of [compareFingerprints(base, value as EngineFingerprint), compareFingerprints(value as EngineFingerprint, base)]) {
      assert.equal(diff.same, null);
      assert.equal(diff.compared, 0);
      assert.ok(diff.reason);
    }
  }
  for (const tolerance of [NaN, Infinity, -Infinity, -1, '1', null]) {
    assert.equal(compareFingerprints(base, base, tolerance as number).same, null);
  }
  const prefix = { tokens: base.tokens.slice(0, 2), logprobs: base.logprobs.slice(0, 2) };
  assert.equal(compareFingerprints(base, prefix).same, null);
  assert.equal(compareFingerprints(prefix, base).same, null);
  const nearTie = { tokens: ['x'], logprobs: [-1] };
  assert.equal(compareFingerprints(nearTie, { tokens: ['y'], logprobs: [-1] }).same, null);
  assert.equal(compareFingerprints(nearTie, { tokens: ['y'], logprobs: [-1] }).compared, 0);
  const confident = { tokens: ['y'], logprobs: [-0.01] };
  assert.equal(compareFingerprints(nearTie, confident).same, false);
  assert.equal(compareFingerprints(confident, nearTie).same, false, 'comparison is symmetric');
});

async function engine(reply: (body: Record<string, unknown>) => { status?: number; json?: unknown; delayMs?: number }): Promise<{ url: string; bodies: Record<string, unknown>[]; close: () => Promise<void> }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      bodies.push(body);
      const answer = reply(body);
      setTimeout(() => {
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.json ?? {}));
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const answer = (content: Array<{ token: string; logprob: number }>) => ({ json: { choices: [{ message: { content: 'x' }, logprobs: { content } }] } });

test('the probe rejects malformed probabilities without numeric coercion', async () => {
  const payloads: unknown[] = [null, {}, { choices: {} }, { choices: [null] }];
  for (const entry of [null, {}, { token: 1, logprob: -0.1 }, ...[null, false, true, '', '0', '-0.1', 0.1, -9999].map((logprob) => ({ token: 'One', logprob }))]) {
    payloads.push({ choices: [{ logprobs: { content: [entry] } }] });
  }
  payloads.push({ choices: [{ logprobs: { content: Array.from({ length: 17 }, () => ({ token: 'x', logprob: -0.1 })) } }] });
  for (const payload of payloads) {
    const fetchImpl = (async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    assert.equal(await probeEngine('http://unused.invalid', { fetchImpl }), null, JSON.stringify(payload));
  }
});

test('the probe asks a fixed deterministic question and reads the token probabilities', async () => {
  const fake = await engine(() => answer([{ token: 'One', logprob: -0.02 }, { token: ',', logprob: -0.01 }]));
  try {
    const print = await probeEngine(fake.url);
    assert.deepEqual(print, { tokens: ['One', ','], logprobs: [-0.02, -0.01] });
    const body = fake.bodies[0]!;
    assert.deepEqual([body.stream, body.temperature, body.logprobs, body.cache_prompt], [false, 0, true, false]);
    assert.deepEqual(await probeEngine(fake.url), print, 'the same engine gives the same fingerprint');
    assert.deepEqual(fake.bodies[0], fake.bodies[1], 'every probe sends the same request');
  } finally {
    await fake.close();
  }
});

test('a probe that cannot be measured is unknown, never a failure', async () => {
  const noProbabilities = await engine(() => ({ json: { choices: [{ message: { content: 'x' } }] } }));
  const refused = await engine(() => ({ status: 500 }));
  const slow = await engine(() => ({ ...answer([{ token: 'One', logprob: -0.02 }]), delayMs: 2_000 }));
  try {
    assert.equal(await probeEngine(noProbabilities.url), null);
    assert.equal(await probeEngine(refused.url), null);
    assert.equal(await probeEngine(slow.url, { timeoutMs: 100 }), null);
    // A buyer's job cancels the probe.
    const controller = new AbortController();
    const pending = probeEngine(slow.url, { signal: controller.signal });
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(await probeEngine('http://127.0.0.1:9'), null);
  } finally {
    await Promise.all([noProbabilities.close(), refused.close(), slow.close()]);
  }
});

test('the engine never sees a host\'s own llama.cpp settings', () => {
  const { env, dropped } = engineEnv({
    PATH: '/usr/bin',
    CUDA_VISIBLE_DEVICES: '1',
    LLAMA_SERVER: '/opt/llama-server',
    LLAMA_ARG_CHAT_TEMPLATE: 'chatml',
    LLAMA_ARG_CACHE_TYPE_K: 'q4_0',
    llama_arg_ctx_size: '512',
    LLAMA_API_KEY: 'secret',
    LLAMA_LOG_FILE: '/tmp/prompts.log',
  }, { FAKE_CTX: '2048' });
  assert.deepEqual(dropped, ['LLAMA_API_KEY', 'LLAMA_ARG_CACHE_TYPE_K', 'LLAMA_ARG_CHAT_TEMPLATE', 'LLAMA_LOG_FILE', 'llama_arg_ctx_size']);
  // GPU selection and the agent's own variables pass through.
  assert.deepEqual(env, { PATH: '/usr/bin', CUDA_VISIBLE_DEVICES: '1', LLAMA_SERVER: '/opt/llama-server', FAKE_CTX: '2048' });
});
