import { createReadStream, createWriteStream, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ensureDir, freeDiskBytes } from '../util/fs.js';
import { formatBytes } from '../util/format.js';
import { ProgressBar } from '../ui/progress.js';
import {
  checkModelUrl,
  estimateVramMb,
  fetchModelUrl,
  MAX_MODEL_BYTES,
  parseGgufHeader,
  parseHfUrl,
  readGgufHeader,
  type GgufInfo,
} from './gguf.js';
import { modelsDir } from '../config.js';
import { USER_AGENT } from '../version.js';
import { directoryBytes, diskWriteAllowance, storageLimitError, storagePolicy } from '../util/storage.js';
import type { CachedModelInfo } from '../types.js';

export type ModelProgress = {
  phase: 'download' | 'verify' | 'header' | 'cache';
  received: number;
  total: number | null;
  percent: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
  note: string;
};

export type LoadedModel = {
  path: string;
  file: string;
  url: string;
  sha256: string;
  size: number;
  info: GgufInfo;
  paramB: number | null;
  quant: string | null;
  layers: number | null;
  contextTrain: number | null;
  architecture: string | null;
  needsMb: number | null;
  /** A supplied expected SHA-256 matched measured file bytes; a computed digest alone is not verification. */
  verified: boolean;
};

export type DownloadModelOptions = {
  url: string;
  expectedSha256?: string | null;
  expectedSize?: number | null;
  expectedLayers?: number | null;
  context?: number;
  cacheDir?: string;
  onProgress?: (progress: ModelProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  showProgress?: boolean;
  stream?: NodeJS.WriteStream;
  slots?: number;
  /** Unit tests only: allow http(s) downloads from a loopback address. */
  allowLocalhost?: boolean;
  /**
   * Retained for caller compatibility. Cached files are always hashed before reporting their
   * SHA-256, unless this process already hashed the same file identity and change timestamps.
   */
  verifyCached?: boolean;
};

/** Avoid repeated hashes of unchanged files. Stat identity detects ordinary changes, not a malicious local administrator. */
const hashedThisRun = new Map<string, { identity: string; sha256: string }>();

function fileIdentity(info: BigIntStats): string {
  // Windows/libuv may return dev=0 for path stat but a volume ID for fstat. Inode and
  // birth/change timestamps remain comparable; this cache is additionally keyed by path.
  const dev = process.platform === 'win32' ? 0n : info.dev;
  return [dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].join(':');
}

async function assertUnchanged(path: string, before: BigIntStats): Promise<void> {
  if (fileIdentity(await stat(path, { bigint: true })) !== fileIdentity(before)) {
    hashedThisRun.delete(path);
    throw new Error(`The model file ${basename(path)} changed during verification; retry when it is no longer being modified`);
  }
}

/** Never recursively delete a path supplied by cache state (it may now be a directory). */
async function removeIfExists(path: string): Promise<void> {
  try { await unlink(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function expectedHash(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error('Expected SHA-256 must be exactly 64 hexadecimal characters');
  return value.toLowerCase();
}

/** Hash one open descriptor, never a path reopened after recording its identity. */
async function hashModel(path: string, onProgress?: (bytes: number) => void): Promise<{ sha256: string; snapshot: BigIntStats }> {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`Not a regular model file: ${basename(path)}`);
    await assertUnchanged(path, before);
    const hash = createHash('sha256');
    let received = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      received += chunk.length;
      onProgress?.(received);
    }
    const after = await handle.stat({ bigint: true });
    if (fileIdentity(before) !== fileIdentity(after) || BigInt(received) !== before.size) {
      throw new Error(`The model file ${basename(path)} changed during verification; retry when it is no longer being modified`);
    }
    await assertUnchanged(path, before);
    return { sha256: hash.digest('hex'), snapshot: before };
  } catch (error) {
    hashedThisRun.delete(path);
    throw error;
  } finally {
    await handle.close();
  }
}

/** Unit tests: behave like a new agent process that has hashed nothing yet. */
export function forgetHashedModels(): void {
  hashedThisRun.clear();
}

type Sidecar = {
  sha256: string;
  size: number;
  mtimeMs: number;
  identity: string;
  checkedAt: number;
  info: Pick<GgufInfo, 'architecture' | 'layers' | 'paramB' | 'quantLabel' | 'contextTrain'>;
};

function sanitizeFile(name: string): string {
  const base = basename(name).replace(/[^\w.\-()+ ]+/g, '_').slice(0, 180);
  return base || 'model.gguf';
}

export function modelPathFor(url: string, cacheDir = modelsDir()): string {
  let name = 'model.gguf';
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || name);
  } catch {
    name = basename(url) || name;
  }
  return join(cacheDir, sanitizeFile(name));
}

function sidecarPath(path: string): string {
  return `${path}.sublet.json`;
}

function partSourcePath(part: string): string {
  return `${part}.json`;
}

async function readPartSource(part: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(partSourcePath(part), 'utf8')) as { url?: unknown };
    return typeof data?.url === 'string' ? data.url : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function emitProgress(options: DownloadModelOptions, progress: ModelProgress, bar: ProgressBar | null): void {
  options.onProgress?.(progress);
  if (bar) bar.set(progress.received, progress.total ?? undefined);
}

async function readSidecar(path: string): Promise<Sidecar | null> {
  try {
    const raw = await readFile(sidecarPath(path), 'utf8');
    const data = JSON.parse(raw) as Sidecar;
    if (!data || typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(data.sha256)
        || !Number.isSafeInteger(data.size) || data.size <= 0 || !Number.isFinite(data.mtimeMs)
        || typeof data.identity !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

/** Cache inventory hints, not proof of a hash check. downloadModel revalidates bytes before use. */
export async function listCachedModels(cacheDir = modelsDir()): Promise<CachedModelInfo[]> {
  let entries;
  try {
    entries = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const models: CachedModelInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.gguf$/i.test(entry.name)) continue;
    const path = join(cacheDir, entry.name);
    const [sidecar, info] = await Promise.all([readSidecar(path), stat(path, { bigint: true }).catch(() => null)]);
    if (!sidecar || !info?.isFile() || info.size !== BigInt(sidecar.size) || sidecar.identity !== fileIdentity(info)) continue;
    models.push({ sha256: sidecar.sha256.toLowerCase(), file: entry.name, sizeBytes: Number(info.size) });
    if (models.length >= 200) break;
  }
  return models;
}

async function writeSidecar(path: string, sha256: string, info: GgufInfo, snapshot: BigIntStats): Promise<void> {
  await assertUnchanged(path, snapshot);
  const data: Sidecar = {
    sha256,
    size: Number(snapshot.size),
    mtimeMs: Number(snapshot.mtimeNs) / 1e6,
    identity: fileIdentity(snapshot),
    checkedAt: Date.now(),
    info: {
      architecture: info.architecture,
      layers: info.layers,
      paramB: info.paramB,
      quantLabel: info.quantLabel,
      contextTrain: info.contextTrain,
    },
  };
  await writeFile(sidecarPath(path), JSON.stringify(data), 'utf8');
  await assertUnchanged(path, snapshot);
}

function loadedFrom(path: string, url: string, sha: string, size: number, info: GgufInfo, verified: boolean, context: number, slots = 1): LoadedModel {
  const paramB = info.paramB;
  const quant = info.quantLabel;
  return {
    path,
    file: basename(path),
    url,
    sha256: sha,
    size,
    info,
    paramB,
    quant,
    layers: info.layers,
    contextTrain: info.contextTrain,
    architecture: info.architecture,
    needsMb: paramB ? estimateVramMb({ paramB, quant: quant || 'Q4_K_M', context, layers: info.layers ?? undefined, slots }) : null,
    verified,
  };
}

async function verifyHeader(path: string, expectedLayers: number | null | undefined): Promise<GgufInfo> {
  const info = await readGgufHeader(path);
  if (expectedLayers && info.layers && Math.abs(info.layers - expectedLayers) > 2) {
    throw new Error(`GGUF header has ${info.layers} layers, buyer asked for ${expectedLayers}`);
  }
  return info;
}

let pendingDownload: Promise<unknown> = Promise.resolve();

/** Serialize downloads so concurrent jobs in this process cannot spend the same disk budget. */
export async function downloadModel(options: DownloadModelOptions): Promise<LoadedModel> {
  const operation = pendingDownload.catch(() => undefined).then(() => downloadModelWithinBudget(options));
  pendingDownload = operation;
  return operation;
}

async function downloadModelWithinBudget(options: DownloadModelOptions): Promise<LoadedModel> {
  const expectedSha = expectedHash(options.expectedSha256);
  const url = checkModelUrl(options.url, { allowLocalhost: options.allowLocalhost });
  const cacheDir = options.cacheDir ?? modelsDir();
  await ensureDir(cacheDir);
  const dest = modelPathFor(url, cacheDir);
  const part = `${dest}.part`;
  const context = options.context ?? 8192;
  const slots = options.slots ?? 1;
  const policy = storagePolicy();
  options.signal?.throwIfAborted();
  const fetchModel = (headers: Record<string, string>) => fetchModelUrl(url, { headers, signal: options.signal }, {
    allowLocalhost: options.allowLocalhost,
    fetchImpl: options.fetchImpl,
  });

  if (await fileExists(dest)) {
    try {
      let snapshot = await stat(dest, { bigint: true });
      const size = Number(snapshot.size);
      const seen = hashedThisRun.get(dest);
      let actual: string;
      if (seen?.identity === fileIdentity(snapshot)) {
        actual = seen.sha256;
      } else {
        const note = `Verifying cached ${basename(dest)}`;
        let lastNote = 0;
        const report = (received: number) => {
          const now = Date.now();
          if (received < size && now - lastNote < 1_000) return;
          lastNote = now;
          emitProgress(options, { phase: 'verify', received, total: size, percent: size ? Math.min(100, (received / size) * 100) : null, speedBps: null, etaSeconds: null, note }, null);
        };
        report(0);
        const hashed = await hashModel(dest, report);
        actual = hashed.sha256;
        snapshot = hashed.snapshot;
      }
      if (expectedSha && actual !== expectedSha) {
        // A measured mismatch justifies fetching a replacement, not deleting the current file
        // before that replacement succeeds. IO, header, callback, and sidecar errors never do.
        hashedThisRun.delete(dest);
        emitProgress(options, { phase: 'cache', received: 0, total: null, percent: null, speedBps: null, etaSeconds: null, note: `The cached ${basename(dest)} failed verification; downloading it again` }, null);
      } else {
        const info = await verifyHeader(dest, options.expectedLayers);
        await assertUnchanged(dest, snapshot);
        await writeSidecar(dest, actual, info, snapshot);
        hashedThisRun.set(dest, { identity: fileIdentity(snapshot), sha256: actual });
        return loadedFrom(dest, url, actual, Number(snapshot.size), info, Boolean(expectedSha), context, slots);
      }
    } catch (error) {
      hashedThisRun.delete(dest);
      throw error;
    }
  }

  let startAt = (await fileExists(part)) ? (await stat(part)).size : 0;
  if (startAt > 0 && await readPartSource(part) !== url) {
    await removeIfExists(part);
    startAt = 0;
  }
  let total = options.expectedSize ?? null;
  if (total != null && (!Number.isSafeInteger(total) || total <= 0)) throw new Error('Expected model size must be a positive safe integer');
  let response: Response;
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/octet-stream' };
  if (startAt > 0) headers.range = `bytes=${startAt}-`;

  try {
    response = await fetchModel(headers);
  } catch (error) {
    // A transient network failure says nothing about the bytes already downloaded.
    throw new Error(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 416) {
    await removeIfExists(part);
    startAt = 0;
    response = await fetchModel({ 'user-agent': USER_AGENT });
  }
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }
  let append = false;
  if (startAt > 0 && response.status === 206) {
    const contentRange = response.headers.get('content-range') || '';
    const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (!match || Number(match[1]) !== startAt) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`Server returned an invalid resume range: ${contentRange || 'missing'}`);
    }
    total = match[3] && match[3] !== '*' ? Number(match[3]) : total;
    append = true;
  } else if (response.status === 200 && startAt > 0) {
    // Server ignored Range; the body starts at byte zero.
    startAt = 0;
    append = false;
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (!total && contentLength > 0) total = startAt + contentLength;
  if (total != null && (!Number.isSafeInteger(total) || total <= 0)) {
    await response.body.cancel().catch(() => undefined);
    throw new Error('Invalid model download size');
  }
  // Once the response establishes a restart, discard the old partial before
  // measuring cache usage and free space. Otherwise it is counted alongside its
  // replacement and can falsely exhaust either budget. Resumes keep their bytes.
  if (!append) {
    try { await removeIfExists(part); } catch (error) {
      await response.body.cancel().catch(() => undefined);
      throw error;
    }
  }
  const limit = Math.min(total ?? MAX_MODEL_BYTES, MAX_MODEL_BYTES);
  const free = await freeDiskBytes(cacheDir);
  const refusal = total && total > MAX_MODEL_BYTES
    ? `The model is ${formatBytes(total)}, above the ${formatBytes(MAX_MODEL_BYTES)} limit for one GGUF file`
    : total && free != null && total - startAt > free
      ? `Not enough disk space: ${formatBytes(total - startAt)} is needed, ${formatBytes(free)} is free in ${cacheDir}`
      : null;
  if (refusal) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(refusal);
  }

  let writeBudget: number;
  try {
    const used = await directoryBytes(cacheDir);
    // Keep 64 KiB for sidecar metadata; old/replaced models count until replacement succeeds.
    writeBudget = Math.min(policy.modelCacheBytes - used - 64 * 1024, await diskWriteAllowance(cacheDir, policy.reserveBytes));
    if (writeBudget <= 0 || (total != null && total - startAt > writeBudget)) throw storageLimitError();
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }

  const hash = createHash('sha256');
  if (append) {
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(part);
      rs.on('data', (chunk) => hash.update(chunk));
      rs.on('end', () => resolve());
      rs.on('error', reject);
    });
  }

  const bar = options.showProgress === false ? null : new ProgressBar({
    label: `Downloading ${basename(dest)}`,
    total: total ?? 0,
    enabled: options.showProgress ?? Boolean(options.stream?.isTTY ?? process.stderr.isTTY),
    stream: options.stream ?? process.stderr,
  });

  await writeFile(partSourcePath(part), JSON.stringify({ url }), 'utf8');
  const writer = createWriteStream(part, { flags: append ? 'a' : 'w' });
  let received = startAt;
  let oversized = false;
  let lastDiskCheck = startAt;
  const started = Date.now();
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (options.signal?.aborted) throw new Error('Download cancelled');
      if (!value?.length) continue;
      if (received - startAt + value.length > writeBudget) throw storageLimitError();
      if (received - lastDiskCheck >= 64 * 1024 * 1024) {
        if (await diskWriteAllowance(cacheDir, policy.reserveBytes) < value.length) throw storageLimitError();
        lastDiskCheck = received;
      }
      if (received + value.length > limit) {
        oversized = true;
        throw new Error(`The download is larger than the expected ${formatBytes(limit)}; the file was rejected`);
      }
      hash.update(value);
      received += value.length;
      if (!writer.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => { cleanup(); resolve(); };
          const onError = (error: Error) => { cleanup(); reject(error); };
          const cleanup = () => {
            writer.off('drain', onDrain);
            writer.off('error', onError);
          };
          writer.once('drain', onDrain);
          writer.once('error', onError);
        });
      }
      const elapsed = Math.max(0.001, (Date.now() - started) / 1000);
      const speed = (received - startAt) / elapsed;
      emitProgress(options, {
        phase: 'download',
        received,
        total,
        percent: total ? Math.min(100, (received / total) * 100) : null,
        speedBps: speed,
        etaSeconds: total && speed > 0 ? Math.max(0, (total - received) / speed) : null,
        note: `Downloading ${basename(dest)}`,
      }, bar);
    }
    await new Promise<void>((resolve, reject) => writer.end((error?: Error | null) => error ? reject(error) : resolve()));
  } catch (error) {
    if (!writer.closed) await new Promise<void>((resolve) => writer.once('close', () => resolve()).destroy());
    await reader.cancel().catch(() => undefined);
    bar?.fail();
    if (oversized) {
      await removeIfExists(part);
      await removeIfExists(partSourcePath(part));
    }
    throw error;
  }
  bar?.done();

  const actual = hash.digest('hex');
  if (expectedSha && actual !== expectedSha) {
    await removeIfExists(part);
    await removeIfExists(partSourcePath(part));
    throw new Error(`SHA-256 mismatch. Expected ${expectedSha}, got ${actual}. The file was rejected.`);
  }
  if (total != null && received !== total) throw new Error(`Incomplete model download: expected ${total} bytes, received ${received}`);
  // Reject bad headers before replacing any existing cache entry.
  await verifyHeader(part, options.expectedLayers);
  await rename(part, dest);
  await removeIfExists(partSourcePath(part));
  emitProgress(options, {
    phase: 'verify',
    received,
    total,
    percent: 100,
    speedBps: null,
    etaSeconds: 0,
    note: 'Verifying GGUF header',
  }, null);
  // A stream hash measures incoming bytes, not necessarily the final file on disk. Reopen and
  // hash one stable descriptor before associating the hash with its on-disk stat identity.
  const hashed = await hashModel(dest);
  if (hashed.sha256 !== actual) throw new Error(`The model file ${basename(dest)} changed during download verification`);
  const info = await verifyHeader(dest, options.expectedLayers);
  await assertUnchanged(dest, hashed.snapshot);
  await writeSidecar(dest, hashed.sha256, info, hashed.snapshot);
  const model = loadedFrom(dest, url, hashed.sha256, Number(hashed.snapshot.size), info, Boolean(expectedSha), context, slots);
  emitProgress(options, {
    phase: 'header',
    received,
    total,
    percent: 100,
    speedBps: null,
    etaSeconds: 0,
    note: `Read ${model.info.architecture || 'GGUF'} header, ${model.layers || '?'} layers${expectedSha ? '; expected SHA-256 matched' : '; no expected SHA-256 supplied'}`,
  }, null);
  await assertUnchanged(dest, hashed.snapshot);
  hashedThisRun.set(dest, { identity: fileIdentity(hashed.snapshot), sha256: hashed.sha256 });
  return model;
}

export async function verifyModelFile(path: string, expected?: { sha256?: string | null; layers?: number | null; context?: number; slots?: number }): Promise<LoadedModel> {
  const expectedSha = expectedHash(expected?.sha256);
  const { sha256: hash, snapshot } = await hashModel(path);
  if (expectedSha && hash !== expectedSha) {
    throw new Error(`SHA-256 mismatch for ${basename(path)}`);
  }
  const info = await readGgufHeader(path);
  if (expected?.layers && info.layers && Math.abs(info.layers - expected.layers) > 2) {
    throw new Error(`GGUF has ${info.layers} layers, expected ${expected.layers}`);
  }
  await assertUnchanged(path, snapshot);
  return loadedFrom(path, path, hash, Number(snapshot.size), info, Boolean(expectedSha), expected?.context ?? 8192, expected?.slots ?? 1);
}

export function cachedModelName(url: string): string {
  const parsed = parseHfUrl(url);
  return parsed?.file || sanitizeFile(url.split('/').pop() || 'model.gguf');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function openModelHeader(path: string, bytes = 4096): Promise<GgufInfo> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return parseGgufHeader(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
