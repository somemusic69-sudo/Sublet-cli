import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ensureDir, fileSize, freeDiskBytes, removeIfExists, sha256File } from '../util/fs.js';
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
};

type Sidecar = {
  sha256: string;
  size: number;
  mtimeMs: number;
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
  } catch {
    return null;
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
    if (!data || typeof data.sha256 !== 'string' || typeof data.size !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

/** Verified GGUF files on disk, by SHA-256, so the market can show "ready now" for matching requests. */
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
    const [sidecar, info] = await Promise.all([readSidecar(path), stat(path).catch(() => null)]);
    if (!sidecar || !info || !/^[0-9a-f]{64}$/i.test(sidecar.sha256) || info.size !== sidecar.size) continue;
    models.push({ sha256: sidecar.sha256.toLowerCase(), file: entry.name, sizeBytes: info.size });
    if (models.length >= 200) break;
  }
  return models;
}

async function writeSidecar(path: string, sha256: string, info: GgufInfo, size: number): Promise<void> {
  const infoStat = await stat(path);
  const data: Sidecar = {
    sha256,
    size,
    mtimeMs: infoStat.mtimeMs,
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

async function verifyHeader(path: string, expectedLayers: number | null | undefined, expectedSha: string, url: string, context: number, slots = 1): Promise<LoadedModel> {
  const info = await readGgufHeader(path);
  if (expectedLayers && info.layers && Math.abs(info.layers - expectedLayers) > 2) {
    throw new Error(`GGUF header has ${info.layers} layers, buyer asked for ${expectedLayers}`);
  }
  const size = await fileSize(path);
  await writeSidecar(path, expectedSha, info, size);
  return loadedFrom(path, url, expectedSha, size, info, true, context, slots);
}

export async function downloadModel(options: DownloadModelOptions): Promise<LoadedModel> {
  const url = checkModelUrl(options.url, { allowLocalhost: options.allowLocalhost });
  const cacheDir = options.cacheDir ?? modelsDir();
  await ensureDir(cacheDir);
  const dest = modelPathFor(url, cacheDir);
  const part = `${dest}.part`;
  const context = options.context ?? 8192;
  const slots = options.slots ?? 1;
  const fetchModel = (headers: Record<string, string>) => fetchModelUrl(url, { headers, signal: options.signal }, {
    allowLocalhost: options.allowLocalhost,
    fetchImpl: options.fetchImpl,
  });

  if (await fileExists(dest)) {
    const infoStat = await stat(dest);
    const size = infoStat.size;
    const cached = await readSidecar(dest);
    const sameSize = cached?.size === size && Math.abs((cached?.mtimeMs || 0) - infoStat.mtimeMs) < 2;
    if (sameSize && (!options.expectedSha256 || cached?.sha256 === options.expectedSha256.toLowerCase())) {
      try {
        const info = await readGgufHeader(dest);
        const verified = Boolean(options.expectedSha256);
        return loadedFrom(dest, url, cached?.sha256 || '', size, info, verified, context, slots);
      } catch {
        await removeIfExists(dest);
      }
    } else {
      // The sidecar may be missing or stale. Verify the existing weights before
      // spending the host's bandwidth on another 20 GB download.
      try {
        const info = await readGgufHeader(dest);
        const actual = await sha256File(dest);
        if (options.expectedSha256 && actual.toLowerCase() !== options.expectedSha256.toLowerCase()) {
          throw new Error(`SHA-256 mismatch for cached ${basename(dest)}`);
        }
        if (options.expectedLayers && info.layers && Math.abs(info.layers - options.expectedLayers) > 2) {
          throw new Error(`GGUF has ${info.layers} layers, expected ${options.expectedLayers}`);
        }
        await writeSidecar(dest, actual, info, size);
        return loadedFrom(dest, url, actual, size, info, Boolean(options.expectedSha256), context, slots);
      } catch {
        await removeIfExists(dest);
      }
    }
  }

  let startAt = (await fileExists(part)) ? await fileSize(part) : 0;
  if (startAt > 0 && await readPartSource(part) !== url) {
    await removeIfExists(part);
    startAt = 0;
  }
  let total = options.expectedSize ?? null;
  let response: Response;
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/octet-stream' };
  if (startAt > 0) headers.range = `bytes=${startAt}-`;

  try {
    response = await fetchModel(headers);
  } catch (error) {
    if (startAt > 0) {
      // A stale partial should never wedge the download. Retry from zero once.
      await removeIfExists(part);
      startAt = 0;
      response = await fetchModel({ 'user-agent': USER_AGENT });
    } else {
      throw new Error(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      await removeIfExists(part);
      startAt = 0;
      append = false;
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

  const hash = createHash('sha256');
  if (append) {
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(part);
      rs.on('data', (chunk) => hash.update(chunk));
      rs.on('end', () => resolve());
      rs.on('error', reject);
    });
  } else {
    await removeIfExists(part);
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
  const started = Date.now();
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (options.signal?.aborted) throw new Error('Download cancelled');
      if (!value?.length) continue;
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
  if (options.expectedSha256 && actual.toLowerCase() !== options.expectedSha256.toLowerCase()) {
    await removeIfExists(part);
    await removeIfExists(partSourcePath(part));
    await removeIfExists(dest);
    throw new Error(`SHA-256 mismatch. Expected ${options.expectedSha256}, got ${actual}. The file was rejected.`);
  }
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
  const model = await verifyHeader(dest, options.expectedLayers, actual, url, context, slots);
  emitProgress(options, {
    phase: 'header',
    received,
    total,
    percent: 100,
    speedBps: null,
    etaSeconds: 0,
    note: `Verified ${model.info.architecture || 'GGUF'} ${model.layers || '?'} layers`,
  }, null);
  return model;
}

export async function verifyModelFile(path: string, expected?: { sha256?: string | null; layers?: number | null; context?: number; slots?: number }): Promise<LoadedModel> {
  const size = await fileSize(path);
  const hash = await sha256File(path);
  if (expected?.sha256 && hash.toLowerCase() !== expected.sha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${basename(path)}`);
  }
  const info = await readGgufHeader(path);
  if (expected?.layers && info.layers && Math.abs(info.layers - expected.layers) > 2) {
    throw new Error(`GGUF has ${info.layers} layers, expected ${expected.layers}`);
  }
  return loadedFrom(path, path, hash, size, info, Boolean(expected?.sha256), expected?.context ?? 8192, expected?.slots ?? 1);
}

export function cachedModelName(url: string): string {
  const parsed = parseHfUrl(url);
  return parsed?.file || sanitizeFile(url.split('/').pop() || 'model.gguf');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
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
