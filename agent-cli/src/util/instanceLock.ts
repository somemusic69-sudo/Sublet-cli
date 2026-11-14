import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { subletHome } from '../config.js';
import { ensureDir } from './fs.js';

export function instanceLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'agent.lock');
}

type LockOwner = { id?: unknown; pid?: unknown };

/** Creates the file only if it does not exist yet; null when it already does. */
async function createExclusive(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return owner && typeof owner === 'object' ? owner as LockOwner : null;
  } catch {
    return null;
  }
}

/** True unless the PID is certainly gone. An unknown PID counts as alive, so an unreadable lock fails closed. EPERM means the process exists but belongs to another user. */
function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function lockedError(path: string, detail: string): Error {
  return new Error(`SUBLET_HOME is locked: ${path}. ${detail} Do not delete state.json.`);
}

/**
 * Removes a lock whose process is gone, after a crash, so an agent restarted by a service manager restores its
 * booking. A live or unknown owner keeps the lock (PID reuse only ever makes it look alive, which fails closed).
 * `agent.lock.reclaim` lets one process at a time check and remove a stale lock, so two reclaimers cannot both
 * remove it, and a fresh lock (another id) is never removed. Ownership is still decided only by the exclusive create.
 */
async function reclaimStale(path: string): Promise<void> {
  const owner = await readOwner(path);
  if (!owner || typeof owner.id !== 'string') throw lockedError(path, 'Its owner cannot be read. If no agent or maintenance task uses this directory, remove only agent.lock.');
  if (processAlive(owner.pid)) throw lockedError(path, `Another agent or maintenance task is running (process ${String(owner.pid)}).`);
  const guardPath = `${path}.reclaim`;
  const guard = await createExclusive(guardPath);
  if (!guard) throw lockedError(path, `Another process is taking over a stale lock. If none is, remove ${guardPath}.`);
  await guard.close();
  try {
    if ((await readOwner(path))?.id === owner.id) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  } finally {
    await unlink(guardPath).catch(() => undefined);
  }
}

/** Exclusive ownership of SUBLET_HOME. A lock left by a process that is gone is taken over; any other lock is refused. */
export async function acquireInstanceLock(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  await ensureDir(subletHome(env));
  const path = instanceLockPath(env);
  const id = randomUUID();
  let handle = await createExclusive(path);
  if (!handle) {
    await reclaimStale(path);
    handle = await createExclusive(path);
    if (!handle) throw lockedError(path, 'Another agent or maintenance task started at the same time.');
  }
  try {
    await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, id, createdAt: Date.now() }));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
  let releasePromise: Promise<void> | undefined;
  // Publish one promise synchronously: overlapping calls must not both unlink,
  // and neither successful nor failed releases may later touch a new owner's lock.
  return () => releasePromise ??= (async () => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Instance lock changed; refusing to remove it');
    const owner = JSON.parse(await readFile(path, 'utf8')) as { id?: string };
    if (owner.id !== id) throw new Error('Instance lock ownership changed; refusing to remove it');
    await unlink(path);
  })();
}
