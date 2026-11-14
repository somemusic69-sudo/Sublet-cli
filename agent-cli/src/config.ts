import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { brandEnv } from './util/env.js';

export type AgentConfig = {
  server: string;
  token: string;
  wsPath: string;
  updatedAt: number;
  tokenLabel?: string;
};

export function subletHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = brandEnv(env, 'SUBLET_HOME');
  // Keep the existing default so old/new binaries share credentials and ownership.
  return resolve(home && home.trim() ? home : join(homedir(), '.sublet'));
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'config.json');
}

export function binDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'bin');
}

export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'models');
}

export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'logs');
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'cache');
}

/** The OpenAI-compatible base URL that buyers use for this host's public market. */
export function hostEndpoint(server: string, username: string | null | undefined): string {
  return `${server.replace(/\/+$/, '')}/h/${username || 'USERNAME'}/v1`;
}

/** True for this machine's own addresses: localhost, 127.0.0.0/8, 0.0.0.0 and [::1]. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '0.0.0.0' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
/**
 * A server URL in one canonical form. Plain http is allowed only for this machine, because the host key travels in
 * every request; SUBLERA_ALLOW_HTTP=1 allows it elsewhere, for a test server on a trusted LAN.
 */
export function normalizeServer(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  let value = raw.trim();
  if (!value) throw new Error('Server URL is empty');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
    value = `${local ? 'http' : 'https'}://${value}`;
  }
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Server must be an http(s) URL');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && brandEnv(env, 'SUBLET_ALLOW_HTTP') !== '1') {
    throw new Error('Server must use https:// (the host key would be sent unencrypted). For a test server on a trusted network, set SUBLERA_ALLOW_HTTP=1');
  }
  if (url.username || url.password) throw new Error('Server URL must not contain credentials; use --key or SUBLET_KEY');
  if (url.search || url.hash) throw new Error('Server URL must not contain a query or fragment');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

export function apiUrl(server: string, path: string): string {
  return `${normalizeServer(server)}${path.startsWith('/') ? path : `/${path}`}`;
}

export function wsUrl(server: string, token: string, wsPath = '/tunnel', mode: 'query' | 'header' = 'query'): string {
  const base = new URL(normalizeServer(server));
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = wsPath.trim() || '/tunnel';
  if (/^wss?:\/\//i.test(path)) {
    const full = new URL(path);
    if (full.origin !== base.origin) throw new Error('Tunnel URL must use the same server origin; refusing to forward the host key');
    if (full.username || full.password || full.hash) throw new Error('Tunnel URL must not contain credentials or a fragment');
    if (mode === 'query') full.searchParams.set('token', token);
    return full.toString();
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  base.search = '';
  if (mode === 'query') base.searchParams.set('token', token);
  return base.toString();
}

export function maskToken(token: string | null | undefined): string {
  if (!token) return 'not set';
  if (token.length <= 10) return `${token.slice(0, 3)}...`;
  return `${token.slice(0, 7)}...${token.slice(-4)}`;
}

export function hostKeyFromToken(token: string): boolean {
  return /^(sh_|sk-)[A-Za-z0-9_-]{6,}$/.test(token.trim());
}

export function displayNameForHome(home: string): string {
  const parent = dirname(home);
  return parent === home ? home : `${parent}${home.startsWith('/') || home.includes('\\') ? '\\' : '/'}${home}`;
}
