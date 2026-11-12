import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildLlamaArgs, engineEnv, findFreePort, LlamaRunner, type LlamaRunnerOptions } from '../src/engine/llamaRunner.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'fake-llama-server.mjs');

test('engine env overrides cannot reintroduce forbidden llama settings', () => {
  const base = { PATH: 'base', CUDA_VISIBLE_DEVICES: '0', LLAMA_API_KEY: 'inherited-secret', LLAMA_ARG_MODEL: 'old.gguf' };
  const extra = { PATH: 'override', CUDA_VISIBLE_DEVICES: '1', LLAMA_API_KEY: 'override-secret', LLAMA_ARG_MODEL: 'new.gguf', llama_log_file: 'prompts.log', llama_arg_chat_template: 'chatml' };
  const { env, dropped } = engineEnv(base, extra);
  assert.deepEqual(env, { PATH: 'override', CUDA_VISIBLE_DEVICES: '1' });
  assert.deepEqual(dropped, ['LLAMA_API_KEY', 'LLAMA_ARG_MODEL', 'llama_arg_chat_template', 'llama_log_file']);
  assert.equal(base.LLAMA_API_KEY, 'inherited-secret', 'does not mutate callers');
  assert.equal(extra.LLAMA_ARG_MODEL, 'new.gguf');
});

// First spawn serves /health and exits on /crash. Later spawns hang (never
// healthy) or exit at once, depending on FLAKY_MODE; 'dead' exits every time.
const FLAKY_SERVER = `
import http from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const log = process.env.FLAKY_LOG;
const n = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).length + 1 : 1;
appendFileSync(log, process.pid + '\\n');
const mode = process.env.FLAKY_MODE;
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
if (mode === 'dead' || (n > 1 && mode === 'exit')) process.exit(3);
else if (n > 1) setInterval(() => {}, 1000);
else http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.url === '/props' ? JSON.stringify({ n_ctx: 8192 }) : '{"status":"ok"}');
  if (req.url === '/crash') setTimeout(() => process.exit(7), 30);
}).listen(port, '127.0.0.1');
`;

async function flakyRunner(dir: string, mode: 'hang' | 'exit' | 'dead', restart: LlamaRunnerOptions['restart']) {
  const script = join(dir, 'flaky-llama-server.mjs');
  const log = join(dir, 'spawns.txt');
  await writeFile(script, FLAKY_SERVER);
  const runner = new LlamaRunner({
    binaryPath: process.execPath,
    baseArgs: [script],
    modelPath: 'fake.gguf',
    context: 8192,
    healthTimeoutMs: 20_000,
    restart,
    env: { FLAKY_LOG: log, FLAKY_MODE: mode },
    logFile: join(dir, 'llama.log'),
  });
  const spawns = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  return { runner, spawns };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup(runner: LlamaRunner, spawns: () => Promise<number[]>, dir: string): Promise<void> {
  await runner.stop();
  for (const pid of await spawns()) if (alive(pid)) process.kill(pid, 'SIGKILL');
  await rm(dir, { recursive: true, force: true });
}

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
  const dir = await mkdtemp(join(tmpdir(), 'sublet-runner-'));
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
  const dir = await mkdtemp(join(tmpdir(), 'sublet-runner-'));
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
  const dir = await mkdtemp(join(tmpdir(), 'sublet-runner-'));
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

test('stopping during a restart leaves no llama-server running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-runner-'));
  const { runner, spawns } = await flakyRunner(dir, 'hang', { maxRestarts: 5, windowMs: 60_000, delayMs: 100 });
  try {
    await runner.start();
    await fetch(`${runner.url}/crash`);
    const deadline = Date.now() + 10_000;
    while ((await spawns()).length < 2 && Date.now() < deadline) await delay(50);
    assert.equal((await spawns()).length, 2);
    await runner.stop();
    await delay(1500);
    const pids = await spawns();
    assert.equal(pids.length, 2);
    assert.deepEqual(pids.filter(alive), []);
    assert.equal(runner.status, 'stopped');
  } finally {
    await cleanup(runner, spawns, dir);
  }
});

test('restarts that never become ready end in a fatal state, one spawn per failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-runner-'));
  const { runner, spawns } = await flakyRunner(dir, 'exit', { maxRestarts: 2, windowMs: 1, delayMs: 50 });
  try {
    await runner.start();
    const fatal = new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runner never gave up')), 15_000);
      runner.once('fatal', (error: Error) => { clearTimeout(timer); resolve(error); });
    });
    await fetch(`${runner.url}/crash`);
    assert.match((await fatal).message, /did not become ready after 2 restarts/);
    await delay(1000);
    assert.equal((await spawns()).length, 3);
    assert.equal(runner.restarts, 2);
    assert.equal(runner.status, 'failed');
  } finally {
    await cleanup(runner, spawns, dir);
  }
});

test('a failed first start is reported to the caller and not retried in the background', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-runner-'));
  const { runner, spawns } = await flakyRunner(dir, 'dead', { maxRestarts: 5, windowMs: 60_000, delayMs: 50 });
  try {
    await assert.rejects(runner.start(), /exited during startup/);
    await delay(1000);
    assert.equal((await spawns()).length, 1);
    assert.equal(runner.restarts, 0);
  } finally {
    await cleanup(runner, spawns, dir);
  }
});
