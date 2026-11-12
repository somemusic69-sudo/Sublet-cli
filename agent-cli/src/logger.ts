import { appendFileSync, chmodSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { colorEnabled, paint, type ColorName } from './util/format.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export type LogFields = Record<string, unknown>;

/** Host keys (sh_...), API keys (sk-...), and bearer tokens never reach a terminal or a log file in full. */
// Order matters: whole bearer values and token= parameters first, then any bare key left in free text.
const SECRET_PATTERNS: Array<[RegExp, (match: string) => string]> = [
  [/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, (m) => `${m.split(/\s+/)[0]} ***`],
  [/([?&](?:token|access_token|api_key|key|signature|sig)=)[^&\s"']+/gi, (m) => `${m.slice(0, m.indexOf('=') + 1)}***`],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, (m) => `${m.slice(0, m.indexOf('://') + 3)}***@`],
  [/\b(sh_|sk-)[A-Za-z0-9_-]{6,}/g, (m) => `${m.slice(0, 6)}***`],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replace] of SECRET_PATTERNS) out = out.replace(pattern, replace);
  // Do not let a remote error string clear the terminal or forge a second log line.
  return out.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export type LogFileOptions = {
  path: string;
  /** Rotate when the file reaches this size. Default 10 MB. */
  maxBytes?: number;
  /** Rotated files to keep (agent.log.1 ... agent.log.N). Default 5. */
  keep?: number;
  /** Called once if logging fails. No error text or credentials are passed. */
  onError?: () => void;
};

/**
 * A synchronous, size-rotated JSON-lines log file. Synchronous writes keep the
 * last lines before a crash; agent logs are a few lines a minute, so the cost is negligible.
 */
export class LogFile {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private size = -1;
  private failed = false;
  private readonly onError: () => void;

  constructor(options: LogFileOptions) {
    this.path = options.path;
    this.maxBytes = Number.isFinite(options.maxBytes) ? Math.max(64 * 1024, Math.floor(options.maxBytes!)) : 10 * 1024 * 1024;
    this.keep = Number.isFinite(options.keep) ? Math.max(1, Math.min(50, Math.floor(options.keep!))) : 5;
    this.onError = options.onError ?? (() => { process.stderr.write('Warning: agent file logging stopped; check disk space and log-file permissions.\n'); });
  }

  write(line: string): void {
    if (this.failed) return;
    try {
      if (this.size < 0) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        try {
          const stat = lstatSync(this.path);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Log must be a regular file');
          this.size = stat.size;
          if (process.platform !== 'win32') chmodSync(this.path, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          this.size = 0;
        }
      }
      // Do not persist an oversized record, even when the file was empty.
      const data = Buffer.byteLength(line) + 1 > this.maxBytes
        ? `${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', message: 'Oversized log record omitted', truncated: true })}\n`
        : `${line}\n`;
      if (this.size + Buffer.byteLength(data) > this.maxBytes && this.size > 0) this.rotate();
      appendFileSync(this.path, data, { encoding: 'utf8', mode: 0o600 });
      this.size += Buffer.byteLength(data);
    } catch {
      // A full disk or a read-only home must never stop a booking; the terminal still has the logs.
      this.failed = true;
      try { this.onError(); } catch { /* diagnostics must not stop serving */ }
    }
  }

  private rotate(): void {
    rmSync(`${this.path}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      try { renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try { renameSync(this.path, `${this.path}.1`); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.size = 0;
  }
}

export type LoggerOptions = {
  level?: LogLevel;
  json?: boolean;
  color?: boolean;
  stream?: NodeJS.WriteStream;
  /** Every record (debug included) is also written here as JSON lines. */
  file?: LogFile | null;
};

export class Logger {
  readonly level: LogLevel;
  readonly json: boolean;
  readonly color: boolean;
  readonly file: LogFile | null;
  private readonly stream: NodeJS.WriteStream;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.json = options.json ?? false;
    this.color = options.color ?? colorEnabled(process.stderr);
    this.stream = options.stream ?? process.stderr;
    this.file = options.file ?? null;
  }

  child(options: Partial<LoggerOptions>): Logger {
    return new Logger({ level: this.level, json: this.json, color: this.color, stream: this.stream, file: this.file, ...options });
  }

  debug(message: string, fields?: LogFields): void { this.write('debug', message, fields); }
  info(message: string, fields?: LogFields): void { this.write('info', message, fields); }
  warn(message: string, fields?: LogFields): void { this.write('warn', message, fields); }
  error(message: string, fields?: LogFields): void { this.write('error', message, fields); }

  success(message: string, fields?: LogFields): void {
    this.write('info', message, { ...fields, ok: true });
  }

  private write(level: Exclude<LogLevel, 'silent'>, rawMessage: string, rawFields?: LogFields): void {
    const toFile = this.file != null;
    const toStream = ORDER[level] >= ORDER[this.level];
    if (!toFile && !toStream) return;
    const message = redactSecrets(rawMessage);
    const fields = rawFields ? redactFields(rawFields) : undefined;
    // Redact BEFORE serialization: rewriting escaped JSON can corrupt records.
    const record = (toFile || this.json) ? JSON.stringify({ ...fields, ts: new Date().toISOString(), level, message }) : '';
    if (toFile) this.file!.write(record);
    if (!toStream) return;
    if (this.json) {
      this.stream.write(`${record}\n`);
      return;
    }
    const label = level === 'info' ? '•' : level === 'warn' ? '!' : level === 'error' ? 'x' : '·';
    const color: ColorName = level === 'warn' ? 'yellow' : level === 'error' ? 'red' : level === 'debug' ? 'gray' : 'cyan';
    const prefix = paint(label, color, this.color);
    const suffix = fields && Object.keys(fields).length
      ? ` ${paint(formatFields(fields), 'gray', this.color)}`
      : '';
    this.stream.write(`${prefix} ${message}${suffix}\n`);
  }
}

const SECRET_KEYS = /^(token|key|hostkey|apikey|authorization|proxyauthorization|password|secret|accesstoken|refreshtoken|devicecode|cookie|setcookie|prompt|messages|content)$/i;

export function redactFields(fields: LogFields): LogFields {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return redactSecrets(value);
    if (typeof value === 'bigint') return value.toString();
    if (value == null || typeof value !== 'object') return typeof value === 'function' ? '[function]' : value;
    if (depth > 8) return '[depth limit]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.slice(0, 100).map((item) => visit(item, depth + 1));
      const out: LogFields = Object.create(null) as LogFields;
      for (const key of Object.keys(value).slice(0, 100)) {
        if (SECRET_KEYS.test(key.replace(/[-_]/g, ''))) { out[key] = '***'; continue; }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        out[redactSecrets(key)] = descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[accessor]';
      }
      return out;
    } finally { seen.delete(value); }
  };
  try { return visit(fields, 0) as LogFields; } catch { return { fields: '[unavailable]' }; }
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      if (typeof value === 'string') return `${key}=${value.includes(' ') ? JSON.stringify(value) : value}`;
      if (typeof value === 'number' || typeof value === 'boolean') return `${key}=${value}`;
      return `${key}=${JSON.stringify(value)}`;
    })
    .join(' ');
}
