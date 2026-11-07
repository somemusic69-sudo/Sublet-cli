import { formatClock, formatDuration, formatPercent, formatSpeed, formatUsdNanos, modelShortName, padRight, stripAnsi, truncate } from '../util/format.js';
import { BRAND, VERSION } from '../version.js';

export type DashboardStatus = 'starting' | 'online' | 'working' | 'reconnecting' | 'offline' | 'auth-failed' | 'outdated' | 'paused';

export type DashboardJob = {
  kind: 'request' | 'public' | 'canary';
  id?: string | null;
  model?: string | null;
  verified?: boolean;
  timerStartedAt?: number | null;
  timerEndsAt?: number | null;
  minTokS?: number | null;
  guaranteedNanos?: number | null;
  hours?: number | null;
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
  job: DashboardJob | null;
  liveTokPerSec: number | null;
  sessionEarnedNanos: number;
  sessionGuaranteedNanos: number;
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
    liveTokPerSec: null,
    sessionEarnedNanos: 0,
    sessionGuaranteedNanos: 0,
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

function jobLine(state: DashboardState): string {
  const job = state.job;
  if (!job) return 'Standby - waiting for a web request';
  if (job.kind === 'canary') return 'Canary handshake (temp=0)';
  if (job.kind === 'public') return `Public pay-per-token${job.model ? ` · ${modelShortName(job.model)}` : ''}`;
  return `Dedicated Buyer Request${job.id ? ` (#${job.id.replace(/^req_/, '').slice(0, 12)})` : ''}`;
}

function modelLine(state: DashboardState): string {
  const model = state.job?.model || null;
  if (!model) return state.llamaStatus === 'ready' ? 'llama-server ready' : state.llamaStatus;
  const mark = state.job?.verified ? ' ✓ verified' : '';
  return `${modelShortName(model)}${mark}`;
}

function timerLine(state: DashboardState): string {
  const job = state.job;
  if (!job?.timerEndsAt) return job?.kind === 'request' ? 'Timer starts after the model is verified' : '-';
  const remaining = Math.max(0, Math.floor((job.timerEndsAt - Date.now()) / 1000));
  const total = job.hours ? Math.round(job.hours * 3600) : Math.max(remaining, 1);
  return `${formatClock(remaining)} / ${formatClock(total)}`;
}

function speedLine(state: DashboardState): string {
  const speed = formatSpeed(state.liveTokPerSec);
  const min = state.job?.minTokS ? ` (min required: ${state.job.minTokS.toFixed(1)} tok/s${state.liveTokPerSec != null && state.liveTokPerSec >= state.job.minTokS ? ' ✓' : ' !'})` : '';
  return `${speed}${min}`;
}

function earningsLine(state: DashboardState): string {
  const guaranteed = state.job?.guaranteedNanos ?? state.sessionGuaranteedNanos;
  return `${formatUsdNanos(state.sessionEarnedNanos)}${guaranteed > 0 ? ` / ${formatUsdNanos(guaranteed)} Guaranteed` : ' this session'}`;
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
  add(`Reliability   : ${state.reliability != null ? formatPercent(state.reliability) : '-'}${state.held ? '  (HELD - under 90%)' : state.reliability != null ? '  (safe - auto-ban < 90.0%)' : ''}`);
  add(`GPU Detected  : ${truncate(gpuLine(state), inner - 20)}`);
  add(`GPU Temp/Power: ${thermalLine(state)}`);
  lines.push(divider);
  add(`CURRENT JOB   : ${jobLine(state)}`);
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
