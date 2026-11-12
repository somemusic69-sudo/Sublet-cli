import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest, type AgentOptions } from 'node:https';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import type { Duplex } from 'node:stream';
import { isIP, type Socket } from 'node:net';

/**
 * Corporate network support. Standard proxy variables are honored for every
 * outbound connection the agent makes (API, HuggingFace/GitHub downloads, and
 * the WebSocket tunnel). llama-server on 127.0.0.1 is never proxied.
 *
 *   HTTPS_PROXY / https_proxy   proxy for https:// and wss:// (most common)
 *   HTTP_PROXY  / http_proxy    proxy for http:// and ws://
 *   NO_PROXY    / no_proxy      comma-separated hosts, .domains, host:port, or *
 *   NODE_EXTRA_CA_CERTS         extra corporate root CA (read by Node itself at startup)
 */
export type ProxySettings = {
  httpsProxy: string | null;
  httpProxy: string | null;
  noProxy: string[];
};

function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name] ?? env[name.toLowerCase()];
  return value && value.trim() ? value.trim() : null;
}

export function proxySettings(env: NodeJS.ProcessEnv = process.env): ProxySettings {
  return {
    httpsProxy: envValue(env, 'HTTPS_PROXY'),
    httpProxy: envValue(env, 'HTTP_PROXY'),
    noProxy: (envValue(env, 'NO_PROXY') || '').split(/[\s,]+/).map((v) => v.trim().toLowerCase()).filter(Boolean),
  };
}

export function proxyConfigured(settings: ProxySettings = proxySettings()): boolean {
  return Boolean(settings.httpsProxy || settings.httpProxy);
}

/** True when NO_PROXY (or loopback) says this host must be reached directly. */
export function bypassProxy(target: URL, noProxy: string[]): boolean {
  const host = normalizeHost(target.hostname);
  if (host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.')) ||
      /^::ffff:7f[0-9a-f]{2}:/i.test(host)) return true;
  const port = target.port || (target.protocol === 'https:' || target.protocol === 'wss:' ? '443' : '80');
  for (const raw of noProxy) {
    let entry = raw.trim().toLowerCase();
    if (entry === '*') return true;
    // Only bracketed IPv6 may have a port; a bare IPv6 address is never split.
    const match = entry.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    if (match) {
      if (Number(match[2]) !== Number(port)) continue;
      entry = match[1]!;
    }
    entry = normalizeHost(entry.replace(/^\*?\./, ''));
    if (entry && (host === entry || (!isIP(host) && !isIP(entry) && host.endsWith(`.${entry}`)))) return true;
  }
  return false;
}

function normalizeHost(host: string): string {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(bare) === 6 && !bare.includes('%')) return new URL(`http://[${bare}]`).hostname.slice(1, -1);
  return bare;
}

/** The proxy URL to use for a target, or null for a direct connection. */
export function proxyFor(target: string | URL, settings: ProxySettings = proxySettings()): URL | null {
  const url = typeof target === 'string' ? new URL(target) : target;
  if (bypassProxy(url, settings.noProxy)) return null;
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const raw = secure ? settings.httpsProxy || settings.httpProxy : settings.httpProxy;
  if (!raw) return null;
  return parseProxyUrl(raw);
}

export function parseProxyUrl(raw: string): URL {
  let proxy: URL;
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error('Invalid proxy setting (use an http:// or https:// proxy URL)');
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new Error('Unsupported proxy protocol (use an http:// or https:// proxy)');
  }
  // Fail eagerly and without echoing credentials, including malformed escapes.
  proxyAuthHeader(proxy);
  return proxy;
}

/** Proxy URL safe for logs and doctor output: credentials are hidden. */
export function redactProxy(raw: string | URL | null): string {
  if (!raw) return 'none';
  try {
    const url = parseProxyUrl(String(raw));
    // Paths, query strings and fragments can also contain secrets.
    return `${url.protocol}//${url.username || url.password ? '***@' : ''}${url.host}`;
  } catch {
    return '[invalid proxy URL]';
  }
}

function proxyAuthHeader(proxy: URL): string | null {
  if (!proxy.username && !proxy.password) return null;
  try {
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password);
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  } catch {
    throw new Error('Invalid proxy credentials (check percent-encoding)');
  }
}

/** Opens an HTTP CONNECT tunnel through the proxy and returns the raw socket to host:port. */
export function openConnectTunnel(proxy: URL, host: string, port: number, timeoutMs = 15_000, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let req: ReturnType<typeof httpRequest> | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req?.destroy();
      reject(error);
    };
    const abort = () => fail(new Error('Proxy connection aborted'));
    const refused = (status: number | undefined) => {
      const hint = status === 407 ? ' (the proxy needs a login: use http://user:password@proxy:port)' : '';
      return new Error(`Proxy ${redactProxy(proxy)} refused CONNECT: HTTP ${status}${hint}`);
    };
    if (signal?.aborted) { abort(); return; }
    try {
      proxy = parseProxyUrl(proxy.href);
      host = normalizeHost(host);
      if (!host || /[\s/?#@]/.test(host) || (host.includes(':') && !isIP(host)) ||
          !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CONNECT target');
      const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
      const headers: Record<string, string> = { host: authority };
      const auth = proxyAuthHeader(proxy);
      if (auth) headers['proxy-authorization'] = auth;
      const request = proxy.protocol === 'https:' ? httpsRequest : httpRequest;
      const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
      req = request({
        host: proxyHost,
        // HTTPS otherwise derives SNI/verification from the CONNECT Host header,
        // which names the destination rather than the TLS peer (the proxy).
        servername: isIP(proxyHost) ? '' : proxyHost,
        port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT',
        path: authority,
        headers,
        agent: false,
      });
      req.once('connect', (res, socket, head) => {
        if (settled || res.statusCode !== 200) {
          socket.destroy();
          if (!settled) fail(refused(res.statusCode));
          return;
        }
        settled = true;
        cleanup();
        socket.setTimeout(0);
        // The proxy may send upstream bytes in the same packet as its headers.
        if (head.length) socket.unshift(head);
        resolve(socket as Socket);
      });
      req.once('response', (res) => { res.destroy(); fail(refused(res.statusCode)); });
      req.once('close', () => fail(new Error(`Proxy ${redactProxy(proxy)} closed before CONNECT completed`)));
      // Do not echo peer-controlled parser errors (which can include credentials).
      req.once('error', (error: NodeJS.ErrnoException) => {
        const code = error.code && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : '';
        fail(new Error(`Could not reach proxy ${redactProxy(proxy)}${code}`));
      });
      signal?.addEventListener('abort', abort, { once: true });
      // A deadline, not an inactivity timeout: trickled headers must not hang forever.
      timer = setTimeout(() => fail(new Error(`Proxy ${redactProxy(proxy)} did not answer within ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
      req.end();
    } catch {
      fail(new Error(`Invalid proxy connection settings for ${redactProxy(proxy)}`));
    }
  });
}

type ConnectOptions = ConnectionOptions & { hostname?: string; timeout?: number };
type ConnectionCallback = (error: Error | null, stream: Duplex) => void;

/** Opens the CONNECT tunnel, then (for https/wss) does TLS end to end with the real host. */
function connectThroughProxy(proxy: URL, secure: boolean, rawOptions: object, pending: Set<AbortController>, callback?: ConnectionCallback): void {
  // An asynchronous connection cannot be handed off without a callback.
  if (!callback) return;
  const controller = new AbortController();
  pending.add(controller);
  const options = rawOptions as ConnectOptions;
  const host = String(options.hostname || options.host || 'localhost').replace(/^\[|\]$/g, '');
  const port = Number(options.port) || (secure ? 443 : 80);
  const timeout = options.timeout && options.timeout > 0 ? options.timeout : 15_000;
  let stream: Socket | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (error: Error | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abort);
    pending.delete(controller);
    stream?.removeListener('secureConnect', ready);
    stream?.removeListener('error', fail);
    stream?.removeListener('close', closed);
    if (error) stream?.destroy();
    // Node accepts an error with no stream; the typings require one.
    callback(error, error ? undefined as unknown as Duplex : stream!);
  };
  const fail = (error: Error) => finish(error);
  const ready = () => finish(null);
  const closed = () => fail(new Error('Proxy tunnel closed before TLS negotiation completed'));
  const abort = () => fail(new Error('Proxy connection aborted'));
  controller.signal.addEventListener('abort', abort, { once: true });
  openConnectTunnel(proxy, host, port, timeout, controller.signal).then((socket) => {
    if (settled) { socket.destroy(); return; }
    stream = socket;
    if (!secure) {
      ready();
      return;
    }
    try {
      // Always validate against the destination, not the proxy or localhost.
      // IP literals need certificate IP validation but must not be sent as SNI.
      stream = tlsConnect({ ...options, host, port, socket, servername: options.servername ?? (isIP(host) ? '' : host) });
      stream.once('secureConnect', ready);
      stream.once('error', fail);
      stream.once('close', closed);
      timer = setTimeout(() => fail(new Error('Proxy tunnel TLS negotiation timed out')), timeout);
      timer.unref();
    } catch {
      fail(new Error('Could not initialize TLS through proxy'));
    }
  }, fail);
}

/**
 * An https.Agent that reaches the target through an HTTP CONNECT proxy. Used
 * for the wss:// tunnel, because the `ws` package takes a Node agent and ignores proxy variables.
 */
export class ConnectProxyAgent extends HttpsAgent {
  readonly proxy: URL;
  private readonly pending = new Set<AbortController>();

  constructor(proxy: URL, options: AgentOptions = {}) {
    super({ keepAlive: false, ...options });
    this.proxy = proxy;
  }

  override createConnection(rawOptions: object, callback?: ConnectionCallback): Duplex | null | undefined {
    connectThroughProxy(this.proxy, true, rawOptions, this.pending, callback);
    return undefined;
  }

  override destroy(): void {
    for (const controller of this.pending) controller.abort();
    super.destroy();
  }
}

/** The plain-HTTP twin of ConnectProxyAgent, for ws:// servers (local or test setups). */
export class ConnectProxyHttpAgent extends HttpAgent {
  readonly proxy: URL;
  private readonly pending = new Set<AbortController>();

  constructor(proxy: URL) {
    super({ keepAlive: false });
    this.proxy = proxy;
  }

  override createConnection(rawOptions: object, callback?: ConnectionCallback): Duplex | null | undefined {
    connectThroughProxy(this.proxy, false, rawOptions, this.pending, callback);
    return undefined;
  }

  override destroy(): void {
    for (const controller of this.pending) controller.abort();
    super.destroy();
  }
}

/** A Node agent for the `ws` tunnel when a proxy applies to this URL, else undefined (direct). */
export function websocketAgentFor(url: string, settings: ProxySettings = proxySettings()): HttpAgent | undefined {
  const proxy = proxyFor(url, settings);
  if (!proxy) return undefined;
  return /^(wss|https):/i.test(url) ? new ConnectProxyAgent(proxy) : new ConnectProxyHttpAgent(proxy);
}

let fetchProxyInstallation: Promise<boolean> | undefined;

/**
 * Routes the global fetch() (API calls, model and engine downloads) through the
 * configured proxy. Loads nothing and changes nothing when no proxy is set.
 */
export async function installFetchProxy(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (fetchProxyInstallation) return fetchProxyInstallation;
  const settings = proxySettings(env);
  if (!proxyConfigured(settings)) return false;
  // A malformed value fails here with a clear message instead of on the first download.
  if (settings.httpsProxy) settings.httpsProxy = parseProxyUrl(settings.httpsProxy).href;
  if (settings.httpProxy) settings.httpProxy = parseProxyUrl(settings.httpProxy).href;
  fetchProxyInstallation = (async () => {
    const undici = await import('undici');
    // Node's native fetch shares this dispatcher. Do not replace fetch, Request,
    // Response, FormData, WebSocket, etc. with different class identities.
    undici.setGlobalDispatcher(new undici.Agent({
      factory(origin, options) {
        // One routing policy for fetch and ws; no ambient environment fallback.
        const proxy = proxyFor(String(origin), settings);
        return proxy
          ? new undici.ProxyAgent({ ...options, uri: proxy.href, token: proxyAuthHeader(proxy) ?? undefined })
          : new undici.Pool(origin, options);
      },
    }));
    return true;
  })();
  try {
    return await fetchProxyInstallation;
  } catch (error) {
    fetchProxyInstallation = undefined;
    throw error;
  }
}
