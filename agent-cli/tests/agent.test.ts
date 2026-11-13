import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';

process.env.SUBLET_HOME = await mkdtemp(join(tmpdir(), 'sublet-cli-test-'));
const { Agent } = await import('../src/agent.js');
const { Logger } = await import('../src/logger.js');

afterEach(async () => {
  // stop() tears down resources; run() retains ownership until pending startup
  // and final snapshot writes complete. Do not race the next test against it.
  const path = join(process.env.SUBLET_HOME!, 'agent.lock');
  for (let n = 0; n < 200; n++) {
    try { await stat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Agent did not release ownership after stop');
});

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

function agentFor(server: string, simulation: boolean, extra: { requestId?: string } = {}) {
  return new Agent({
    config: { server, token: 'sh_test', wsPath: '/tunnel', updatedAt: 0 },
    logger: new Logger({ level: 'silent' }),
    simulation,
    tokPerSec: 500,
    json: true,
    gpuOverride: { name: 'Fake GPU', vramMb: 8192 },
    ...extra,
  });
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('run() did not settle')), ms)),
  ]);
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected agent state not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('ownership blocks a second host; drain completes active inference and rejects new work', async () => {
  let socket: WebSocket | undefined;
  const server = await fakeServer({ onSocket: (client) => { socket = client; } });
  const agent = agentFor(server.url, true);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    assert.equal(agent.health.ready, true);
    const second = agentFor(server.url, true);
    await assert.rejects(second.run(), /locked/);
    socket!.send(JSON.stringify({ type: 'infer', jobId: 'active', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 }));
    await eventually(() => agent.health.activeJobs === 1);
    const draining = agent.drain(5_000);
    assert.equal(agent.health.draining, true);
    assert.equal(agent.health.ready, false);
    socket!.send(JSON.stringify({ type: 'infer', jobId: 'new', messages: [], maxTokens: 4 }));
    await draining;
    await running;
    assert.ok(server.frames.some((frame) => frame.type === 'done' && frame.jobId === 'active'));
    assert.ok(server.frames.some((frame) => frame.type === 'error' && frame.jobId === 'new' && frame.code === 'host_busy'));
    assert.equal(agent.health.live, false);
  } finally { await agent.stop(); await running; await server.close(); }
});

test('drain timeout cancels work without a successful completion frame', async () => {
  let socket: WebSocket | undefined;
  const server = await fakeServer({ onSocket: (client) => { socket = client; } });
  const agent = agentFor(server.url, true);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    socket!.send(JSON.stringify({ type: 'infer', jobId: 'cancelled', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 }));
    await eventually(() => agent.health.activeJobs === 1);
    await agent.drain(0);
    await running;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(!server.frames.some((frame) => frame.type === 'done' && frame.jobId === 'cancelled'));
  } finally { await agent.stop(); await running; await server.close(); }
});

test('disconnect makes readiness false and waitForOnline no longer uses stale state', async () => {
  let socket: WebSocket | undefined;
  const server = await fakeServer({ onSocket: (client) => { socket = client; } });
  const agent = agentFor(server.url, true);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    socket!.terminate();
    await eventually(() => agent.health.tunnel !== 'open');
    assert.equal(agent.health.ready, false);
    await assert.rejects(agent.waitForOnline(10), /Timed out/);
  } finally { await agent.stop(); await running; await server.close(); }
});

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

test('`sublera start <code>` sends the code in hello and reports a reject for that request', async () => {
  const server = await fakeServer({
    onSocket: (socket) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Frame;
        if (frame.type === 'hello') socket.send(JSON.stringify({ type: 'reject', requestId: 'r_code123', reason: 'Another host already has this request.' }));
      });
    },
  });
  const agent = agentFor(server.url, true, { requestId: 'r_code123' });
  try {
    const rejected = new Promise<{ requestId: string; reason: string }>((resolve) => agent.once('rejected', resolve));
    void agent.run().catch(() => undefined);
    const event = await rejected;
    assert.equal(event.requestId, 'r_code123');
    assert.match(event.reason, /Another host/);
    const hello = server.frames.find((f) => f.type === 'hello');
    assert.equal(hello?.requestId, 'r_code123');
    assert.ok(Array.isArray(hello?.cachedModels));
  } finally {
    await agent.stop();
    await server.close();
  }
});

test('a loaded model is not server-verified and stale verification/rejection cannot change the current request', async () => {
  let socket: WebSocket | undefined;
  const server = await fakeServer({ onSocket: (client) => { socket = client; } });
  const agent = agentFor(server.url, true);
  const running = agent.run();
  const waitUntil = async (condition: () => boolean) => {
    const until = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() >= until) throw new Error('Expected agent state was not reached');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await agent.waitForOnline(5_000);
    socket!.send(JSON.stringify({ type: 'load', requestId: 'r_current', url: 'https://huggingface.co/a/b/resolve/main/model.gguf', sha256: 'a'.repeat(64), file: 'model.gguf', layers: 4, context: 2048 }));
    await waitUntil(() => server.frames.some((frame) => frame.type === 'loaded'));
    assert.equal(agent.dashboardState.job?.verified, false);
    socket!.send(JSON.stringify({ type: 'verified', requestId: 'r_old' }));
    socket!.send(JSON.stringify({ type: 'reject', requestId: 'r_old', reason: 'Old booking' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(agent.dashboardState.job?.id, 'r_current');
    assert.equal(agent.dashboardState.job?.verified, false);
    socket!.send(JSON.stringify({ type: 'verified', requestId: 'r_current' }));
    await waitUntil(() => agent.dashboardState.job?.verified === true);
    assert.equal(agent.dashboardState.job?.id, 'r_current');
  } finally {
    await agent.stop();
    await running;
    await server.close();
  }
});

// Narrow test seams keep the races deterministic without platform wake-lock processes.
type LifecycleAgent = {
  sleepGuard: { acquire: (reason: string) => Promise<void>; stop: () => Promise<void> };
  loadingModel: boolean;
  bookingWake: boolean;
  activeJobs: Map<string, { controller: AbortController; chunks: number; text: string }>;
  handleInfer: (message: Record<string, unknown>) => Promise<void>;
  handleLoad: (message: { requestId: string; url: string }) => Promise<void>;
  loadModel: (...args: unknown[]) => Promise<unknown>;
  tunnel: { send: (frame: Frame) => boolean };
  runner: { url: string } | null;
};
function lifecycle(agent: InstanceType<typeof Agent>): LifecycleAgent {
  return agent as unknown as LifecycleAgent;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const work of ['infer', 'load'] as const) {
  test(`${work}: failed wake-lock acquisition clears busy state and permits retry`, async () => {
    const agent = agentFor('http://127.0.0.1:1', true);
    const internals = lifecycle(agent);
    const frames: Frame[] = [];
    internals.tunnel = { send: (frame) => { frames.push(frame); return true; } };
    internals.sleepGuard.acquire = async () => { throw new Error('wake acquisition failed'); };
    const perform = () => work === 'infer'
      ? internals.handleInfer({ jobId: 'wake', messages: [], maxTokens: 1 })
      : internals.handleLoad({ requestId: 'wake', url: 'https://huggingface.co/a/b/resolve/main/model.gguf' });
    try {
      await perform();
      assert.equal(internals.activeJobs.size, 0);
      assert.equal(internals.loadingModel, false);
      assert.equal(internals.bookingWake, false);
      assert.equal(frames.length, 1);
      assert.match(String(frames[0]?.message), /wake acquisition failed/);
      internals.sleepGuard.acquire = async () => {};
      await perform();
      assert.ok(frames.some((frame) => frame.type === (work === 'infer' ? 'done' : 'loaded')));
    } finally {
      // The fake tunnel only implements send, not resource teardown.
      (internals as unknown as { tunnel: null }).tunnel = null;
      await agent.stop();
    }
  });

  test(`${work}: stop during wake acquisition suppresses work and run retains ownership until settlement`, async () => {
    let socket: WebSocket | undefined;
    const server = await fakeServer({ onSocket: (client) => { socket = client; } });
    const agent = agentFor(server.url, true);
    const internals = lifecycle(agent);
    const gate = deferred();
    const entered = deferred();
    const running = agent.run();
    try {
      await agent.waitForOnline(5_000);
      internals.sleepGuard.acquire = async () => { entered.resolve(); await gate.promise; };
      let loadCalls = 0;
      const originalLoad = internals.loadModel.bind(agent);
      internals.loadModel = async (...args) => { loadCalls++; return originalLoad(...args); };
      socket!.send(JSON.stringify(work === 'infer'
        ? { type: 'infer', jobId: 'pending', messages: [], maxTokens: 1 }
        : { type: 'load', requestId: 'pending', url: 'https://huggingface.co/a/b/resolve/main/model.gguf' }));
      await entered.promise;
      await agent.stop();
      const snapshot = structuredClone(agent.dashboardState);
      await assert.rejects(agentFor(server.url, true).run(), /locked/);
      gate.resolve();
      await settlesWithin(running, 5_000);
      assert.equal(loadCalls, 0);
      assert.equal(internals.activeJobs.size, 0);
      assert.equal(internals.loadingModel, false);
      assert.equal(internals.bookingWake, false);
      assert.deepEqual(agent.dashboardState, snapshot);
      assert.ok(!server.frames.some((frame) => ['chunk', 'done', 'loaded', 'progress'].includes(frame.type)));
    } finally {
      gate.resolve();
      await agent.stop();
      await running;
      await server.close();
    }
  });
}



test('buffered engine chunks after cancellation do not mutate or send job output', async (t) => {
  const agent = agentFor('http://127.0.0.1:1', false);
  const internals = lifecycle(agent);
  internals.sleepGuard.acquire = async () => {};
  internals.runner = { url: 'http://engine.invalid' };
  const frames: Frame[] = [];
  let cancelled: { controller: AbortController; chunks: number; text: string } | undefined;
  internals.tunnel = { send: (frame) => {
    frames.push(frame);
    if (frame.type === 'chunk') {
      cancelled = internals.activeJobs.get('buffered');
      cancelled!.controller.abort(new Error('Cancelled by server'));
    }
    return true;
  } };
  const event = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
  t.mock.method(globalThis, 'fetch', async () => new Response(event('first') + event('late') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }));
  try {
    await internals.handleInfer({ jobId: 'buffered', messages: [], maxTokens: 2 });
    assert.equal(cancelled?.chunks, 1);
    assert.equal(cancelled?.text, 'first');
    assert.equal(frames.filter((frame) => frame.type === 'chunk').length, 1);
    assert.equal(frames.some((frame) => frame.type === 'done'), false);
    assert.equal(internals.activeJobs.size, 0);
  } finally {
    internals.runner = null;
    (internals as unknown as { tunnel: null }).tunnel = null;
    await agent.stop();
  }
});


test('run keeps ownership through an in-flight load and preserves stopped dashboard', async () => {
  let socket: WebSocket | undefined;
  const server = await fakeServer({ onSocket: (client) => { socket = client; } });
  const agent = agentFor(server.url, true);
  const internals = lifecycle(agent);
  const entered = deferred();
  const gate = deferred();
  const originalLoad = internals.loadModel.bind(agent);
  internals.loadModel = async (...args) => {
    entered.resolve();
    await gate.promise;
    return originalLoad(...args);
  };
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    socket!.send(JSON.stringify({ type: 'load', requestId: 'slow', url: 'https://huggingface.co/a/b/resolve/main/model.gguf' }));
    await entered.promise;
    await agent.stop();
    const snapshot = structuredClone(agent.dashboardState);
    await assert.rejects(agentFor(server.url, true).run(), /locked/);
    gate.resolve();
    await settlesWithin(running, 5_000);
    assert.deepEqual(agent.dashboardState, snapshot);
    assert.equal(internals.loadingModel, false);
    assert.ok(!server.frames.some((frame) => frame.type === 'loaded'));
    const next = agentFor(server.url, true);
    const nextRunning = next.run();
    try { await next.waitForOnline(5_000); }
    finally { await next.stop(); await nextRunning; }
  } finally {
    gate.resolve();
    await agent.stop();
    await running;
    await server.close();
  }
});


test('failed stop attempts every teardown and retains ownership through tasks and final writes', async (t) => {
  const server = await fakeServer();
  const agent = agentFor(server.url, true);
  const internals = agent as unknown as {
    sleepGuard: { stop(): Promise<void> };
    tunnel: { stop(): Promise<void> };
    runner: { stop(): Promise<void> } | null;
    dashboard: { stop(): void };
    messageTasks: Set<Promise<void>>;
    stateWrite: Promise<void>;
    healthWrite: Promise<void>;
    publishHealth(): Promise<void>;
  };
  const taskGate = deferred();
  const stateGate = deferred();
  const healthGate = deferred();
  const healthEntered = deferred();
  const failure = new Error('injected sleep guard cleanup failure');
  const tunnelFailure = new Error('injected tunnel cleanup failure');
  let tunnelStops = 0;
  let runnerStops = 0;
  let dashboardStops = 0;
  let settled = false;
  const running = agent.run();
  // Attach the rejection handler before injecting the failure.
  const result = running.then(
    () => { settled = true; return undefined; },
    (error: unknown) => { settled = true; return error; },
  );
  try {
    await agent.waitForOnline(5_000);
    const stopTunnel = internals.tunnel.stop.bind(internals.tunnel);
    t.mock.method(internals.sleepGuard, 'stop', async () => { throw failure; });
    t.mock.method(internals.tunnel, 'stop', async () => {
      tunnelStops++;
      await stopTunnel();
      throw tunnelFailure;
    });
    const stopDashboard = internals.dashboard.stop.bind(internals.dashboard);
    t.mock.method(internals.dashboard, 'stop', () => { dashboardStops++; stopDashboard(); });
    internals.runner = { stop: async () => { runnerStops++; } };
    internals.messageTasks.add(taskGate.promise.then(() => {
      // Simulate a handler allocating an engine after stop's first teardown.
      internals.runner = { stop: async () => { runnerStops++; } };
    }));
    await assert.rejects(agent.stop(), (error) => error === failure);
    assert.ok(tunnelStops >= 1);
    assert.equal(runnerStops, 1);
    assert.ok(dashboardStops >= 1);
    internals.stateWrite = stateGate.promise;
    internals.healthWrite = healthGate.promise;
    const publishHealth = internals.publishHealth.bind(agent);
    t.mock.method(internals, 'publishHealth', () => {
      healthEntered.resolve();
      return publishHealth();
    });
    const assertOwned = async () => {
      assert.equal(settled, false);
      await assert.rejects(agentFor(server.url, true).run(), /locked/);
      assert.equal(settled, false);
    };
    await assertOwned();
    taskGate.resolve();
    await eventually(() => runnerStops === 2);
    // Startup may also retry teardown as its final refresh completes.
    assert.ok(tunnelStops >= 2);
    assert.ok(dashboardStops >= 2);
    await assertOwned();
    stateGate.resolve();
    await healthEntered.promise;
    await assertOwned();
    healthGate.resolve();
    assert.equal(await settlesWithin(result, 5_000), failure);
    const next = agentFor(server.url, true);
    const nextRunning = next.run();
    try { await next.waitForOnline(5_000); }
    finally { await next.stop(); await nextRunning; }
  } finally {
    taskGate.resolve();
    stateGate.resolve();
    healthGate.resolve();
    await agent.stop().catch(() => {});
    await result;
    await server.close();
  }
});
