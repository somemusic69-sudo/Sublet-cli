import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { AgentConfig } from './config.js';
import { apiUrl } from './config.js';
import type { Logger } from './logger.js';
import { GpuMonitor, checkFit } from './hardware/gpuMonitor.js';
import type { GpuSnapshot, GpuStats } from './hardware/types.js';
import { SleepGuard } from './hardware/sleepGuard.js';
import { ensureLlamaServer, type LlamaInstall } from './engine/binaryManager.js';
import { downloadModel, verifyModelFile, type LoadedModel } from './engine/modelManager.js';
import { estimateVramMb, inspectHuggingFace, parseHfUrl, paramBFromName, quantFromName, type InspectedModel } from './engine/gguf.js';
import { LlamaRunner } from './engine/llamaRunner.js';
import { canarySimulation, runCanary, simulateChat, streamChat } from './network/streamProxy.js';
import { TunnelClient } from './network/tunnelClient.js';
import { TerminalDashboard, initialState, type DashboardJob, type DashboardState, type DashboardStatus } from './ui/terminalDashboard.js';
import type { AgentMe, ChatMessage, HeartbeatPayload, HelloPayload, LoadJob, ServerMessage } from './types.js';
import { fetchJson, HttpError } from './util/http.js';
import { execFile, sleep } from './util/exec.js';
import { formatPercent, formatUsdNanos, modelShortName } from './util/format.js';
import { clearAgentState, readAgentState, saveAgentState, type PersistedBooking, type PersistedState } from './state.js';
import { VERSION } from './version.js';

export type AgentOptions = {
  config: AgentConfig;
  logger: Logger;
  simulation: boolean;
  model?: string | null;
  modelInfo?: InspectedModel | null;
  publicMode?: boolean;
  price?: number | null;
  priceInUsd?: number | null;
  priceOutUsd?: number | null;
  context?: number;
  slots?: number;
  gpuOverride?: { name: string; vramMb: number } | null;
  tokPerSec?: number | null;
  autoInstall?: boolean;
  json?: boolean;
  once?: boolean;
  dashboard?: boolean;
};

type AgentModel = {
  path: string | null;
  sourceUrl: string;
  file: string;
  modelId: string;
  label: string;
  repo: string;
  quant: string;
  paramB: number | null;
  layers: number | null;
  contextTrain: number | null;
  sha256: string | null;
  verified: boolean;
  needsMb: number | null;
  size: number;
  architecture: string | null;
};

type ActiveJob = {
  jobId: string;
  controller: AbortController;
  startedAt: number;
  firstTokenAt: number | null;
  chunks: number;
  text: string;
  publicJob: boolean;
  requestId: string | null;
};

function simulatedGpu(override: { name: string; vramMb: number } | null): GpuSnapshot {
  if (!override) {
    return {
      gpus: [], primary: null, source: 'simulation', platform: process.platform, checkedAt: Date.now(),
      warnings: ['Simulation mode: no GPU was scanned.'],
    };
  }
  const gpu: GpuStats = {
    index: 0,
    name: override.name,
    vendor: /nvidia/i.test(override.name) ? 'nvidia' : /amd|radeon/i.test(override.name) ? 'amd' : /apple|mac/i.test(override.name) ? 'apple' : 'unknown',
    totalVramMb: override.vramMb,
    freeVramMb: override.vramMb,
    usedVramMb: 0,
    utilizationPct: 0,
    temperatureC: null,
    powerW: null,
    powerLimitW: null,
    processes: [],
  };
  return { gpus: [gpu], primary: gpu, source: 'override', platform: process.platform, checkedAt: Date.now(), warnings: [] };
}

export class Agent extends EventEmitter {
  private readonly options: AgentOptions;
  private readonly logger: Logger;
  private readonly gpuMonitor: GpuMonitor;
  private readonly sleepGuard: SleepGuard;
  private readonly dashboard: TerminalDashboard;
  private tunnel: TunnelClient | null = null;
  private runner: LlamaRunner | null = null;
  private install: LlamaInstall | null = null;
  private runnerModelPath: string | null = null;
  private runnerContext: number | null = null;
  private gpu: GpuSnapshot;
  private model: AgentModel | null = null;
  private me: AgentMe | null = null;
  private meTimer: NodeJS.Timeout | null = null;
  private gpuTimer: NodeJS.Timeout | null = null;
  private activeJobs = new Map<string, ActiveJob>();
  private stopped = false;
  private readonly startup = new AbortController();
  private bookingWake = false;
  private loadingModel = false;
  private meInitialWallet: number | null = null;
  private lastSpeed: number | null = null;
  private lastTtft: number | null = null;
  private persisted: PersistedState | null = null;
  private stateWrite: Promise<void> = Promise.resolve();
  private online = false;
  private onlineWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private keyHandler: ((data: Buffer) => void) | null = null;
  private heartbeatAt: number | null = null;
  private bookingTimer: NodeJS.Timeout | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  private logLines: string[] = [];

  constructor(options: AgentOptions) {
    super();
    this.options = options;
    this.logger = options.logger;
    this.gpuMonitor = new GpuMonitor();
    this.sleepGuard = new SleepGuard({ logger: options.logger });
    this.gpu = simulatedGpu(options.gpuOverride ?? null);
    const state = initialState(options.config.server);
    this.dashboard = new TerminalDashboard(state, {
      enabled: !options.json,
      color: Boolean(process.stdout.isTTY),
      unicode: process.platform === 'win32' ? true : true,
    });
  }

  get dashboardState(): DashboardState { return this.dashboard.current; }

  waitForOnline(timeoutMs = 20_000): Promise<void> {
    if (this.online) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onlineWaiters = this.onlineWaiters.filter((w) => w.timer !== timer);
        reject(new Error('Timed out waiting for the host tunnel'));
      }, timeoutMs);
      this.onlineWaiters.push({ resolve, reject, timer });
    });
  }

  private markOnline(): void {
    this.online = true;
    for (const waiter of this.onlineWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.onlineWaiters = [];
    this.emit('online');
  }

  private async restorePersistedBooking(): Promise<boolean> {
    const state = await readAgentState();
    if (!state?.booking) return false;
    const booking = state.booking;
    if (!booking.timerEndsAt || booking.timerEndsAt < Date.now() - 60_000) {
      await clearAgentState();
      return false;
    }
    // If the server is reachable, trust its view of the booking before loading a
    // large cached model. A cancelled/completed booking must not be resurrected.
    try {
      const me = await fetchJson<AgentMe>(apiUrl(this.options.config.server, '/api/agent/me'), {
        token: this.options.config.token,
        timeoutMs: 5_000,
      });
      const active = me.activeRequest;
      if (!active || active.id !== booking.requestId) {
        await clearAgentState();
        return false;
      }
      if (active.timerEndsAt) booking.timerEndsAt = active.timerEndsAt;
      if (active.timerStartedAt) booking.timerStartedAt = active.timerStartedAt;
      if (booking.timerEndsAt && booking.timerEndsAt < Date.now()) {
        await clearAgentState();
        return false;
      }
    } catch {
      // Server may be temporarily unreachable; the local snapshot is still useful.
    }
    try {
      let model: AgentModel;
      if (this.options.simulation) {
        model = {
          path: booking.model.path || null,
          sourceUrl: booking.model.url || booking.model.path || '',
          file: booking.model.file,
          modelId: booking.model.modelId,
          label: booking.model.label,
          repo: booking.model.repo,
          quant: booking.model.quant,
          paramB: booking.model.paramB,
          layers: booking.model.layers,
          contextTrain: booking.model.contextTrain,
          sha256: booking.model.sha256,
          verified: booking.model.verified,
          needsMb: booking.model.needsMb,
          size: booking.model.size,
          architecture: booking.model.architecture,
        };
      } else {
        if (!booking.model.path) throw new Error('The cached model path is missing');
        model = await this.loadModel(booking.model.path, {
          context: booking.context,
          requestId: booking.requestId,
          expectedSha: booking.model.sha256,
          expectedLayers: booking.model.layers,
          file: booking.model.file,
        });
      }
      this.model = model;
      this.persisted = state;
      this.bookingWake = true;
      await this.sleepGuard.acquire('resuming a booked model after a process restart');
      this.dashboard.update({
        job: {
          kind: 'request',
          id: booking.requestId,
          model: model.file,
          verified: model.verified,
          timerStartedAt: booking.timerStartedAt,
          timerEndsAt: booking.timerEndsAt,
          minTokS: booking.minTokS,
          guaranteedNanos: booking.guaranteedNanos,
          hours: booking.hours,
        },
        sessionGuaranteedNanos: booking.guaranteedNanos || 0,
        wakeLock: this.sleepGuard.status().active,
        status: 'working',
        message: `Resuming booking ${booking.requestId} after a restart`,
      });
      this.logger.info('Resuming persisted booking', { requestId: booking.requestId, ends: new Date(booking.timerEndsAt).toISOString() });
      return true;
    } catch (error) {
      this.logger.warn('Could not restore the previous booking', { error: error instanceof Error ? error.message : String(error) });
      await clearAgentState();
      return false;
    }
  }

  private persistCurrentBooking(overrides: Partial<PersistedBooking> = {}): void {
    if (!this.model) return;
    const current = this.dashboard.current.job;
    const requestId = overrides.requestId || current?.id || '';
    if (!requestId) return;
    const booking: PersistedBooking = {
      requestId,
      model: {
        url: this.model.sourceUrl || this.model.path || '',
        path: this.model.path || '',
        file: this.model.file,
        modelId: this.model.modelId,
        label: this.model.label,
        repo: this.model.repo,
        quant: this.model.quant,
        paramB: this.model.paramB,
        layers: this.model.layers,
        contextTrain: this.model.contextTrain,
        sha256: this.model.sha256,
        verified: this.model.verified,
        needsMb: this.model.needsMb,
        size: this.model.size,
        architecture: this.model.architecture,
        ...(overrides.model || {}),
      },
      context: overrides.context ?? this.runnerContext ?? this.persisted?.booking.context ?? this.options.context ?? 8192,
      slots: overrides.slots ?? 1,
      timerStartedAt: overrides.timerStartedAt ?? current?.timerStartedAt ?? null,
      timerEndsAt: overrides.timerEndsAt ?? current?.timerEndsAt ?? null,
      hours: overrides.hours ?? current?.hours ?? null,
      pricePerHourNanos: overrides.pricePerHourNanos ?? null,
      minTokS: overrides.minTokS ?? current?.minTokS ?? null,
      guaranteedNanos: overrides.guaranteedNanos ?? current?.guaranteedNanos ?? null,
      savedAt: Date.now(),
    };
    this.persisted = { version: 1, booking, updatedAt: Date.now() };
    const snapshot = this.persisted;
    this.stateWrite = this.stateWrite
      .then(() => saveAgentState(snapshot))
      .catch((error) => this.logger.warn('Could not save recovery state', { error: error instanceof Error ? error.message : String(error) }));
  }

  private clearPersistedBooking(): void {
    if (!this.persisted) return;
    this.persisted = null;
    this.stateWrite = this.stateWrite
      .then(() => clearAgentState())
      .catch(() => undefined);
  }


  async run(): Promise<void> {
    const cfg = this.options.config;
    if (!cfg.token) throw new Error('No host key saved. Run: kiln login');
    this.logger.info(`Starting Kiln agent v${VERSION}`, { server: cfg.server, simulate: this.options.simulation });
    if (!this.options.simulation) {
      this.gpu = await this.gpuMonitor.scan(true);
      for (const warning of this.gpu.warnings) this.logger.warn(warning);
    }
    if (!this.gpu.primary && !this.options.simulation && !this.options.gpuOverride) {
      this.logger.warn('No GPU detected. Use --gpu "RTX 4090" --vram 24576 for a test node, or --simulation.');
    }
    this.updateGpuDashboard();
    const restored = await this.restorePersistedBooking();
    if (!restored && this.options.model && !this.stopped) {
      try {
        await this.prepareStartupModel(this.options.model);
      } catch (error) {
        if (!this.stopped) throw error;
      }
    }
    if (this.stopped) return this.releaseResources();
    this.dashboard.start();
    this.setupKeyboard();
    this.dashboard.update({ status: 'starting', server: cfg.server });
    const endpoint = await this.endpointFor(cfg);
    this.dashboard.update({ endpoint });

    this.tunnel = new TunnelClient({
      server: cfg.server,
      token: cfg.token,
      wsPath: cfg.wsPath,
      logger: this.logger,
      hello: () => this.helloPayload(),
      heartbeat: () => this.heartbeatPayload(),
    });
    this.tunnel.on('state', (state: string) => {
      if (state === 'open') {
        this.dashboard.update({ status: this.activeJobs.size ? 'working' : 'online' });
      } else if (state === 'reconnecting') {
        this.dashboard.update({ status: 'reconnecting', message: 'Tunnel dropped; keeping llama-server warm' });
      } else if (state === 'auth-failed') {
        this.dashboard.update({ status: 'auth-failed', message: 'Host key rejected. Run kiln login again.' });
      }
    });
    this.tunnel.on('outdated', (error: Error) => { this.fail(error, 'outdated'); });
    this.tunnel.on('message', (message: ServerMessage) => { void this.handleMessage(message); });
    this.tunnel.on('auth-failed', (error: Error) => { this.fail(error); });
    this.tunnel.start();
    try {
      await this.tunnel.waitForWelcome(20_000);
    } catch (error) {
      if (this.stopped) return this.releaseResources();
      this.dashboard.update({ status: 'offline', message: error instanceof Error ? error.message : String(error) });
      await this.stop(true);
      throw error;
    }
    this.dashboard.update({ status: 'online', endpoint, message: null });
    await this.refreshMe();
    if (this.stopped) return this.releaseResources();
    this.markOnline();
    setTimeout(() => { void this.refreshMe(); }, 1_200);
    this.meTimer = setInterval(() => { void this.refreshMe(); }, 10_000);
    this.startGpuPolling();
    this.logger.info('Agent is online. Waiting for work.');
    if (this.options.once) {
      await new Promise<void>((resolve) => this.once('once', resolve));
      await this.stop();
      return;
    }
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      this.once('stop', resolve);
    });
  }

  private async endpointFor(cfg: AgentConfig): Promise<string> {
    const url = new URL(cfg.server);
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(url.hostname);
    if (local) return `${cfg.server.replace(/\/+$/, '')}/h/${this.me?.user.username || 'USERNAME'}/v1`;
    const host = url.hostname.replace(/^www\./, '');
    return `https://${this.me?.user.username || 'USERNAME'}.${host}/api/v1`;
  }

  private async prepareStartupModel(input: string): Promise<void> {
    const inspection = this.options.modelInfo
      || (this.options.simulation || !/^https?:\/\//i.test(input)
        ? null
        : await inspectHuggingFace(input).catch(() => null));
    const loaded = await this.loadModel(input, {
      context: this.options.context ?? 8192,
      requestId: null,
      expectedSha: inspection?.sha256 ?? null,
      expectedLayers: inspection?.layers ?? null,
      file: inspection?.file ?? null,
    });
    this.model = loaded;
    this.dashboard.update({
      job: {
        kind: this.options.publicMode ? 'public' : 'request',
        model: loaded.file,
        verified: loaded.verified,
        minTokS: null,
        guaranteedNanos: 0,
      },
      llamaStatus: this.runner?.status || 'ready',
    });
  }

  private async loadModel(input: string, opts: { context: number; requestId: string | null; expectedSha?: string | null; expectedLayers?: number | null; file?: string | null }): Promise<AgentModel> {
    if (this.options.simulation) {
      const file = opts.file || (input.startsWith('http') ? parseHfUrl(input)?.file : basename(input)) || 'kiln-simulator.gguf';
      const paramB = paramBFromName(file) || 7;
      const quant = quantFromName(file) || 'Q4_K_M';
      return {
        path: null,
        sourceUrl: input,
        file,
        modelId: file.replace(/\.gguf$/i, ''),
        label: file.replace(/\.gguf$/i, ''),
        repo: parseHfUrl(input)?.repo || '',
        quant,
        paramB,
        layers: opts.expectedLayers ?? null,
        contextTrain: opts.context,
        sha256: opts.expectedSha ?? null,
        verified: Boolean(opts.expectedSha),
        needsMb: estimateVramMb({ paramB, quant, context: opts.context, layers: opts.expectedLayers ?? undefined, slots: this.runnerSlots() }),
        size: 0,
        architecture: 'simulation',
      };
    }
    let loaded: LoadedModel | null = null;
    if (/^https?:\/\//i.test(input)) {
      loaded = await downloadModel({
        url: input,
        expectedSha256: opts.expectedSha ?? null,
        expectedLayers: opts.expectedLayers ?? null,
        context: opts.context,
        slots: this.runnerSlots(),
        onProgress: (progress) => {
          if (opts.requestId) {
            this.tunnel?.send({ type: 'progress', requestId: opts.requestId, note: progress.note });
          }
          this.dashboard.update({ message: progress.note });
        },
        showProgress: true,
        signal: this.startup.signal,
      });
    } else {
      loaded = await verifyModelFile(input, { sha256: opts.expectedSha ?? null, layers: opts.expectedLayers ?? null, context: opts.context, slots: this.runnerSlots() });
    }
    const needsMb = loaded.needsMb ?? estimateVramMb({
      paramB: loaded.paramB || 7,
      quant: loaded.quant || 'Q4_K_M',
      context: opts.context,
      layers: loaded.layers ?? undefined,
      slots: this.runnerSlots(),
    });
    const fit = checkFit(needsMb, this.gpu.primary);
    if (this.gpu.primary && !fit.ok) throw new Error(fit.reason || 'Model does not fit in free VRAM');
    const model: AgentModel = {
      path: loaded.path,
      sourceUrl: input,
      file: loaded.file,
      modelId: loaded.info.name || loaded.file.replace(/\.gguf$/i, ''),
      label: loaded.info.name || loaded.file.replace(/\.gguf$/i, ''),
      repo: parseHfUrl(input)?.repo || '',
      quant: loaded.quant || 'Q4_K_M',
      paramB: loaded.paramB,
      layers: loaded.layers,
      contextTrain: loaded.contextTrain,
      sha256: loaded.sha256,
      verified: loaded.verified,
      needsMb,
      size: loaded.size,
      architecture: loaded.architecture,
    };
    await this.ensureRunner(model, opts.context);
    return model;
  }

  private async ensureRunner(model: AgentModel, context: number, slots = this.runnerSlots()): Promise<void> {
    if (this.options.simulation || !model.path) return;
    if (!this.install) {
      const result = await ensureLlamaServer({
        logger: this.logger,
        gpu: this.gpu,
        fix: this.options.autoInstall !== false,
        showProgress: true,
      });
      if (!result.found) throw new Error(result.reason);
      this.install = result.install;
      this.logger.info('llama-server ready', { path: result.install.path, variant: result.install.variant, verified: result.install.verified });
    }
    if (this.runner && this.runner.status === 'ready' && this.runnerModelPath === model.path && this.runnerContext === context) return;
    if (this.runner) {
      await this.runner.stop();
      this.runner = null;
      this.runnerModelPath = null;
      this.runnerContext = null;
    }
    const runner = new LlamaRunner({
      binaryPath: this.install.path,
      modelPath: model.path,
      context,
      slots,
      logger: this.logger,
      restart: { maxRestarts: 5, windowMs: 120_000, delayMs: 500 },
      onLog: (line) => {
        this.logLines.push(line);
        if (this.logLines.length > 200) this.logLines.shift();
        if (this.dashboard.current.showLogs) this.dashboard.update({ logTail: this.logLines.slice(-5) });
      },
    });
    runner.on('status', (status: string) => {
      this.dashboard.update({ llamaStatus: status });
    });
    runner.on('ready', () => {
      this.dashboard.update({ llamaStatus: 'ready' });
    });
    runner.on('crash', () => {
      this.logger.warn('llama-server crashed; the runner is restarting it');
      this.dashboard.update({ message: 'llama-server crashed; restarting in place' });
    });
    runner.on('fatal', (error: Error) => {
      this.logger.error('llama-server could not recover', { error: error.message });
      this.dashboard.update({ llamaStatus: 'failed', message: error.message });
    });
    this.runner = runner;
    await runner.start();
    this.runnerModelPath = model.path;
    this.runnerContext = context;
    this.dashboard.update({ llamaStatus: runner.status, gpuName: this.gpu.primary?.name || null });
  }

  private runnerSlots(): number {
    if (this.options.publicMode) return Math.max(1, this.options.slots ?? 4);
    return Math.max(1, this.options.slots ?? 1);
  }

  private helloPayload(): HelloPayload {
    const gpu = this.gpu.primary;
    const model = this.model;
    const advertised = this.options.simulation ? (this.options.tokPerSec || 24) : (this.lastSpeed || this.options.tokPerSec || 24);
    return {
      type: 'hello',
      agentVersion: VERSION,
      platform: process.platform,
      arch: process.arch,
      gpuName: gpu?.name || this.options.gpuOverride?.name || 'Unknown GPU',
      gpuVendor: gpu?.vendor || 'unknown',
      vramMb: gpu?.totalVramMb || this.options.gpuOverride?.vramMb || 0,
      freeVramMb: gpu?.freeVramMb || 0,
      modelId: model?.modelId || (this.options.publicMode ? 'kiln-public' : 'kiln-standby'),
      modelLabel: model?.label || (this.options.publicMode ? 'Kiln public host' : 'Standby'),
      repo: model?.repo || '',
      file: model?.file || '',
      quant: model?.quant || 'Q4_K_M',
      paramB: model?.paramB ?? null,
      layers: model?.layers ?? null,
      context: this.runnerContext ?? this.persisted?.booking.context ?? this.options.context ?? 8192,
      slots: this.runnerSlots(),
      sha256: model?.sha256 || null,
      hashVerified: Boolean(model?.verified),
      tokPerSec: advertised,
      ttftMs: this.options.simulation ? 300 : (this.lastTtft || 300),
      priceInUsd: this.options.priceInUsd ?? (this.options.price != null ? Math.max(0.01, this.options.price / 2) : 0.1),
      priceOutUsd: this.options.priceOutUsd ?? this.options.price ?? 0.2,
      simulate: this.options.simulation,
      publicMode: Boolean(this.options.publicMode),
    };
  }

  private heartbeatPayload(): HeartbeatPayload | null {
    if (!this.tunnel?.connected) return null;
    const gpu = this.gpu.primary;
    const active = [...this.activeJobs.values()][0];
    this.heartbeatAt = Date.now();
    const advertised = this.options.simulation ? (this.options.tokPerSec || 24) : (this.lastSpeed || this.options.tokPerSec || 24);
    return {
      type: 'heartbeat',
      tokPerSec: advertised,
      ttftMs: this.options.simulation ? 300 : (this.lastTtft || 300),
      llamaUp: this.options.simulation || this.runner?.status === 'ready',
      sha256: this.model?.sha256 || null,
      file: this.model?.file || '',
      layers: this.model?.layers ?? null,
      activeJobId: active?.jobId || null,
      wakeLock: this.sleepGuard.status().active,
      gpuTempC: gpu?.temperatureC ?? null,
      gpuPowerW: gpu?.powerW ?? null,
      gpuUtilPct: gpu?.utilizationPct ?? null,
      freeVramMb: gpu?.freeVramMb ?? 0,
      slotsUsed: this.activeJobs.size,
    };
  }

  private async handleMessage(message: ServerMessage): Promise<void> {
    if (this.stopped) return;
    switch (message.type) {
      case 'welcome':
        this.dashboard.update({ status: 'online' });
        this.emit('welcome');
        return;
      case 'canary':
        await this.handleCanary(message as unknown as Record<string, unknown>);
        return;
      case 'infer':
        await this.handleInfer(message as unknown as Record<string, unknown>);
        return;
      case 'load':
        await this.handleLoad(message as LoadJob);
        return;
      case 'cancel': {
        const job = this.activeJobs.get(String(message.jobId));
        if (job) job.controller.abort(new Error('Cancelled by server'));
        return;
      }
      case 'verified':
        this.dashboard.update({ job: this.dashboard.current.job ? { ...this.dashboard.current.job, verified: true } : null, message: 'Canary verified. Clock can start.' });
        return;
      case 'booking':
        this.applyBooking(message as unknown as Record<string, unknown>);
        return;
      case 'reject':
        this.bookingWake = false;
        this.loadingModel = false;
        this.clearPersistedBooking();
        void this.releaseWakeLockIfIdle();
        this.dashboard.update({ message: `Server rejected load: ${String(message.reason || 'unknown')}`, wakeLock: false });
        return;
      case 'error':
        this.logger.warn(String(message.message || 'Server error'));
        return;
      default:
        this.logger.debug('Unhandled server message', { type: String(message.type) });
    }
  }

  private applyBooking(message: Record<string, unknown>): void {
    const requestId = String(message.requestId || '');
    const timerEndsAt = Number(message.timerEndsAt || 0) || null;
    const timerStartedAt = Number(message.timerStartedAt || 0) || Date.now();
    const hours = Number(message.hours || 0) || (timerEndsAt ? (timerEndsAt - timerStartedAt) / 3_600_000 : null);
    const minTokS = Number(message.minTokS || 0) || null;
    const pricePerHour = Number(message.pricePerHourNanos || 0) || null;
    const guaranteed = hours && pricePerHour ? Math.round(hours * pricePerHour) : null;
    this.bookingWake = true;
    this.loadingModel = false;
    void this.sleepGuard.acquire('dedicated booking window');
    const job: DashboardJob = {
      kind: 'request',
      id: requestId,
      model: this.model?.file || null,
      verified: true,
      timerStartedAt,
      timerEndsAt,
      minTokS,
      guaranteedNanos: guaranteed,
      hours,
    };
    this.dashboard.update({
      job,
      sessionGuaranteedNanos: guaranteed || 0,
      status: 'working',
      wakeLock: this.sleepGuard.status().active,
      message: 'Booking timer started. Keep the terminal open.',
    });
    this.persistCurrentBooking({
      requestId,
      timerStartedAt,
      timerEndsAt,
      hours,
      pricePerHourNanos: pricePerHour,
      minTokS,
      guaranteedNanos: guaranteed,
    });
    if (this.endTimer) clearTimeout(this.endTimer);
    if (timerEndsAt) {
      this.endTimer = setTimeout(() => {
        this.logger.info('Booking window ended');
        this.bookingWake = false;
        this.clearPersistedBooking();
        void this.releaseWakeLockIfIdle();
        this.dashboard.update({ status: 'online', job: null, message: 'Booking finished. Back on standby.', wakeLock: false });
      }, Math.max(0, timerEndsAt - Date.now()) + 1_000);
    }
  }

  private async handleCanary(message: Record<string, unknown>): Promise<void> {
    const jobId = String(message.jobId || '');
    const previous = this.dashboard.current.job;
    this.dashboard.update({ job: { kind: 'canary', id: null, model: this.model?.file || null }, status: 'working' });
    try {
      let result: { tokens: string[]; logprobs: number[] };
      if (this.options.simulation) {
        result = canarySimulation();
      } else if (this.runner?.status === 'ready') {
        result = await runCanary(this.runner.url, String(message.prompt || 'The capital of France is'));
      } else {
        throw new Error('llama-server is not ready for the canary');
      }
      this.tunnel?.send({
        type: 'done',
        jobId,
        finishReason: 'stop',
        promptTokens: 5,
        completionTokens: result.tokens.length,
        tokens: result.tokens,
        logprobs: result.logprobs,
      });
      this.dashboard.update({ message: 'Canary answered. Waiting for VERIFIED.' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.tunnel?.send({ type: 'error', jobId, code: 'canary_failed', message: msg });
      this.logger.warn('Canary failed', { error: msg });
      this.dashboard.update({ message: `Canary failed: ${msg}` });
    } finally {
      this.dashboard.update({ job: previous, status: previous?.timerEndsAt ? 'working' : 'online' });
    }
  }

  private async handleInfer(message: Record<string, unknown>): Promise<void> {
    const jobId = String(message.jobId || '');
    if (!jobId) return;
    if (this.activeJobs.has(jobId)) return;
    const controller = new AbortController();
    const active: ActiveJob = {
      jobId,
      controller,
      startedAt: Date.now(),
      firstTokenAt: null,
      chunks: 0,
      text: '',
      publicJob: !this.dashboard.current.job || this.dashboard.current.job.kind === 'public',
      requestId: this.dashboard.current.job?.id || null,
    };
    this.activeJobs.set(jobId, active);
    const wasIdle = this.activeJobs.size === 1;
    if (wasIdle) {
      await this.sleepGuard.acquire(this.options.publicMode ? 'public token serving' : 'dedicated booking');
      this.dashboard.update({ wakeLock: true });
    }
    this.dashboard.update({
      status: 'working',
      job: this.dashboard.current.job?.kind === 'request'
        ? this.dashboard.current.job
        : { kind: 'public', model: this.model?.file || null, verified: this.model?.verified, minTokS: null, guaranteedNanos: 0 },
      message: null,
    });
    const onChunk = (text: string) => {
      if (active.firstTokenAt == null) active.firstTokenAt = Date.now();
      active.text += text;
      active.chunks++;
      // A chunk lost to a tunnel drop would leave a hole in the buyer's text, so stop the job instead.
      if (!this.tunnel?.send({ type: 'chunk', jobId, text })) controller.abort(new Error('Tunnel dropped during the stream'));
    };
    try {
      let result;
      if (this.options.simulation) {
        result = await simulateChat({
          jobId,
          messages: message.messages as ChatMessage[],
          maxTokens: Number(message.maxTokens || 256),
          temperature: Number(message.temperature ?? 0.7),
          model: this.model?.modelId || 'kiln-simulator',
        }, {
          signal: controller.signal,
          tokPerSec: this.options.tokPerSec || 24,
          onChunk,
        });
      } else {
        if (!this.runner) throw new Error('No model is loaded on this host');
        result = await streamChat(this.runner.url, {
          jobId,
          messages: message.messages as ChatMessage[],
          maxTokens: Number(message.maxTokens || 256),
          temperature: Number(message.temperature ?? 0.7),
          model: this.model?.modelId || 'local',
        }, {
          signal: controller.signal,
          onChunk,
        });
      }
      const elapsed = Math.max(1, Date.now() - active.startedAt);
      this.lastTtft = this.options.simulation ? 300 : (active.firstTokenAt ? active.firstTokenAt - active.startedAt : null);
      this.lastSpeed = this.options.simulation
        ? (this.options.tokPerSec || 24)
        : (result.completionTokens > 0 ? result.completionTokens / (elapsed / 1000) : this.lastSpeed);
      this.tunnel?.send({
        type: 'done',
        jobId,
        finishReason: result.finishReason,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        tokens: result.tokens,
        logprobs: result.logprobs,
      });
      this.dashboard.update({
        liveTokPerSec: this.lastSpeed,
        sessionEarnedNanos: this.dashboard.current.sessionEarnedNanos + this.estimateEarned(result.completionTokens),
        lastHeartbeatAt: Date.now(),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.tunnel?.send({ type: 'error', jobId, code: 'infer_failed', message: msg });
      this.logger.warn('Inference failed', { error: msg });
    } finally {
      this.activeJobs.delete(jobId);
      if (this.activeJobs.size === 0) {
        await this.releaseWakeLockIfIdle();
        const current = this.dashboard.current.job;
        const fallback: DashboardJob | null = this.options.publicMode
          ? { kind: 'public', model: this.model?.file || null, verified: this.model?.verified, minTokS: null, guaranteedNanos: 0 }
          : null;
        this.dashboard.update({
          status: 'online',
          wakeLock: false,
          job: current?.kind === 'request' ? current : fallback,
        });
      }
      if (this.options.once && this.dashboard.current.job?.kind !== 'request') this.emit('once');
    }
  }

  private estimateEarned(completionTokens: number): number {
    const job = this.dashboard.current.job;
    if (job?.kind === 'request' && job.guaranteedNanos) return 0;
    const priceOutUsd = this.options.priceOutUsd ?? this.options.price ?? 0.2;
    return Math.round((completionTokens / 1_000_000) * priceOutUsd * 1e9);
  }

  private async handleLoad(load: LoadJob): Promise<void> {
    const requestId = String(load.requestId || '');
    this.loadingModel = true;
    this.bookingWake = true;
    await this.sleepGuard.acquire('downloading and loading a booked model');
    this.dashboard.update({
      status: 'working',
      wakeLock: this.sleepGuard.status().active,
      job: { kind: 'request', id: requestId, model: load.file || load.url, verified: false, timerStartedAt: null, timerEndsAt: null, minTokS: null, guaranteedNanos: 0 },
      message: 'Pulling the requested GGUF',
    });
    try {
      this.tunnel?.send({ type: 'progress', requestId, note: 'Starting download' });
      const context = Math.max(Number(load.context || this.options.context || 8192), 2048);
      const model = await this.loadModel(load.url, {
        context,
        requestId,
        expectedSha: load.sha256,
        expectedLayers: load.layers,
        file: load.file,
      });
      this.model = model;
      this.loadingModel = false;
      this.tunnel?.send({
        type: 'loaded',
        requestId,
        sha256: model.sha256,
        file: model.file,
        layers: model.layers,
        context,
        llamaUp: this.options.simulation || this.runner?.status === 'ready',
      });
      this.dashboard.update({
        job: { kind: 'request', id: requestId, model: model.file, verified: true, timerStartedAt: null, timerEndsAt: null, minTokS: null, guaranteedNanos: 0 },
        llamaStatus: this.runner?.status || 'simulation',
        message: 'Loaded and hash-checked. Waiting for the canary handshake.',
      });
      this.persistCurrentBooking({ requestId, context, slots: 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.loadingModel = false;
      this.bookingWake = false;
      await this.releaseWakeLockIfIdle();
      this.clearPersistedBooking();
      this.tunnel?.send({ type: 'load_failed', requestId, message });
      this.logger.error('Request load failed', { error: message });
      this.dashboard.update({ status: 'online', job: null, message: `Load failed: ${message}`, wakeLock: false });
    }
  }

  private async refreshMe(): Promise<void> {
    try {
      const me = await fetchJson<AgentMe>(apiUrl(this.options.config.server, '/api/agent/me'), {
        token: this.options.config.token,
        timeoutMs: 10_000,
      });
      if (this.stopped) return;
      this.me = me;
      if (this.meInitialWallet == null) this.meInitialWallet = me.wallet.availableNanos;
      const host = me.host;
      const active = me.activeRequest;
      const booked = active && (active.status === 'active' || active.status === 'awaiting_confirm');
      const current = this.dashboard.current.job;
      const job: DashboardJob | null = booked
        ? {
          kind: 'request',
          id: active.id,
          model: active.file || this.model?.file || null,
          verified: true,
          timerStartedAt: active.timerStartedAt ?? null,
          timerEndsAt: active.timerEndsAt ?? null,
          minTokS: active.minTokS ?? null,
          guaranteedNanos: active.hours && active.pricePerHourNanos ? Math.round(active.hours * active.pricePerHourNanos) : null,
          hours: active.hours ?? null,
        }
        : current?.kind === 'public'
          ? current
          : current?.kind === 'request' && !current.timerEndsAt
            ? current
            : null;
      let earned = this.dashboard.current.sessionEarnedNanos;
      if (job?.kind === 'request' && job.guaranteedNanos && job.timerStartedAt && job.timerEndsAt) {
        const total = Math.max(1, job.timerEndsAt - job.timerStartedAt);
        const elapsed = Math.min(total, Math.max(0, Date.now() - job.timerStartedAt));
        earned = Math.round(job.guaranteedNanos * (elapsed / total));
      }
      this.dashboard.update({
        username: me.user.username,
        endpoint: await this.endpointFor(this.options.config),
        reliability: host?.uptimePct ?? null,
        held: host?.status === 'held' || (host?.uptimePct != null && host.uptimePct < 90),
        walletNanos: me.wallet.availableNanos + me.wallet.pendingNanos,
        sessionGuaranteedNanos: job?.guaranteedNanos || this.dashboard.current.sessionGuaranteedNanos,
        sessionEarnedNanos: earned,
        job,
        liveTokPerSec: this.lastSpeed || this.dashboard.current.liveTokPerSec,
        lastHeartbeatAt: this.heartbeatAt,
      });
      if (booked && active) {
        this.persistCurrentBooking({
          requestId: active.id,
          timerStartedAt: active.timerStartedAt ?? null,
          timerEndsAt: active.timerEndsAt ?? null,
          hours: active.hours ?? null,
          pricePerHourNanos: active.pricePerHourNanos ?? null,
          minTokS: active.minTokS ?? null,
          guaranteedNanos: job?.guaranteedNanos ?? null,
        });
      }
      if (active && active.status === 'active' && active.timerEndsAt) {
        if (this.endTimer) clearTimeout(this.endTimer);
        this.endTimer = setTimeout(() => {
          this.bookingWake = false;
          this.clearPersistedBooking();
          void this.releaseWakeLockIfIdle();
          this.dashboard.update({ status: 'online', job: null, message: 'Booking window ended', wakeLock: false });
        }, Math.max(0, active.timerEndsAt - Date.now()) + 1_000);
      } else if (!active && !this.loadingModel && this.activeJobs.size === 0 && this.bookingWake) {
        this.bookingWake = false;
        this.clearPersistedBooking();
        void this.releaseWakeLockIfIdle();
      }
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 405)) {
        this.logger.debug('Server does not expose /api/agent/me; dashboard will use tunnel state only.');
      } else {
        this.logger.debug('Could not refresh host status', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private setupKeyboard(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY || this.keyHandler) return;
    const handler = (data: Buffer) => { void this.handleKey(data.toString()); };
    this.keyHandler = handler;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handler);
    this.dashboard.update({ keyHint: 'W withdraw · C copy endpoint · L logs · ? help' });
  }

  private async handleKey(key: string): Promise<void> {
    if (key === '\u0003') {
      await this.stop();
      return;
    }
    if (key === 'w' || key === 'W') {
      const url = this.withdrawUrl();
      this.openExternal(url);
      this.dashboard.update({ message: `Wallet / withdraw: ${url}` });
      return;
    }
    if (key === 'c' || key === 'C') {
      const endpoint = this.dashboard.current.endpoint || '';
      const copied = await this.copyText(endpoint);
      this.dashboard.update({ message: copied ? `Copied ${endpoint}` : `Endpoint: ${endpoint}` });
      return;
    }
    if (key === 'l' || key === 'L') {
      const showLogs = !this.dashboard.current.showLogs;
      this.dashboard.update({ showLogs, logTail: this.logLines.slice(-5) });
      return;
    }
    if (key === '?') {
      this.dashboard.update({ message: 'W withdraw · C copy endpoint · L logs · Ctrl+C stop' });
    }
  }

  private withdrawUrl(): string {
    return `${this.options.config.server.replace(/\/+$/, '')}/wallet`;
  }

  private openExternal(url: string): void {
    try {
      if (process.platform === 'win32') {
        const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      } else {
        const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
        const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
        child.unref();
      }
    } catch {
      /* the URL is also printed in the dashboard */
    }
  }

  private async copyText(text: string): Promise<boolean> {
    if (!text) return false;
    try {
      const command = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
      const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
      const result = await execFile(command, args, { input: text, timeoutMs: 5_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  private cleanupKeyboard(): void {
    if (!this.keyHandler) return;
    process.stdin.off('data', this.keyHandler);
    this.keyHandler = null;
    try { process.stdin.setRawMode(false); } catch { /* not a TTY */ }
    process.stdin.pause();
  }

  private startGpuPolling(): void {
    if (this.options.simulation) return;
    this.gpuTimer = setInterval(() => {
      void (async () => {
        try {
          this.gpu = await this.gpuMonitor.scan(true);
          this.updateGpuDashboard();
          const ownPid = this.runner?.pid;
          const others = (this.gpu.primary?.processes || []).filter((proc) =>
            proc.pid !== ownPid && !/llama-server|llama\.exe|server\.exe/i.test(proc.name) && proc.usedMb >= 256,
          );
          if (this.activeJobs.size > 0 && others.length) {
            const note = `Another process is using GPU memory: ${others.map((p) => `${p.name.split(/[\\/]/).pop()} ${p.usedMb}MB`).join(', ')}`;
            this.logger.warn(note);
            this.dashboard.update({ message: note });
          }
        } catch {
          /* keep the heartbeat alive even if nvidia-smi hiccups */
        }
      })();
    }, 5_000);
  }

  private async releaseWakeLockIfIdle(): Promise<void> {
    if (this.bookingWake || this.activeJobs.size > 0) return;
    await this.sleepGuard.stop();
    this.dashboard.update({ wakeLock: false });
  }

  private updateGpuDashboard(): void {
    const gpu = this.gpu.primary;
    this.dashboard.update({
      gpuName: gpu?.name || this.options.gpuOverride?.name || null,
      totalVramMb: gpu?.totalVramMb || this.options.gpuOverride?.vramMb || 0,
      freeVramMb: gpu?.freeVramMb || 0,
      gpuTempC: gpu?.temperatureC ?? null,
      gpuPowerW: gpu?.powerW ?? null,
      gpuUtilPct: gpu?.utilizationPct ?? null,
    });
  }

  private fail(error: Error, status: DashboardStatus = 'auth-failed'): void {
    this.logger.error(error.message);
    this.dashboard.update({ status, message: error.message });
    this.emit('fatal', error);
  }

  async stop(preserveState = false): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.online = false;
    for (const waiter of this.onlineWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Agent stopped'));
    }
    this.onlineWaiters = [];
    if (this.meTimer) clearInterval(this.meTimer);
    if (this.gpuTimer) clearInterval(this.gpuTimer);
    if (this.bookingTimer) clearInterval(this.bookingTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.meTimer = null;
    this.gpuTimer = null;
    this.bookingTimer = null;
    this.endTimer = null;
    this.bookingWake = false;
    this.loadingModel = false;
    if (!preserveState) this.clearPersistedBooking();
    for (const job of this.activeJobs.values()) job.controller.abort(new Error('Agent stopping'));
    this.activeJobs.clear();
    this.startup.abort(new Error('Agent stopping'));
    await this.releaseResources();
    this.emit('stop');
  }

  /** Frees the wake lock, tunnel, llama-server and terminal. run() calls it again when startup finishes after stop(). */
  private async releaseResources(): Promise<void> {
    for (const timer of [this.meTimer, this.gpuTimer, this.bookingTimer]) if (timer) clearInterval(timer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.meTimer = null;
    this.gpuTimer = null;
    this.bookingTimer = null;
    this.endTimer = null;
    this.cleanupKeyboard();
    await this.sleepGuard.stop();
    await this.tunnel?.stop();
    await this.runner?.stop();
    this.runner = null;
    this.runnerModelPath = null;
    this.runnerContext = null;
    this.dashboard.stop();
  }
}
