import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
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

async function fakeServer(options: { meDelayMs?: number; onSocket?: (socket: WebSocket) => void; me?: () => Record<string, unknown> } = {}): Promise<{ url: string; frames: Frame[]; close: () => Promise<void> }> {
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
        ...(options.me?.() ?? {}),
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

function agentFor(server: string, simulation: boolean, extra: { requestId?: string; publicMode?: boolean; priceHourUsd?: number; priceOutUsd?: number; slots?: number; model?: string } = {}) {
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
      setTimeout(() => socket.send(JSON.stringify({ type: 'load', requestId: 'r_1', url: '/home/host/.ssh/id_ed25519', context: 4096 })), 100);
    },
  });
  const agent = agentFor(server.url, true);
  try {
    void agent.run().catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while (!server.frames.some((f) => f.type === 'load_failed') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const failed = server.frames.find((f) => f.type === 'load_failed');
    assert.equal(failed?.requestId, 'r_1');
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

// Several bookings on one loaded model: speed seats and full-GPU rentals side by side.
const { renderFrame } = await import('../src/ui/terminalDashboard.js');
const { clearAgentState, readAgentState, saveAgentState, statePath } = await import('../src/state.js');

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A fake server that lists every booking it started in /api/agent/me until it ends. */
async function bookingServer(options: { onHello?: (send: (frame: Frame) => void) => void } = {}) {
  let socket: WebSocket | undefined;
  const live = new Map<string, Record<string, unknown>>();
  const server = await fakeServer({
    onSocket: (client) => {
      socket = client;
      client.on('message', (raw) => {
        if ((JSON.parse(String(raw)) as Frame).type === 'hello') options.onHello?.(send);
      });
    },
    me: () => {
      const rows = [...live.values()].filter((row) => Number(row.timerEndsAt) > Date.now()).reverse();
      return { activeRequests: rows, activeRequest: rows[0] ?? null };
    },
  });
  const send = (frame: Frame) => socket!.send(JSON.stringify(frame));
  return {
    ...server,
    live,
    send,
    book: (frame: Record<string, unknown>) => {
      live.set(String(frame.requestId), { id: frame.requestId, status: 'active', ...frame });
      send({ type: 'booking', ...frame });
    },
    end: (requestId: string, reason = 'Cancelled by the buyer') => {
      live.delete(requestId);
      send({ type: 'reject', requestId, reason });
    },
  };
}

type WakeStub = { acquired: number; released: number };
function stubWake(agent: InstanceType<typeof Agent>): WakeStub {
  const counts = { acquired: 0, released: 0 };
  const guard = lifecycle(agent).sleepGuard;
  guard.acquire = async () => { counts.acquired++; };
  guard.stop = async () => { counts.released++; };
  return counts;
}

test('several bookings run side by side; a seat and a full-GPU rental each end on their own', async () => {
  const server = await bookingServer();
  const agent = agentFor(server.url, true, { slots: 2, model: 'https://huggingface.co/a/b/resolve/main/model.gguf' });
  const wake = stubWake(agent);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    const now = Date.now();
    // Stacked bookings come without a load frame: model checks, then verified, then booking.
    server.send({ type: 'verified', requestId: 'r_seat' });
    server.book({ requestId: 'r_seat', timerStartedAt: now, timerEndsAt: now + 1_500, hours: 1, pricePerHourNanos: 1e9, minTokS: 50, shared: true, tokS: 50 });
    server.book({ requestId: 'r_full', timerStartedAt: now, timerEndsAt: now + 3_600_000, hours: 1, pricePerHourNanos: 2e9 });
    await eventually(() => agent.activeBookings.length === 2);
    assert.deepEqual(agent.activeBookings.map((b) => [b.requestId, b.tokS, b.shared]), [['r_seat', 50, true], ['r_full', null, false]]);
    const frame = renderFrame(agent.dashboardState, { width: 90, color: false });
    assert.match(frame, /CURRENT JOB\s+: 2 rentals: 50 tok\/s \+ full GPU/);
    assert.match(frame, /first of 2 to end/);
    assert.match(frame, /Guaranteed/);
    await until(async () => (await readAgentState())?.bookings.length === 2, 'both bookings in state.json');
    // Work on the loaded model keeps flowing while both bookings run.
    server.send({ type: 'infer', jobId: 'during', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 });
    await eventually(() => server.frames.some((f) => f.type === 'done' && f.jobId === 'during'));
    // The seat's end timer removes only the seat; the full-GPU rental keeps the wake lock.
    await eventually(() => agent.booking('r_seat') === null);
    assert.ok(agent.booking('r_full'));
    assert.equal(wake.released, 0, 'the wake lock was released while a booking was still active');
    await until(async () => (await readAgentState())?.bookings.map((b) => b.requestId).join() === 'r_full', 'state.json without the ended seat');
    const rejected = new Promise<{ requestId: string; wasActive: boolean }>((resolve) => agent.once('rejected', resolve));
    server.end('r_full');
    assert.deepEqual(await rejected, { requestId: 'r_full', reason: 'Cancelled by the buyer', wasActive: true });
    assert.deepEqual(agent.activeBookings, []);
    await eventually(() => wake.released > 0);
    await until(async () => (await readAgentState()) === null, 'state.json to be removed');
    assert.ok(!server.frames.some((f) => f.type === 'load_failed' || (f.type === 'error' && f.code !== undefined)));
    assert.equal(server.frames.find((f) => f.type === 'hello')?.priceHourUsd, 0, 'start and jobs do not rent the GPU by the hour');
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

test('a reject ends only its own booking', async () => {
  const server = await bookingServer();
  const agent = agentFor(server.url, true);
  stubWake(agent);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    const now = Date.now();
    server.book({ requestId: 'r_a', timerStartedAt: now, timerEndsAt: now + 600_000, hours: 1, pricePerHourNanos: 1e9, tokS: 40 });
    server.book({ requestId: 'r_b', timerStartedAt: now, timerEndsAt: now + 900_000, hours: 1, pricePerHourNanos: 1e9, tokS: 60 });
    await eventually(() => agent.activeBookings.length === 2);
    server.end('r_a');
    await eventually(() => agent.booking('r_a') === null);
    assert.equal(agent.booking('r_b')?.tokS, 60);
    assert.equal(agent.dashboardState.job?.id, 'r_b');
    assert.equal(agent.dashboardState.status, 'working');
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

test('the status poll adds bookings the server lists, updates timers, and drops the ones it no longer lists', async () => {
  let me: Record<string, unknown> = {};
  const server = await fakeServer({ me: () => me });
  const agent = agentFor(server.url, true);
  stubWake(agent);
  const refresh = async () => {
    // A booking confirmed in the same millisecond as the poll is never dropped by it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await (agent as unknown as { refreshMe(): Promise<void> }).refreshMe();
  };
  const ids = () => agent.activeBookings.map((b) => b.requestId);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    const now = Date.now();
    me = {
      activeRequests: [
        { id: 'r_b', status: 'active', timerStartedAt: now, timerEndsAt: now + 900_000, hours: 1, pricePerHourNanos: 1e9 },
        { id: 'r_a', status: 'active', timerStartedAt: now, timerEndsAt: now + 600_000, hours: 1, pricePerHourNanos: 1e9, tokS: 40, shared: true },
        { id: 'r_loading', status: 'loading' },
      ],
      activeRequest: null,
    };
    await refresh();
    assert.deepEqual(ids(), ['r_a', 'r_b']);
    assert.equal(agent.booking('r_a')?.tokS, 40);
    assert.equal(agent.booking('r_b')?.guaranteedNanos, 1e9);
    me = { activeRequests: [{ id: 'r_b', status: 'active', timerStartedAt: now, timerEndsAt: now + 1_200_000 }], activeRequest: null };
    await refresh();
    assert.deepEqual(ids(), ['r_b']);
    assert.equal(agent.booking('r_b')?.timerEndsAt, now + 1_200_000);
    // An older server sends only the newest request, without activeRequests.
    me = { activeRequest: { id: 'r_c', status: 'active', timerStartedAt: now, timerEndsAt: now + 300_000 } };
    await refresh();
    assert.deepEqual(ids(), ['r_c']);
    me = { activeRequest: null };
    await refresh();
    assert.deepEqual(ids(), []);
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

test('a restart restores every saved booking with its slot count and drops the ones the server ended', async () => {
  const now = Date.now();
  const model = {
    url: 'https://huggingface.co/a/b/resolve/main/model.gguf', path: '', file: 'model.gguf', modelId: 'model', label: 'model', repo: 'a/b',
    quant: 'Q4_K_M', paramB: 7, layers: 4, contextTrain: 8192, sha256: 'a'.repeat(64), verified: true, needsMb: 5000, size: 1, architecture: 'simulation',
  };
  const record = (requestId: string, slots: number, extra: Record<string, unknown> = {}) => ({
    requestId, model, context: 4096, slots, timerStartedAt: now - 60_000, timerEndsAt: now + 3_600_000, hours: 1,
    pricePerHourNanos: 1e9, minTokS: null, guaranteedNanos: 1e9, savedAt: now, ...extra,
  });
  const one = record('r_one', 4, { shared: true, tokS: 50 });
  await saveAgentState({ version: 1, booking: one, bookings: [one, record('r_two', 2), record('r_gone', 1)], updatedAt: now });
  const listed = ['r_one', 'r_two'].map((id) => ({ id, status: 'active', timerStartedAt: now - 60_000, timerEndsAt: now + 3_600_000 }));
  const server = await fakeServer({ me: () => ({ activeRequests: listed, activeRequest: listed[0] }) });
  const agent = agentFor(server.url, true);
  stubWake(agent);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    assert.deepEqual(agent.activeBookings.map((b) => b.requestId).sort(), ['r_one', 'r_two']);
    assert.equal(agent.booking('r_one')?.tokS, 50);
    await eventually(() => server.frames.some((f) => f.type === 'hello'));
    const hello = server.frames.find((f) => f.type === 'hello')!;
    assert.equal(hello.slots, 4, 'llama-server must come back with the largest saved slot count');
    assert.equal(hello.context, 4096);
    const saved = await readAgentState();
    assert.deepEqual(saved?.bookings.map((b) => [b.requestId, b.slots]).sort(), [['r_one', 4], ['r_two', 2]]);
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

test('public mode keeps per-token earnings from before a booking, counts none while rentals run, and adds each booking\'s time share', async () => {
  const server = await bookingServer();
  const agent = agentFor(server.url, true, { publicMode: true, priceOutUsd: 1000, slots: 2 });
  stubWake(agent);
  const job = async (jobId: string) => {
    server.send({ type: 'infer', jobId, messages: [{ role: 'user', content: 'hello there' }], maxTokens: 16 });
    await eventually(() => server.frames.some((f) => f.type === 'done' && f.jobId === jobId));
  };
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    await job('p1');
    const tokens1 = agent.dashboardState.tokenEarnedNanos ?? 0;
    assert.ok(tokens1 > 0, 'per-token earnings were not counted');
    const now = Date.now();
    // A one-hour seat at $1/h that started half an hour ago has earned about $0.50.
    server.book({ requestId: 'r_seat', timerStartedAt: now - 1_800_000, timerEndsAt: now + 1_800_000, hours: 1, pricePerHourNanos: 1e9, shared: true, tokS: 50 });
    await eventually(() => agent.activeBookings.length === 1);
    const earned = agent.dashboardState.sessionEarnedNanos;
    assert.ok(earned >= tokens1 + 0.49e9 && earned <= tokens1 + 0.51e9, `earned ${earned}, tokens ${tokens1}`);
    // An infer frame does not say whether the seat renter sent it, so jobs beside a seat are not counted per token.
    await job('p2');
    const tokens2 = agent.dashboardState.tokenEarnedNanos ?? 0;
    assert.equal(tokens2, tokens1, 'a job during a speed seat was counted as per-token income');
    server.book({ requestId: 'r_full', timerStartedAt: now, timerEndsAt: now + 3_600_000, hours: 1, pricePerHourNanos: 2e9 });
    await eventually(() => agent.activeBookings.length === 2);
    // A full-GPU renter's tokens are paid by the hour, not per token.
    await job('p3');
    assert.equal(agent.dashboardState.tokenEarnedNanos, tokens2);
    assert.ok(agent.dashboardState.sessionEarnedNanos >= tokens2 + 0.49e9);
    assert.equal(agent.dashboardState.sessionGuaranteedNanos, 3e9);
    const frame = renderFrame(agent.dashboardState, { width: 100, color: false });
    assert.match(frame, /CURRENT JOB\s+: Per-token \+ 2 rentals: 50 tok\/s \+ full GPU/);
    assert.match(frame, /Prices\s+: \$1000\.00 per 1M tokens · \$0\.50\/h full GPU/);
    assert.match(frame, /per-token\) \/ \$3\.00 Guaranteed/);
    assert.equal(server.frames.find((f) => f.type === 'hello')?.priceHourUsd, 0.5);
    assert.equal(server.frames.find((f) => f.type === 'hello')?.publicMode, true);
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

test('a booking during a real model load keeps the host busy, and the load\'s slot count is saved', async () => {
  const server = await bookingServer();
  const agent = agentFor(server.url, true);
  const internals = lifecycle(agent);
  stubWake(agent);
  const entered = deferred();
  const gate = deferred();
  const originalLoad = internals.loadModel.bind(agent);
  internals.loadModel = async (...args) => { entered.resolve(); await gate.promise; return originalLoad(...args); };
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    server.send({ type: 'load', requestId: 'r_load', url: 'https://huggingface.co/a/b/resolve/main/model.gguf', sha256: 'b'.repeat(64), slots: 3, context: 4096 });
    await entered.promise;
    const now = Date.now();
    server.book({ requestId: 'r_other', timerStartedAt: now, timerEndsAt: now + 600_000, hours: 1, pricePerHourNanos: 1e9, tokS: 30 });
    await eventually(() => agent.booking('r_other') !== null);
    assert.equal(internals.loadingModel, true, 'a booking frame cleared the busy flag of a real load');
    server.send({ type: 'infer', jobId: 'during-load', messages: [], maxTokens: 4 });
    await eventually(() => server.frames.some((f) => f.jobId === 'during-load'));
    assert.equal(server.frames.find((f) => f.jobId === 'during-load')?.code, 'host_busy');
    gate.resolve();
    await eventually(() => server.frames.some((f) => f.type === 'loaded' && f.requestId === 'r_load'));
    assert.equal(internals.loadingModel, false);
    assert.equal(agent.dashboardState.job?.id, 'r_load', 'the request being checked stays in focus');
    server.send({ type: 'verified', requestId: 'r_load' });
    server.book({ requestId: 'r_load', timerStartedAt: now, timerEndsAt: now + 1_200_000, hours: 1, pricePerHourNanos: 1e9 });
    await eventually(() => agent.booking('r_load') !== null);
    await until(async () => (await readAgentState())?.bookings.find((b) => b.requestId === 'r_load')?.slots === 3, 'the load slot count in state.json');
    // A second load for the model that is already running is served on it without a download.
    server.send({ type: 'load', requestId: 'r_same', url: 'https://huggingface.co/a/b/resolve/main/model.gguf', sha256: 'B'.repeat(64), slots: 1, context: 4096 });
    await eventually(() => server.frames.some((f) => f.type === 'loaded' && f.requestId === 'r_same'));
    assert.ok(server.frames.some((f) => f.type === 'progress' && f.requestId === 'r_same' && /already loaded/.test(String(f.note))));
    // A different model would restart llama-server under the other bookings, so it is refused.
    server.send({ type: 'load', requestId: 'r_new', url: 'https://huggingface.co/c/d/resolve/main/other.gguf', sha256: 'c'.repeat(64), context: 4096 });
    await eventually(() => server.frames.some((f) => f.type === 'load_failed' && f.requestId === 'r_new'));
    assert.match(String(server.frames.find((f) => f.type === 'load_failed' && f.requestId === 'r_new')?.message), /serving other work/);
    assert.ok(agent.booking('r_other') && agent.booking('r_load'));
  } finally {
    gate.resolve();
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

const MODEL_URL = 'https://huggingface.co/a/b/resolve/main/model.gguf';

/** A fake server whose /api/agent/me answer the test sets, with the tunnel socket to send frames on. */
async function pollServer() {
  let socket: WebSocket | undefined;
  let me: Record<string, unknown> = {};
  const server = await fakeServer({ onSocket: (client) => { socket = client; }, me: () => me });
  return {
    ...server,
    send: (frame: Record<string, unknown>) => socket!.send(JSON.stringify(frame)),
    setMe: (next: Record<string, unknown>) => { me = next; },
  };
}

async function refreshMe(agent: InstanceType<typeof Agent>): Promise<void> {
  // A booking confirmed in the same millisecond as the poll is never dropped by it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await (agent as unknown as { refreshMe(): Promise<void> }).refreshMe();
}

test('an ended booking stays ended: a stale status answer or a late booking frame cannot add it and its earnings again', async () => {
  const server = await pollServer();
  const agent = agentFor(server.url, true);
  stubWake(agent);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    const start = Date.now();
    // A one-hour booking at $1/h that ends in 300 ms.
    const row = { id: 'r_done', status: 'active', timerStartedAt: start + 300 - 3_600_000, timerEndsAt: start + 300, hours: 1, pricePerHourNanos: 1e9 };
    server.setMe({ activeRequests: [row], activeRequest: row });
    server.send({ type: 'booking', requestId: 'r_done', timerStartedAt: row.timerStartedAt, timerEndsAt: row.timerEndsAt, hours: 1, pricePerHourNanos: 1e9 });
    await eventually(() => agent.booking('r_done') !== null);
    // The agent's own end timer ends it; the server sends no reject for a booking that completes.
    await eventually(() => agent.booking('r_done') === null);
    const earned = agent.dashboardState.sessionEarnedNanos;
    assert.equal(earned, 1e9);
    // An answer built before the end (the server clock is 5 s behind) still lists it as active.
    server.setMe({ activeRequests: [row], activeRequest: row, serverNow: row.timerEndsAt - 5_000 });
    await refreshMe(agent);
    assert.equal(agent.booking('r_done'), null, 'a stale status answer brought an ended booking back');
    server.send({ type: 'booking', requestId: 'r_done', timerStartedAt: row.timerStartedAt, timerEndsAt: row.timerEndsAt, hours: 1, pricePerHourNanos: 1e9 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(agent.booking('r_done'), null, 'a late booking frame brought an ended booking back');
    assert.equal(agent.dashboardState.sessionEarnedNanos, earned, 'an ended booking was counted twice');
    // The server clock decides whether a listed booking is over: here the server is two minutes ahead.
    const local = Date.now();
    const skewed = { id: 'r_skew', status: 'active', timerStartedAt: local - 3_600_000, timerEndsAt: local + 60_000, hours: 1, pricePerHourNanos: 1e9 };
    server.setMe({ activeRequests: [skewed], activeRequest: skewed, serverNow: local + 120_000 });
    await refreshMe(agent);
    assert.equal(agent.booking('r_skew'), null, 'a booking already over on the server clock was added');
    server.setMe({ activeRequests: [skewed], activeRequest: skewed, serverNow: Date.now() });
    await refreshMe(agent);
    assert.ok(agent.booking('r_skew'), 'with the clocks in step the listed booking is live');
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

test('a loaded request in its model check keeps llama-server and stays pending: other loads get "Host is busy"', async () => {
  const server = await pollServer();
  const agent = agentFor(server.url, true);
  stubWake(agent);
  const running = agent.run();
  const failed = (id: string) => server.frames.find((f) => f.type === 'load_failed' && f.requestId === id);
  try {
    await agent.waitForOnline(5_000);
    const checking = { id: 'r_check', status: 'verifying' };
    server.setMe({ activeRequests: [checking], activeRequest: checking });
    server.send({ type: 'load', requestId: 'r_check', url: MODEL_URL, sha256: 'a'.repeat(64), context: 4096 });
    await eventually(() => server.frames.some((f) => f.type === 'loaded' && f.requestId === 'r_check'));
    await refreshMe(agent);
    // Another file would restart llama-server mid-check; the same file would replace the request being checked.
    server.send({ type: 'load', requestId: 'r_other', url: 'https://huggingface.co/c/d/resolve/main/other.gguf', sha256: 'c'.repeat(64), context: 4096 });
    server.send({ type: 'load', requestId: 'r_same', url: MODEL_URL, sha256: 'a'.repeat(64), context: 4096 });
    await eventually(() => Boolean(failed('r_other') && failed('r_same')));
    for (const id of ['r_other', 'r_same']) assert.match(String(failed(id)?.message), /^Host is busy: .*r_check/);
    assert.deepEqual(server.frames.filter((f) => f.type === 'loaded').map((f) => f.requestId), ['r_check']);
    assert.equal(agent.dashboardState.job?.id, 'r_check');
    // The check passes and the booking starts as usual.
    const now = Date.now();
    const row = { id: 'r_check', status: 'active', timerStartedAt: now, timerEndsAt: now + 600_000, hours: 1, pricePerHourNanos: 1e9 };
    server.setMe({ activeRequests: [row], activeRequest: row });
    server.send({ type: 'verified', requestId: 'r_check' });
    server.send({ type: 'booking', requestId: 'r_check', timerStartedAt: now, timerEndsAt: now + 600_000, hours: 1, pricePerHourNanos: 1e9 });
    await eventually(() => agent.booking('r_check')?.verified === true);
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

test('the status poll: requests in their model check keep start <code> serving, and what it adds or lists again takes the wake lock', async () => {
  const server = await pollServer();
  const agent = agentFor(server.url, true);
  const wake = stubWake(agent);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    // A loaded request the server stops listing lets the machine sleep; listed again, it takes the wake lock again.
    server.send({ type: 'load', requestId: 'r_check', url: MODEL_URL, context: 4096 });
    await eventually(() => server.frames.some((f) => f.type === 'loaded' && f.requestId === 'r_check'));
    server.setMe({ activeRequests: [] });
    await refreshMe(agent);
    let before = wake.acquired;
    server.setMe({ activeRequests: [{ id: 'r_check', status: 'verifying' }] });
    await refreshMe(agent);
    assert.ok(wake.acquired > before, 'a request listed again did not take the wake lock');
    const rejected = new Promise((resolve) => agent.once('rejected', resolve));
    server.send({ type: 'reject', requestId: 'r_check', reason: 'Model check failed' });
    await rejected;
    // A booking only the status poll reports takes the wake lock too.
    const now = Date.now();
    const target = { id: 'r_target', status: 'active', timerStartedAt: now, timerEndsAt: now + 600_000, hours: 1, pricePerHourNanos: 1e9 };
    before = wake.acquired;
    server.setMe({ activeRequests: [{ id: 'r_seat', status: 'verifying' }, target], activeRequest: target });
    await refreshMe(agent);
    assert.ok(agent.booking('r_target'));
    assert.ok(wake.acquired > before, 'a booking added by the status poll did not take the wake lock');
    // A seat on the loaded model gets no load frame: during its check only the server's list shows it.
    assert.equal(agent.servingOthers('r_target'), true, 'a seat in its model check was not counted');
    for (const status of ['claimed', 'loading']) {
      server.setMe({ activeRequests: [{ id: 'r_seat', status }, target], activeRequest: target });
      await refreshMe(agent);
      assert.equal(agent.servingOthers('r_target'), true, `a ${status} request was not counted`);
    }
    server.setMe({ activeRequests: [target], activeRequest: target });
    await refreshMe(agent);
    assert.equal(agent.servingOthers('r_target'), false);
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

test('a stop during the restore after a restart adds no booking, and a failed restore releases the wake lock', async () => {
  const now = Date.now();
  const model = {
    url: MODEL_URL, path: '', file: 'model.gguf', modelId: 'model', label: 'model', repo: 'a/b',
    quant: 'Q4_K_M', paramB: 7, layers: 4, contextTrain: 8192, sha256: 'a'.repeat(64), verified: true, needsMb: 5000, size: 1, architecture: 'simulation',
  };
  const record = {
    requestId: 'r_keep', model, context: 4096, slots: 1, timerStartedAt: now - 60_000, timerEndsAt: now + 3_600_000, hours: 1,
    pricePerHourNanos: 1e9, minTokS: null, guaranteedNanos: 1e9, savedAt: now,
  };
  const listed = [{ id: 'r_keep', status: 'active', timerStartedAt: record.timerStartedAt, timerEndsAt: record.timerEndsAt }];
  const server = await fakeServer({ me: () => ({ activeRequests: listed, activeRequest: listed[0] }) });
  try {
    await saveAgentState({ version: 1, booking: record, bookings: [record], updatedAt: now });
    const agent = agentFor(server.url, true);
    stubWake(agent);
    let stopping: Promise<void> | undefined;
    // SIGTERM arrives while the restore waits for the wake lock.
    lifecycle(agent).sleepGuard.acquire = async () => { stopping = agent.stop(true); };
    await settlesWithin(agent.run(), 5_000);
    await stopping;
    assert.deepEqual(agent.activeBookings, [], 'the restore added bookings after the stop');
    assert.deepEqual((await readAgentState())?.bookings.map((b) => b.requestId), ['r_keep'], 'a stop that keeps state removed state.json');
    const failing = agentFor(server.url, true);
    const wake = stubWake(failing);
    lifecycle(failing).sleepGuard.acquire = async () => { throw new Error('wake lock failed'); };
    const running = failing.run();
    try {
      await failing.waitForOnline(5_000);
      assert.ok(wake.released >= 1, 'the failed restore kept the wake lock');
    } finally {
      await failing.stop();
      await running;
    }
  } finally {
    await server.close();
    await clearAgentState();
  }
});

test('state.json names the server\'s activeRequest in the legacy booking field, else the newest booking', async () => {
  const server = await pollServer();
  const agent = agentFor(server.url, true, { model: MODEL_URL });
  stubWake(agent);
  const running = agent.run();
  const legacy = async () => {
    try { return (JSON.parse(await readFile(statePath(), 'utf8')) as { booking: { requestId: string } }).booking.requestId; } catch { return null; }
  };
  try {
    await agent.waitForOnline(5_000);
    const now = Date.now();
    // r_late started later, but the server's newest by claim time is r_early: an older agent restores only that one.
    const early = { id: 'r_early', status: 'active', timerStartedAt: now - 60_000, timerEndsAt: now + 600_000, hours: 1, pricePerHourNanos: 1e9 };
    const late = { id: 'r_late', status: 'active', timerStartedAt: now, timerEndsAt: now + 600_000, hours: 1, pricePerHourNanos: 1e9 };
    server.setMe({ activeRequests: [early, late], activeRequest: early });
    await refreshMe(agent);
    await until(async () => (await legacy()) === 'r_early', 'the server\'s activeRequest in the legacy field');
    assert.deepEqual((await readAgentState())?.bookings.map((b) => b.requestId), ['r_late', 'r_early']);
    server.setMe({ activeRequests: [early, late], activeRequest: null });
    await refreshMe(agent);
    await until(async () => (await legacy()) === 'r_late', 'the newest booking in the legacy field');
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});

test('server values are checked: malformed request ids are ignored, numbers are coerced, control characters are removed', async () => {
  const server = await pollServer();
  const agent = agentFor(server.url, true);
  stubWake(agent);
  const running = agent.run();
  try {
    await agent.waitForOnline(5_000);
    const now = Date.now();
    server.setMe({ activeRequests: [{ id: 'r_ok', status: 'active', timerStartedAt: now, timerEndsAt: now + 600_000 }, { id: 'r_far', status: 'active', timerStartedAt: now }] });
    for (const requestId of ['r', 'r\u001b[2J', 'a'.repeat(81), 42]) {
      server.send({ type: 'booking', requestId, timerStartedAt: now, timerEndsAt: now + 600_000, hours: 1, pricePerHourNanos: 1e9 });
      server.send({ type: 'load', requestId, url: MODEL_URL });
      server.send({ type: 'reject', requestId, reason: 'x' });
    }
    // An end time Date cannot show used to make the booking log throw and stop the agent.
    server.send({ type: 'booking', requestId: 'r_far', timerStartedAt: now, timerEndsAt: 1e300, hours: 1, pricePerHourNanos: 1e9 });
    server.send({ type: 'booking', requestId: 'r_ok', timerStartedAt: now, timerEndsAt: now + 600_000, hours: '1', pricePerHourNanos: 1e9, tokS: '30' });
    await eventually(() => agent.booking('r_ok') !== null);
    assert.deepEqual(agent.activeBookings.map((b) => b.requestId), ['r_ok', 'r_far']);
    assert.equal(agent.booking('r_far')?.timerEndsAt, null);
    assert.equal(agent.booking('r_ok')?.tokS, 30);
    assert.equal(agent.health.live, true);
    assert.ok(!server.frames.some((f) => ['loaded', 'load_failed', 'progress'].includes(f.type)), 'a frame with a malformed requestId was handled');
    const rejected = new Promise<{ reason: string }>((resolve) => agent.once('rejected', resolve));
    server.send({ type: 'reject', requestId: 'r_ok', reason: 'Cancelled\u001b[31m by the buyer\u0007' });
    assert.equal((await rejected).reason, 'Cancelled[31m by the buyer');
    assert.doesNotMatch(String(agent.dashboardState.message), /[\u0000-\u001f]/);
    // The status poll: numeric strings count, broken numbers are null, a row with a bad id or no valid end is skipped.
    server.setMe({
      activeRequests: [
        { id: 'r_poll', status: 'active', timerStartedAt: String(now), timerEndsAt: String(now + 600_000), hours: '1', pricePerHourNanos: '1000000000', tokS: '40', minTokS: 'fast', file: 'm\u001b]0;title\u0007.gguf' },
        { id: 'bad id', status: 'active', timerStartedAt: now, timerEndsAt: now + 600_000 },
        { id: 'r_broken', status: 'active', timerStartedAt: now, timerEndsAt: 'later' },
        { id: 'r_far', status: 'active', timerStartedAt: now },
      ],
      activeRequest: null,
    });
    await refreshMe(agent);
    assert.deepEqual(agent.activeBookings.map((b) => b.requestId), ['r_poll', 'r_far']);
    const poll = agent.booking('r_poll')!;
    assert.deepEqual([poll.timerEndsAt, poll.tokS, poll.minTokS, poll.guaranteedNanos], [now + 600_000, 40, null, 1e9]);
    const frame = renderFrame(agent.dashboardState, { width: 100, color: false });
    assert.doesNotMatch(frame, /NaN|\u001b|\u0007/);
  } finally {
    await agent.stop();
    await running;
    await server.close();
    await clearAgentState();
  }
});
