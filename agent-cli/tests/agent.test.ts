import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';

process.env.SUBLET_HOME = await mkdtemp(join(tmpdir(), 'sublet-cli-test-'));
const { Agent } = await import('../src/agent.js');
const { Logger } = await import('../src/logger.js');

type Frame = { type: string; [key: string]: unknown };

async function fakeServer(options: { meDelayMs?: number; onSocket?: (socket: WebSocket) => void } = {}): Promise<{ url: string; frames: Frame[]; close: () => Promise<void> }> {
  const frames: Frame[] = [];
  const http: Server = createServer((_req, res) => {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        user: { id: '1', username: 'ada' },
        wallet: { availableNanos: 0, pendingNanos: 0, escrowNanos: 0 },
        host: null,
        activeRequest: null,
        serverNow: Date.now(),
      }));
    }, options.meDelayMs ?? 0);
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame));
    socket.send(JSON.stringify({ type: 'welcome', username: 'ada' }));
    options.onSocket?.(socket);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    frames,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function agentFor(server: string, simulation: boolean) {
  return new Agent({
    config: { server, token: 'sh_test', wsPath: '/tunnel', updatedAt: 0 },
    logger: new Logger({ level: 'silent' }),
    simulation,
    tokPerSec: 500,
    json: true,
    gpuOverride: { name: 'Fake GPU', vramMb: 8192 },
  });
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('run() did not settle')), ms)),
  ]);
}

test('stopping during startup ends run() and never opens the tunnel', async () => {
  const server = await fakeServer();
  const agent = agentFor(server.url, true);
  try {
    const stopped = agent.stop();
    await settlesWithin(agent.run(), 5_000);
    await stopped;
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(server.frames, []);
  } finally {
    await agent.stop();
    await server.close();
  }
});

test('stopping while the first status call is in flight ends run()', async () => {
  const server = await fakeServer({ meDelayMs: 600 });
  const agent = agentFor(server.url, true);
  try {
    const running = agent.run();
    setTimeout(() => { void agent.stop(); }, 300);
    await settlesWithin(running, 5_000);
  } finally {
    await agent.stop();
    await server.close();
  }
});

test('a live host with no model answers with an error, not simulated text', async () => {
  const server = await fakeServer({
    onSocket: (socket) => {
      setTimeout(() => socket.send(JSON.stringify({ type: 'infer', jobId: 'j1', messages: [{ role: 'user', content: 'hi' }], maxTokens: 4 })), 100);
    },
  });
  const agent = agentFor(server.url, false);
  try {
    void agent.run().catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while (!server.frames.some((f) => f.jobId === 'j1') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 100));
    const jobFrames = server.frames.filter((f) => f.jobId === 'j1');
    assert.equal(jobFrames.length, 1, `expected one frame for the job, got ${JSON.stringify(jobFrames)}`);
    assert.equal(jobFrames[0]?.type, 'error');
    assert.match(String(jobFrames[0]?.message), /No model is loaded/);
  } finally {
    await agent.stop();
    await server.close();
  }
});

test('a server load that points at a local file is refused before anything is read', async () => {
  const server = await fakeServer({
    onSocket: (socket) => {
      setTimeout(() => socket.send(JSON.stringify({ type: 'load', requestId: 'r1', url: '/home/host/.ssh/id_ed25519', context: 4096 })), 100);
    },
  });
  const agent = agentFor(server.url, true);
  try {
    void agent.run().catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while (!server.frames.some((f) => f.type === 'load_failed') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const failed = server.frames.find((f) => f.type === 'load_failed');
    assert.equal(failed?.requestId, 'r1');
    assert.match(String(failed?.message), /valid URL/);
    assert.equal(server.frames.some((f) => f.type === 'loaded'), false);
  } finally {
    await agent.stop();
    await server.close();
  }
});
