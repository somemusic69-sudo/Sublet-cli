import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, renderFrame } from '../src/ui/terminalDashboard.js';

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
  state.keyHint = 'W withdraw · C copy endpoint · L logs · ? help';
  const frame = renderFrame(state, { width: 72, color: false });
  assert.match(frame, /Kiln GPU TERMINAL AGENT v1\.0\.0/);
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
  assert.match(frame, /Keys\s+: W withdraw/);
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
