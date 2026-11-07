import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { TunnelClient } from '../src/network/tunnelClient.js';
import type { HeartbeatPayload, HelloPayload } from '../src/types.js';

const hello = (): HelloPayload => ({
  type: 'hello',
  agentVersion: '1.0.0',
  platform: 'test',
  arch: 'x64',
  gpuName: 'Fake GPU',
  gpuVendor: 'nvidia',
  vramMb: 8192,
  freeVramMb: 8000,
  modelId: 'fake',
  modelLabel: 'fake',
  repo: '',
  file: 'fake.gguf',
  quant: 'Q4_K_M',
  paramB: 7,
  layers: 32,
  context: 8192,
  slots: 1,
  sha256: null,
  hashVerified: false,
  tokPerSec: 24,
  ttftMs: 300,
  priceInUsd: 0.1,
  priceOutUsd: 0.2,
  simulate: true,
  publicMode: false,
});

const heartbeat = (): HeartbeatPayload => ({
  type: 'heartbeat',
  tokPerSec: 24,
  ttftMs: 300,
  llamaUp: true,
  sha256: null,
  file: 'fake.gguf',
  layers: 32,
  activeJobId: null,
  wakeLock: false,
  gpuTempC: 50,
  gpuPowerW: 80,
  gpuUtilPct: 10,
  freeVramMb: 8000,
  slotsUsed: 0,
});

async function startServer(onConnection: (socket: import('ws').WebSocket, count: number) => void): Promise<{ wss: WebSocketServer; port: number; connections: () => number }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  let count = 0;
  wss.on('connection', (socket, request) => {
    count++;
    onConnection(socket, count, request);
  });
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { wss, port, connections: () => count };
}

test('tunnel connects, sends hello, heartbeats, and reconnects after a drop', async () => {
  let hellos = 0;
  let heartbeats = 0;
  const auth: string[] = [];
  const urls: string[] = [];
  const server = await startServer((socket, _count, request) => {
    auth.push(String(request.headers.authorization || ''));
    urls.push(String(request.url || ''));
    socket.send(JSON.stringify({ type: 'welcome', username: 'ada' }));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type === 'hello') hellos++;
      if (message.type === 'heartbeat') heartbeats++;
      if (message.type === 'hello' && hellos === 1) {
        setTimeout(() => socket.close(1001, 'wifi blip'), 60);
      }
    });
  });
  const tunnel = new TunnelClient({
    server: `http://127.0.0.1:${server.port}`,
    token: 'kh_test',
    hello,
    heartbeat,
    heartbeatMs: 50,
    reconnectDelaysMs: [40, 40],
    logger: undefined,
  });
  try {
    tunnel.start();
    await tunnel.waitForWelcome(5_000);
    assert.equal(tunnel.username, 'ada');
    assert.equal(auth[0], 'Bearer kh_test');
    assert.ok(!urls[0]?.includes('token='), 'host key must not be in the URL');
    await new Promise((r) => setTimeout(r, 180));
    assert.ok(heartbeats >= 1);
    const deadline = Date.now() + 8_000;
    while (hellos < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(hellos >= 2, `expected a reconnect hello, got ${hellos}`);
    assert.equal(tunnel.state, 'open');
    assert.ok(server.connections() >= 2);
  } finally {
    await tunnel.stop();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
  }
});

test('a rejected host key stops reconnecting', async () => {
  const server = await startServer((socket) => {
    socket.close(4001, 'bad token');
  });
  const tunnel = new TunnelClient({
    server: `http://127.0.0.1:${server.port}`,
    token: 'kh_bad',
    hello,
    reconnectDelaysMs: [30],
  });
  try {
    let failed = false;
    tunnel.once('auth-failed', () => { failed = true; });
    tunnel.start();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(failed, true);
    assert.equal(tunnel.state, 'auth-failed');
    assert.equal(server.connections() >= 1, true);
  } finally {
    await tunnel.stop();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
  }
});

test('a server that requires a newer agent stops reconnecting with an update hint', async () => {
  const server = await startServer((socket) => {
    socket.close(4426, '1.4.0');
  });
  const tunnel = new TunnelClient({
    server: `http://127.0.0.1:${server.port}`,
    token: 'kh_test',
    hello,
    reconnectDelaysMs: [30],
  });
  try {
    const outdated = new Promise<Error>((resolve) => tunnel.once('outdated', resolve));
    const welcome = tunnel.waitForWelcome(5_000);
    tunnel.start();
    const error = await outdated;
    assert.match(error.message, /needs v1\.4\.0/);
    assert.match(error.message, /npx kiln-agent@latest/);
    await assert.rejects(welcome, /too old/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(tunnel.state, 'outdated');
    assert.equal(server.connections(), 1);
  } finally {
    await tunnel.stop();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
  }
});

test('an HTTP 401 at the tunnel handshake is treated as a rejected key', async () => {
  let upgrades = 0;
  const http = createServer();
  http.on('upgrade', (_request, socket) => {
    upgrades++;
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const tunnel = new TunnelClient({
    server: `http://127.0.0.1:${port}`,
    token: 'kh_bad',
    hello,
    reconnectDelaysMs: [30],
  });
  try {
    const failed = new Promise<Error>((resolve) => tunnel.once('auth-failed', resolve));
    tunnel.start();
    const error = await failed;
    assert.match(error.message, /HTTP 401/);
    assert.equal(tunnel.state, 'auth-failed');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(upgrades, 2, 'expected one header attempt and one query-token fallback');
  } finally {
    await tunnel.stop();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('a tunnel that stops answering pings is torn down and reconnected', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  let connections = 0;
  wss.on('connection', (socket) => {
    connections++;
    socket.send(JSON.stringify({ type: 'welcome', username: 'ada' }));
  });
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const tunnel = new TunnelClient({
    server: `http://127.0.0.1:${port}`,
    token: 'kh_test',
    hello,
    pingIntervalMs: 40,
    staleAfterMs: 150,
    reconnectDelaysMs: [30],
  });
  try {
    tunnel.start();
    await tunnel.waitForWelcome(5_000);
    const deadline = Date.now() + 5_000;
    while (connections < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(connections >= 2, `expected a reconnect after the silent tunnel, got ${connections} connection(s)`);
  } finally {
    await tunnel.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

test('server frames named like internal events do not crash or spoof the tunnel', async () => {
  const server = await startServer((socket) => {
    socket.send(JSON.stringify({ type: 'welcome', username: 'ada' }));
    socket.send(JSON.stringify({ type: 'error', message: 'rate limited' }));
    socket.send(JSON.stringify({ type: 'auth-failed' }));
  });
  const tunnel = new TunnelClient({ server: `http://127.0.0.1:${server.port}`, token: 'kh_test', hello });
  try {
    const seen: string[] = [];
    let spoofed = false;
    tunnel.on('message', (message: { type: string }) => seen.push(message.type));
    tunnel.on('auth-failed', () => { spoofed = true; });
    tunnel.start();
    await tunnel.waitForWelcome(5_000);
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, ['welcome', 'error', 'auth-failed']);
    assert.equal(spoofed, false);
    assert.equal(tunnel.state, 'open');
  } finally {
    await tunnel.stop();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
  }
});
