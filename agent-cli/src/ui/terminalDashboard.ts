import { formatClock, formatDuration, formatPercent, formatSpeed, formatUsdNanos, modelShortName, padRight, stripAnsi, truncate } from '../util/format.js';
import { BRAND, VERSION } from '../version.js';

export type DashboardStatus = 'starting' | 'online' | 'working' | 'reconnecting' | 'offline' | 'auth-failed' | 'outdated' | 'paused';

export type DashboardJob = {
  kind: 'request' | 'public';
  id?: string | null;
  model?: string | null;
  verified?: boolean;
  timerStartedAt?: number | null;
  timerEndsAt?: number | null;
  minTokS?: number | null;
  guaranteedNanos?: number | null;
  hours?: number | null;
  /** A speed seat that shares the GPU. */
  shared?: boolean;
  /** Reserved speed of a seat; null means the full GPU. */
  tokS?: number | null;
};

export type DashboardState = {
  status: DashboardStatus;
  username: string | null;
  endpoint: string | null;
  server: string;
  reliability: number | null;
  held: boolean;
  gpuName: string | null;
  totalVramMb: number;
  freeVramMb: number;
  gpuTempC: number | null;
  gpuPowerW: number | null;
  gpuUtilPct: number | null;
  wakeLock: boolean;
  llamaStatus: string;
  /** The request in focus: the one loading or being checked, else the booking that ends first. */
  job: DashboardJob | null;
  /** Every booking on this host, soonest end first. */
  bookings?: DashboardJob[];
  liveTokPerSec: number | null;
  /** Per-token earnings plus the time-proportional share of every booking. */
  sessionEarnedNanos: number;
  sessionGuaranteedNanos: number;
  /** The per-token part of sessionEarnedNanos. */
  tokenEarnedNanos?: number;
  publicMode?: boolean;
  /** Public mode prices, shown on the dashboard. */
  priceOutUsd?: number | null;
  priceHourUsd?: number | null;
  walletNanos: number | null;
  lastHeartbeatAt: number | null;
  message: string | null;
  showLogs?: boolean;
  logTail?: string[];
  keyHint?: string | null;
};

export function initialState(server: string): DashboardState {
  return {
    status: 'starting',
    username: null,
    endpoint: null,
    server,
    reliability: null,
    held: false,
    gpuName: null,
    totalVramMb: 0,
    freeVramMb: 0,
    gpuTempC: null,
    gpuPowerW: null,
    gpuUtilPct: null,
    wakeLock: false,
    llamaStatus: 'not started',
    job: null,
    bookings: [],
    liveTokPerSec: null,
    sessionEarnedNanos: 0,
    sessionGuaranteedNanos: 0,
    tokenEarnedNanos: 0,
    publicMode: false,
    priceOutUsd: null,
    priceHourUsd: null,
    walletNanos: null,
    lastHeartbeatAt: null,
    message: null,
    showLogs: false,
    logTail: [],
    keyHint: null,
  };
}

function statusLabel(state: DashboardState): { text: string; status: DashboardStatus } {
  if (state.status === 'auth-failed') return { text: 'AUTH FAILED', status: state.status };
  if (state.status === 'outdated') return { text: 'UPDATE NEEDED', status: state.status };
  if (state.status === 'reconnecting') return { text: 'RECONNECTING', status: state.status };
  if (state.status === 'paused') return { text: 'HELD', status: state.status };
  if (state.status === 'offline') return { text: 'OFFLINE', status: state.status };
  if (state.status === 'working') return { text: 'WORKING', status: state.status };
  if (state.status === 'starting') return { text: 'STARTING', status: state.status };
  return { text: 'ONLINE', status: state.status };
}

function valueOrDash(value: string | null | undefined): string {
  return value && value.trim() ? value : '-';
}

function gpuLine(state: DashboardState): string {
  if (!state.gpuName) return 'No GPU detected (use --gpu / --vram for a test node)';
  const total = state.totalVramMb > 0 ? `${(state.totalVramMb / 1024).toFixed(1)} GB` : '? GB';
  const free = state.freeVramMb > 0 ? `${(state.freeVramMb / 1024).toFixed(1)} GB` : '? GB';
  const util = state.gpuUtilPct != null ? ` · ${state.gpuUtilPct.toFixed(0)}% util` : '';
  return `${state.gpuName} (${free} free / ${total})${util}`;
}

function thermalLine(state: DashboardState): string {
  const temp = state.gpuTempC != null ? `${state.gpuTempC.toFixed(0)}°C` : 'temp n/a';
  const power = state.gpuPowerW != null ? `${state.gpuPowerW.toFixed(0)}W` : 'power n/a';
  const lock = state.wakeLock ? 'Wake-Lock: ACTIVE - sleep blocked' : 'Wake-Lock: idle';
  return `${temp} · ${power} · ${lock}`;
}

function tokS(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A positive finite number, or null: a broken value never prints as NaN (or throws in toFixed). */
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** "50 tok/s" for a speed seat, "full GPU" for an exclusive rental. */
export function rentalLabel(job: DashboardJob): string {
  const speed = positive(job.tokS);
  if (speed) return `${tokS(speed)} tok/s`;
  return job.shared ? 'shared seat' : 'full GPU';
}

/** "2 rentals: 50 tok/s + full GPU"; with more than three, "4 rentals, 150 tok/s reserved". */
export function rentalsSummary(rentals: DashboardJob[]): string {
  if (rentals.length <= 3) return `${rentals.length} rental${rentals.length === 1 ? '' : 's'}: ${rentals.map(rentalLabel).join(' + ')}`;
  const reserved = rentals.reduce((sum, job) => sum + (positive(job.tokS) ?? 0), 0);
  const full = rentals.some((job) => !positive(job.tokS) && !job.shared) ? ' + full GPU' : '';
  return `${rentals.length} rentals, ${tokS(reserved)} tok/s reserved${full}`;
}

function jobLine(state: DashboardState): string {
  const job = state.job;
  const rentals = state.bookings ?? [];
  const single = rentals[0];
  // One full-GPU rental keeps the classic label; seats, several rentals, or public selling list every rental.
  if (rentals.length > 1 || (single && (state.publicMode || single.tokS || single.shared))) {
    const loading = job?.kind === 'request' && job.id && !rentals.some((rental) => rental.id === job.id) ? ' + 1 loading' : '';
    return `${state.publicMode ? 'Per-token + ' : ''}${rentalsSummary(rentals)}${loading}`;
  }
  if (!job) return 'Standby - waiting for a web request';
  if (job.kind === 'public') return `Public pay-per-token${job.model ? ` · ${modelShortName(job.model)}` : ''}`;
  if (job.id?.startsWith('bench_')) return 'Benchmark: measuring this GPU (no buyer)';
  return `Dedicated Buyer Request${job.id ? ` (#${job.id.replace(/^req_/, '').slice(0, 12)})` : ''}`;
}

function pricesLine(state: DashboardState): string | null {
  if (!state.publicMode || state.priceOutUsd == null) return null;
  const hourly = state.priceHourUsd && state.priceHourUsd > 0 ? `$${state.priceHourUsd.toFixed(2)}/h full GPU` : 'no hourly rentals';
  return `$${state.priceOutUsd.toFixed(2)} per 1M tokens · ${hourly}`;
}

function modelLine(state: DashboardState): string {
  const model = state.job?.model || null;
  if (!model) return state.llamaStatus === 'ready' ? 'llama-server ready' : state.llamaStatus;
  const mark = state.job?.verified ? ' ✓ verified' : '';
  return `${modelShortName(model)}${mark}`;
}

function timerLine(state: DashboardState): string {
  // With several rentals, show the one that ends first.
  const timed = (state.bookings ?? []).filter((rental) => rental.timerEndsAt)
    .sort((a, b) => (a.timerEndsAt ?? 0) - (b.timerEndsAt ?? 0));
  const job = timed[0] ?? state.job;
  if (!job?.timerEndsAt) return job?.kind === 'request' ? 'Timer starts after the model is verified' : '-';
  const remaining = Math.max(0, Math.floor((job.timerEndsAt - Date.now()) / 1000));
  const total = job.hours ? Math.round(job.hours * 3600) : Math.max(remaining, 1);
  return `${formatClock(remaining)} / ${formatClock(total)}${timed.length > 1 ? ` · first of ${timed.length} to end` : ''}`;
}

function speedLine(state: DashboardState): string {
  const speed = formatSpeed(state.liveTokPerSec);
  const reserved = (state.bookings ?? []).reduce((sum, job) => sum + (positive(job.tokS) ?? 0), 0);
  if (reserved > 0) return `${speed} (${tokS(reserved)} tok/s reserved by seats)`;
  const minTokS = positive(state.job?.minTokS);
  const min = minTokS ? ` (min required: ${minTokS.toFixed(1)} tok/s${state.liveTokPerSec != null && state.liveTokPerSec >= minTokS ? ' ✓' : ' !'})` : '';
  return `${speed}${min}`;
}

function earningsLine(state: DashboardState): string {
  const guaranteed = state.bookings?.length ? state.sessionGuaranteedNanos : (state.job?.guaranteedNanos ?? state.sessionGuaranteedNanos);
  const tokens = state.tokenEarnedNanos ?? 0;
  const split = tokens > 0 && state.sessionEarnedNanos > tokens ? ` (${formatUsdNanos(tokens)} per-token)` : '';
  return `${formatUsdNanos(state.sessionEarnedNanos)}${split}${guaranteed > 0 ? ` / ${formatUsdNanos(guaranteed)} Guaranteed` : ' this session'}`;
}

export function renderFrame(state: DashboardState, options: { width?: number; color?: boolean; unicode?: boolean } = {}): string {
  const width = Math.max(54, options.width ?? 72);
  const unicode = options.unicode ?? true;
  const tl = unicode ? '┌' : '+';
  const tr = unicode ? '┐' : '+';
  const bl = unicode ? '└' : '+';
  const br = unicode ? '┘' : '+';
  const h = unicode ? '─' : '-';
  const v = unicode ? '│' : '|';
  const ml = unicode ? '├' : '+';
  const mr = unicode ? '┤' : '+';
  const status = statusLabel(state);
  const dot = unicode ? '●' : '*';
  const title = `${BRAND} GPU TERMINAL AGENT v${VERSION}`;
  const statusText = `${dot} ${status.text}`;
  const inner = width - 2;
  const top = `${tl}${h.repeat(inner)}${tr}`;
  const divider = `${ml}${h.repeat(inner)}${mr}`;
  const bottom = `${bl}${h.repeat(inner)}${br}`;
  const lines: string[] = [];
  const add = (left: string, right = '') => {
    const leftText = `  ${left}`;
    const available = inner - 2;
    const rightWidth = stripAnsi(right).length;
    const clippedLeft = truncate(leftText, Math.max(0, available - rightWidth - 1));
    const leftWidth = stripAnsi(clippedLeft).length;
    const gap = Math.max(1, available - leftWidth - rightWidth);
    const body = clippedLeft + ' '.repeat(gap) + right;
    lines.push(`${v}${padRight(truncate(body, inner), inner)}${v}`);
  };
  const single = (text: string) => {
    const body = `  ${text}`;
    lines.push(`${v}${padRight(truncate(body, inner), inner)}${v}`);
  };

  lines.push(top);
  add(`${title}`, `STATUS: ${statusText}`);
  lines.push(divider);
  add(`Host Endpoint : ${valueOrDash(state.endpoint)}`);
  add(`Reliability   : ${state.reliability != null ? formatPercent(state.reliability) : '-'}${state.held ? '  (HELD - see your host page)' : state.reliability != null ? '  (OK - held only after repeated failures)' : ''}`);
  add(`GPU Detected  : ${truncate(gpuLine(state), inner - 20)}`);
  add(`GPU Temp/Power: ${thermalLine(state)}`);
  lines.push(divider);
  add(`CURRENT JOB   : ${jobLine(state)}`);
  const prices = pricesLine(state);
  if (prices) add(`Prices        : ${prices}`);
  add(`Model Loaded  : ${modelLine(state)}`);
  add(`Time Remaining: ${timerLine(state)}`);
  add(`Live Speed    : ${speedLine(state)}`);
  lines.push(divider);
  add(`Session Earn. : ${earningsLine(state)}`);
  add(`Total Wallet  : ${state.walletNanos != null ? formatUsdNanos(state.walletNanos) : '-'}`);
  add(`Server        : ${truncate(state.server, inner - 20)}`, state.lastHeartbeatAt ? `hb ${Math.max(0, Math.round((Date.now() - state.lastHeartbeatAt) / 1000))}s` : 'no heartbeat');
  if (state.keyHint) add(`Keys          : ${truncate(state.keyHint, inner - 20)}`);
  if (state.showLogs && state.logTail?.length) {
    for (const line of state.logTail.slice(-3)) single(`log  ${truncate(line, inner - 8)}`);
  }
  if (state.message) add(`Note          : ${truncate(state.message, inner - 20)}`);
  lines.push(bottom);

  if (!options.color) return lines.join('\n');
  const paintStatus = (text: string): string => {
    const color = status.status === 'online' || status.status === 'working'
      ? '\x1b[32m'
      : status.status === 'starting' || status.status === 'reconnecting'
        ? '\x1b[33m'
        : '\x1b[31m';
    return `${text.replace(statusText, `${color}${statusText}\x1b[0m`)}`;
  };
  return lines.map((line, index) => index === 1 ? paintStatus(line) : line).join('\n');
}

export class TerminalDashboard {
  private state: DashboardState;
  private readonly stream: NodeJS.WriteStream;
  private readonly color: boolean;
  private readonly unicode: boolean;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private lastFrame = '';
  private lastStatus: DashboardStatus | null = null;

  constructor(state: DashboardState, options: { stream?: NodeJS.WriteStream; color?: boolean; unicode?: boolean; intervalMs?: number; enabled?: boolean } = {}) {
    this.state = state;
    this.stream = options.stream ?? process.stdout;
    this.color = options.color ?? Boolean(this.stream.isTTY);
    this.unicode = options.unicode ?? true;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.enabled = options.enabled ?? true;
  }

  get current(): DashboardState { return this.state; }

  start(): void {
    if (this.started || !this.enabled) return;
    this.started = true;
    this.lastStatus = this.state.status;
    if (!this.stream.isTTY) {
      this.printOnce();
      return;
    }
    this.stream.write('\x1b[?25l');
    this.rerender(true);
    this.timer = setInterval(() => this.rerender(false), this.intervalMs);
  }

  update(partial: Partial<DashboardState>): void {
    this.state = { ...this.state, ...partial };
    if (!this.started) return;
    if (!this.stream.isTTY) {
      if (this.state.status !== this.lastStatus) {
        this.lastStatus = this.state.status;
        this.printOnce();
      }
      return;
    }
    this.rerender(false);
  }

  setJob(job: DashboardJob | null): void {
    this.update({ job });
  }

  private printOnce(): void {
    this.stream.write(`${renderFrame(this.state, { color: this.color, unicode: this.unicode })}\n`);
  }

  private rerender(force: boolean): void {
    const frame = renderFrame(this.state, { color: this.color, unicode: this.unicode });
    if (!force && frame === this.lastFrame) return;
    this.lastFrame = frame;
    if (force) this.stream.write('\x1b[H\x1b[2J');
    else this.stream.write('\x1b[H');
    this.stream.write(frame);
    this.stream.write('\x1b[0J');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream.isTTY && this.started) this.stream.write('\x1b[?25h\n');
    this.started = false;
  }
}
