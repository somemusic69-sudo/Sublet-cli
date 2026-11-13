import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, renderFrame, TerminalDashboard } from '../src/ui/terminalDashboard.js';
import { VERSION } from '../src/version.js';

function fakeStream(isTTY: boolean): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stream = { isTTY, write: (chunk: string) => { writes.push(chunk); return true; } } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

test('the dashboard frame shows the fields a host needs overnight', () => {
  const state = initialState('http://127.0.0.1:8787');
  state.status = 'working';
  state.username = 'ada';
  state.endpoint = 'http://127.0.0.1:8787/h/ada/v1';
  state.reliability = 98.5;
  state.gpuName = 'NVIDIA GeForce RTX 4090';
  state.totalVramMb = 24576;
  state.freeVramMb = 21000;
  state.gpuTempC = 61;
  state.gpuPowerW = 185;
  state.wakeLock = true;
  state.job = {
    kind: 'request',
    id: 'req_804',
    model: 'Llama-3.3-70B-Abliterated-Q4_K_M.gguf',
    verified: true,
    timerStartedAt: Date.now(),
    timerEndsAt: Date.now() + 6 * 3600_000,
    minTokS: 25,
    guaranteedNanos: 6_000_000_000,
    hours: 8,
  };
  state.liveTokPerSec = 38.4;
  state.sessionEarnedNanos = 4_680_000_000;
  state.walletNanos = 42_150_000_000;
  state.lastHeartbeatAt = Date.now();
  state.showLogs = true;
  state.logTail = ['llama-server loaded', 'slot released'];
  state.keyHint = 'W host page · C copy endpoint · L logs · ? help';
  const frame = renderFrame(state, { width: 72, color: false });
  assert.ok(frame.includes(`Sublera GPU TERMINAL AGENT v${VERSION}`));
  assert.match(frame, /STATUS: .*WORKING/);
  assert.match(frame, /Host Endpoint/);
  assert.match(frame, /Reliability\s+: 98\.5%/);
  assert.match(frame, /NVIDIA GeForce RTX 4090/);
  assert.match(frame, /Wake-Lock: ACTIVE/);
  assert.match(frame, /CURRENT JOB\s+: Dedicated Buyer Request/);
  assert.ok(frame.includes('Time Remaining: '), frame);
  assert.match(frame, /38\.4 tok\/s/);
  assert.match(frame, /Session Earn\. : \$4\.68/);
  assert.match(frame, /Total Wallet\s+: \$42\.15/);
  assert.match(frame, /Keys\s+: W host page/);
  assert.match(frame, /llama-server loaded/);
  const lines = frame.split('\n');
  assert.ok(lines.length >= 15);
  assert.ok(lines.every((line) => ['\u250c','\u2502','\u251c','\u2514'].includes(line[0] || '') && ['\u2510','\u2502','\u2524','\u2518'].includes(line[line.length - 1] || '')), lines.join('\n'));
});

test('standby shows a clear waiting state and no fake GPU', () => {
  const frame = renderFrame(initialState('http://127.0.0.1:8787'), { width: 72, color: false });
  assert.match(frame, /Standby - waiting for a web request/);
  assert.match(frame, /No GPU detected/);
  assert.match(frame, /Time Remaining: -/);
});

test('the frame has a top border and the status color sits on the title line', () => {
  const state = initialState('http://127.0.0.1:8787');
  state.status = 'working';
  const lines = renderFrame(state, { width: 72, color: true }).split('\n');
  assert.ok(lines[0]?.startsWith('\u250c') && lines[0]?.endsWith('\u2510'), lines[0]);
  assert.ok(lines[lines.length - 1]?.startsWith('\u2514'));
  assert.match(lines[1] || '', /STATUS: \x1b\[32m● WORKING\x1b\[0m/);
});

test('a non-TTY dashboard prints plain frames on status changes only and never redraws in place', async () => {
  const { stream, writes } = fakeStream(false);
  const state = initialState('http://127.0.0.1:8787');
  state.lastHeartbeatAt = Date.now();
  const dashboard = new TerminalDashboard(state, { stream, intervalMs: 5 });
  dashboard.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  dashboard.update({ message: 'same status' });
  dashboard.update({ status: 'online' });
  dashboard.stop();
  assert.equal(writes.length, 2);
  assert.ok(writes.every((chunk) => !chunk.includes('\x1b[')), JSON.stringify(writes));
});

test('a disabled dashboard writes nothing even on a TTY', async () => {
  const { stream, writes } = fakeStream(true);
  const dashboard = new TerminalDashboard(initialState('http://127.0.0.1:8787'), { stream, intervalMs: 5, enabled: false });
  dashboard.start();
  dashboard.update({ status: 'online', message: 'hello' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  dashboard.stop();
  assert.deepEqual(writes, []);
});

test('a benchmark test load is shown as a benchmark, not as a buyer request', () => {
  const state = initialState('http://127.0.0.1:8787');
  state.job = { kind: 'request', id: 'bench_abc123', model: 'tiny.gguf', verified: false, timerStartedAt: null, timerEndsAt: null, minTokS: null, guaranteedNanos: 0 };
  const frame = renderFrame(state, { width: 72, color: false });
  assert.match(frame, /Benchmark: measuring this GPU/);
  assert.doesNotMatch(frame, /Dedicated Buyer Request/);
});
