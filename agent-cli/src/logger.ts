import { colorEnabled, paint, type ColorName } from './util/format.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogFields = Record<string, unknown>;

export type LoggerOptions = {
  level?: LogLevel;
  json?: boolean;
  color?: boolean;
  stream?: NodeJS.WriteStream;
};

export class Logger {
  readonly level: LogLevel;
  readonly json: boolean;
  readonly color: boolean;
  private readonly stream: NodeJS.WriteStream;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.json = options.json ?? false;
    this.color = options.color ?? colorEnabled(process.stderr);
    this.stream = options.stream ?? process.stderr;
  }

  child(options: Partial<LoggerOptions>): Logger {
    return new Logger({ level: this.level, json: this.json, color: this.color, stream: this.stream, ...options });
  }

  debug(message: string, fields?: LogFields): void { this.write('debug', message, fields); }
  info(message: string, fields?: LogFields): void { this.write('info', message, fields); }
  warn(message: string, fields?: LogFields): void { this.write('warn', message, fields); }
  error(message: string, fields?: LogFields): void { this.write('error', message, fields); }

  success(message: string, fields?: LogFields): void {
    this.write('info', message, { ...fields, ok: true });
  }

  private write(level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields): void {
    if (ORDER[level] < ORDER[this.level]) return;
    if (this.json) {
      this.stream.write(`${JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields })}\n`);
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
