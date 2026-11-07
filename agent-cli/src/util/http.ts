import { toError } from './exec.js';

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
    'user-agent': 'kiln-agent/1.0',
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
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.message || message;
    } catch {
      /* raw text */
    }
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
      'user-agent': 'kiln-agent/1.0',
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
