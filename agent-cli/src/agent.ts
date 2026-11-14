import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import type { AgentConfig } from './config.js';
import { apiUrl, hostEndpoint } from './config.js';
import type { Logger } from './logger.js';
import { GpuMonitor, applyGpuOverride, checkFit, type GpuOverride } from './hardware/gpuMonitor.js';
import type { GpuSnapshot } from './hardware/types.js';
import { SleepGuard } from './hardware/sleepGuard.js';
import { ensureLlamaServer, type EnsureResult, type LlamaInstall } from './engine/binaryManager.js';
import { downloadModel, listCachedModels, verifyModelFile, type LoadedModel } from './engine/modelManager.js';
import { checkModelUrl, estimateVramMb, inspectHuggingFace, parseHfUrl, paramBFromName, quantFromName, type InspectedModel } from './engine/gguf.js';
import { LlamaRunner } from './engine/llamaRunner.js';
import { compareFingerprints, probeEngine, type EngineFingerprint } from './engine/selfCheck.js';
import { simulateChat, streamChat } from './network/streamProxy.js';
import { TunnelClient } from './network/tunnelClient.js';
import { TerminalDashboard, initialState, type DashboardJob, type DashboardState, type DashboardStatus } from './ui/terminalDashboard.js';
import { activeRequestsOf, finiteNumber, isRequestId, validTime, type AgentMe, type BookingFrame, type CachedModelInfo, type ChatMessage, type HeartbeatPayload, type HelloPayload, type LoadJob, type ServerMessage, type TokenPosition } from './types.js';
import { fetchJson, HttpError } from './util/http.js';
import { execFile, sleep } from './util/exec.js';
import { formatPercent, formatUsdNanos, modelShortName } from './util/format.js';
import { clearAgentState, readAgentState, saveAgentState, type PersistedBooking, type PersistedModel, type PersistedState } from './state.js';
import { VERSION } from './version.js';
import { openUrl, printable } from './util/open.js';
import { acquireInstanceLock } from './util/instanceLock.js';
import { atomicWrite } from './util/fs.js';
import { healthPath, type AgentHealth } from './health.js';

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
  /** Public mode: price per hour for the full GPU (default 0.5; 0 = no hourly rentals). Other modes send 0. */
  priceHourUsd?: number | null;
  context?: number;
  slots?: number;
  gpuOverride?: GpuOverride | null;
  /** `sublera start <code>`: serve this request from the website. */
  requestId?: string | null;
  tokPerSec?: number | null;
  autoInstall?: boolean;
  requireChecksum?: boolean;
  drainTimeoutMs?: number;
  json?: boolean;
  once?: boolean;
  dashboard?: boolean;
  /** Unit tests only: run this program as the engine instead of an installed llama-server. */
  engine?: { binaryPath: string; baseArgs?: string[]; env?: NodeJS.ProcessEnv };
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

/** One request the server booked on this host. Several run side by side on the loaded model. */
type Booking = {
  requestId: string;
  model: string | null;
  verified: boolean;
  timerStartedAt: number | null;
  timerEndsAt: number | null;
  hours: number | null;
  pricePerHourNanos: number | null;
  minTokS: number | null;
  guaranteedNanos: number | null;
  /** A speed seat that shares the GPU with other renters and per-token buyers. */
  shared: boolean;
  /** The reserved speed of a seat; null means the full GPU. */
  tokS: number | null;
  /** llama-server slots and per-slot context the booking runs with; restored after a restart. */
  slots: number;
  context: number;
  /** When a booking frame or a status poll last confirmed it. */
  seenAt: number;
  timer: NodeJS.Timeout | null;
};

/** The request whose model is loading or waiting for the server's model check. */
type PendingRequest = {
  requestId: string;
  model: string | null;
  verified: boolean;
  loaded: boolean;
  slots: number;
  context: number;
  /** False once the server stopped listing it; it then no longer keeps the machine awake. */
  holdsWake: boolean;
  seenAt: number;
};

export type BookingView = Readonly<Pick<Booking,
  'requestId' | 'verified' | 'timerStartedAt' | 'timerEndsAt' | 'hours' | 'minTokS' | 'guaranteedNanos' | 'shared' | 'tokS'>>;

/** What loading a model with given settings does to the running llama-server. */
type RunnerPlan = { action: 'start' | 'reuse' | 'restart' | 'refuse'; note?: string };

// setTimeout fires at once for delays above 2^31-1 ms; long bookings re-arm instead.
const MAX_TIMER_MS = 2_000_000_000;

/** How long an ended booking's id is remembered, so a stale status answer cannot bring it back. */
const ENDED_TTL_MS = 3_600_000;

/** Request statuses the server lists while a request is live on this host. */
const LIVE_STATUSES = new Set(['claimed', 'loading', 'verifying', 'active']);

/** Server frames that name a request; one with a malformed requestId is ignored. */
const REQUEST_FRAMES = new Set(['load', 'verified', 'booking', 'reject']);

/** An ISO time for logs, or null when `ms` is not a time `Date` can show (toISOString would throw). */
function isoTime(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Aborts when any of the signals aborts (AbortSignal.any needs Node 20.3). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function simulatedGpu(override: GpuOverride | null): GpuSnapshot {
  const empty: GpuSnapshot = { gpus: [], primary: null, source: 'simulation', platform: process.platform, checkedAt: Date.now(), warnings: [] };
  if (!override) return { ...empty, warnings: ['Simulation mode: no GPU was scanned.'] };
  return applyGpuOverride(empty, { name: override.name ?? 'Simulated GPU', vramMb: override.vramMb ?? 24_576 });
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
  /** The --parallel count the running llama-server was started with. */
  private runnerSlotCount: number | null = null;
  private gpu: GpuSnapshot;
  private model: AgentModel | null = null;
  private cachedModels: CachedModelInfo[] = [];
  private me: AgentMe | null = null;
  private meTimer: NodeJS.Timeout | null = null;
  private gpuTimer: NodeJS.Timeout | null = null;
  private activeJobs = new Map<string, ActiveJob>();
  private stopped = false;
  private readonly startup = new AbortController();
  /** Aborts the download of a request the server stopped (released, cancelled, or taken back). */
  private loadAbort: { requestId: string; controller: AbortController } | null = null;
  /** A model download or engine start that replaces the runner: new inference waits. */
  private loadingModel = false;
  /** Any load frame in progress, including one that reuses the running model. */
  private loadInFlight = false;
  /** llama-server slots the last load asked for: more than one only for a shared booking. */
  private bookingSlots = 1;
  /** Every booked request, keyed by requestId. */
  private readonly bookings = new Map<string, Booking>();
  /**
   * Bookings that ended in this session (end timer, reject, or dropped by the status poll) and
   * when. Their earned share is already settled, so they are never added again.
   */
  private readonly endedIds = new Map<string, number>();
  /** Server clock minus this machine's clock, from the last `/api/agent/me` answer. */
  private serverOffset = 0;
  /** Requests the last status poll listed as live: claimed, loading, verifying or active. */
  private liveRequestIds = new Set<string>();
  /** The id of `me.activeRequest` (the server's newest live request) in the last status answer. */
  private serverNewestId: string | null = null;
  private pending: PendingRequest | null = null;
  /** What the dashboard shows with no request: the public model, or the model loaded with --model. */
  private startupJob: DashboardJob | null = null;
  private tokenEarnedNanos = 0;
  /** Earned share of bookings that ended or were stopped in this session. */
  private settledEarnedNanos = 0;
  private settledGuaranteedNanos = 0;
  private meInitialWallet: number | null = null;
  private lastSpeed: number | null = null;
  private lastTtft: number | null = null;
  private persisted: PersistedState | null = null;
  /** True while the restore after a restart works on state.json. */
  private restoring = false;
  private stateWrite: Promise<void> = Promise.resolve();
  private online = false;
  private onlineWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private keyHandler: ((data: Buffer) => void) | null = null;
  private heartbeatAt: number | null = null;
  private bookingTimer: NodeJS.Timeout | null = null;
  private logLines: string[] = [];
  /** The engine's answer to the self-check prompt right after the current model was loaded. */
  private engineBaseline: { modelPath: string; fingerprint: EngineFingerprint } | null = null;
  private selfCheckAbort: AbortController | null = null;
  private draining = false;
  private runStarted = false;
  private stopPromise: Promise<void> | null = null;
  private readonly messageTasks = new Set<Promise<void>>();
  private healthTimer: NodeJS.Timeout | null = null;
  private healthWrite: Promise<void> = Promise.resolve();

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
    if (options.publicMode) this.dashboard.update({ publicMode: true, priceOutUsd: this.priceOutUsd(), priceHourUsd: this.priceHourUsd() });
  }

  get dashboardState(): DashboardState { return this.dashboard.current; }

  /** Every booked request, soonest end first. */
  get activeBookings(): BookingView[] {
    return this.sortedBookings().map((booking) => this.bookingView(booking));
  }

  /** The booking for this request, or null when it is not (or no longer) booked here. */
  booking(requestId: string): BookingView | null {
    const booking = this.bookings.get(requestId);
    return booking ? this.bookingView(booking) : null;
  }

  /**
   * True while something other than `requestId` still needs this agent: public selling, another
   * booking, another request being loaded, or another request the server lists as live. A seat on
   * the loaded model never gets a load frame, so during its model check only the server's list shows it.
   */
  servingOthers(requestId: string): boolean {
    if (this.options.publicMode) return true;
    for (const id of this.bookings.keys()) if (id !== requestId) return true;
    for (const id of this.liveRequestIds) if (id !== requestId && !this.endedIds.has(id)) return true;
    return Boolean(this.pending && this.pending.requestId !== requestId && (this.pending.holdsWake || this.loadInFlight));
  }

  /** This machine's estimate of the server clock. */
  private serverTime(): number {
    return Date.now() + this.serverOffset;
  }

  /** Remembers the server clock from a status answer, so ends are judged by server time even when this clock is off. */
  private noteServerClock(me: AgentMe): void {
    const serverNow = finiteNumber(me.serverNow);
    if (serverNow != null && serverNow > 0) this.serverOffset = serverNow - Date.now();
  }

  /** The loaded request that waits for its model check, or a loaded benchmark. Restarting llama-server would break it. */
  private checkingRequest(): PendingRequest | null {
    const pending = this.pending;
    if (!pending?.loaded) return null;
    // A request the server stopped listing no longer counts; a benchmark is not listed and ends with a reject.
    return pending.holdsWake || pending.requestId.startsWith('bench_') ? pending : null;
  }

  /** Keeps the machine awake for a booking (the same call for a booking frame and a status poll). */
  private holdWakeLock(): void {
    void this.sleepGuard.acquire('dedicated booking window').then(() => {
      if (!this.stopped) this.dashboard.update({ wakeLock: this.sleepGuard.status().active });
    }, () => undefined);
  }

  private bookingView(booking: Booking): BookingView {
    const { requestId, verified, timerStartedAt, timerEndsAt, hours, minTokS, guaranteedNanos, shared, tokS } = booking;
    return { requestId, verified, timerStartedAt, timerEndsAt, hours, minTokS, guaranteedNanos, shared, tokS };
  }

  /** Bookings, a pending request, or a real load keep the machine awake. */
  private get bookingWake(): boolean {
    return this.loadingModel || this.bookings.size > 0 || Boolean(this.pending?.holdsWake);
  }

  private priceOutUsd(): number {
    return this.options.priceOutUsd ?? this.options.price ?? 0.2;
  }

  private priceHourUsd(): number {
    return this.options.publicMode ? (this.options.priceHourUsd ?? 0.5) : 0;
  }

  get health(): AgentHealth {
    const connected = this.online && this.tunnel?.connected === true;
    const engine = this.options.simulation ? 'simulation' : this.runner?.status || 'not-loaded';
    return {
      schemaVersion: 1, agentVersion: VERSION, pid: process.pid, updatedAt: Date.now(),
      live: !this.stopped, ready: Boolean(connected && !this.stopped && !this.draining && !this.loadingModel
        && (this.options.simulation || this.runner?.status === 'ready')),
      draining: this.draining, simulation: this.options.simulation,
      tunnel: this.tunnel?.state || 'closed', engine, activeJobs: this.activeJobs.size, loading: this.loadingModel,
    };
  }

  private publishHealth(): Promise<void> {
    const snapshot = JSON.stringify(this.health);
    this.healthWrite = this.healthWrite.then(() => atomicWrite(healthPath(), `${snapshot}\n`)).catch(() => {
      this.logger.warn('Could not write local health snapshot; check disk space and permissions');
    });
    return this.healthWrite;
  }

  /** Reject new work, finish in-flight inference up to a bounded grace period,
   * then cancel leftovers and preserve booking state for server reconciliation. */
  async drain(timeoutMs = this.options.drainTimeoutMs ?? 30_000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) throw new Error('Drain timeout must be between 0 and 300000 ms');
    if (this.stopped) return this.stopPromise ?? Promise.resolve();
    this.draining = true;
    this.selfCheckAbort?.abort();
    this.loadAbort?.controller.abort(new Error('Agent draining'));
    this.logger.info('Agent draining; new work will be refused', { timeoutMs, activeJobs: this.activeJobs.size });
    await this.publishHealth();
    const deadline = Date.now() + timeoutMs;
    while (!this.stopped && this.activeJobs.size > 0 && Date.now() < deadline) await sleep(25);
    await this.stop(true);
  }

  waitForOnline(timeoutMs = 20_000): Promise<void> {
    if (this.online && this.tunnel?.connected) return Promise.resolve();
    if (this.stopped || this.draining) return Promise.reject(new Error('Agent is stopped or draining'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onlineWaiters = this.onlineWaiters.filter((w) => w.timer !== timer);
        reject(new Error('Timed out waiting for the host tunnel'));
      }, timeoutMs);
      this.onlineWaiters.push({ resolve, reject, timer });
    });
  }

  private markOnline(): void {
    if (this.stopped || this.draining || !this.tunnel?.connected) return;
    this.online = true;
    for (const waiter of this.onlineWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.onlineWaiters = [];
    this.emit('online');
  }

  /** After a crash or restart, reload the booked model and resume every booking saved in state.json. */
  private async restorePersistedBooking(): Promise<boolean> {
    // Only run() calls this, while it holds the instance lock, so state.json is this agent's file.
    this.restoring = true;
    try {
      return await this.restoreOwned();
    } finally {
      this.restoring = false;
    }
  }

  private async restoreOwned(): Promise<boolean> {
    // readAgentState checks every number and drops bookings without a valid end time.
    const state = await readAgentState();
    if (!state || this.stopped) return false;
    let saved = state.bookings.filter((booking) => booking.timerEndsAt != null && booking.timerEndsAt >= Date.now() - 60_000);
    if (!saved.length) {
      await clearAgentState();
      return false;
    }
    // If the server is reachable, trust its view of the bookings before loading a
    // large cached model. A cancelled/completed booking must not be resurrected.
    let fetched: AgentMe | null = null;
    try {
      fetched = await fetchJson<AgentMe>(apiUrl(this.options.config.server, '/api/agent/me'), {
        token: this.options.config.token,
        timeoutMs: 5_000,
      });
    } catch {
      // Server may be temporarily unreachable; the local snapshot is still useful.
    }
    if (this.stopped) return false;
    if (fetched && typeof fetched === 'object') {
      const me = fetched;
      this.noteServerClock(me);
      this.serverNewestId = isRequestId(me.activeRequest?.id) ? me.activeRequest.id : null;
      // activeRequestsOf checks the ids and numbers of the rows.
      const live = new Map(activeRequestsOf(me).map((row) => [row.id, row]));
      const now = this.serverTime();
      saved = saved
        .filter((booking) => live.has(booking.requestId))
        .map((booking) => {
          const row = live.get(booking.requestId)!;
          return { ...booking, timerEndsAt: row.timerEndsAt || booking.timerEndsAt, timerStartedAt: row.timerStartedAt || booking.timerStartedAt };
        })
        .filter((booking) => booking.timerEndsAt != null && booking.timerEndsAt >= now);
      if (!saved.length) {
        await clearAgentState();
        return false;
      }
    }
    const first = saved[0]!;
    // Every booking runs on the one loaded model; a record for another file cannot be served.
    const modelKey = (model: PersistedModel) => model.path || model.file;
    const restorable = saved.filter((booking) => modelKey(booking.model) === modelKey(first.model));
    if (restorable.length < saved.length) {
      this.logger.warn('Dropping saved bookings for a different model', { requestIds: saved.filter((b) => !restorable.includes(b)).map((b) => b.requestId).join(',') });
    }
    // Restart llama-server with the slots and context the bookings had before the restart.
    this.bookingSlots = Math.min(16, Math.max(1, ...restorable.map((booking) => Math.round(Number(booking.slots) || 1))));
    const context = Math.max(...restorable.map((booking) => Number(booking.context) || 0)) || this.options.context || 8192;
    try {
      let model: AgentModel;
      if (this.options.simulation) {
        model = {
          path: first.model.path || null,
          sourceUrl: first.model.url || first.model.path || '',
          file: first.model.file,
          modelId: first.model.modelId,
          label: first.model.label,
          repo: first.model.repo,
          quant: first.model.quant,
          paramB: first.model.paramB,
          layers: first.model.layers,
          contextTrain: first.model.contextTrain,
          sha256: first.model.sha256,
          verified: first.model.verified,
          needsMb: first.model.needsMb,
          size: first.model.size,
          architecture: first.model.architecture,
        };
      } else {
        if (!first.model.path) throw new Error('The cached model path is missing');
        model = await this.loadModel(first.model.path, {
          context,
          requestId: first.requestId,
          expectedSha: first.model.sha256,
          expectedLayers: first.model.layers,
          file: first.model.file,
        });
        // A stop during the load: run() frees the engine, and stop() decides about state.json.
        if (this.stopped) return false;
      }
      this.model = model;
      await this.sleepGuard.acquire('resuming a booked model after a process restart');
      // Bookings added after a stop would keep end timers that nothing clears.
      if (this.stopped) return false;
      for (const booking of restorable) {
        this.upsertBooking(booking.requestId, {
          model: model.file,
          verified: model.verified,
          timerStartedAt: booking.timerStartedAt,
          timerEndsAt: booking.timerEndsAt,
          hours: booking.hours,
          pricePerHourNanos: booking.pricePerHourNanos,
          minTokS: booking.minTokS,
          guaranteedNanos: booking.guaranteedNanos,
          shared: Boolean(booking.shared),
          tokS: booking.tokS && booking.tokS > 0 ? booking.tokS : null,
          slots: Math.max(1, Math.round(Number(booking.slots) || 1)),
          context: Number(booking.context) || context,
        });
      }
      this.persistBookings();
      this.syncDashboard({
        wakeLock: this.sleepGuard.status().active,
        status: 'working',
        message: restorable.length === 1 ? `Resuming booking ${first.requestId} after a restart` : `Resuming ${restorable.length} bookings after a restart`,
      });
      for (const booking of restorable) {
        this.logger.info('Resuming persisted booking', { requestId: booking.requestId, ends: isoTime(booking.timerEndsAt), slots: booking.slots });
      }
      return true;
    } catch (error) {
      for (const booking of restorable) this.removeBooking(booking.requestId, false);
      // The wake lock may already be held for the bookings that could not be resumed.
      await this.releaseWakeLockIfIdle();
      // A stop during the restore (the load was aborted) is not a failed restore: stop() decides about state.json.
      if (this.stopped) return false;
      this.logger.warn('Could not restore the previous booking', { error: error instanceof Error ? error.message : String(error) });
      this.persisted = null;
      await clearAgentState();
      return false;
    }
  }

  /** Writes every booking to state.json (newest first), or removes the file when none is left. */
  private persistBookings(): void {
    const model = this.model;
    const list = [...this.bookings.values()].sort((a, b) => (b.timerStartedAt ?? 0) - (a.timerStartedAt ?? 0));
    if (!model || !list.length) {
      this.clearPersistedBooking();
      return;
    }
    const now = Date.now();
    const saved: PersistedModel = {
      url: model.sourceUrl || model.path || '',
      path: model.path || '',
      file: model.file,
      modelId: model.modelId,
      label: model.label,
      repo: model.repo,
      quant: model.quant,
      paramB: model.paramB,
      layers: model.layers,
      contextTrain: model.contextTrain,
      sha256: model.sha256,
      verified: model.verified,
      needsMb: model.needsMb,
      size: model.size,
      architecture: model.architecture,
    };
    const records: PersistedBooking[] = list.map((booking) => ({
      requestId: booking.requestId,
      model: { ...saved },
      context: booking.context,
      // The slot count the booking was loaded with, so a restart starts llama-server the same way.
      slots: booking.slots,
      timerStartedAt: booking.timerStartedAt,
      timerEndsAt: booking.timerEndsAt,
      hours: booking.hours,
      pricePerHourNanos: booking.pricePerHourNanos,
      minTokS: booking.minTokS,
      guaranteedNanos: booking.guaranteedNanos,
      shared: booking.shared,
      tokS: booking.tokS,
      savedAt: now,
    }));
    // An older agent restores only `booking`, and drops it unless it is the server's `activeRequest`
    // (the newest by claim time, which need not be the newest by start time). Write that one there.
    const legacy = records.find((record) => record.requestId === this.serverNewestId) ?? records[0]!;
    this.persisted = { version: 1, booking: legacy, bookings: records, updatedAt: now };
    const snapshot = this.persisted;
    this.stateWrite = this.stateWrite
      .then(() => saveAgentState(snapshot))
      .catch((error) => this.logger.warn('Could not save recovery state', { error: error instanceof Error ? error.message : String(error) }));
  }

  private sortedBookings(): Booking[] {
    return [...this.bookings.values()].sort((a, b) => (a.timerEndsAt ?? Number.MAX_SAFE_INTEGER) - (b.timerEndsAt ?? Number.MAX_SAFE_INTEGER));
  }

  /** Adds or updates a booking. A pending request with the same id becomes this booking. */
  private upsertBooking(requestId: string, fields: Partial<Omit<Booking, 'requestId' | 'timer' | 'seenAt'>>): Booking {
    const pending = this.pending?.requestId === requestId ? this.pending : null;
    let booking = this.bookings.get(requestId);
    if (!booking) {
      booking = {
        requestId,
        model: pending?.model ?? this.model?.file ?? null,
        verified: pending?.verified ?? false,
        timerStartedAt: null,
        timerEndsAt: null,
        hours: null,
        pricePerHourNanos: null,
        minTokS: null,
        guaranteedNanos: null,
        shared: false,
        tokS: null,
        slots: pending?.slots ?? this.capacity(),
        context: pending?.context ?? this.runnerContext ?? this.options.context ?? 8192,
        seenAt: Date.now(),
        timer: null,
      };
      this.bookings.set(requestId, booking);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (booking as unknown as Record<string, unknown>)[key] = value;
    }
    booking.seenAt = Date.now();
    if (pending) this.pending = null;
    this.scheduleBookingEnd(booking);
    return booking;
  }

  private scheduleBookingEnd(booking: Booking): void {
    if (booking.timer) clearTimeout(booking.timer);
    booking.timer = null;
    if (!booking.timerEndsAt) return;
    const delay = Math.max(0, booking.timerEndsAt - Date.now()) + 1_000;
    booking.timer = setTimeout(() => this.finishBooking(booking.requestId), Math.min(delay, MAX_TIMER_MS));
  }

  /** The end timer of one booking fired: remove only that booking. */
  private finishBooking(requestId: string): void {
    const booking = this.bookings.get(requestId);
    if (this.stopped || !booking) return;
    if (booking.timerEndsAt && Date.now() < booking.timerEndsAt) {
      this.scheduleBookingEnd(booking);
      return;
    }
    this.logger.info('Booking window ended', { requestId });
    this.removeBooking(requestId);
    this.persistBookings();
    void this.releaseWakeLockIfIdle();
    const left = this.bookings.size;
    this.syncDashboard({
      status: left || this.activeJobs.size ? 'working' : 'online',
      message: left ? `Booking ${requestId} finished; ${left} rental${left === 1 ? '' : 's'} still active.` : 'Booking finished. Back on standby.',
    });
  }

  /**
   * Removes one booking and books its earned share into the session total. A settled booking has
   * ended: its id is remembered so a status answer built before the end cannot add it (and its
   * earnings) a second time. `settle = false` only drops it (a restore that failed), so it is not remembered.
   */
  private removeBooking(requestId: string, settle = true): Booking | null {
    const booking = this.bookings.get(requestId);
    if (!booking) return null;
    if (booking.timer) clearTimeout(booking.timer);
    booking.timer = null;
    this.bookings.delete(requestId);
    if (settle) {
      const now = Date.now();
      const share = this.bookingShare(booking, now);
      this.settledEarnedNanos += share;
      this.settledGuaranteedNanos += share;
      for (const [id, endedAt] of this.endedIds) if (now - endedAt > ENDED_TTL_MS) this.endedIds.delete(id);
      this.endedIds.set(requestId, now);
    }
    return booking;
  }

  private clearBookingTimers(): void {
    for (const booking of this.bookings.values()) {
      if (booking.timer) clearTimeout(booking.timer);
      booking.timer = null;
    }
  }

  /** The part of a booking's guaranteed pay that the time so far has earned. */
  private bookingShare(booking: Booking, now: number): number {
    if (!booking.guaranteedNanos || !booking.timerStartedAt || !booking.timerEndsAt) return 0;
    const total = Math.max(1, booking.timerEndsAt - booking.timerStartedAt);
    const elapsed = Math.min(total, Math.max(0, now - booking.timerStartedAt));
    return Math.round(booking.guaranteedNanos * (elapsed / total));
  }

  private bookingJob(booking: Booking): DashboardJob {
    return {
      kind: 'request',
      id: booking.requestId,
      model: booking.model ?? this.model?.file ?? null,
      verified: booking.verified,
      timerStartedAt: booking.timerStartedAt,
      timerEndsAt: booking.timerEndsAt,
      minTokS: booking.minTokS,
      guaranteedNanos: booking.guaranteedNanos,
      hours: booking.hours,
      shared: booking.shared,
      tokS: booking.tokS,
    };
  }

  private baseJob(): DashboardJob | null {
    if (this.startupJob) return { ...this.startupJob, model: this.model?.file || this.startupJob.model, verified: this.model?.verified ?? this.startupJob.verified };
    if (this.options.publicMode || this.activeJobs.size > 0) {
      return { kind: 'public', model: this.model?.file || null, verified: this.model?.verified, minTokS: null, guaranteedNanos: 0 };
    }
    return null;
  }

  /**
   * Rebuilds the dashboard's request view from the bookings. Earnings are the per-token
   * earnings plus the time-proportional share of every booking, active or settled.
   */
  private syncDashboard(extra: Partial<DashboardState> = {}): void {
    if (this.stopped) return;
    const now = Date.now();
    const bookings = this.sortedBookings();
    const pending = this.pending;
    const job: DashboardJob | null = pending
      ? { kind: 'request', id: pending.requestId, model: pending.model, verified: pending.verified, timerStartedAt: null, timerEndsAt: null, minTokS: null, guaranteedNanos: 0 }
      : bookings[0] ? this.bookingJob(bookings[0]) : this.baseJob();
    let earned = this.tokenEarnedNanos + this.settledEarnedNanos;
    let guaranteed = this.settledGuaranteedNanos;
    for (const booking of bookings) {
      earned += this.bookingShare(booking, now);
      guaranteed += booking.guaranteedNanos || 0;
    }
    this.dashboard.update({
      job,
      bookings: bookings.map((booking) => this.bookingJob(booking)),
      sessionEarnedNanos: earned,
      sessionGuaranteedNanos: guaranteed,
      tokenEarnedNanos: this.tokenEarnedNanos,
      ...extra,
    });
  }

  /** Removes state.json if this agent wrote it; `force` also removes the file a restore in progress is working on. */
  private clearPersistedBooking(force = false): void {
    if (!this.persisted && !force) return;
    this.persisted = null;
    this.stateWrite = this.stateWrite
      .then(() => clearAgentState())
      .catch(() => undefined);
  }


  async run(): Promise<void> {
    if (this.runStarted) throw new Error('Agent.run() can only be called once');
    this.runStarted = true;
    if (this.stopped) return;
    const release = await acquireInstanceLock();
    try {
      await this.publishHealth();
      this.healthTimer = setInterval(() => { void this.publishHealth(); }, 5_000);
      await this.runOwned();
    } finally {
      if (this.healthTimer) clearInterval(this.healthTimer);
      try {
        const errors: unknown[] = [];
        // A failed stop must not bypass pending handlers, late allocations, or
        // final writes. Retain ownership until every cleanup step settles.
        for (const cleanup of [
          () => this.stop(true),
          () => Promise.allSettled([...this.messageTasks]),
          () => this.releaseResources(),
          () => this.stateWrite,
          () => this.publishHealth(),
        ]) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        // Preserve the first cleanup failure rather than masking it with a retry.
        if (errors.length) throw errors[0];
      } finally { await release(); }
    }
  }

  private async runOwned(): Promise<void> {
    if (this.stopped) return;
    const cfg = this.options.config;
    if (!cfg.token) throw new Error('No host key saved. Run: sublera login');
    this.logger.info(`Starting Sublera agent v${VERSION}`, { server: cfg.server, simulate: this.options.simulation });
    if (!this.options.simulation) {
      this.gpu = applyGpuOverride(await this.gpuMonitor.scan(true), this.options.gpuOverride);
      for (const warning of this.gpu.warnings) this.logger.warn(warning);
    }
    if (!this.gpu.primary && !this.options.simulation && !this.options.gpuOverride) {
      this.logger.warn('No GPU detected. Use --gpu "RTX 4090" --vram 24576 for a test node, or --simulation.');
    }
    this.updateGpuDashboard();
    this.cachedModels = await listCachedModels();
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
      if (state !== 'open') this.online = false;
      if (state === 'open') {
        this.dashboard.update({ status: this.activeJobs.size ? 'working' : 'online' });
      } else if (state === 'reconnecting') {
        this.dashboard.update({ status: 'reconnecting', message: 'Tunnel dropped; keeping llama-server warm' });
      } else if (state === 'auth-failed') {
        this.dashboard.update({ status: 'auth-failed', message: 'Host key rejected. Run sublera login again.' });
      }
    });
    this.tunnel.on('outdated', (error: Error) => { this.fail(error, 'outdated'); });
    this.tunnel.on('message', (message: ServerMessage) => {
      const task = this.handleMessage(message).catch((error) => {
        if (this.stopped) return;
        this.logger.error('Server message handling failed', { error: error instanceof Error ? error.message : String(error) });
        this.fail(new Error('Server message handling failed'));
        void this.stop(true);
      });
      this.messageTasks.add(task);
      void task.finally(() => this.messageTasks.delete(task));
    });
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
    return hostEndpoint(cfg.server, this.me?.user.username);
  }

  /** Tells the server about a newly downloaded model, so the board can show it as ready on this host. */
  private async refreshCachedModels(): Promise<void> {
    this.cachedModels = await listCachedModels();
    this.tunnel?.send({ type: 'models', cachedModels: this.cachedModels });
  }

  private async prepareStartupModel(input: string): Promise<void> {
    const inspection = this.options.modelInfo
      || (this.options.simulation || !/^https?:\/\//i.test(input)
        ? null
        : await inspectHuggingFace(input).catch(() => null));
    const loaded = await this.loadModel(input, {
      context: this.options.context ?? 8192,
      capContext: true,
      requestId: null,
      expectedSha: inspection?.sha256 ?? null,
      expectedLayers: inspection?.layers ?? null,
      file: inspection?.file ?? null,
    });
    this.model = loaded;
    this.startupJob = {
      kind: this.options.publicMode ? 'public' : 'request',
      model: loaded.file,
      verified: loaded.verified,
      minTokS: null,
      guaranteedNanos: 0,
    };
    this.syncDashboard({ llamaStatus: this.runner?.status || 'ready' });
  }

  private async loadModel(input: string, opts: { context: number; requestId: string | null; expectedSha?: string | null; expectedLayers?: number | null; file?: string | null; signal?: AbortSignal; capContext?: boolean }): Promise<AgentModel> {
    if (this.options.simulation) {
      const file = opts.file || (input.startsWith('http') ? parseHfUrl(input)?.file : basename(input)) || 'sublera-simulator.gguf';
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
        verified: false,
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
        // A file already on disk is hashed again: the SHA-256 the server gets is of the bytes that will be served.
        verifyCached: true,
        onProgress: (progress) => {
          if (opts.requestId) {
            this.tunnel?.send({ type: 'progress', requestId: opts.requestId, note: progress.note });
          }
          this.dashboard.update({ message: progress.note });
        },
        showProgress: true,
        signal: opts.signal ? anySignal([this.startup.signal, opts.signal]) : this.startup.signal,
      });
      await this.refreshCachedModels();
    } else {
      loaded = await verifyModelFile(input, { sha256: opts.expectedSha ?? null, layers: opts.expectedLayers ?? null, context: opts.context, slots: this.runnerSlots() });
    }
    // llama-server never gives a slot more context than the model was trained for, so check before starting it.
    let context = opts.context;
    if (loaded.contextTrain && loaded.contextTrain < context) {
      const limit = `This model supports at most ${loaded.contextTrain} tokens of context`;
      if (!opts.capContext) throw new Error(`${limit}, but ${context} were asked for. Ask for ${loaded.contextTrain} or less, or pick another model.`);
      this.logger.warn(`${limit}; using ${loaded.contextTrain} instead of ${context}.`);
      context = loaded.contextTrain;
    }
    const needsMb = loaded.needsMb ?? estimateVramMb({
      paramB: loaded.paramB || 7,
      quant: loaded.quant || 'Q4_K_M',
      context,
      layers: loaded.layers ?? undefined,
      slots: this.runnerSlots(),
    });
    // When llama-server already runs this file with these settings, its memory is part of the
    // "used" VRAM, so a fit check would count the model twice. Reuse it without checking.
    const plan = this.runnerPlan(loaded.path, context, this.runnerSlots(), opts.requestId);
    if (plan.action === 'refuse') throw new Error(`${plan.note}. Retry when that work ends.`);
    if (plan.action !== 'reuse') {
      const fit = checkFit(needsMb, this.gpu.primary);
      if (this.gpu.primary && !fit.ok) throw new Error(fit.reason || 'Model does not fit in free VRAM');
    }
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
    await this.ensureRunner(model, context, this.runnerSlots(), opts.requestId);
    return model;
  }

  /**
   * True while llama-server serves someone other than `owner`: an inference job, another
   * booking, public selling, or another request whose model is loaded and in its model check
   * (or a benchmark). A restart would cut them off, so it is not allowed then.
   */
  private runnerBusy(owner: string | null): boolean {
    if (this.activeJobs.size > 0) return true;
    if (this.options.publicMode && this.model) return true;
    for (const id of this.bookings.keys()) if (id !== owner) return true;
    const checking = this.checkingRequest();
    return Boolean(checking && checking.requestId !== owner);
  }

  /** Decides whether loading `path` reuses, restarts, or must not touch the running llama-server. */
  private runnerPlan(path: string | null, context: number, slots: number, owner: string | null): RunnerPlan {
    // The simulator has no engine to restart.
    if (this.options.simulation) return { action: 'reuse' };
    const runner = this.runner;
    if (!runner || !path || runner.status === 'stopped' || runner.status === 'failed') return { action: 'start' };
    const samePath = this.runnerModelPath === path;
    if (samePath && runner.status === 'ready' && this.runnerContext === context && this.runnerSlotCount === slots) return { action: 'reuse' };
    if (!this.runnerBusy(owner)) return { action: 'restart' };
    if (!samePath) {
      return { action: 'refuse', note: `llama-server is serving other work with ${basename(this.runnerModelPath || 'another model')}, so it cannot load another model now` };
    }
    if ((this.runnerContext ?? 0) < context) {
      return { action: 'refuse', note: `llama-server is serving other work with ${this.runnerContext} tokens of context per slot, so it cannot restart for ${context}` };
    }
    if (this.runnerSlotCount !== slots) {
      return { action: 'reuse', note: `Keeping llama-server at ${this.runnerSlotCount} parallel slots (${slots} asked for) because it is serving other work` };
    }
    return { action: 'reuse' };
  }

  /** Requests are served on the slots llama-server really runs with. */
  private capacity(): number {
    return this.runner && this.runnerSlotCount ? this.runnerSlotCount : this.runnerSlots();
  }

  private async ensureRunner(model: AgentModel, context: number, slots = this.runnerSlots(), owner: string | null = null): Promise<void> {
    if (this.options.simulation || !model.path) return;
    if (!this.install) {
      const result: EnsureResult = this.options.engine
        ? { found: true, install: { path: this.options.engine.binaryPath, version: 'test', variant: 'cpu', sha256: null, verified: false, source: 'env' } }
        : await ensureLlamaServer({
          logger: this.logger,
          gpu: this.gpu,
          fix: this.options.autoInstall !== false,
          requireChecksum: this.options.requireChecksum,
          showProgress: true,
        });
      if (!result.found) throw new Error(result.reason);
      this.install = result.install;
      this.logger.info('llama-server ready', { path: result.install.path, variant: result.install.variant, verified: result.install.verified });
      const source = result.install.source;
      if (source === 'env' || source === 'path') {
        this.logger.warn(
          `Using your own llama-server (${source === 'env' ? 'set in LLAMA_SERVER' : 'found on your PATH'}), not the build Sublera installs. `
          + 'The server compares your answers with other hosts; a different llama.cpp build can fail those model checks. '
          + `To use the official build, ${source === 'env' ? 'unset LLAMA_SERVER' : 'take llama-server off your PATH'} and run: sublera doctor --fix`,
        );
      }
    }
    const plan = this.runnerPlan(model.path, context, slots, owner);
    if (plan.action === 'refuse') throw new Error(`${plan.note}. Retry when that work ends.`);
    if (plan.action === 'reuse') {
      if (plan.note) this.logger.warn(plan.note);
      return;
    }
    if (this.runner) {
      await this.runner.stop();
      this.runner = null;
      this.runnerModelPath = null;
      this.runnerContext = null;
      this.runnerSlotCount = null;
    }
    const runner = new LlamaRunner({
      binaryPath: this.install.path,
      modelPath: model.path,
      context,
      slots,
      baseArgs: this.options.engine?.baseArgs,
      env: this.options.engine?.env,
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
      // After a crash the engine reloads the model; make sure it still answers as it did before.
      if (runner.restarts > 0 && this.runner === runner) void this.selfCheckEngine('restart');
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
    this.runnerSlotCount = slots;
    this.dashboard.update({ llamaStatus: runner.status, gpuName: this.gpu.primary?.name || null });
    await this.selfCheckEngine('load');
  }

  /**
   * Asks the engine one short fixed question and compares the answer's token probabilities:
   * twice in a row after a load, and against the load-time answer after a crash restart. It only
   * warns; the server's model checks decide. It runs when the engine's prompt cache is empty and
   * no buyer is waiting, and a buyer's job cancels it.
   */
  private async selfCheckEngine(reason: 'load' | 'restart'): Promise<void> {
    const runner = this.runner;
    const modelPath = this.runnerModelPath;
    if (this.options.simulation || !runner || !modelPath || runner.status !== 'ready' || this.activeJobs.size > 0 || this.stopped) return;
    this.selfCheckAbort?.abort();
    const controller = new AbortController();
    this.selfCheckAbort = controller;
    const signal = AbortSignal.any([controller.signal, this.startup.signal]);
    try {
      const first = await probeEngine(runner.url, { signal });
      if (!first) {
        this.logger.debug('Engine self-check skipped: the engine gave no token probabilities in time');
        return;
      }
      if (signal.aborted || this.stopped || this.runner !== runner) return;
      const baseline = this.engineBaseline?.modelPath === modelPath ? this.engineBaseline.fingerprint : null;
      if (reason === 'restart' && baseline) {
        const diff = compareFingerprints(baseline, first);
        if (diff.same === null) {
          this.logger.debug('Engine self-check inconclusive after restart', { reason: diff.reason });
          return;
        }
        if (diff.same === true) {
          this.logger.info('Engine self-check passed after the restart', { tokens: diff.compared });
          return;
        }
        const note = `Self-check: after the restart llama-server answers differently than when the model was loaded (${diff.reason}). The server's model checks may fail.`;
        this.logger.warn(note);
        this.dashboard.update({ message: note });
        return;
      }
      const second = await probeEngine(runner.url, { signal });
      if (!second || signal.aborted || this.stopped || this.runner !== runner) return;
      const diff = compareFingerprints(first, second);
      if (diff.same === null) {
        this.logger.debug('Engine self-check inconclusive', { reason: diff.reason });
        return;
      }
      if (diff.same === true) {
        this.engineBaseline = { modelPath, fingerprint: first };
        this.logger.info('Engine self-check passed: the same prompt gave the same answer twice', { tokens: diff.compared });
        return;
      }
      const note = `Self-check: the engine returned different token probabilities for the same prompt (${diff.reason}). This is diagnostic only, not proof of a fake model or faulty GPU. Check engine settings and repeat the test.`;
      this.logger.warn(note);
      this.dashboard.update({ message: note });
    } catch (error) {
      this.logger.debug('Engine self-check could not run', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.selfCheckAbort === controller) this.selfCheckAbort = null;
    }
  }

  private runnerSlots(): number {
    if (this.options.publicMode) return Math.max(1, this.options.slots ?? 4);
    return Math.max(1, this.options.slots ?? 1, this.bookingSlots);
  }

  private helloPayload(): HelloPayload {
    const gpu = this.gpu.primary;
    const model = this.model;
    const advertised = this.options.simulation ? (this.options.tokPerSec || 24) : (this.lastSpeed || this.options.tokPerSec || 24);
    return {
      type: 'hello',
      requestId: this.options.requestId ?? null,
      cachedModels: this.cachedModels,
      agentVersion: VERSION,
      platform: process.platform,
      arch: process.arch,
      gpuName: gpu?.name || this.options.gpuOverride?.name || 'Unknown GPU',
      gpuVendor: gpu?.vendor || 'unknown',
      vramMb: gpu?.totalVramMb || this.options.gpuOverride?.vramMb || 0,
      freeVramMb: gpu?.freeVramMb || 0,
      modelId: model?.modelId || (this.options.publicMode ? 'sublet-public' : 'sublet-standby'),
      modelLabel: model?.label || (this.options.publicMode ? 'Sublera public host' : 'Standby'),
      repo: model?.repo || '',
      file: model?.file || '',
      quant: model?.quant || 'Q4_K_M',
      paramB: model?.paramB ?? null,
      layers: model?.layers ?? null,
      context: this.runnerContext ?? this.sortedBookings()[0]?.context ?? this.options.context ?? 8192,
      slots: this.capacity(),
      sha256: model?.sha256 || null,
      hashVerified: Boolean(model?.verified),
      tokPerSec: advertised,
      ttftMs: this.options.simulation ? 300 : (this.lastTtft || 300),
      priceInUsd: this.options.priceInUsd ?? (this.options.price != null ? Math.max(0.01, this.options.price / 2) : 0.1),
      priceOutUsd: this.priceOutUsd(),
      priceHourUsd: this.priceHourUsd(),
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
    // The requestId ends up in dashboard text, logs and replies, so only the server's id shape is accepted.
    if (REQUEST_FRAMES.has(message.type) && !isRequestId((message as { requestId?: unknown }).requestId)) {
      this.logger.debug('Ignoring a server frame with a malformed requestId', { type: message.type });
      return;
    }
    switch (message.type) {
      case 'welcome':
        if (!this.draining) this.markOnline();
        this.dashboard.update({ status: 'online' });
        this.emit('welcome');
        return;
      case 'infer':
        await this.handleInfer(message as unknown as Record<string, unknown>);
        return;
      case 'load':
        if (this.draining) {
          this.tunnel?.send({ type: 'load_failed', requestId: message.requestId, message: 'Agent draining; retry on another host' });
          return;
        }
        await this.handleLoad(message as LoadJob);
        return;
      case 'cancel': {
        const job = this.activeJobs.get(String(message.jobId));
        if (job) job.controller.abort(new Error('Cancelled by server'));
        return;
      }
      case 'verified': {
        const requestId = String(message.requestId || '');
        const pending = this.pending;
        if (pending?.requestId === requestId) {
          // A check result that arrives while the model is still loading belongs to an older load.
          if (!pending.loaded) return;
          pending.verified = true;
          this.syncDashboard({ message: 'Model check passed. The clock can start.' });
          return;
        }
        const booking = this.bookings.get(requestId);
        if (booking) {
          booking.verified = true;
          this.syncDashboard();
          return;
        }
        // A seat or hourly rental on the model that is already loaded: its booking frame follows.
        this.logger.debug('Model check passed for a request without a load', { requestId });
        return;
      }
      case 'booking':
        this.applyBooking(message as unknown as BookingFrame);
        return;
      case 'reject': {
        const requestId = String(message.requestId || '');
        // Shown on the dashboard and printed by start/jobs: no control characters from the server.
        const reason = printable(String(message.reason || 'unknown'));
        const booking = this.bookings.get(requestId) ?? null;
        const pending = this.pending?.requestId === requestId;
        const loading = this.loadAbort?.requestId === requestId;
        if (!booking && !pending && !loading) {
          this.emit('rejected', { requestId, reason, wasActive: false });
          return;
        }
        // A reject ends only this request; other bookings keep running.
        if (loading) {
          this.loadAbort!.controller.abort(new Error(`Request ${requestId} stopped: ${reason}`));
          this.loadAbort = null;
        }
        if (pending) this.pending = null;
        if (booking) {
          this.removeBooking(requestId);
          this.persistBookings();
        }
        void this.releaseWakeLockIfIdle();
        this.syncDashboard({
          status: this.bookings.size || this.activeJobs.size ? 'working' : 'online',
          message: requestId.startsWith('bench_') ? reason : `Request ${requestId || '?'} stopped: ${reason}`,
        });
        this.emit('rejected', { requestId, reason, wasActive: Boolean(booking?.timerEndsAt) });
        return;
      }
      case 'error':
        this.logger.warn(printable(String(message.message || 'Server error')));
        return;
      default:
        this.logger.debug('Unhandled server message', { type: String(message.type) });
    }
  }

  /**
   * The server started a booking's clock. It may be for the request just loaded, or for a
   * request that never had a load frame (a speed seat or hourly rental on the loaded model).
   * Each booking keeps its own end timer; a model load in progress stays busy.
   */
  private applyBooking(message: BookingFrame): void {
    const requestId = message.requestId;
    if (!isRequestId(requestId)) {
      this.logger.debug('Ignoring a booking frame without a valid requestId');
      return;
    }
    if (this.endedIds.has(requestId)) {
      // Its earned share is already settled; adding it again would count it twice.
      this.logger.debug('Ignoring a booking frame for a booking that already ended', { requestId });
      return;
    }
    const timerEndsAt = validTime(message.timerEndsAt);
    const timerStartedAt = validTime(message.timerStartedAt) ?? Date.now();
    const hours = finiteNumber(message.hours) || (timerEndsAt ? (timerEndsAt - timerStartedAt) / 3_600_000 : null);
    const minTokS = finiteNumber(message.minTokS) || null;
    const pricePerHour = finiteNumber(message.pricePerHourNanos) || null;
    const guaranteed = hours && pricePerHour ? Math.round(hours * pricePerHour) : null;
    const seatTokS = finiteNumber(message.tokS);
    const tokS = seatTokS != null && seatTokS > 0 ? seatTokS : null;
    const booking = this.upsertBooking(requestId, {
      verified: true,
      timerStartedAt,
      timerEndsAt,
      hours,
      pricePerHourNanos: pricePerHour,
      minTokS,
      guaranteedNanos: guaranteed,
      shared: message.shared === true || tokS != null,
      tokS,
    });
    this.holdWakeLock();
    const count = this.bookings.size;
    this.logger.info('Booking started', { requestId, ends: isoTime(timerEndsAt), tokS: booking.tokS ?? 'full GPU', active: count });
    this.syncDashboard({
      status: 'working',
      wakeLock: this.sleepGuard.status().active,
      message: count > 1 ? `Booking ${requestId} started; ${count} rentals active.` : 'Booking timer started. Keep the terminal open.',
    });
    this.persistBookings();
  }

  private async handleInfer(message: Record<string, unknown>): Promise<void> {
    const jobId = String(message.jobId || '');
    if (!jobId || this.stopped) return;
    if (this.activeJobs.has(jobId)) return;
    if (this.draining || this.loadingModel || this.activeJobs.size >= this.capacity()) {
      this.tunnel?.send({ type: 'error', jobId, code: 'host_busy', message: 'Agent draining, loading, or at capacity; retry on another host' });
      return;
    }
    // A buyer never waits behind the agent's own self-check.
    this.selfCheckAbort?.abort();
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
    const perToken = this.earnsPerToken();
    try {
      if (wasIdle) {
        await this.sleepGuard.acquire(this.options.publicMode ? 'public token serving' : 'dedicated booking');
      }
      controller.signal.throwIfAborted();
      if (this.stopped) return;
      this.syncDashboard({ status: 'working', wakeLock: this.sleepGuard.status().active, message: null });
      const onChunk = (text: string, positions: TokenPosition[]) => {
        if (this.stopped || controller.signal.aborted) return;
        if (active.firstTokenAt == null) active.firstTokenAt = Date.now();
        active.text += text;
        active.chunks++;
        const frame = positions.length ? { type: 'chunk', jobId, text, lp: positions } : { type: 'chunk', jobId, text };
        // A chunk lost to a tunnel drop would leave a hole in the buyer's text, so stop the job instead.
        if (!this.tunnel?.send(frame)) controller.abort(new Error('Tunnel dropped during the stream'));
      };
      let result;
      if (this.options.simulation) {
        result = await simulateChat({
          jobId,
          messages: message.messages as ChatMessage[],
          maxTokens: Number(message.maxTokens || 256),
          temperature: Number(message.temperature ?? 0.7),
          model: this.model?.modelId || 'sublera-simulator',
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
      controller.signal.throwIfAborted();
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
      });
      if (perToken) this.tokenEarnedNanos += this.estimateEarned(result.completionTokens);
      this.syncDashboard({ liveTokPerSec: this.lastSpeed, lastHeartbeatAt: Date.now() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!this.stopped) this.tunnel?.send({ type: 'error', jobId, code: 'infer_failed', message: msg });
      this.logger.warn('Inference failed', { error: msg });
    } finally {
      this.activeJobs.delete(jobId);
      if (this.activeJobs.size === 0) {
        await this.releaseWakeLockIfIdle();
        if (this.stopped) return;
        this.syncDashboard({
          status: this.bookings.size > 0 ? 'working' : 'online',
          wakeLock: this.sleepGuard.status().active,
        });
      }
      if (this.options.once && this.dashboard.current.job?.kind !== 'request') this.emit('once');
    }
  }

  /**
   * Whether the dashboard counts a job that starts now as per-token income: only while no paid
   * booking (speed seat or full GPU) is active. A renter's tokens are paid by the hour, and in
   * public mode per-token buyers are served beside speed seats, but an `infer` frame does not say
   * whose job it is. That is by design: the server must not reveal which jobs are hidden model
   * checks. So while rentals run, per-token earnings are left out of the session total; the
   * wallet on the website is exact.
   */
  private earnsPerToken(): boolean {
    for (const booking of this.bookings.values()) if (booking.guaranteedNanos) return false;
    return true;
  }

  private estimateEarned(completionTokens: number): number {
    return Math.round((completionTokens / 1_000_000) * this.priceOutUsd() * 1e9);
  }

  /** The loaded model, when a load frame names it: the same SHA-256, or the same HuggingFace link when no hash is given. */
  private loadedModelFor(load: LoadJob): AgentModel | null {
    const model = this.model;
    if (!model) return null;
    if (!this.options.simulation && (!this.runner || this.runnerModelPath !== model.path)) return null;
    const sha = typeof load.sha256 === 'string' ? load.sha256.trim().toLowerCase() : '';
    if (sha) return model.sha256?.toLowerCase() === sha ? model : null;
    try {
      return checkModelUrl(String(load.url || '')) === checkModelUrl(model.sourceUrl) ? model : null;
    } catch {
      return null;
    }
  }

  /** The slots llama-server should run with after a load that asks for `loadSlots`. */
  private slotsAfterLoad(loadSlots: number): number {
    if (this.options.publicMode) return this.runnerSlots();
    return Math.max(1, this.options.slots ?? 1, loadSlots);
  }

  private async handleLoad(load: LoadJob): Promise<void> {
    const requestId = String(load.requestId || '');
    if (this.stopped || this.draining || this.loadInFlight) {
      this.tunnel?.send({ type: 'load_failed', requestId, message: 'Host is busy; retry after current work completes' });
      return;
    }
    // Another request is loaded and in its model check (or a benchmark runs): it is not a booking
    // yet, but replacing it, or restarting llama-server under it, would break that check.
    const checking = this.checkingRequest();
    if (checking && checking.requestId !== requestId) {
      const what = checking.requestId.startsWith('bench_')
        ? 'a benchmark is running on the loaded model'
        : `request ${checking.requestId} is loaded and waiting for its model check`;
      this.tunnel?.send({ type: 'load_failed', requestId, message: `Host is busy: it is serving other work (${what}). Retry after current work completes.` });
      return;
    }
    const loadSlots = Math.max(1, Math.min(16, Math.round(Number(load.slots) || 1)));
    const context = Math.max(Number(load.context || this.options.context || 8192), 2048);
    // The model this request names may already be running for other renters or public buyers.
    // Then the request is served on it as it is: no download, no VRAM check, no restart.
    const loaded = this.loadedModelFor(load);
    const plan = loaded ? this.runnerPlan(loaded.path, context, this.slotsAfterLoad(loadSlots), requestId) : null;
    const reuse = loaded && plan?.action === 'reuse' ? loaded : null;
    if (!reuse && this.runnerBusy(requestId)) {
      // Never stop llama-server under other bookings, public buyers, or a running job.
      const reason = plan?.action === 'refuse' && plan.note ? plan.note : 'it is serving other work on its loaded model, so it cannot load another model now';
      this.tunnel?.send({ type: 'load_failed', requestId, message: `Host is busy: ${reason}. Retry after current work completes.` });
      return;
    }
    this.loadInFlight = true;
    if (!reuse) {
      this.loadingModel = true;
      this.bookingSlots = loadSlots;
    }
    this.pending = { requestId, model: printable(String(load.file || load.url || '')) || null, verified: false, loaded: false, slots: loadSlots, context, holdsWake: true, seenAt: Date.now() };
    const loadAbort = { requestId, controller: new AbortController() };
    this.loadAbort = loadAbort;
    try {
      await this.sleepGuard.acquire(reuse ? 'serving a booked model' : 'downloading and loading a booked model');
      loadAbort.controller.signal.throwIfAborted();
      if (this.stopped || this.draining) throw new Error('Agent stopped or draining');
      this.syncDashboard({
        status: 'working',
        wakeLock: this.sleepGuard.status().active,
        message: requestId.startsWith('bench_') ? 'Loading a model for the benchmark' : reuse ? 'This model is already loaded; reusing it' : 'Pulling the requested GGUF',
      });
      let model: AgentModel;
      if (reuse) {
        // The wake-lock wait may have let another load or a stop change the engine.
        const now = this.runnerPlan(reuse.path, context, this.slotsAfterLoad(loadSlots), requestId);
        if (this.loadedModelFor(load) !== reuse || now.action !== 'reuse') {
          throw new Error('The loaded model changed while this request waited; retry');
        }
        if (now.note) this.logger.warn(now.note);
        this.tunnel?.send({ type: 'progress', requestId, note: 'Model already loaded; reusing the running engine' });
        model = reuse;
      } else {
        this.tunnel?.send({ type: 'progress', requestId, note: 'Starting download' });
        // The server may only point at a HuggingFace download, never at a file or address on this machine.
        const url = checkModelUrl(String(load.url || ''));
        model = await this.loadModel(url, {
          context,
          requestId,
          signal: loadAbort.controller.signal,
          expectedSha: load.sha256,
          expectedLayers: load.layers,
          file: load.file,
        });
      }
      loadAbort.controller.signal.throwIfAborted();
      if (this.stopped || this.draining) throw new Error('Agent stopped or draining');
      this.model = model;
      this.loadingModel = false;
      const servedContext = this.runnerContext ?? context;
      const pending = this.pending?.requestId === requestId ? this.pending : null;
      if (pending) {
        Object.assign(pending, { model: model.file, loaded: true, slots: this.capacity(), context: servedContext, seenAt: Date.now() });
      }
      this.tunnel?.send({
        type: 'loaded',
        requestId,
        sha256: model.sha256,
        file: model.file,
        layers: model.layers,
        context: servedContext,
        llamaUp: this.options.simulation || this.runner?.status === 'ready',
      });
      this.syncDashboard({
        llamaStatus: this.runner?.status || 'simulation',
        message: reuse ? 'Model already loaded. Waiting for the server model check.'
          : this.options.simulation ? 'Simulation loaded. Waiting for the server check.'
            : model.verified ? 'File hash matched. Waiting for the server model check.'
              : 'Model loaded without a reference hash. Waiting for the server model check.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.loadingModel = false;
      if (this.pending?.requestId === requestId) this.pending = null;
      await this.releaseWakeLockIfIdle();
      if (this.stopped) return;
      this.tunnel?.send({ type: 'load_failed', requestId, message });
      this.logger.error('Request load failed', { error: message });
      this.syncDashboard({ status: this.bookings.size ? 'working' : 'online', message: `Load failed: ${message}` });
    } finally {
      this.loadInFlight = false;
      if (this.loadAbort?.requestId === requestId) this.loadAbort = null;
    }
  }

  private async refreshMe(): Promise<void> {
    // Bookings confirmed after this moment are newer than the answer and are never dropped by it.
    const askedAt = Date.now();
    try {
      const me = await fetchJson<AgentMe>(apiUrl(this.options.config.server, '/api/agent/me'), {
        token: this.options.config.token,
        timeoutMs: 10_000,
      });
      if (this.stopped) return;
      this.noteServerClock(me);
      const endpoint = await this.endpointFor(this.options.config);
      if (this.stopped) return;
      this.me = me;
      if (this.meInitialWallet == null) this.meInitialWallet = me.wallet.availableNanos;
      const host = me.host;
      const ended = this.reconcileBookings(me, askedAt);
      this.syncDashboard({
        username: me.user.username,
        endpoint,
        reliability: host?.uptimePct ?? null,
        held: host?.status === 'held',
        walletNanos: me.wallet.availableNanos + me.wallet.pendingNanos,
        liveTokPerSec: this.lastSpeed || this.dashboard.current.liveTokPerSec,
        lastHeartbeatAt: this.heartbeatAt,
        ...(ended.length ? {
          status: this.bookings.size || this.activeJobs.size ? 'working' : 'online',
          message: ended.length === 1 ? `Booking ${ended[0]} ended` : `${ended.length} bookings ended`,
        } as Partial<DashboardState> : {}),
      });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 405)) {
        this.logger.debug('Server does not expose /api/agent/me; dashboard will use tunnel state only.');
      } else {
        this.logger.debug('Could not refresh host status', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Makes the bookings match the server's list of live requests: adds booked ones this agent
   * missed (never one that already ended here or whose end has passed on the server's clock),
   * updates timers, and drops bookings the server no longer lists. Also keeps the ids of every
   * live request for servingOthers(). Returns the dropped ids.
   */
  private reconcileBookings(me: AgentMe, askedAt: number): string[] {
    // activeRequestsOf drops rows with a malformed id and turns broken numbers into null.
    const listed = activeRequestsOf(me);
    const ids = new Set(listed.map((row) => row.id));
    // Whether a listed booking is over is judged by the server's clock, not this machine's.
    const now = this.serverTime();
    const over = (row: { status: string; timerEndsAt?: number | null }) => row.status === 'active' && row.timerEndsAt != null && row.timerEndsAt <= now;
    this.liveRequestIds = new Set(listed
      .filter((row) => LIVE_STATUSES.has(row.status) && !this.endedIds.has(row.id) && !over(row))
      .map((row) => row.id));
    const newest = isRequestId(me.activeRequest?.id) ? me.activeRequest.id : null;
    let changed = newest !== this.serverNewestId && this.bookings.size > 0;
    this.serverNewestId = newest;
    let added = false;
    for (const row of listed) {
      if (row.status !== 'active' && row.status !== 'awaiting_confirm') continue;
      // A booking that ended here stays ended, whatever an answer built before the end still says.
      if (this.endedIds.has(row.id) || over(row)) continue;
      const existing = this.bookings.get(row.id);
      // A running booking always has an end time; a row without a valid one is not added.
      if (!existing && row.status === 'active' && !row.timerEndsAt) continue;
      if (!existing) added = true;
      const hours = row.hours || existing?.hours || null;
      const price = row.pricePerHourNanos || existing?.pricePerHourNanos || null;
      const tokS = row.tokS === undefined ? undefined : row.tokS && row.tokS > 0 ? row.tokS : null;
      this.upsertBooking(row.id, {
        model: existing?.model ?? (row.file ? printable(row.file) : undefined),
        verified: Boolean(row.timerStartedAt) || existing?.verified || (this.pending?.requestId === row.id && this.pending.verified),
        timerStartedAt: row.timerStartedAt || undefined,
        timerEndsAt: row.timerEndsAt || undefined,
        hours: hours ?? undefined,
        pricePerHourNanos: price ?? undefined,
        minTokS: row.minTokS === undefined ? undefined : row.minTokS || null,
        guaranteedNanos: hours && price ? Math.round(hours * price) : undefined,
        shared: row.shared == null ? (tokS != null ? true : undefined) : Boolean(row.shared),
        tokS,
      });
      changed = true;
    }
    const ended: string[] = [];
    for (const booking of [...this.bookings.values()]) {
      if (ids.has(booking.requestId) || booking.seenAt >= askedAt) continue;
      this.removeBooking(booking.requestId);
      ended.push(booking.requestId);
      changed = true;
    }
    if (ended.length) this.logger.info('Bookings ended on the server', { requestIds: ended.join(',') });
    // A loaded request the server stopped listing no longer keeps the machine awake.
    const pending = this.pending;
    let released = ended.length > 0;
    let wake = added;
    if (pending && !this.loadInFlight) {
      if (ids.has(pending.requestId)) {
        // Listed again after a gap: it keeps the machine awake again.
        if (!pending.holdsWake) wake = true;
        pending.holdsWake = true;
      } else if (pending.holdsWake && this.activeJobs.size === 0 && pending.seenAt < askedAt) {
        pending.holdsWake = false;
        released = true;
      }
    }
    if (changed) this.persistBookings();
    if (wake) this.holdWakeLock();
    if (released) void this.releaseWakeLockIfIdle();
    return ended;
  }

  private setupKeyboard(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY || this.keyHandler) return;
    const handler = (data: Buffer) => { void this.handleKey(data.toString()); };
    this.keyHandler = handler;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handler);
    this.dashboard.update({ keyHint: 'W host page · C copy endpoint · L logs · ? help' });
  }

  private async handleKey(key: string): Promise<void> {
    if (key === '\u0003') {
      await this.stop();
      return;
    }
    if (key === 'w' || key === 'W') {
      const url = this.hostPageUrl();
      this.openExternal(url);
      this.dashboard.update({ message: `Host page: ${url}` });
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
      this.dashboard.update({ message: 'W host page · C copy endpoint · L logs · Ctrl+C stop' });
    }
  }

  /** The website page with this host's earnings, reliability, and current request. */
  private hostPageUrl(): string {
    return `${this.options.config.server.replace(/\/+$/, '')}/host`;
  }

  private openExternal(url: string): void {
    openUrl(url, this.options.config.server);
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
          this.gpu = applyGpuOverride(await this.gpuMonitor.scan(true), this.options.gpuOverride);
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
    if (!this.stopped) this.dashboard.update({ wakeLock: false });
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

  stop(preserveState = false): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopOwned(preserveState);
    return this.stopPromise;
  }

  private async stopOwned(preserveState: boolean): Promise<void> {
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
    this.clearBookingTimers();
    this.meTimer = null;
    this.gpuTimer = null;
    this.bookingTimer = null;
    // In memory only: with preserveState the bookings stay in state.json for the next start.
    this.bookings.clear();
    this.pending = null;
    this.loadingModel = false;
    // Ctrl+C clears saved state, also while a restore is still working on it; the restore then stops early.
    if (!preserveState) this.clearPersistedBooking(this.restoring);
    this.selfCheckAbort?.abort();
    this.loadAbort?.controller.abort(new Error('Agent stopping'));
    for (const job of this.activeJobs.values()) job.controller.abort(new Error('Agent stopping'));
    this.activeJobs.clear();
    this.startup.abort(new Error('Agent stopping'));
    try { await this.releaseResources(); } finally { this.emit('stop'); }
  }

  /** Frees the wake lock, tunnel, llama-server and terminal. run() calls it again when startup finishes after stop(). */
  private async releaseResources(): Promise<void> {
    for (const timer of [this.meTimer, this.gpuTimer, this.bookingTimer]) if (timer) clearInterval(timer);
    this.clearBookingTimers();
    this.meTimer = null;
    this.gpuTimer = null;
    this.bookingTimer = null;
    const errors: unknown[] = [];
    for (const cleanup of [
      () => this.cleanupKeyboard(),
      () => this.sleepGuard.stop(),
      () => this.tunnel?.stop(),
      () => this.runner?.stop(),
      () => {
        this.runner = null;
        this.runnerModelPath = null;
        this.runnerContext = null;
        this.runnerSlotCount = null;
        this.dashboard.stop();
      },
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }
}
