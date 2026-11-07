import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildLlamaArgs, findFreePort, LlamaRunner } from '../src/engine/llamaRunner.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'fake-llama-server.mjs');

test('llama flags lock GPU layers, context, slots, and logging', () => {
  const args = buildLlamaArgs({
    modelPath: 'C:\\models\\x.gguf',
    context: 16384,
    slots: 4,
    port: 19001,
  });
  assert.deepEqual(args.slice(0, 2), ['-m', 'C:\\models\\x.llama'.replace('x.llama', 'x.gguf')]);
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('--port') + 1], '19001');
  assert.equal(args[args.indexOf('--n-gpu-layers') + 1], '999');
  assert.equal(args[args.indexOf('--ctx-size') + 1], '65536');
  assert.equal(args[args.indexOf('--parallel') + 1], '4');
  assert.ok(args.includes('--cont-batching'));
  assert.ok(args.includes('--log-disable'));
});

test('the runner becomes ready and reports llm props', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-runner-'));
  const port = await findFreePort();
  const runner = new LlamaRunner({
    binaryPath: process.execPath,
    baseArgs: [FIXTURE],
    modelPath: 'fake.gguf',
    context: 8192,
    slots: 2,
    port,
    healthTimeoutMs: 20_000,
    restart: false,
    logFile: join(dir, 'llama.log'),
  });
  try {
    const props = await runner.start();
    assert.equal(runner.status, 'ready');
    assert.equal(props.n_ctx, 8192);
    assert.equal(props.total_slots, 2);
    assert.equal(await runner.isHealthy(), true);
    assert.ok(runner.url.includes(String(port)));
  } finally {
    await runner.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a locked context below the requested size is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-runner-'));
  const runner = new LlamaRunner({
    binaryPath: process.execPath,
    baseArgs: [FIXTURE],
    modelPath: 'fake.gguf',
    context: 16384,
    slots: 1,
    healthTimeoutMs: 20_000,
    restart: false,
    env: { FAKE_CTX: '2048' },
    logFile: join(dir, 'llama.log'),
  });
  try {
    await assert.rejects(runner.start(), /below the locked 16384/);
    assert.equal(runner.status, 'failed');
  } finally {
    await runner.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a crashed llama-server is restarted in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-runner-'));
  const port = await findFreePort();
  const runner = new LlamaRunner({
    binaryPath: process.execPath,
    baseArgs: [FIXTURE],
    modelPath: 'fake.gguf',
    context: 8192,
    slots: 1,
    port,
    healthTimeoutMs: 20_000,
    restart: { maxRestarts: 2, windowMs: 30_000, delayMs: 100 },
    logFile: join(dir, 'llama.log'),
  });
  try {
    await runner.start();
    const firstPid = runner.pid;
    const readyAgain = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runner did not restart')), 15_000);
      runner.once('ready', () => { clearTimeout(timer); resolve(); });
    });
    await fetch(`${runner.url}/crash`);
    await readyAgain;
    assert.equal(runner.status, 'ready');
    assert.notEqual(runner.pid, firstPid);
    assert.equal(runner.restarts, 1);
  } finally {
    await runner.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
