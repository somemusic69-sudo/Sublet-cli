import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { brandEnv } from '../util/env.js';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize, relative, sep } from 'node:path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { binDir, cacheDir } from '../config.js';
import { USER_AGENT } from '../version.js';
import { atomicWrite, pathExists, safeJoin, sha256File } from '../util/fs.js';
import { fetchJson, type HttpError } from '../util/http.js';
import { which } from '../util/exec.js';
import { ProgressBar } from '../ui/progress.js';
import type { Logger } from '../logger.js';
import type { GpuSnapshot, GpuVendor } from '../hardware/types.js';
import { directoryBytes, diskWriteAllowance, requireDiskSpace, storagePolicy } from '../util/storage.js';

const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
const MAX_ENGINE_CACHE_BYTES = 10 * 1024 ** 3;

export type LlamaVariant = 'cuda' | 'vulkan' | 'metal' | 'cpu';

export type LlamaInstall = {
  path: string;
  version: string;
  variant: LlamaVariant;
  sha256: string | null;
  binarySha256?: string | null;
  verified: boolean;
  source: 'env' | 'path' | 'manifest' | 'download';
  dir?: string;
};

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size?: number;
  digest?: string | null;
};

export type ReleaseInfo = {
  tag_name: string;
  name?: string;
  published_at?: string;
  assets: ReleaseAsset[];
};

export type InstallOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  gpu?: GpuSnapshot | null;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  showProgress?: boolean;
  stream?: NodeJS.WriteStream;
  requireChecksum?: boolean;
  release?: ReleaseInfo;
  version?: string;
};

export type EnsureResult =
  | { found: true; install: LlamaInstall }
  | { found: false; reason: string; install?: undefined };

type Manifest = {
  installs: LlamaInstall[];
  latest?: string;
};

const RELEASE_CACHE_MS = 6 * 60 * 60 * 1000;
const RELEASE_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
const RELEASE_LIST_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20';
const RELEASE_URL_FALLBACK = 'https://api.github.com/repos/ggerganov/llama.cpp/releases/latest';

export function variantFor(platform: NodeJS.Platform, arch: string, vendor: GpuVendor | null | undefined): LlamaVariant {
  if (platform === 'darwin') return arch === 'arm64' ? 'metal' : 'cpu';
  if (vendor === 'nvidia') return 'cuda';
  if (vendor === 'amd' || vendor === 'intel') return 'vulkan';
  return 'cpu';
}

function patternsFor(platform: NodeJS.Platform, arch: string, variant: LlamaVariant): RegExp[] {
  if (platform === 'win32') {
    if (variant === 'cuda') return [/bin-win-cuda.*x64\.zip$/i, /win-cuda.*x64\.zip$/i, /win-cuda.*\.zip$/i];
    if (variant === 'vulkan') return [/bin-win-vulkan.*x64\.zip$/i, /win-vulkan.*x64\.zip$/i];
    return [/bin-win-cpu.*x64\.zip$/i, /win-cpu.*x64\.zip$/i];
  }
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? [/macos-arm64\.(zip|tar\.gz)$/i, /bin-macos-arm64\.(zip|tar\.gz)$/i, /macos.*arm64.*\.(zip|tar\.gz)$/i]
      : [/macos-x64\.(zip|tar\.gz)$/i, /bin-macos-x64\.(zip|tar\.gz)$/i];
  }
  if (variant === 'vulkan') return [/ubuntu-vulkan.*x64\.(zip|tar\.gz)$/i, /linux-vulkan.*x64\.(zip|tar\.gz)$/i];
  if (variant === 'cuda') return [/ubuntu-cuda.*x64\.(zip|tar\.gz)$/i, /linux-cuda.*x64\.(zip|tar\.gz)$/i, /ubuntu.*x64\.(zip|tar\.gz)$/i];
  return [/ubuntu-x64\.(zip|tar\.gz)$/i, /ubuntu.*x64\.(zip|tar\.gz)$/i, /linux.*x64\.(zip|tar\.gz)$/i];
}

export function pickReleaseAsset(release: ReleaseInfo, platform: NodeJS.Platform, arch: string, variant: LlamaVariant): { main: ReleaseAsset | null; companions: ReleaseAsset[] } {
  const assets = release.assets.filter((a) => !/\.sha256(\.txt)?$/i.test(a.name) && !/^cudart/i.test(a.name));
  let main: ReleaseAsset | null = null;
  for (const pattern of patternsFor(platform, arch, variant)) {
    const found = assets.find((a) => pattern.test(a.name));
    if (found) { main = found; break; }
  }
  if (!main && variant !== 'cpu') {
    // A CPU build is a safe fallback on a machine without the expected runtime.
    const patterns = patternsFor(platform, arch, 'cpu');
    for (const pattern of patterns) {
      const found = assets.find((a) => pattern.test(a.name));
      if (found) { main = found; break; }
    }
  }
  const cudaVersion = main?.name.match(/cuda-([\d.]+)-x64/i)?.[1] || null;
  const companions = variant === 'cuda'
    ? release.assets.filter((a) => {
      if (!/^cudart/i.test(a.name) || /\.sha256/i.test(a.name)) return false;
      if (!/(x64|x86_64)/i.test(a.name)) return false;
      if (platform === 'win32' && !/win/i.test(a.name)) return false;
      if (platform === 'linux' && !/(ubuntu|linux)/i.test(a.name)) return false;
      if (platform === 'darwin') return false;
      if (cudaVersion && !a.name.includes(cudaVersion)) return false;
      return true;
    })
    : [];
  return { main, companions };
}

function releaseCachePath(env: NodeJS.ProcessEnv, key = 'default'): string {
  return join(cacheDir(env), `llama-release-${key}.json`);
}

async function readReleaseCache(env: NodeJS.ProcessEnv, key: string): Promise<ReleaseInfo | null> {
  try {
    const raw = await readFile(releaseCachePath(env, key), 'utf8');
    const data = JSON.parse(raw) as { fetchedAt: number; release: ReleaseInfo };
    if (!data || Date.now() - data.fetchedAt > RELEASE_CACHE_MS || !data.release?.assets?.length) return null;
    return data.release;
  } catch {
    return null;
  }
}

async function fetchRelease(options: InstallOptions, platform: NodeJS.Platform, arch: string, variant: LlamaVariant): Promise<ReleaseInfo> {
  if (options.release) return options.release;
  const env = options.env ?? process.env;
  const cacheKey = `${platform}-${arch}-${variant}`;
  const cached = await readReleaseCache(env, cacheKey);
  if (cached && pickReleaseAsset(cached, platform, arch, variant).main) return cached;
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' };
  const parse = async (response: Response): Promise<ReleaseInfo | null> => {
    if (!response.ok) return null;
    const data = await response.json() as ReleaseInfo | ReleaseInfo[];
    const list = Array.isArray(data) ? data : [data];
    return list.find((release) => release?.tag_name && Array.isArray(release.assets) && release.assets.length > 0 && pickReleaseAsset(release, platform, arch, variant).main) || null;
  };
  let release: ReleaseInfo | null = null;
  for (const url of [RELEASE_URL, RELEASE_LIST_URL, RELEASE_URL_FALLBACK]) {
    try {
      release = await parse(await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) }));
      if (release) break;
    } catch {
      /* try the next endpoint */
    }
  }
  if (!release) throw new Error(`No llama.cpp release with a ${variant} build was found for ${platform}/${arch}`);
  await mkdir(cacheDir(env), { recursive: true });
  await writeFile(releaseCachePath(env, cacheKey), JSON.stringify({ fetchedAt: Date.now(), release }), 'utf8');
  return release;
}

async function checksumFor(asset: ReleaseAsset, release: ReleaseInfo, options: InstallOptions, isMain: boolean): Promise<{ expected: string | null; published: boolean }> {
  const env = options.env ?? process.env;
  const override = brandEnv(env, 'SUBLET_LLAMA_SHA256');
  if (isMain && override && /^[a-f0-9]{64}$/i.test(override.trim())) return { expected: override.trim().toLowerCase(), published: true };
  if (asset.digest && /^sha256:[a-f0-9]{64}$/i.test(asset.digest)) return { expected: asset.digest.slice(7).toLowerCase(), published: true };
  const sidecar = release.assets.find((a) => new RegExp(`^${escapeRegExp(asset.name)}\\.sha256(?:\\.txt)?$`, 'i').test(a.name));
  if (sidecar) {
    try {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(sidecar.browser_download_url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      const match = text.match(/\b([a-f0-9]{64})\b/i);
      if (match?.[1]) return { expected: match[1].toLowerCase(), published: true };
    } catch {
      /* no published digest */
    }
  }
  return { expected: null, published: false };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function downloadFile(url: string, dest: string, options: InstallOptions & { label: string }): Promise<string> {
  await mkdir(dirname(dest), { recursive: true });
  const fetchImpl = options.fetchImpl ?? fetch;
  const bar = options.showProgress === false ? null : new ProgressBar({
    label: options.label,
    total: 0,
    enabled: options.showProgress ?? Boolean((options.stream ?? process.stderr).isTTY),
    stream: options.stream ?? process.stderr,
  });
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length') || 0) || null;
      const reserve = storagePolicy(options.env).reserveBytes;
      const budget = Math.min(MAX_ARCHIVE_BYTES, await diskWriteAllowance(dirname(dest), reserve));
      if (budget <= 0 || (total != null && (!Number.isSafeInteger(total) || total < 0 || total > budget))) {
        await response.body.cancel().catch(() => undefined);
        throw new Error('Engine archive exceeds storage budget (maximum 2 GiB), or insufficient free disk space');
      }
      if (total) bar?.setTotal(total);
      const writer = createWriteStream(dest, { flags: 'w' });
      let received = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) {
            // Free space can shrink while streaming (other downloads/processes).
            // Compare remaining allowance with this chunk plus writes still buffered,
            // not all bytes received: flushed bytes already reduced free disk space.
            const allowance = await diskWriteAllowance(dirname(dest), reserve);
            if (received + value.length > budget || value.length + writer.writableLength > allowance) {
              throw new Error('Engine archive exceeds storage budget');
            }
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
            received += value.length;
            bar?.set(received, total ?? undefined);
          }
        }
        await new Promise<void>((resolve, reject) => writer.end((error?: Error | null) => error ? reject(error) : resolve()));
      } catch (error) {
        writer.destroy();
        throw error;
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      bar?.done();
      return dest;
    } catch (error) {
      lastError = error;
      bar?.fail();
      await rm(dest, { force: true });
      if (attempt < 3) await new Promise((r) => setTimeout(r, 750 * attempt));
    }
  }
  throw new Error(`Could not download ${basename(url)}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function extractArchive(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const lower = archive.toLowerCase();
  if (lower.endsWith('.zip')) {
    const zip = new AdmZip(archive);
    const entries = zip.getEntries();
    if (entries.length > 10_000) throw new Error('Archive has too many entries');
    let uncompressed = 0;
    for (const entry of entries) {
      uncompressed += Number(entry.header.size || 0);
      if (uncompressed > 4 * 1024 * 1024 * 1024) throw new Error('Archive expands beyond the 4GB safety limit');
      if (entry.isDirectory) {
        await mkdir(safeJoin(destination, entry.entryName), { recursive: true });
        continue;
      }
      const target = safeJoin(destination, entry.entryName);
      await mkdir(join(target, '..'), { recursive: true });
      const data = entry.getData();
      await writeFile(target, data);
      if (/[\\/](llama-server|server)(\.exe)?$/i.test(target)) {
        await chmod(target, 0o755).catch(() => undefined);
      }
    }
    return;
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    // Linux and macOS builds ship library link chains (libllama.so -> libllama.so.0 -> libllama.so.0.9.0).
    // tar refuses to create a link through another link, so links are skipped here and copied as files below.
    const links = new Map<string, { linkpath: string; hard: boolean }>();
    let entries = 0;
    let expanded = 0;
    await tar.x({
      file: archive,
      cwd: destination,
      strict: true,
      filter: (path, entry) => {
        safeJoin(destination, path);
        entries++;
        expanded += Number(entry.size || 0);
        if (entries > 10_000 || !Number.isSafeInteger(expanded) || expanded > 4 * 1024 ** 3) throw new Error('Archive exceeds entry or 4 GiB expansion limit');
        const type = 'type' in entry ? entry.type : undefined;
        if (type === 'SymbolicLink' || type === 'Link') {
          links.set(path.replace(/\/+$/, ''), { linkpath: String((entry as { linkpath?: string }).linkpath ?? ''), hard: type === 'Link' });
          return false;
        }
        return true;
      },
    });
    await materializeLinks(destination, links);
    return;
  }
  throw new Error(`Unsupported archive type: ${basename(archive)}`);
}

/** Copies the file each archive link points to, following link chains, and never outside the destination. */
async function materializeLinks(destination: string, links: Map<string, { linkpath: string; hard: boolean }>): Promise<void> {
  let expanded = await directoryBytes(destination);
  const resolveLink = (path: string, depth = 0): string => {
    const link = links.get(path);
    if (!link) return path;
    if (depth > 16) throw new Error(`Archive link loop at ${path}`);
    const target = link.hard
      ? normalize(link.linkpath)
      : normalize(join(dirname(path), link.linkpath));
    safeJoin(destination, target);
    return resolveLink(target.split(sep).join('/'), depth + 1);
  };
  for (const path of links.keys()) {
    const source = safeJoin(destination, resolveLink(path));
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) continue;
    expanded += info.size;
    if (expanded > 4 * 1024 ** 3) throw new Error('Archive links exceed the 4 GiB expansion limit');
    const target = safeJoin(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, info.mode & 0o777).catch(() => undefined);
  }
}

async function locateServerBinary(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && /^(llama-server|server)(\.exe)?$/i.test(entry.name)) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await locateServerBinary(join(dir, entry.name));
    if (found) return found;
  }
  return null;
}

function manifestPath(env: NodeJS.ProcessEnv): string {
  return join(binDir(env), 'manifest.json');
}

async function readManifest(env: NodeJS.ProcessEnv): Promise<Manifest> {
  try {
    const data = JSON.parse(await readFile(manifestPath(env), 'utf8')) as Manifest;
    return { installs: Array.isArray(data.installs) ? data.installs : [], latest: data.latest };
  } catch {
    return { installs: [] };
  }
}

async function writeManifest(env: NodeJS.ProcessEnv, manifest: Manifest): Promise<void> {
  await mkdir(binDir(env), { recursive: true });
  await atomicWrite(manifestPath(env), JSON.stringify(manifest, null, 2));
}

export async function findExistingLlama(options: InstallOptions = {}): Promise<LlamaInstall | null> {
  const env = options.env ?? process.env;
  const explicit = env.LLAMA_SERVER;
  if (explicit && await pathExists(explicit)) {
    return { path: explicit, version: 'env', variant: 'cpu', sha256: null, verified: false, source: 'env' };
  }
  const manifest = await readManifest(env);
  if (manifest.latest) {
    const install = manifest.installs.find((i) => i.path === manifest.latest);
    if (install && await pathExists(install.path)) {
      if (!install.binarySha256 || await sha256File(install.path) !== install.binarySha256) return null;
      return { ...install, source: 'manifest' };
    }
  }
  const fromPath = await which('llama-server');
  if (fromPath) return { path: fromPath, version: 'path', variant: 'cpu', sha256: null, verified: false, source: 'path' };
  return null;
}

export async function ensureLlamaServer(options: InstallOptions & { fix?: boolean; simulation?: boolean } = {}): Promise<EnsureResult> {
  if (options.simulation) return { found: false, reason: 'Simulation mode: llama-server is not needed.' };
  const existing = await findExistingLlama(options);
  if (existing) {
    if (!options.requireChecksum || existing.verified) return { found: true, install: existing };
    if (!options.fix || existing.source === 'env' || existing.source === 'path') {
      return { found: false, reason: 'The existing llama-server has no verified release checksum; --require-checksum refuses it. Remove custom LLAMA_SERVER/PATH overrides and run sublera doctor --fix --require-checksum.' };
    }
  }
  if (!options.fix) return { found: false, reason: 'llama-server is not installed. Run: sublera doctor --fix' };
  try {
    const install = await installLlamaServer(options);
    return { found: true, install };
  } catch (error) {
    return { found: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const pendingInstalls = new Map<string, Promise<LlamaInstall>>();

// The caller owns the cross-process instance lock (the running agent already holds it).
// Queue the entire read/modify/write transaction, not just the manifest write.
export async function installLlamaServer(options: InstallOptions = {}): Promise<LlamaInstall> {
  const env = { ...(options.env ?? process.env) };
  const home = binDir(env);
  const key = process.platform === 'win32' ? home.toLowerCase() : home;
  const previous = pendingInstalls.get(key);
  const pending = (previous ?? Promise.resolve()).catch(() => undefined)
    .then(() => installLlamaServerUnlocked({ ...options, env }));
  pendingInstalls.set(key, pending);
  try { return await pending; } finally {
    if (pendingInstalls.get(key) === pending) pendingInstalls.delete(key);
  }
}

async function installLlamaServerUnlocked(options: InstallOptions): Promise<LlamaInstall> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const vendor = options.gpu?.primary?.vendor;
  const variant = variantFor(platform, arch, vendor);
  const policy = storagePolicy(env);
  const release = await fetchRelease(options, platform, arch, variant);
  const picked = pickReleaseAsset(release, platform, arch, variant);
  if (!picked.main) {
    throw new Error(`No llama.cpp release asset found for ${platform}/${arch} (${variant}) in ${release.tag_name}`);
  }
  const version = (options.version || release.tag_name || 'latest').replace(/[^\w.-]+/g, '-');
  const installDir = join(binDir(env), `llama-${version}-${variant}`);
  const existingBinary = await locateServerBinary(installDir).catch(() => null);
  if (existingBinary) {
    const manifest = await readManifest(env);
    const known = manifest.installs.find((i) => i.path === existingBinary);
    if (known?.binarySha256 && (!options.requireChecksum || known.verified) && await sha256File(existingBinary) === known.binarySha256) {
      manifest.latest = existingBinary;
      await writeManifest(env, manifest);
      return { ...known, source: 'manifest' };
    }
  }

  const id = randomUUID();
  const work = join(cacheDir(env), `install-${id}`);
  const staging = `${installDir}.${id}.tmp`;
  const backup = `${installDir}.${id}.bak`;
  let backedUp = false;
  let promoted = false;
  const archiveDir = join(work, 'archives');
  const extractDir = join(work, 'extract');
  await mkdir(binDir(env), { recursive: true });
  if (await directoryBytes(binDir(env)) >= MAX_ENGINE_CACHE_BYTES) throw new Error('Engine cache reached 10 GiB; remove unused engine versions while the agent is stopped');
  // Archives, extracted libraries and staging coexist during installation.
  await requireDiskSpace(binDir(env), 8 * 1024 ** 3, policy.reserveBytes);
  await mkdir(archiveDir, { recursive: true });
  await mkdir(extractDir, { recursive: true });
  try {
    const assets = [picked.main, ...picked.companions];
    if (assets.length > 4) throw new Error('Too many companion engine archives');
    let mainSha: string | null = null;
    let anyVerified = true;
    for (const [index, asset] of assets.entries()) {
      const archive = join(archiveDir, asset.name);
      await downloadFile(asset.browser_download_url, archive, {
        ...options,
        label: `Downloading ${asset.name}`,
      });
      const actual = await sha256File(archive);
      const check = await checksumFor(asset, release, options, index === 0);
      if (check.expected && check.expected !== actual) {
        throw new Error(`Checksum mismatch for ${asset.name}. Expected ${check.expected}, got ${actual}.`);
      }
      if (!check.published) {
        if (options.requireChecksum) {
          throw new Error(`No published SHA-256 for ${asset.name}; refusing because --require-checksum is set.`);
        }
        anyVerified = false;
        options.logger?.warn(`No published SHA-256 for ${asset.name}; recorded the local hash.`);
      }
      if (index === 0) mainSha = actual;
      await requireDiskSpace(extractDir, 4 * 1024 ** 3, policy.reserveBytes);
      await extractArchive(archive, extractDir);
      if (await directoryBytes(extractDir) > 4 * 1024 ** 3) throw new Error('Combined engine extraction exceeds 4 GiB');
    }
    const binary = await locateServerBinary(extractDir);
    if (!binary) throw new Error('No llama-server binary found inside the release archive');
    const extractedBytes = await directoryBytes(extractDir);
    if (await directoryBytes(binDir(env)) + extractedBytes > MAX_ENGINE_CACHE_BYTES) throw new Error('Engine cache would exceed 10 GiB; remove unused versions while the agent is stopped');
    await requireDiskSpace(binDir(env), extractedBytes, policy.reserveBytes);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const entries = await readdir(extractDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = join(extractDir, entry.name);
      const target = join(staging, entry.name);
      if (entry.isDirectory()) {
        await copyDir(source, target);
      } else {
        await copyFile(source, target);
        if (/^(llama-server|server)(\.exe)?$/i.test(entry.name)) await chmod(target, 0o755).catch(() => undefined);
      }
    }
    // Validate and hash the copied candidate before disturbing the previous install.
    const stagedBinary = await locateServerBinary(staging);
    if (!stagedBinary) throw new Error('llama-server was extracted but could not be found in staging');
    await chmod(stagedBinary, 0o755).catch(() => undefined);
    const binarySha256 = await sha256File(stagedBinary);
    const installedBinary = join(installDir, relative(staging, stagedBinary));
    if (await pathExists(installDir)) {
      await rename(installDir, backup);
      backedUp = true;
    }
    await rename(staging, installDir);
    promoted = true;
    const install: LlamaInstall = {
      path: installedBinary,
      version,
      variant,
      sha256: mainSha,
      binarySha256,
      verified: anyVerified,
      source: 'download',
      dir: installDir,
    };
    const manifest = await readManifest(env);
    manifest.installs = manifest.installs.filter((i) => i.path !== installedBinary);
    manifest.installs.push(install);
    manifest.latest = installedBinary;
    await writeManifest(env, manifest);
    // A failed cleanup must not roll back an already committed manifest.
    if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return install;
  } catch (error) {
    // Keep the backup if rollback itself fails, so it remains recoverable.
    if (promoted) await rm(installDir, { recursive: true, force: true });
    if (backedUp) await rename(backup, installDir);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function copyDir(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await copyFile(from, to);
  }
}

export async function binaryStatus(options: InstallOptions = {}): Promise<{ install: LlamaInstall | null; manifestPath: string }> {
  return { install: await findExistingLlama(options), manifestPath: manifestPath(options.env ?? process.env) };
}

export async function verifyInstalledBinary(install: LlamaInstall): Promise<boolean> {
  if (!install.binarySha256) return false;
  const actual = await sha256File(install.path);
  return actual === install.binarySha256;
}

export function isHttpError(error: unknown): error is HttpError {
  return Boolean(error && typeof error === 'object' && 'status' in error);
}

export async function readReleaseForTest(): Promise<ReleaseInfo> {
  const response = await fetchJson<ReleaseInfo>(RELEASE_URL, { headers: { accept: 'application/vnd.github+json' } });
  return response;
}

void rename;
void stat;
void ensureDirUnused;
function ensureDirUnused() { /* keeps import shape stable for older Node typings */ }
