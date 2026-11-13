import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { binDir, cacheDir, logsDir, modelsDir, subletHome } from './config.js';
import { directoryBytes, storagePolicy } from './util/storage.js';
import { freeDiskBytes } from './util/fs.js';
import { acquireInstanceLock } from './util/instanceLock.js';
import { UsageError } from './exitCodes.js';

/** Maintenance is deliberately serialized against serving. Only regular stale
 * partial files in the managed model root are eligible, never complete models. */
export async function storageReport(prune: boolean, apply: boolean, env: NodeJS.ProcessEnv = process.env) {
  const release = await acquireInstanceLock(env);
  try {
    const root = modelsDir(env);
    const candidates: Array<{ path: string; bytes: number }> = [];
    if (prune) {
      // Validate the root before even enumerating candidates: readdir follows
      // directory symlinks (including Windows junctions), unlike lstat.
      const checkRoot = async () => {
        try {
          const info = await lstat(root);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Prune refuses a linked or non-directory model root: ${root}`);
          return info;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      };
      const rootInfo = await checkRoot();
      let names: string[] = [];
      try { if (rootInfo) names = await readdir(root); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const name of names) {
        if (!/^[^/\\]+\.gguf\.part(?:\.json)?$/i.test(name)) continue;
        const path = join(root, name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || Date.now() - info.mtimeMs < 7 * 24 * 3600_000) continue;
        candidates.push({ path, bytes: info.size });
      }
      if (apply) {
        for (const candidate of candidates) {
          const currentRoot = await checkRoot();
          if (!currentRoot || !rootInfo || currentRoot.dev !== rootInfo.dev || currentRoot.ino !== rootInfo.ino) {
            throw new Error('Prune model root changed; retry with all agents stopped');
          }
          const info = await lstat(candidate.path);
          if (!info.isFile() || info.isSymbolicLink() || info.size !== candidate.bytes
            || Date.now() - info.mtimeMs < 7 * 24 * 3600_000) throw new Error('Prune candidate changed; retry with all agents stopped');
          await unlink(candidate.path);
        }
      }
    }
    const usage: Record<string, number> = {};
    for (const [name, dir] of Object.entries({ models: root, engines: binDir(env), cache: cacheDir(env), logs: logsDir(env) })) usage[name] = await directoryBytes(dir);
    return { schemaVersion: 1, home: subletHome(env), policy: storagePolicy(env), freeBytes: await freeDiskBytes(subletHome(env)), usage, prune, dryRun: !apply, candidates };
  } finally { await release(); }
}

export function storageAction(positionals: string[], force: boolean): { prune: boolean; apply: boolean } {
  const action = positionals[0] || 'status';
  if (positionals.length > 1 || !['status', 'prune'].includes(action)) throw new UsageError('Usage: sublera storage [status|prune] [--force] [--json]. Prune is dry-run unless --force is supplied.');
  if (force && action !== 'prune') throw new UsageError('--force is only supported with storage prune');
  return { prune: action === 'prune', apply: force };
}