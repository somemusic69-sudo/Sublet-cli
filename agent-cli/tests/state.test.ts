import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clearAgentState, readAgentState, saveAgentState, statePath, type PersistedState } from '../src/state.js';

const model = {
  url: 'https://huggingface.co/a/b/resolve/main/x.gguf',
  path: 'C:\\models\\x.gguf',
  file: 'x.gguf',
  modelId: 'x',
  label: 'x',
  repo: 'a/b',
  quant: 'Q4_K_M',
  paramB: 7,
  layers: 32,
  contextTrain: 8192,
  sha256: 'abc123',
  verified: true,
  needsMb: 5000,
  size: 100,
  architecture: 'llama',
};

test('a booking survives a crash and is read back for recovery', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiln-state-'));
  const env = { ...process.env, KILN_HOME: home };
  const state: PersistedState = {
    version: 1,
    updatedAt: Date.now(),
    booking: {
      requestId: 'req_123',
      model,
      context: 8192,
      slots: 1,
      timerStartedAt: 1_000,
      timerEndsAt: Date.now() + 60_000,
      hours: 8,
      pricePerHourNanos: 100,
      minTokS: 10,
      guaranteedNanos: 800,
      savedAt: Date.now(),
    },
  };
  try {
    await saveAgentState(state, env);
    assert.equal(statePath(env), join(home, 'state.json'));
    const read = await readAgentState(env);
    assert.deepEqual(read, state);
    await clearAgentState(env);
    assert.equal(await readAgentState(env), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an invalid or old state file is ignored', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiln-state-'));
  const env = { ...process.env, KILN_HOME: home };
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(home, 'state.json'), '{"version":2,"booking":{}}', 'utf8');
    assert.equal(await readAgentState(env), null);
    await writeFile(join(home, 'state.json'), 'not-json', 'utf8');
    assert.equal(await readAgentState(env), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('simulation bookings with no local model path are still valid state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiln-state-'));
  const env = { ...process.env, KILN_HOME: home };
  const state: PersistedState = {
    version: 1,
    updatedAt: Date.now(),
    booking: {
      requestId: 'req_sim',
      model: { ...model, path: '', url: 'sim' },
      context: 2048,
      slots: 1,
      timerStartedAt: Date.now(),
      timerEndsAt: Date.now() + 30_000,
      hours: 1,
      pricePerHourNanos: 100,
      minTokS: 0,
      guaranteedNanos: 100,
      savedAt: Date.now(),
    },
  };
  try {
    await saveAgentState(state, env);
    const read = await readAgentState(env);
    assert.equal(read?.booking.requestId, 'req_sim');
    assert.equal(read?.booking.model.path, '');
  } finally {
    await clearAgentState(env);
    await rm(home, { recursive: true, force: true });
  }
});
