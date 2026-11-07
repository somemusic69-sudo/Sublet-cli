import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { checkFit, choosePrimary, parseNvidiaCsv, parseNvidiaProcesses, parseWmicJson } from '../src/hardware/gpuMonitor.js';
import { SleepGuard, sleepGuardAvailable, windowsSleepScript } from '../src/hardware/sleepGuard.js';
import type { ChildProcess } from 'node:child_process';

test('nvidia-smi CSV parses multi-GPU output and N/A values', () => {
  const gpus = parseNvidiaCsv([
    'NVIDIA GeForce RTX 4060, 8188, 6418, 15, 46, [N/A], 115',
    'NVIDIA GeForce RTX 3060, 12288, 10240, 0, [N/A], 32.5, 170',
  ].join('\n'));
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0]?.name, 'NVIDIA GeForce RTX 4060');
  assert.equal(gpus[0]?.totalVramMb, 8188);
  assert.equal(gpus[0]?.freeVramMb, 6418);
  assert.equal(gpus[0]?.powerW, null);
  assert.equal(gpus[1]?.temperatureC, null);
  assert.equal(gpus[1]?.powerW, 32.5);
});

test('VRAM fit check reserves a small safety margin', () => {
  const gpu = parseNvidiaCsv('NVIDIA GeForce RTX 4060, 8188, 7000, 10, 45, 80, 115')[0]!;
  assert.equal(checkFit(6000, gpu).ok, true);
  assert.equal(checkFit(7000, gpu).ok, false);
  assert.equal(checkFit(100, null).ok, false);
  assert.equal(choosePrimary([gpu])?.name, gpu.name);
});

test('GPU process output ignores zero-memory graphics contexts', () => {
  const processes = parseNvidiaProcesses('123, C:\\Windows\\explorer.exe, 0\n456, python.exe, 3200');
  assert.equal(processes.length, 2);
  assert.equal(processes[1]?.usedMb, 3200);
});

test('Windows video controller JSON is parsed and virtual adapters are skipped', () => {
  const gpus = parseWmicJson([
    { Name: 'Microsoft Basic Display Adapter', AdapterRAM: 0 },
    { Name: 'NVIDIA GeForce RTX 4090', AdapterRAM: 25757220864 },
  ]);
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0]?.vendor, 'nvidia');
  assert.ok((gpus[0]?.totalVramMb || 0) > 20000);
});

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.defineProperty(child, 'pid', { value: 1234 });
  Object.defineProperty(child, 'exitCode', { value: null, writable: true });
  Object.defineProperty(child, 'killed', { value: false, writable: true });
  (child as unknown as { kill: () => boolean }).kill = () => true;
  return child;
}

test('sleep guard uses caffeinate on macOS and releases it', async () => {
  const calls: string[][] = [];
  const child = fakeChild();
  let killed = false;
  const guard = new SleepGuard({
    platform: 'darwin',
    spawnFn: ((command: string, args: string[]) => { calls.push([command, ...args]); return child; }) as never,
    whichFn: (async () => '/usr/bin/caffeinate') as never,
    killFn: (async () => { killed = true; }) as never,
  });
  assert.equal(await guard.acquire('booking'), true);
  assert.deepEqual(calls[0], ['caffeinate', '-dimsu']);
  assert.equal(guard.status().active, true);
  assert.equal(await guard.acquire('again'), true);
  assert.equal(calls.length, 1);
  await guard.stop();
  assert.equal(killed, true);
  assert.equal(guard.status().active, false);
});

test('sleep guard uses the Windows execution-state loop', () => {
  const calls: string[][] = [];
  const guard = new SleepGuard({
    platform: 'win32',
    spawnFn: ((command: string, args: string[]) => { calls.push([command, ...args]); return fakeChild(); }) as never,
    whichFn: (async () => null) as never,
    killFn: (async () => undefined) as never,
  });
  void guard.acquire('public tokens');
  assert.deepEqual(calls[0]?.slice(0, 4), ['powershell', '-NoProfile', '-NonInteractive', '-WindowStyle']);
  assert.match(windowsSleepScript(), /SetThreadExecutionState/);
  assert.match(windowsSleepScript(), /2147483651/);
});

test('sleep guard availability follows the platform tool', async () => {
  assert.equal(await sleepGuardAvailable('win32'), true);
  assert.equal(await sleepGuardAvailable('darwin', (async (cmd: string) => cmd === 'caffeinate' ? '/usr/bin/caffeinate' : null) as never), true);
  assert.equal(await sleepGuardAvailable('linux', (async () => null) as never), false);
});
