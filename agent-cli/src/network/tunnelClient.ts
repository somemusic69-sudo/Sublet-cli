import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import { RECONNECT_DELAYS_MS, HEARTBEAT_MS } from '../version.js';
import { wsUrl as buildWsUrl } from '../config.js';
import type { HeartbeatPayload, HelloPayload, ServerMessage } from '../types.js';
import type { Logger } from '../logger.js';

export type TunnelState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'auth-failed';

export type TunnelOptions = {
  server: string;
  token: string;
  wsPath?: string;
  hello: () => HelloPayload;
  heartbeat?: () => HeartbeatPayload | null;
  logger?: Logger;
  reconnectDelaysMs?: number[];
  heartbeatMs?: number;
  autoReconnect?: boolean;
  authMode?: 'header' | 'query';
  wsFactory?: (url: string) => WebSocket;
};

export class TunnelClient extends EventEmitter {
  private readonly options: TunnelOptions;
  private readonly logger?: Logger;
  private readonly delays: number[];
  private socket: WebSocket | null = null;
  private _state: TunnelState = 'closed';
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private heartbeatMs: number;
  private manuallyStopped = false;
  private authMode: 'header' | 'query';
  private triedQueryFallback = false;
  private welcomeWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private _username: string | null = null;
  private _lastMessageAt = 0;

  constructor(options: TunnelOptions) {
    super();
    this.options = options;
    this.logger = options.logger;
    this.delays = options.reconnectDelaysMs || RECONNECT_DELAYS_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.authMode = options.authMode ?? 'header';
  }

  get state(): TunnelState { return this._state; }
  get connected(): boolean { return this._state === 'open' && this.socket?.readyState === WebSocket.OPEN; }
  get username(): string | null { return this._username; }
  get lastMessageAt(): number { return this._lastMessageAt; }

  private setState(state: TunnelState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }

  start(): void {
    this.manuallyStopped = false;
    if (this._state === 'open' || this._state === 'connecting') return;
    this.connect();
  }

  /** Resolves once the server has sent its welcome frame. */
  waitForWelcome(timeoutMs = 10_000): Promise<void> {
    if (this._state === 'open' && this._username != null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.welcomeWaiters = this.welcomeWaiters.filter((w) => w.timer !== timer);
        reject(new Error('Timed out waiting for the host tunnel welcome'));
      }, timeoutMs);
      this.welcomeWaiters.push({ resolve, reject, timer });
    });
  }

  private connect(): void {
    if (this.manuallyStopped) return;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const useQuery = this.authMode === 'query';
    const url = buildWsUrl(this.options.server, useQuery ? this.options.token : '', this.options.wsPath, useQuery ? 'query' : 'header');
    this.logger?.debug('Opening tunnel', { url: url.replace(/token=[^&]+/, 'token=***'), auth: this.authMode });
    let socket: WebSocket;
    try {
      const headers: Record<string, string> = { 'user-agent': 'kiln-agent/1.0' };
      if (!useQuery) headers.authorization = `Bearer ${this.options.token}`;
      socket = this.options.wsFactory ? this.options.wsFactory(url) : new WebSocket(url, {
        headers,
        handshakeTimeout: 15_000,
      });
    } catch (error) {
      this.logger?.warn('Tunnel connection failed to start', { error: error instanceof Error ? error.message : String(error) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let opened = false;

    socket.on('open', () => {
      opened = true;
      this.attempts = 0;
      this.setState('open');
      this.emit('open');
      this.send(this.options.hello());
      this.startTimers();
      this.logger?.info('Tunnel connected');
    });

    socket.on('message', (raw: RawData) => {
      this._lastMessageAt = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'welcome') {
        this._username = typeof message.username === 'string' ? message.username : this._username;
        for (const waiter of this.welcomeWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
        this.welcomeWaiters = [];
      }
      this.emit('message', message);
      this.emit(String(message.type), message);
    });

    socket.on('pong', () => { this._lastMessageAt = Date.now(); });

    socket.on('error', (error: Error) => {
      this.logger?.debug('Tunnel error', { error: error.message });
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.stopTimers();
      this.socket = null;
      if (this.manuallyStopped) {
        this.setState('closed');
        return;
      }
      const text = reason?.toString() || '';
      const authClose = code === 4001 || code === 4003 || /token|auth/i.test(text);
      if (authClose) {
        if (this.authMode === 'header' && !this.triedQueryFallback) {
          this.authMode = 'query';
          this.triedQueryFallback = true;
          this.logger?.debug('Header auth was rejected; retrying with the query-token fallback');
          this.setState('reconnecting');
          this.scheduleReconnect();
          return;
        }
        this.setState('auth-failed');
        const error = new Error(`Host key was rejected by the server (${code}${text ? `: ${text}` : ''})`);
        for (const waiter of this.welcomeWaiters) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.welcomeWaiters = [];
        this.emit('auth-failed', error);
        this.logger?.error(error.message);
        return;
      }
      this.logger?.warn('Tunnel closed; reconnecting', { code, reason: text || undefined });
      this.setState('reconnecting');
      this.emit('disconnected', { code, reason: text, opened });
      this.scheduleReconnect();
    });
  }

  private startTimers(): void {
    this.stopTimers();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      const heartbeat = this.options.heartbeat?.();
      if (heartbeat) this.send(heartbeat);
    }, this.heartbeatMs);
    this.pingTimer = setInterval(() => {
      if (!this.connected || !this.socket) return;
      try { this.socket.ping(); } catch { /* closing */ }
      if (this._lastMessageAt && Date.now() - this._lastMessageAt > Math.max(45_000, this.heartbeatMs * 5) && !this.socket) {
        this.scheduleReconnect();
      }
    }, Math.max(10_000, this.heartbeatMs * 2));
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.heartbeatTimer = null;
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.manuallyStopped || this.options.autoReconnect === false) return;
    if (this.reconnectTimer) return;
    const base = this.delays[Math.min(this.attempts, this.delays.length - 1)] || 30_000;
    this.attempts++;
    const jitter = Math.round(base * 0.15 * (Math.random() * 2 - 1));
    const delay = Math.max(250, base + jitter);
    this.logger?.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s`, { attempt: this.attempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(message: Record<string, unknown>): boolean {
    if (!this.connected || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.manuallyStopped = true;
    this.stopTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { try { socket.terminate(); } catch { /* */ } resolve(); }, 2_000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        try { socket.close(1000, 'agent stopped'); } catch { clearTimeout(timer); resolve(); }
      });
    }
    this.setState('closed');
    for (const waiter of this.welcomeWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Tunnel stopped'));
    }
    this.welcomeWaiters = [];
  }
}
