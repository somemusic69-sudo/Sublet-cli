import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { subletHome } from '../config.js';
import { ensureDir } from './fs.js';

export function instanceLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'agent.lock');
}

/** Exclusive, fail-closed ownership. Never auto-unlink a stale lock: PID reuse and
 * competing reclaimers make that unsafe. An operator must check the host first. */
export async function acquireInstanceLock(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  await ensureDir(subletHome(env));
  const path = instanceLockPath(env);
  const id = randomUUID();
  let handle;
  try { handle = await open(path, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`SUBLET_HOME is locked: ${path}. Another agent or maintenance task may be running. After a crash, confirm all agents using this directory are stopped before manually removing this lock; do not delete state.json.`);
    }
    throw error;
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