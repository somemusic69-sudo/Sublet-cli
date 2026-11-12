import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

const HOME = await mkdtemp(join(tmpdir(), 'sublet-engine-check-'));
process.env.SUBLET_HOME = HOME;
const { Agent } = await import('../src/agent.js');
const { Logger } = await import('../src/logger.js');
const { buildGgufSample } = await import('../src/engine/gguf.js');

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'fake-llama-server.mjs');
const MODEL = join(HOME, 'tiny-Q4_K_M.gguf');
await writeFile(MODEL, buildGgufSample([
  { key: 'general.architecture', type: 8, write: (b) => b.str('llama') },
  { key: 'general.name', type: 8, write: (b) => b.str('tiny') },
  { key: 'llama.block_count', type: 4, write: (b) => b.u32(4) },
  { key: 'llama.embedding_length', type: 4, write: (b) => b.u32(256) },
  { key: 'llama.context_length', type: 4, write: (b) => b.u32(8192) },
  { key: 'general.file_type', type: 4, write: (b) => b.u32(15) },
]));

type Log = { level: string; message: string; port?: number };

async function subletServer(): Promise<{ url: string; hellos: () => number; close: () => Promise<void> }> {
  let hellos = 0;
  const http: Server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ user: { id: '1', username: 'ada' }, wallet: { availableNanos: 0, pendingNanos: 0, escrowNanos: 0 }, host: null, activeRequest: null, serverNow: Date.now() }));
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => { if ((JSON.parse(String(raw)) as { type: string }).type === 'hello') hellos++; });
    socket.send(JSON.stringify({ type: 'welcome', username: 'ada' }));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hellos: () => hellos,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function hostAgent(server: string, engineEnv: NodeJS.ProcessEnv = {}) {
  const logs: Log[] = [];
  const stream = { isTTY: false, write: (line: string) => { logs.push(JSON.parse(line) as Log); return true; } } as unknown as NodeJS.WriteStream;
  const agent = new Agent({
    config: { server, token: 'sh_test', wsPath: '/tunnel', updatedAt: 0 },
    logger: new Logger({ level: 'info', json: true, color: false, stream }),
    simulation: false,
    model: MODEL,
    publicMode: true,
    context: 2048,
    slots: 1,
    json: true,
    gpuOverride: { name: 'Fake GPU', vramMb: 24_576 },
    engine: { binaryPath: process.execPath, baseArgs: [FIXTURE], env: engineEnv },
  });
  return { agent, logs };
}

async function waitFor(what: string, check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a loaded model passes the engine self-check, and passes it again after a crash restart', async () => {
  const server = await subletServer();
  const { agent, logs } = hostAgent(server.url);
  const said = (pattern: RegExp) => logs.some((log) => pattern.test(log.message));
  try {
    void agent.run().catch(() => undefined);
    await waitFor('the load-time self-check', () => said(/self-check passed: the same prompt gave the same answer twice/));
    await waitFor('the agent to come online', () => server.hellos() > 0);
    assert.ok(said(/Using your own llama-server/), 'a custom engine must be called out');
    assert.ok(!logs.some((log) => log.level === 'warn' && /Self-check/.test(log.message)));

    const port = logs.find((log) => log.message === 'Starting llama-server')?.port;
    assert.ok(port, 'the engine port was not logged');
    await fetch(`http://127.0.0.1:${port}/crash`);
    await waitFor('the self-check after the restart', () => said(/self-check passed after the restart/));
  } finally {
    await agent.stop();
    await server.close();
  }
});

test('an engine whose answers change is reported, and the host still comes online', async () => {
  const server = await subletServer();
  const { agent, logs } = hostAgent(server.url, { FAKE_DRIFT: '1' });
  try {
    void agent.run().catch(() => undefined);
    await waitFor('the repeatability warning', () => logs.some((log) => log.level === 'warn' && /engine returned different token probabilities/.test(log.message)));
    // The self-check only warns; the server's model checks decide.
    await waitFor('the agent to come online', () => server.hellos() > 0);
  } finally {
    await agent.stop();
    await server.close();
  }
});
