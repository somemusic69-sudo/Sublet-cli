import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type AgentConfig = {
  server: string;
  token: string;
  wsPath: string;
  updatedAt: number;
  tokenLabel?: string;
};

export function kilnHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.KILN_HOME && env.KILN_HOME.trim() ? env.KILN_HOME : join(homedir(), '.kiln'));
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(kilnHome(env), 'config.json');
}

export function binDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(kilnHome(env), 'bin');
}

export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(kilnHome(env), 'models');
}

export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(kilnHome(env), 'logs');
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(kilnHome(env), 'cache');
}

export function normalizeServer(raw: string): string {
  let value = raw.trim();
  if (!value) throw new Error('Server URL is empty');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
    value = `${local ? 'http' : 'https'}://${value}`;
  }
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Server must be an http(s) URL');
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
  return /^(kh_|sk-)[A-Za-z0-9_-]{6,}$/.test(token.trim());
}

export function displayNameForHome(home: string): string {
  const parent = dirname(home);
  return parent === home ? home : `${parent}${home.startsWith('/') || home.includes('\\') ? '\\' : '/'}${home}`;
}
