import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { acquireInstanceLock, instanceLockPath } from '../src/util/instanceLock.js';
import { storageAction, storageReport } from '../src/storageCommand.js';
import { readHealth, healthPath } from '../src/health.js';

async function home(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-ops-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { SUBLET_HOME: dir };
}

test('instance ownership is exclusive, release is idempotent, and only a dead owner\'s lock is taken over', async (t) => {
  const env = await home(t);
  const release = await acquireInstanceLock(env);
  await assert.rejects(acquireInstanceLock(env), /locked/);
  await release();
  await release();
  const next = await acquireInstanceLock(env);
  await next();
  const lock = instanceLockPath(env);
  // After a crash the process that wrote the lock is gone: a restarted agent takes the lock over.
  await writeFile(lock, JSON.stringify({ pid: 2147483647, id: 'stale' }));
  const reclaimed = await acquireInstanceLock(env);
  assert.notEqual(JSON.parse(await readFile(lock, 'utf8')).id, 'stale');
  await reclaimed();
  // A running owner keeps it, and so does a lock whose owner cannot be read.
  await writeFile(lock, JSON.stringify({ pid: process.pid, id: 'running' }));
  await assert.rejects(acquireInstanceLock(env), /is running/);
  await writeFile(lock, 'not json');
  await assert.rejects(acquireInstanceLock(env), /cannot be read/);
  // While another process is taking over a stale lock, nobody else may.
  await writeFile(lock, JSON.stringify({ pid: 2147483647, id: 'stale' }));
  await writeFile(`${lock}.reclaim`, '');
  await assert.rejects(acquireInstanceLock(env), /taking over/);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).id, 'stale');
});

test('concurrent releases share one operation, including after a new owner acquires', async (t) => {
  const env = await home(t);
  const release = await acquireInstanceLock(env);
  const first = release();
  const second = release();
  await Promise.all([first, second]);
  assert.equal(first, second);
  const next = await acquireInstanceLock(env);
  try {
    assert.equal(release(), first);
    await release();
    await assert.rejects(acquireInstanceLock(env), /locked/);
  } finally { await next(); }
});

test('failed concurrent releases share a rejection and preserve the replacement lock', async (t) => {
  const env = await home(t);
  const release = await acquireInstanceLock(env);
  const replacement = JSON.stringify({ id: 'replacement' });
  await writeFile(instanceLockPath(env), replacement);
  const first = release();
  const second = release();
  await Promise.all([assert.rejects(first, /ownership changed/), assert.rejects(second, /ownership changed/)]);
  assert.equal(first, second);
  assert.equal(release(), first);
  assert.equal(await readFile(instanceLockPath(env), 'utf8'), replacement);
});

test('prune rejects a linked model root before deleting external partials', async (t) => {
  const env = await home(t);
  const external = await mkdtemp(join(tmpdir(), 'sublet-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const partial = join(external, 'old.gguf.part');
  await writeFile(partial, 'external data');
  const date = new Date(Date.now() - 8 * 24 * 3600_000);
  await utimes(partial, date, date);
  await symlink(external, join(env.SUBLET_HOME, 'models'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const apply of [false, true]) {
    await assert.rejects(storageReport(true, apply, env), /symbolic links|model root/);
    assert.equal(await readFile(partial, 'utf8'), 'external data');
  }
});

test('a different process cannot enter an owned SUBLET_HOME', async (t) => {
  const env = await home(t);
  const release = await acquireInstanceLock(env);
  try {
    const module = new URL('../src/util/instanceLock.ts', import.meta.url).href;
    const code = `import { acquireInstanceLock } from ${JSON.stringify(module)}; try { const release = await acquireInstanceLock(); await release(); process.exitCode = 9; } catch { process.stdout.write('blocked'); }`;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (data) => { text += String(data); });
      child.on('error', reject);
      child.on('exit', (status) => status === 0 ? resolve(text) : reject(new Error(`child exited ${status}`)));
    });
    assert.equal(output, 'blocked');
  } finally { await release(); }
});

test('maintenance prunes only old regular partials and defaults to preview', async (t) => {
  const env = await home(t);
  const dir = join(env.SUBLET_HOME, 'models');
  await mkdir(dir);
  const old = join(dir, 'old.gguf.part');
  const recent = join(dir, 'recent.gguf.part');
  const model = join(dir, 'active.gguf');
  const state = join(env.SUBLET_HOME, 'state.json');
  for (const path of [old, recent, model, state]) await writeFile(path, 'keep');
  const date = new Date(Date.now() - 8 * 24 * 3600_000);
  await utimes(old, date, date);
  const preview = await storageReport(true, false, env);
  assert.deepEqual(preview.candidates.map((row) => row.path), [old]);
  assert.equal(await readFile(old, 'utf8'), 'keep');
  await storageReport(true, true, env);
  await assert.rejects(readFile(old), /ENOENT/);
  for (const path of [recent, model, state]) assert.equal(await readFile(path, 'utf8'), 'keep');
  const release = await acquireInstanceLock(env);
  try { await assert.rejects(storageReport(true, true, env), /locked/); } finally { await release(); }
  assert.deepEqual(storageAction(['prune'], false), { prune: true, apply: false });
  assert.throws(() => storageAction(['invalid'], true), /Usage/);
});

test('health snapshots reject stale/malformed data and expose no credentials', async (t) => {
  const env = await home(t);
  const data = { schemaVersion: 1, agentVersion: 'test', pid: process.pid, updatedAt: Date.now(), live: true, ready: false, draining: false, simulation: false, tunnel: 'connecting', engine: 'not-loaded', activeJobs: 0, loading: false };
  await writeFile(healthPath(env), JSON.stringify(data));
  assert.equal((await readHealth(env)).ready, false);
  await writeFile(healthPath(env), JSON.stringify({ ...data, updatedAt: Date.now() - 60_000 }));
  await assert.rejects(readHealth(env), /stale/);
  await writeFile(healthPath(env), JSON.stringify({ ...data, pid: -1 }));
  await assert.rejects(readHealth(env), /invalid/);
});

test('health rejects contradictory readiness and malformed fields, and strips extra fields', async (t) => {
  const env = await home(t);
  const data = { schemaVersion: 1, agentVersion: 'test', pid: process.pid, updatedAt: Date.now(), live: true, ready: true, draining: false, simulation: false, tunnel: 'open', engine: 'ready', activeJobs: 0, loading: false };
  for (const patch of [{ live: false }, { draining: true }, { loading: true }, { tunnel: 'closed' }, { engine: 'not-loaded' }, { simulation: true }, { loading: null }, { agentVersion: {} }]) {
    await writeFile(healthPath(env), JSON.stringify({ ...data, ...patch }));
    await assert.rejects(readHealth(env), /invalid/);
  }
  await writeFile(healthPath(env), 'null');
  await assert.rejects(readHealth(env), /invalid/);
  await writeFile(healthPath(env), JSON.stringify({ ...data, token: 'must-not-be-output', prompt: 'private' }));
  assert.deepEqual(await readHealth(env), data);
});