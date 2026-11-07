import { formatBytes, formatBytesPerSec, formatDuration } from '../util/format.js';

export type ProgressOptions = {
  label: string;
  total: number;
  width?: number;
  stream?: NodeJS.WriteStream;
  enabled?: boolean;
  showEveryMs?: number;
};

export class ProgressBar {
  private readonly stream: NodeJS.WriteStream;
  private readonly enabled: boolean;
  private readonly width: number;
  private readonly label: string;
  private total: number;
  private current = 0;
  private startedAt = Date.now();
  private lastRender = 0;
  private lastLine = '';
  private finished = false;

  constructor(options: ProgressOptions) {
    this.stream = options.stream ?? process.stderr;
    this.enabled = options.enabled ?? Boolean(this.stream.isTTY);
    this.width = options.width ?? 24;
    this.label = options.label;
    this.total = Math.max(0, options.total);
    this.lastTickMs = options.showEveryMs ?? 100;
    this.startedAt = Date.now();
  }

  private lastTickMs: number;

  setTotal(total: number): void {
    this.total = Math.max(0, total);
  }

  tick(delta: number, total?: number): void {
    if (total != null) this.total = total;
    this.current += Math.max(0, delta);
    this.render(false);
  }

  set(current: number, total?: number): void {
    this.current = Math.max(0, current);
    if (total != null) this.total = Math.max(0, total);
    this.render(false);
  }

  line(): string {
    const ratio = this.total > 0 ? Math.min(1, this.current / this.total) : 0;
    const filled = Math.round(ratio * this.width);
    const bar = `${'='.repeat(filled)}${' '.repeat(this.width - filled)}`;
    const elapsed = Math.max(0.001, (Date.now() - this.startedAt) / 1000);
    const speed = this.current / elapsed;
    const eta = speed > 0 && this.total > 0 ? Math.max(0, (this.total - this.current) / speed) : null;
    const percent = this.total > 0 ? ratio * 100 : 0;
    return `${this.label} ${percent.toFixed(0).padStart(3)}% [${bar}] ${formatBytes(this.current)}${this.total ? ` / ${formatBytes(this.total)}` : ''}  ${formatBytesPerSec(speed)}  ETA ${formatDuration(eta)}`;
  }

  render(force: boolean): void {
    if (this.finished) return;
    const now = Date.now();
    if (!force && now - this.lastRender < this.lastTickMs) return;
    this.lastRender = now;
    if (!this.enabled) return;
    const line = this.line();
    if (line === this.lastLine) return;
    this.lastLine = line;
    this.stream.write(`\r\x1b[2K${line}`);
  }

  done(message?: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.enabled) {
      this.stream.write(`\r\x1b[2K${this.line()}\n`);
      if (message) this.stream.write(`${message}\n`);
    }
  }

  fail(message?: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.enabled) {
      this.stream.write(`\r\x1b[2K${this.label} failed${message ? `: ${message}` : ''}\n`);
    }
  }
}
