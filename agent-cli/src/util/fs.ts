import { appendFile, chmod, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { configPath, type AgentConfig } from '../config.js';

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

/** Bytes available to this user on the disk that holds `dir`, or null when the OS cannot tell. */
export async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

export async function atomicWrite(path: string, data: string, mode = 0o600): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { encoding: 'utf8', mode });
  try {
    await chmod(tmp, mode);
  } catch {
    /* windows */
  }
  await rename(tmp, path);
}

export async function readConfigFile(path = configPath()): Promise<AgentConfig | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const data = JSON.parse(raw) as Partial<AgentConfig>;
    if (!data || typeof data.server !== 'string' || typeof data.token !== 'string') return null;
    return {
      server: data.server,
      token: data.token,
      wsPath: typeof data.wsPath === 'string' && data.wsPath ? data.wsPath : '/tunnel',
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
      tokenLabel: typeof data.tokenLabel === 'string' ? data.tokenLabel : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeConfigFile(config: AgentConfig, path = configPath()): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
}

export async function logLine(file: string, line: string): Promise<void> {
  await ensureDir(dirname(file));
  await appendFile(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function sha256File(path: string, onProgress?: (bytes: number, total: number) => void): Promise<string> {
  const total = await fileSize(path);
  const hash = createHash('sha256');
  let read = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      read += chunk.length;
      onProgress?.(read, total);
    });
    stream.on('end', () => resolvePromise());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export async function readFirstBytes(path: string, length: number): Promise<Buffer> {
  const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'r'));
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Refuse paths that escape a directory, e.g. from a malicious archive. */
export function safeJoin(root: string, candidate: string): string {
  const full = resolve(root, candidate);
  const rootWithSep = resolve(root) + sep;
  if (full !== resolve(root) && !full.startsWith(rootWithSep)) {
    throw new Error(`Archive entry escapes the install directory: ${candidate}`);
  }
  return full;
}

export function shortPath(path: string, max = 52): string {
  if (path.length <= max) return path;
  const head = Math.max(8, Math.floor(max * 0.35));
  const tail = max - head - 1;
  return `${path.slice(0, head)}…${path.slice(-tail)}`;
}
