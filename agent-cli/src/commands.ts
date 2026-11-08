import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readdir, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Agent } from './agent.js';
import { apiUrl, configPath, subletHome, maskToken, modelsDir, normalizeServer, type AgentConfig } from './config.js';
import { AGENT_NAME, BRAND, DEFAULT_SERVER, DEFAULT_WS_PATH, VERSION, compareVersions } from './version.js';
import type { Logger } from './logger.js';
import { GpuMonitor, checkFit, type GpuOverride } from './hardware/gpuMonitor.js';
import type { GpuStats } from './hardware/types.js';
import { sleepGuardAvailable, SleepGuard } from './hardware/sleepGuard.js';
import { ensureLlamaServer, findExistingLlama, variantFor } from './engine/binaryManager.js';
import { inspectHuggingFace, parseHfUrl } from './engine/gguf.js';
import { readConfigFile, writeConfigFile } from './util/fs.js';
import { fetchJson, HttpError, latestPublishedVersion, measureDownloadSpeed } from './util/http.js';
import { execFile, sleep, toError } from './util/exec.js';
import { canOpenBrowser, openUrl } from './util/open.js';
import { formatBytes, formatBytesPerSec, formatDuration, formatPercent, formatSpeed, formatUsdNanos, padRight, truncate } from './util/format.js';
import type { AgentMe, AgentRequest } from './types.js';

export type GlobalFlags = {
  server?: string;
  token?: string;
  wsPath?: string;
  json: boolean;
  verbose: boolean;
  color: boolean;
  simulation: boolean;
  fix: boolean;
  force: boolean;
  once: boolean;
  noInstall: boolean;
  help: boolean;
  version: boolean;
  model?: string;
  context?: number;
  slots?: number;
  price?: number;
  priceIn?: number;
  priceOut?: number;
  gpu?: string;
  vram?: number;
  tokPerSec?: number;
  claim?: string;
  watch: boolean;
  timeoutMs?: number;
  requireChecksum: boolean;
  noBrowser: boolean;
  positionals: string[];
};

function serverFor(flags: GlobalFlags, fallback?: string): string {
  return normalizeServer(flags.server || process.env.SUBLET_SERVER || fallback || DEFAULT_SERVER);
}

function gpuOverrideFrom(flags: GlobalFlags): GpuOverride | null {
  return flags.gpu || flags.vram ? { name: flags.gpu ?? null, vramMb: flags.vram ?? null } : null;
}

async function resolvedConfig(flags: GlobalFlags, requireToken: boolean): Promise<AgentConfig> {
  const existing = await readConfigFile();
  const token = flags.token || existing?.token || '';
  if (!token && requireToken) throw new Error('No host key. Run: sublet login, or pass --key <key>');
  return {
    server: serverFor(flags, existing?.server),
    token,
    wsPath: flags.wsPath || existing?.wsPath || process.env.SUBLET_WS_PATH || DEFAULT_WS_PATH,
    updatedAt: Date.now(),
  };
}

async function promptToken(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('No TTY to prompt. Pass --key <host key> or pipe the key on stdin.');
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question('Paste the host key from the Sublet dashboard: ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function verifyHostKey(server: string, token: string): Promise<AgentMe | null> {
  try {
    return await fetchJson<AgentMe>(apiUrl(server, '/api/agent/me'), { token, timeoutMs: 15_000 });
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401 || error.status === 403) throw new Error('That host key was rejected. Issue a new one from the host console.');
      if (error.status === 404 || error.status === 405) return null;
    }
    throw error;
  }
}

export type DeviceLoginCode = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  expiresAt: number;
  intervalMs?: number;
};

/**
 * Links this computer to a web account: the server gives a short code, the person approves it on the
 * website, and the CLI receives its own host key. Returns null when the server has no device login.
 */
export async function deviceLogin(server: string, options: { name: string; onCode: (code: DeviceLoginCode) => void }): Promise<{ token: string; username: string } | null> {
  let code: DeviceLoginCode;
  try {
    code = await fetchJson<DeviceLoginCode>(apiUrl(server, '/api/cli/login'), { body: JSON.stringify({ name: options.name }), timeoutMs: 15_000 });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 405)) return null;
    throw error;
  }
  options.onCode(code);
  const interval = Math.min(Math.max(code.intervalMs ?? 2_000, 10), 10_000);
  while (Date.now() < code.expiresAt) {
    await sleep(interval);
    const poll = await fetchJson<{ status: string; token?: string; username?: string }>(apiUrl(server, '/api/cli/login/poll'), {
      body: JSON.stringify({ deviceCode: code.deviceCode }),
      timeoutMs: 15_000,
    });
    if (poll.status === 'approved' && poll.token) return { token: poll.token, username: poll.username || '' };
  }
  throw new Error('The login code expired. Run sublet login again.');
}

function announceLoginCode(code: DeviceLoginCode, flags: GlobalFlags): void {
  const link = code.verificationUrlComplete || code.verificationUrl;
  if (flags.json) {
    output.write(`${JSON.stringify({ event: 'code', userCode: code.userCode, verificationUrl: link, expiresAt: code.expiresAt })}\n`);
    return;
  }
  output.write(`\nLink this computer to your ${BRAND} account:\n`);
  output.write(`  1. Open  ${link}\n`);
  output.write(`  2. Check that the page shows the code ${code.userCode}, then click Connect.\n\n`);
  output.write(`Waiting for you to connect... (Ctrl+C to stop)\n`);
  if (!flags.noBrowser && process.stdout.isTTY && canOpenBrowser()) openUrl(link);
}

export async function cmdLogin(flags: GlobalFlags, logger: Logger): Promise<number> {
  const existing = await readConfigFile();
  const server = serverFor(flags, existing?.server);
  let token = (flags.token || flags.positionals[0] || '').trim();
  if (!token) {
    const linked = await deviceLogin(server, { name: hostname(), onCode: (code) => announceLoginCode(code, flags) });
    token = linked?.token ?? (await promptToken()).trim();
  }
  if (!token) throw new Error('Host key is empty');
  const me = await verifyHostKey(server, token);
  const cfg: AgentConfig = {
    server,
    token,
    wsPath: flags.wsPath || DEFAULT_WS_PATH,
    updatedAt: Date.now(),
    tokenLabel: me?.user.username,
  };
  await writeConfigFile(cfg);
  if (flags.json) {
    output.write(`${JSON.stringify({ ok: true, server, username: me?.user.username || null, config: configPath() })}\n`);
  } else {
    logger.success(`Saved host key for ${me?.user.username ? `@${me.user.username}` : 'this machine'}`, { config: configPath() });
    if (!me) logger.warn('The server does not expose /api/agent/me yet. The key is saved, but verify it with: sublet doctor');
    output.write(`\n${BRAND} agent is configured. Next: sublet doctor, then sublet start\n`);
  }
  return 0;
}

type Check = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string };

// A public single-file GGUF on HuggingFace, the same CDN that serves booking models.
const SPEED_TEST_URL = 'https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf';
// Below 2 MB/s an 8 GB model takes more than an hour to download.
const SLOW_DOWNLOAD_BYTES_PER_SEC = 2 * 1024 * 1024;

function check(name: string, status: Check['status'], detail: string): Check {
  return { name, status, detail };
}

export async function cmdDoctor(flags: GlobalFlags, logger: Logger): Promise<number> {
  const cfg = await resolvedConfig(flags, false);
  const server = cfg.server;
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check('Node.js', nodeMajor >= 20 ? 'ok' : 'fail', `v${process.versions.node} (need >= 20)`));
  checks.push(check('Platform', 'ok', `${process.platform}/${process.arch}`));
  const latest = await latestPublishedVersion();
  const outdated = latest != null && compareVersions(latest, VERSION) > 0;
  checks.push(check('Agent version', outdated ? 'warn' : 'ok', outdated
    ? `v${VERSION} installed, v${latest} available. Update with: npx ${AGENT_NAME}@latest`
    : `v${VERSION}${latest ? ' (latest)' : ''}`));

  let me: AgentMe | null = null;
  if (cfg.token) {
    try {
      me = await verifyHostKey(server, cfg.token);
      checks.push(check('Host key', me ? 'ok' : 'warn', me ? `@${me.user.username} · ${server}` : `Saved, but ${server} does not expose /api/agent/me yet`));
    } catch (error) {
      checks.push(check('Host key', 'fail', error instanceof Error ? error.message : String(error)));
    }
  } else {
    checks.push(check('Host key', 'warn', 'Not saved. Run: sublet login'));
  }

  try {
    const started = Date.now();
    const health = await fetchJson<{ ok?: boolean; brand?: string }>(apiUrl(server, '/api/health'), { timeoutMs: 8_000 });
    checks.push(check('Server', 'ok', `${health.brand || BRAND} at ${server} · ${Date.now() - started}ms`));
  } catch (error) {
    checks.push(check('Server', 'fail', error instanceof Error ? error.message : String(error)));
  }

  try {
    const speed = await measureDownloadSpeed(SPEED_TEST_URL);
    const eightGbSeconds = (8 * 1024 ** 3) / Math.max(1, speed.bytesPerSec);
    checks.push(check('Download speed', speed.bytesPerSec >= SLOW_DOWNLOAD_BYTES_PER_SEC ? 'ok' : 'warn',
      `${formatBytesPerSec(speed.bytesPerSec)} from HuggingFace · an 8 GB model takes about ${formatDuration(eightGbSeconds)}`));
  } catch (error) {
    checks.push(check('Download speed', 'warn', toError(error).message));
  }

  const monitor = new GpuMonitor();
  const gpu = await monitor.scan(true);
  if (gpu.primary) {
    const p = gpu.primary;
    checks.push(check('GPU', 'ok', `${p.name} · ${(p.totalVramMb / 1024).toFixed(1)} GB total · ${(p.freeVramMb / 1024).toFixed(1)} GB free${p.temperatureC != null ? ` · ${p.temperatureC.toFixed(0)}C` : ''}`));
    checks.push(check('VRAM headroom', p.freeVramMb > 1024 ? 'ok' : 'warn', `${formatBytes(p.freeVramMb * 1024 * 1024)} free`));
    if (p.processes.length) checks.push(check('GPU processes', 'warn', p.processes.map((proc) => `${proc.name} (${proc.usedMb}MB)`).join(', ')));
  } else {
    checks.push(check('GPU', 'warn', gpu.warnings.join(' ') || 'No GPU detected. Use --simulation or --gpu/--vram.'));
  }

  const sleepOk = await sleepGuardAvailable(process.platform);
  checks.push(check('Sleep guard', sleepOk ? 'ok' : 'warn', sleepOk ? 'Wake-lock is available for overnight bookings' : 'No supported wake-lock on this platform'));

  let install = await findExistingLlama({ env: process.env });
  if (!install && flags.fix) {
    const result = await ensureLlamaServer({ fix: true, gpu, logger, showProgress: true, requireChecksum: flags.requireChecksum, simulation: false });
    if (result.found) install = result.install;
    else checks.push(check('llama-server', 'fail', result.reason));
  }
  if (install) {
    checks.push(check('llama-server', install.verified ? 'ok' : 'warn', `${install.path} · ${install.variant} · ${install.verified ? 'checksum verified' : 'local hash recorded, no published checksum'}`));
  } else if (!flags.fix) {
    checks.push(check('llama-server', 'warn', `Not installed. Run: sublet doctor --fix (target: ${variantFor(process.platform, process.arch, gpu.primary?.vendor)})`));
  }

  const models = await listModels();
  checks.push(check('Model cache', 'ok', `${models.count} file(s), ${formatBytes(models.bytes)} in ${modelsDir()}`));

  const failures = checks.filter((c) => c.status === 'fail');
  if (flags.json) {
    output.write(`${JSON.stringify({ ok: failures.length === 0, checks, server, config: configPath(), gpu, llama: install, me }, null, 2)}\n`);
  } else {
    output.write(`\n${BRAND} agent doctor\n`);
    output.write(`home: ${subletHome()}\nserver: ${server}\nkey: ${maskToken(cfg.token)}\n\n`);
    for (const item of checks) {
      const mark = item.status === 'ok' ? '[ ok ]' : item.status === 'warn' ? '[warn]' : '[fail]';
      output.write(`${mark} ${padRight(item.name, 15)} ${item.detail}\n`);
    }
    output.write(`\n${failures.length ? `${failures.length} check(s) failed.` : 'All blocking checks passed.'}\n`);
    if (!flags.fix && !install) output.write(`Tip: sublet doctor --fix downloads the matching llama-server build.\n`);
  }
  return failures.length ? 1 : 0;
}

async function listModels(): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  try {
    for (const entry of await readdir(modelsDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.gguf$/i.test(entry.name)) continue;
      const info = await stat(join(modelsDir(), entry.name));
      count++;
      bytes += info.size;
    }
  } catch {
    /* no cache */
  }
  return { count, bytes };
}

export async function cmdStart(flags: GlobalFlags, logger: Logger): Promise<number> {
  const requestId = flags.positionals[0] ?? null;
  if (requestId && !/^[A-Za-z0-9_-]{3,80}$/.test(requestId)) throw new Error(`"${requestId}" is not a request code. Copy the start command from the website.`);
  const cfg = await resolvedConfig(flags, true);
  if (requestId) logger.info(`Serving request ${requestId}. The agent stops when the booking ends.`);
  const agent = new Agent({
    requestId,
    config: cfg,
    logger,
    simulation: flags.simulation,
    model: flags.model || null,
    publicMode: false,
    price: flags.price ?? null,
    priceInUsd: flags.priceIn ?? null,
    priceOutUsd: flags.priceOut ?? null,
    context: flags.context,
    slots: flags.slots,
    gpuOverride: gpuOverrideFrom(flags),
    tokPerSec: flags.tokPerSec ?? null,
    autoInstall: !flags.noInstall,
    json: flags.json,
    once: flags.once,
  });
  return await runAgent(agent, logger, requestId);
}

export async function cmdHost(flags: GlobalFlags, logger: Logger): Promise<number> {
  const model = flags.model || flags.positionals[0];
  if (!model) throw new Error('Usage: sublet host <huggingface-gguf-url|path.gguf> --price 0.25');
  if (!flags.simulation && !/^https?:\/\//i.test(model)) {
    try {
      await stat(model);
    } catch {
      throw new Error(`Model file not found: ${model}`);
    }
  }
  let modelInfo: Awaited<ReturnType<typeof inspectHuggingFace>> | null = null;
  if (!flags.simulation && /^https?:\/\//i.test(model)) {
    const parsed = parseHfUrl(model);
    if (parsed) {
      modelInfo = await inspectHuggingFace(model, 15_000);
      const info = modelInfo;
      logger.info('Model inspected', {
        file: info.file,
        layers: info.layers ?? '?',
        paramB: info.paramB ?? '?',
        vram: info.needsMb ? `${(info.needsMb / 1024).toFixed(1)}GB` : '?',
        sha: info.sha256 ? `${info.sha256.slice(0, 12)}…` : 'not published',
      });
    }
  }
  const cfg = await resolvedConfig(flags, true);
  const agent = new Agent({
    config: cfg,
    logger,
    simulation: flags.simulation,
    model,
    modelInfo,
    publicMode: true,
    price: flags.price ?? 0.25,
    priceInUsd: flags.priceIn ?? null,
    priceOutUsd: flags.priceOut ?? flags.price ?? 0.25,
    context: flags.context,
    slots: flags.slots,
    gpuOverride: gpuOverrideFrom(flags),
    tokPerSec: flags.tokPerSec ?? null,
    autoInstall: !flags.noInstall,
    json: flags.json,
    once: flags.once,
  });
  return await runAgent(agent, logger);
}

type RejectedEvent = { requestId: string; reason: string; wasActive: boolean };

/** With a target request (`sublet start <code>`), the agent exits when that request ends. */
async function runAgent(agent: Agent, logger: Logger, target: string | null = null): Promise<number> {
  let stopping = false;
  let exitCode = 0;
  let served = false;
  const stop = async (code: number, preserveState = false) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    await agent.stop(preserveState);
  };
  const onInterrupt = () => { void stop(130); };
  // Shutdowns and service managers send SIGTERM; keep state.json so the next start can reattach to the booking.
  const onTerminate = () => { void stop(143, true); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  agent.once('fatal', () => { void stop(1, true); });
  let watcher: NodeJS.Timeout | null = null;
  if (target) {
    agent.on('rejected', (event: RejectedEvent) => {
      if (event.requestId !== target) return;
      served ||= event.wasActive;
      if (served) logger.info(`Request ${target} ended: ${event.reason}`);
      else logger.error(`Cannot serve ${target}: ${event.reason}`);
      void stop(served ? 0 : 1);
    });
    watcher = setInterval(() => {
      const job = agent.dashboardState.job;
      const mine = job?.kind === 'request' && job.id === target;
      if (mine && job.timerEndsAt) served = true;
      if (served && (!mine || Date.now() > (job?.timerEndsAt ?? 0) + 3_000)) {
        logger.success(`Booking ${target} finished. Run sublet start to stay online for public calls.`);
        void stop(0);
      }
    }, 1_000);
  }
  try {
    await agent.run();
  } finally {
    if (watcher) clearInterval(watcher);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    await agent.stop();
  }
  return exitCode;
}

export async function cmdJobs(flags: GlobalFlags, logger: Logger): Promise<number> {
  const cfg = await resolvedConfig(flags, true);
  const monitor = new GpuMonitor();
  const gpu = await monitor.scan(true);
  const requests = await loadRequests(cfg, logger);
  if (flags.json && !flags.claim) {
    output.write(`${JSON.stringify(requests, null, 2)}\n`);
    return 0;
  }
  if (!flags.json) printRequests(requests, gpu.primary);
  if (flags.claim) {
    const target = requests.find((row) => row.id === flags.claim);
    if (target?.needsMb != null && gpu.primary) {
      const fit = checkFit(target.needsMb, gpu.primary);
      if (!fit.ok) throw new Error(fit.reason || 'This model does not fit in free VRAM');
    }
    if (flags.json) {
      const result = await claimRequest(cfg, flags.claim, true);
      output.write(`${JSON.stringify({ ok: true, requestId: flags.claim, ...result })}\n`);
      return 0;
    }
    return await serveClaim(cfg, flags.claim, flags, logger);
  }
  if (!process.stdin.isTTY) {
    output.write('\nNon-interactive terminal. Use --claim <request-id> to take a job.\n');
    return 0;
  }
  if (!requests.length) return 0;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('\nRun which request? (number, or Enter to leave) ')).trim();
    if (!answer) return 0;
    const index = Number(answer) - 1;
    const picked = requests[index];
    if (!picked) {
      logger.error('That number is not on the list.');
      return 1;
    }
    if (picked.needsMb != null && gpu.primary) {
      const fit = checkFit(picked.needsMb, gpu.primary);
      if (!fit.ok) throw new Error(fit.reason || 'This model does not fit in free VRAM');
    }
    return await serveClaim(cfg, picked.id, flags, logger);
  } finally {
    rl.close();
  }
}

/**
 * Claim a request and, when no other agent is online, run this terminal as the
 * serving agent until the booking ends or the host presses Ctrl+C.
 */
async function serveClaim(cfg: AgentConfig, requestId: string, flags: GlobalFlags, logger: Logger): Promise<number> {
  const existing = await verifyHostKey(cfg.server, cfg.token).catch(() => null);
  if (existing?.host?.kind === 'live' && existing.host.status === 'online') {
    const result = await claimRequest(cfg, requestId, true);
    logger.success(`Claimed ${requestId}; an already-running agent will serve it.`, { claim: result.claimId || '' });
    return 0;
  }

  const agent = new Agent({
    config: cfg,
    logger,
    simulation: flags.simulation,
    model: null,
    publicMode: false,
    context: flags.context,
    slots: 1,
    gpuOverride: gpuOverrideFrom(flags),
    tokPerSec: flags.tokPerSec ?? null,
    autoInstall: !flags.noInstall,
    json: flags.json,
    once: false,
  });
  let finished = false;
  const stop = async () => {
    if (finished) return;
    finished = true;
    await agent.stop();
  };
  const onSignal = () => { void stop(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  agent.once('stop', () => { finished = true; });
  // A cancel, release, or failed check arrives as a reject. It can come before the polling below sees the booking.
  let rejected: RejectedEvent | null = null;
  agent.on('rejected', (event: RejectedEvent) => { if (event.requestId === requestId) rejected = event; });

  const runPromise = agent.run();
  runPromise.catch(async (error) => {
    logger.error('Serving agent stopped', { error: toError(error).message });
    await stop();
  });

  try {
    await Promise.race([
      agent.waitForOnline(25_000),
      runPromise.then(() => { throw new Error('Agent exited before it connected'); }),
    ]);
    await claimRequest(cfg, requestId, true);
    logger.success(`Claimed ${requestId}. This terminal is now the serving agent.`, { stop: 'Ctrl+C' });

    let sawJob = false;
    let lastNotice = Date.now();
    while (!finished && !rejected) {
      const job = agent.dashboardState.job;
      if (job?.kind === 'request' && job.timerEndsAt) {
        sawJob = true;
        if (Date.now() > job.timerEndsAt + 3_000) break;
      } else if (sawJob && !job) {
        break;
      } else if (!sawJob && Date.now() - lastNotice > 15 * 60_000) {
        logger.info('Still waiting for the buyer to confirm or for the timer to start. Press Ctrl+C to stop.');
        lastNotice = Date.now();
      }
      await sleep(1_000);
    }
    const ended = rejected as RejectedEvent | null;
    if (!ended) return 0;
    if (sawJob || ended.wasActive) {
      logger.info(`Request ${requestId} ended: ${ended.reason}`);
      return 0;
    }
    logger.error(`Cannot serve ${requestId}: ${ended.reason}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await stop();
  }
}

async function loadRequests(cfg: AgentConfig, logger: Logger): Promise<AgentRequest[]> {
  try {
    const result = await fetchJson<{ requests: AgentRequest[] }>(apiUrl(cfg.server, '/api/agent/requests'), { token: cfg.token, timeoutMs: 15_000 });
    return result.requests || [];
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 405)) {
      const fallback = await fetchJson<{ requests: AgentRequest[] }>(apiUrl(cfg.server, '/api/board'), { timeoutMs: 15_000 });
      return fallback.requests || [];
    }
    logger.warn('Could not read the request board', { error: toError(error).message });
    throw error;
  }
}

function printRequests(requests: AgentRequest[], gpu: GpuStats | null): void {
  output.write(`\nOpen buyer requests (${requests.length})\n`);
  if (!requests.length) {
    output.write('  None. Post one at /board/new.\n');
    return;
  }
  for (const [index, request] of requests.entries()) {
    const needs = request.needsMb ?? null;
    const fit = needs != null && gpu ? checkFit(needs, gpu).ok ? 'fits' : 'too big' : 'unknown size';
    const payout = request.totalPayoutNanos ?? (request.hours && request.pricePerHourNanos ? request.hours * request.pricePerHourNanos : 0);
    const model = request.modelLabel || request.file || request.repo || 'unknown model';
    output.write(`${String(index + 1).padStart(2)}. ${truncate(model, 38)}  ${formatUsdNanos(payout)} / ${request.hours || '?'}h  ${needs ? `${(needs / 1024).toFixed(1)}GB` : 'VRAM ?'}  ${fit}  ${request.minTokS || 0} tok/s min\n`);
    output.write(`    id ${request.id}  ${request.status}${request.fit ? `  ${request.fit}` : ''}${request.cached ? '  model on disk: ready now' : ''}\n`);
  }
}

async function claimRequest(cfg: AgentConfig, requestId: string, quiet = false): Promise<{ claimId?: string; status?: string }> {
  try {
    const result = await fetchJson<{ claimId?: string; status?: string }>(apiUrl(cfg.server, `/api/agent/requests/${encodeURIComponent(requestId)}/claim`), {
      token: cfg.token,
      method: 'POST',
      body: '{}',
      timeoutMs: 20_000,
    });
    if (!quiet) {
      output.write(`Claimed ${requestId}${result.status ? ` (${result.status})` : ''}.\n`);
      output.write('The running `sublet start` agent will download and verify the model, then the server starts the clock after the model check.\n');
    }
    return result;
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 405)) {
      throw new Error('This server does not expose agent claims yet. Start the agent and use the website, or update the server.');
    }
    throw error;
  }
}

export async function cmdStatus(flags: GlobalFlags, logger: Logger): Promise<number> {
  const cfg = await resolvedConfig(flags, true);
  const me = await verifyHostKey(cfg.server, cfg.token);
  if (flags.json) {
    output.write(`${JSON.stringify(me, null, 2)}\n`);
    return 0;
  }
  if (!me) {
    logger.warn('Server does not expose /api/agent/me. Try: sublet doctor');
    return 0;
  }
  const host = me.host;
  output.write(`\n${BRAND} host status\n`);
  output.write(`user        @${me.user.username}\n`);
  output.write(`server      ${cfg.server}\n`);
  output.write(`host        ${host ? `${host.status} · ${host.kind} · ${host.gpuName}` : 'not registered yet'}\n`);
  output.write(`reliability ${host ? formatPercent(host.uptimePct) : '-'}${host && host.uptimePct < 90 ? '  HELD' : ''}\n`);
  output.write(`model       ${host?.modelLabel || '-'} ${host?.quant || ''}\n`);
  output.write(`speed       ${formatSpeed(host?.tokPerSec)}\n`);
  output.write(`wallet      ${formatUsdNanos(me.wallet.availableNanos)} available · ${formatUsdNanos(me.wallet.pendingNanos)} pending\n`);
  if (me.activeRequest) {
    const active = me.activeRequest;
    const remaining = active.timerEndsAt ? Math.max(0, Math.round((active.timerEndsAt - Date.now()) / 1000)) : null;
    output.write(`booking     ${active.id} · ${active.status}${remaining != null ? ` · ${formatDuration(remaining)} left` : ''}\n`);
  }
  return 0;
}

export async function cmdLogout(flags: GlobalFlags, logger: Logger): Promise<number> {
  const path = configPath();
  const { rm } = await import('node:fs/promises');
  await rm(path, { force: true });
  logger.success('Host key removed', { config: path });
  if (flags.json) output.write(`${JSON.stringify({ ok: true, config: path })}\n`);
  return 0;
}

export function globalHelp(): string {
  return [
    `${BRAND} GPU Terminal Agent v${VERSION}`,
    '',
    'Usage: sublet <command> [options]',
    '',
    'Commands:',
    '  login                 Link this computer to your Sublet account (opens the website)',
    '  doctor                Scan GPU, server, sleep guard, and llama.cpp',
    '  start [code]          Connect and serve; with a code from the website, serve that request',
    '  host <gguf>           Serve a public pay-per-token model',
    '  jobs                  Browse and claim buyer requests from the terminal',
    '  status                Show this host, wallet, and active booking',
    '  logout                Remove the saved host key',
    '',
    'Core options:',
    '  --key <key>           Host key (sh_...) instead of the saved key',
    '  --server <url>        Central server (default: http://127.0.0.1:8787)',
    '  --ws-path <path>      Tunnel path (default: /tunnel)',
    '  --simulation          Test the full pipe without a GPU or GGUF',
    '  --model <url|path>    Load a model on start',
    '  --ctx <tokens>        Locked context window (default: 8192)',
    '  --slots <n>           Parallel slots (public mode default: 4)',
    '  --price <usd>         Public price per 1M output tokens',
    '  --price-in <usd>      Public price per 1M input tokens',
    '  --price-out <usd>     Public price per 1M output tokens',
    '  --gpu <name>          Override GPU detection (test mode)',
    '  --vram <mb>           Override VRAM in MB (test mode)',
    '  --tok-s <n>           Advertised tokens/sec',
    '  --fix                 Download llama-server when doctor needs it',
    '  --require-checksum    Fail if llama-server has no published SHA-256',
    '  --no-browser          login: print the link instead of opening a browser',
    '  --claim <request-id>  Claim a board request non-interactively',
    '  --json                Machine-readable output',
    '  --verbose             Debug logs',
    '  --no-color            Disable ANSI colors',
    '  --no-install          Do not auto-download llama-server',
    '  --once                Exit after the first public job (testing)',
    '  --help, --version',
    '',
    'Examples:',
    '  sublet login',
    '  sublet login --key sh_...          (machines without a browser)',
    '  sublet doctor --fix',
    '  sublet start',
    '  sublet start r_abc123             (the command from Take on the website)',
    '  sublet start --simulation --gpu "RTX 4060" --vram 8188',
    '  sublet host https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf --price 0.25',
    '  sublet jobs',
  ].join('\n');
}
