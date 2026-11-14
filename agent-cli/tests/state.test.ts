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
  const home = await mkdtemp(join(tmpdir(), 'sublet-state-'));
  const env = { ...process.env, SUBLET_HOME: home };
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
    // A file with only the legacy `booking` field reads back as a list of one.
    assert.deepEqual(read, { ...state, bookings: [state.booking] });
    await clearAgentState(env);
    assert.equal(await readAgentState(env), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an invalid or old state file is ignored', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sublet-state-'));
  const env = { ...process.env, SUBLET_HOME: home };
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
  const home = await mkdtemp(join(tmpdir(), 'sublet-state-'));
  const env = { ...process.env, SUBLET_HOME: home };
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
test('every booking is saved, and a file from an older agent with one booking still reads back', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sublet-state-'));
  const env = { ...process.env, SUBLET_HOME: home };
  const { writeFile } = await import('node:fs/promises');
  const booking = (requestId: string, slots: number, extra: Record<string, unknown> = {}) => ({
    requestId, model, context: 4096, slots, timerStartedAt: 1_000, timerEndsAt: Date.now() + 60_000, hours: 1,
    pricePerHourNanos: 100, minTokS: null, guaranteedNanos: 100, savedAt: Date.now(), ...extra,
  });
  const seat = booking('req_seat', 4, { shared: true, tokS: 50 });
  const full = booking('req_full', 1);
  try {
    await saveAgentState({ version: 1, booking: seat, bookings: [seat, full], updatedAt: 1 }, env);
    let read = await readAgentState(env);
    assert.deepEqual(read?.bookings.map((b) => [b.requestId, b.slots, b.tokS ?? null]), [['req_seat', 4, 50], ['req_full', 1, null]]);
    assert.equal(read?.booking.requestId, 'req_seat');
    // Written by 1.3.0 and older: only the single `booking` field.
    await writeFile(statePath(env), JSON.stringify({ version: 1, booking: full, updatedAt: 1 }), 'utf8');
    read = await readAgentState(env);
    assert.deepEqual(read?.bookings.map((b) => b.requestId), ['req_full']);
    // Broken entries are skipped and the repeated newest booking is read once.
    await writeFile(statePath(env), JSON.stringify({ version: 1, booking: seat, bookings: [{ requestId: '' }, null, full, seat], updatedAt: 1 }), 'utf8');
    read = await readAgentState(env);
    assert.deepEqual(read?.bookings.map((b) => b.requestId), ['req_full', 'req_seat']);
    await writeFile(statePath(env), JSON.stringify({ version: 1, booking: {}, bookings: [{}] }), 'utf8');
    assert.equal(await readAgentState(env), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('numbers in state.json are checked: numeric strings count, broken values become null, a booking without a valid end is dropped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sublet-state-'));
  const env = { ...process.env, SUBLET_HOME: home };
  const { writeFile } = await import('node:fs/promises');
  const ends = Date.now() + 60_000;
  try {
    await writeFile(statePath(env), JSON.stringify({
      version: 1,
      bookings: [
        {
          requestId: 'req_text', model, context: '4096', slots: '3', timerStartedAt: '1000', timerEndsAt: String(ends), hours: '2',
          pricePerHourNanos: '100', minTokS: 'fast', guaranteedNanos: '200', tokS: '50', shared: 'yes', savedAt: 'x',
        },
        { requestId: 'req_nan', model, timerEndsAt: 'soon' },
        { requestId: 'req_huge', model, timerEndsAt: 1e300 },
        { requestId: 'req_none', model },
        { requestId: 'bad id', model, timerEndsAt: ends },
      ],
      booking: { requestId: 'req_negative', model, timerEndsAt: -5 },
    }), 'utf8');
    const read = await readAgentState(env);
    assert.deepEqual(read?.bookings.map((b) => b.requestId), ['req_text']);
    const b = read!.bookings[0]!;
    assert.deepEqual(
      [b.context, b.slots, b.timerStartedAt, b.timerEndsAt, b.hours, b.pricePerHourNanos, b.minTokS, b.guaranteedNanos, b.tokS, b.shared, b.savedAt],
      [4096, 3, 1000, ends, 2, 100, null, 200, 50, false, 0],
    );
    await writeFile(statePath(env), JSON.stringify({ version: 1, booking: { requestId: 'req_nan', model, timerEndsAt: null } }), 'utf8');
    assert.equal(await readAgentState(env), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
