import { toError } from './exec.js';
import { AGENT_NAME, USER_AGENT, outdatedMessage } from '../version.js';

export type FetchJsonOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  token?: string;
};

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message || `HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    ...options.headers,
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body != null) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new Error(`Could not reach ${url}: ${toError(error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    let minVersion: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string; minVersion?: string };
      message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.message || message;
      minVersion = typeof parsed.minVersion === 'string' ? parsed.minVersion : undefined;
    } catch {
      /* raw text */
    }
    if (response.status === 426) message = outdatedMessage(minVersion);
    throw new HttpError(response.status, text, message);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${url}`);
  }
}

export async function fetchText(url: string, options: FetchJsonOptions = {}): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      ...options.headers,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, text);
  return text;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Latest kiln-agent on the npm registry, or null when it cannot be checked. */
export async function latestPublishedVersion(timeoutMs = 5_000): Promise<string | null> {
  const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/+$/, '');
  try {
    const body = await fetchJson<{ version?: unknown }>(`${registry}/${AGENT_NAME}/latest`, { timeoutMs });
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

export type SpeedSample = { bytes: number; ms: number; bytesPerSec: number };

/** Downloads at most maxBytes for at most maxMs and returns the throughput after the response headers. */
export async function measureDownloadSpeed(
  url: string,
  options: { maxBytes?: number; maxMs?: number; headerTimeoutMs?: number } = {},
): Promise<SpeedSample> {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const maxMs = options.maxMs ?? 5_000;
  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(), options.headerTimeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, range: `bytes=0-${maxBytes - 1}` },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`Could not reach ${new URL(url).host}: ${toError(error).message}`);
  } finally {
    clearTimeout(headerTimer);
  }
  if (!response.ok || !response.body) throw new HttpError(response.status, '');
  const reader = response.body.getReader();
  const started = performance.now();
  const deadline = setTimeout(() => { void reader.cancel().catch(() => undefined); }, maxMs);
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => undefined);
  }
  const ms = Math.max(1, performance.now() - started);
  return { bytes, ms, bytesPerSec: bytes / (ms / 1000) };
}
