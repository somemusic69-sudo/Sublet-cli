import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { freeDiskBytes } from './fs.js';
import { formatBytes } from './format.js';
import { brandEnv } from './env.js';

const GIB = 1024 ** 3;

function gibSetting(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = brandEnv(env, key);
  const value = raw == null ? fallback : Number(raw);
  if ((raw != null && !raw.trim()) || !Number.isFinite(value) || value <= 0 || value > 1024 * 1024) {
    throw new Error(`${key} must be a positive number of GiB (at most 1048576)`);
  }
  const bytes = Math.floor(value * GIB);
  if (bytes < 1) throw new Error(`${key} must represent at least one byte`);
  return bytes;
}

export function storagePolicy(env: NodeJS.ProcessEnv = process.env): { modelCacheBytes: number; reserveBytes: number } {
  return {
    modelCacheBytes: gibSetting(env, 'SUBLET_MODEL_CACHE_GB', 20),
    reserveBytes: gibSetting(env, 'SUBLET_MIN_FREE_DISK_GB', 5),
  };
}

/** Count all regular files, including partial downloads. Never follow directory links. */
export async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    let info;
    try { info = await lstat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Storage accounting refuses symbolic links: ${path}`);
    if (info.isFile()) bytes += info.size;
    else if (info.isDirectory()) {
      for (const name of await readdir(path)) pending.push(join(path, name));
    } else throw new Error(`Storage accounting requires regular files: ${path}`);
  }
  return bytes;
}

export function availableWriteBytes(free: number, reserve: number): number {
  return Math.max(0, free - reserve);
}

export async function diskWriteAllowance(path: string, reserve: number): Promise<number> {
  const free = await freeDiskBytes(path);
  if (free == null) throw new Error('Cannot determine free disk space; refusing an unbounded download');
  return availableWriteBytes(free, reserve);
}

export function storageLimitError(): Error {
  return new Error('Download stopped by the storage budget. Free disk space or move SUBLET_HOME to a larger drive. Adjust SUBLET_MODEL_CACHE_GB / SUBLET_MIN_FREE_DISK_GB if appropriate; no existing models were automatically deleted.');
}

export async function requireDiskSpace(path: string, bytes: number, reserve: number): Promise<void> {
  const allowance = await diskWriteAllowance(path, reserve);
  if (bytes > allowance) throw new Error(`Not enough disk space: ${formatBytes(bytes)} needed while retaining ${formatBytes(reserve)} free. ${storageLimitError().message}`);
}