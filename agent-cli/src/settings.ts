import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { subletHome } from './config.js';
import { brandEnv } from './util/env.js';
import { isLogLevel, type LogLevel } from './logger.js';

/**
 * Settings that a fleet or a container can set without command-line flags.
 * Precedence, highest first: command-line flag > SUBLET_* environment variable >
 * agent.json > built-in default. The host key normally lives in config.json
 * (written by `sublet login`) or comes from SUBLET_KEY / --key.
 */
export type Settings = {
  server?: string;
  token?: string;
  wsPath?: string;
  context?: number;
  slots?: number;
  price?: number;
  priceIn?: number;
  priceOut?: number;
  priceHour?: number;
  gpu?: string;
  vram?: number;
  tokPerSec?: number;
  noInstall?: boolean;
  noBrowser?: boolean;
  nonInteractive?: boolean;
  drainTimeoutMs?: number;
  requireChecksum?: boolean;
  logLevel?: LogLevel;
  /** A path, or "off" to disable the agent log file. */
  logFile?: string;
};

export type SettingSource = 'flag' | 'env' | 'file' | 'default';

type Kind = 'string' | 'number' | 'integer' | 'boolean' | 'level';

/** One row per setting: its agent.json key, environment variable, and type. */
export const SETTINGS_SPEC: ReadonlyArray<{ key: keyof Settings; env: string; kind: Kind; secret?: boolean; help: string }> = [
  { key: 'server', env: 'SUBLET_SERVER', kind: 'string', help: 'Central server URL' },
  { key: 'token', env: 'SUBLET_KEY', kind: 'string', secret: true, help: 'Host key (sh_...); prefer sublet login' },
  { key: 'wsPath', env: 'SUBLET_WS_PATH', kind: 'string', help: 'Tunnel path' },
  { key: 'context', env: 'SUBLET_CTX', kind: 'integer', help: 'Context window per slot' },
  { key: 'slots', env: 'SUBLET_SLOTS', kind: 'integer', help: 'Parallel slots for public mode' },
  { key: 'price', env: 'SUBLET_PRICE', kind: 'number', help: 'Public price per 1M output tokens (USD)' },
  { key: 'priceIn', env: 'SUBLET_PRICE_IN', kind: 'number', help: 'Public price per 1M input tokens (USD)' },
  { key: 'priceOut', env: 'SUBLET_PRICE_OUT', kind: 'number', help: 'Public price per 1M output tokens (USD)' },
  { key: 'priceHour', env: 'SUBLET_PRICE_HOUR', kind: 'number', help: 'Host mode price per hour for the full GPU (USD, 0-50; 0 = no hourly rentals)' },
  { key: 'gpu', env: 'SUBLET_GPU', kind: 'string', help: 'Correct a wrongly detected GPU name' },
  { key: 'vram', env: 'SUBLET_VRAM', kind: 'integer', help: 'Correct a wrongly detected VRAM size (MB)' },
  { key: 'tokPerSec', env: 'SUBLET_TOK_S', kind: 'number', help: 'Advertised tokens/sec (the server measures its own)' },
  { key: 'noInstall', env: 'SUBLET_NO_INSTALL', kind: 'boolean', help: 'Never download llama-server' },
  { key: 'noBrowser', env: 'SUBLET_NO_BROWSER', kind: 'boolean', help: 'Never open a browser' },
  { key: 'nonInteractive', env: 'SUBLET_NON_INTERACTIVE', kind: 'boolean', help: 'Never prompt or begin device login; fail when a key is missing' },
  { key: 'drainTimeoutMs', env: 'SUBLET_DRAIN_TIMEOUT_MS', kind: 'integer', help: 'SIGTERM inference drain grace period (0–300000 ms; default 30000)' },
  { key: 'requireChecksum', env: 'SUBLET_REQUIRE_CHECKSUM', kind: 'boolean', help: 'Refuse a llama.cpp release without a published SHA-256' },
  { key: 'logLevel', env: 'SUBLET_LOG_LEVEL', kind: 'level', help: 'Terminal log level: debug, info, warn, error, silent' },
  { key: 'logFile', env: 'SUBLET_LOG_FILE', kind: 'string', help: 'Agent log file path, or "off"' },
];

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = brandEnv(env, 'SUBLET_CONFIG')?.trim();
  return explicit ? resolve(explicit) : join(subletHome(env), 'agent.json');
}

function coerce(kind: Kind, raw: unknown, where: string): unknown {
  if (kind === 'string') {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${where} must be a non-empty string`);
    return raw.trim();
  }
  if (kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    throw new Error(`${where} must be true or false, got "${String(raw)}"`);
  }
  if (kind === 'level') {
    const text = String(raw).trim().toLowerCase();
    if (!isLogLevel(text)) throw new Error(`${where} must be one of debug, info, warn, error, silent; got "${String(raw)}"`);
    return text;
  }
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) throw new Error(`${where} must be a number, got "${String(raw)}"`);
  if (value < 0) throw new Error(`${where} must not be negative`);
  if (kind === 'integer' && !Number.isInteger(value)) throw new Error(`${where} must be a whole number`);
  return value;
}

/** Reads agent.json. A missing file is fine; a broken or misspelled one is an error, never silently ignored. */
export function readSettingsFile(path: string = settingsPath()): Settings {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    // JSON.parse errors may quote part of a secret-bearing configuration file.
    throw new Error(`${path} is not valid JSON. Check commas, quotes and braces.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path} must contain a JSON object`);
  if ('version' in data && data.version !== 1) throw new Error(`${path}: unsupported settings version; expected 1`);
  const known = new Map(SETTINGS_SPEC.map((row) => [row.key as string, row]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === '$schema' || key === 'version') continue;
    const row = known.get(key);
    if (!row) throw new Error(`${path}: unknown setting "${key}". Known settings: ${[...known.keys()].join(', ')}`);
    if (value == null) continue;
    out[key] = coerce(row.kind, value, `${path}: ${key}`);
  }
  return out as Settings;
}

export function readSettingsEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const out: Record<string, unknown> = {};
  for (const row of SETTINGS_SPEC) {
    const value = brandEnv(env, row.env);
    if (value == null || value === '') continue;
    out[row.key] = coerce(row.kind, value, row.env);
  }
  return out as Settings;
}

export type ResolvedSettings = {
  values: Settings;
  sources: Partial<Record<keyof Settings, SettingSource>>;
  file: string;
};

type FlagTarget = Record<string, unknown> & { positionals?: unknown };

/** Fills every flag the person did not pass from SUBLET_* variables, then agent.json. Returns where each value came from. */
export function applySettings<T extends object>(flags: T, explicit: ReadonlySet<string>, env: NodeJS.ProcessEnv = process.env): ResolvedSettings {
  const target = flags as unknown as FlagTarget;
  const fromFlags: Record<string, unknown> = {};
  for (const row of SETTINGS_SPEC) {
    if (explicit.has(row.key)) fromFlags[row.key] = target[row.key];
  }
  const resolved = resolveSettings(fromFlags as Settings, env);
  for (const row of SETTINGS_SPEC) {
    const value = resolved.values[row.key];
    if (value === undefined || explicit.has(row.key)) continue;
    // Boolean switches can only be turned on by a setting; flags never default to true.
    if (row.kind === 'boolean' && value !== true) continue;
    target[row.key] = value;
  }
  return resolved;
}

/** Merges flags over environment over agent.json. */
export function resolveSettings(fromFlags: Settings, env: NodeJS.ProcessEnv = process.env): ResolvedSettings {
  const file = settingsPath(env);
  if (brandEnv(env, 'SUBLET_CONFIG')?.trim()) {
    try { readFileSync(file, 'utf8'); } catch { throw new Error(`Cannot read the settings file selected by SUBLET_CONFIG: ${file}`); }
  }
  const layers: Array<[SettingSource, Settings]> = [['file', readSettingsFile(file)], ['env', readSettingsEnv(env)], ['flag', fromFlags]];
  const values: Record<string, unknown> = {};
  const sources: Partial<Record<keyof Settings, SettingSource>> = {};
  for (const [source, layer] of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      values[key] = value;
      sources[key as keyof Settings] = source;
    }
  }
  for (const row of SETTINGS_SPEC) {
    if (values[row.key] !== undefined) values[row.key] = coerce(row.kind, values[row.key], row.env);
  }
  for (const key of ['context', 'slots'] as const) {
    const n = values[key];
    if (typeof n === 'number' && !Number.isSafeInteger(n)) throw new Error(`${key} must be a safe whole number`);
  }
  if (typeof values.context === 'number' && values.context < 256) throw new Error('context must be at least 256 tokens');
  if (typeof values.slots === 'number' && (values.slots < 1 || values.slots > 16)) throw new Error('slots must be between 1 and 16');
  if (typeof values.drainTimeoutMs === 'number' && values.drainTimeoutMs > 300_000) throw new Error('drainTimeoutMs must be between 0 and 300000');
  if (typeof values.priceHour === 'number' && values.priceHour > 50) throw new Error('priceHour must be between 0 and 50 USD');
  return { values: values as Settings, sources, file };
}
