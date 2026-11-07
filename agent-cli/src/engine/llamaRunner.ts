import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { logsDir } from '../config.js';
import { killTree, sleep } from '../util/exec.js';
import type { Logger } from '../logger.js';

export type RunnerStatus = 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed';

export type LlamaRunnerOptions = {
  binaryPath: string;
  modelPath: string;
  context: number;
  slots?: number;
  host?: string;
  port?: number;
  gpuLayers?: number;
  extraArgs?: string[];
  /** Used by tests to put a script before the llama flags. */
  baseArgs?: string[];
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  logFile?: string;
  healthTimeoutMs?: number;
  restart?: false | { maxRestarts?: number; windowMs?: number; delayMs?: number };
  onLog?: (line: string) => void;
};

export type LlamaProps = {
  n_ctx?: number;
  default_generation_settings?: { n_ctx?: number };
  total_slots?: number;
  model_path?: string;
  [key: string]: unknown;
};

export function buildLlamaArgs(options: Pick<LlamaRunnerOptions, 'modelPath' | 'context' | 'slots' | 'host' | 'port' | 'gpuLayers' | 'extraArgs'>): string[] {
  const slots = Math.max(1, Math.round(options.slots ?? 1));
  // llama-server treats --ctx-size as the total KV cache and divides it across
  // parallel slots. Kiln advertises the per-slot context, so allocate slots * ctx.
  const totalContext = Math.max(256, Math.round(options.context)) * slots;
  const args = [
    '-m', options.modelPath,
    '--host', options.host || '127.0.0.1',
    '--port', String(options.port || 0),
    '--n-gpu-layers', String(options.gpuLayers ?? 999),
    '--ctx-size', String(totalContext),
    '--parallel', String(slots),
    '--cont-batching',
    '--log-disable',
  ];
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error('Could not allocate a local port')));
    });
  });
}

export class LlamaRunner extends EventEmitter {
  private readonly options: LlamaRunnerOptions;
  private readonly logger?: Logger;
  private child: ChildProcess | null = null;
  private logStream: WriteStream | null = null;
  private _status: RunnerStatus = 'stopped';
  private _port = 0;
  private _url = '';
  private _props: LlamaProps | null = null;
  private _pid: number | null = null;
  private stopping = false;
  private restartTimes: number[] = [];
  private startPromise: Promise<LlamaProps> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private _restarts = 0;
  private failuresSinceReady = 0;

  constructor(options: LlamaRunnerOptions) {
    super();
    this.options = options;
    this.logger = options.logger;
  }

  get status(): RunnerStatus { return this._status; }
  get port(): number { return this._port; }
  get url(): string { return this._url; }
  get pid(): number | null { return this._pid; }
  get props(): LlamaProps | null { return this._props; }
  get restarts(): number { return this._restarts; }

  setStatus(status: RunnerStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
  }

  async start(): Promise<LlamaProps> {
    if (this._status === 'ready' && this._props) return this._props;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<LlamaProps> {
    this.stopping = false;
    this.setStatus(this._restarts > 0 ? 'restarting' : 'starting');
    const port = this.options.port ?? await findFreePort(this.options.host || '127.0.0.1');
    this._port = port;
    this._url = `http://${this.options.host || '127.0.0.1'}:${port}`;
    const args = [
      ...(this.options.baseArgs || []),
      ...buildLlamaArgs({ ...this.options, port }),
    ];
    this.logger?.info('Starting llama-server', { port, context: this.options.context, slots: this.options.slots ?? 1 });
    await mkdir(logsDir(), { recursive: true }).catch(() => undefined);
    if (this.stopping) throw new Error('llama-server start was cancelled');
    const logFile = this.options.logFile ?? join(logsDir(), 'llama-server.log');
    this.logStream?.end();
    this.logStream = createWriteStream(logFile, { flags: 'a' });
    const child = spawn(this.options.binaryPath, args, {
      env: { ...process.env, ...this.options.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this._pid = child.pid ?? null;
    const handleLine = (line: string) => {
      this.options.onLog?.(line);
      this.logStream?.write(`${new Date().toISOString()} ${line}\n`);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) handleLine(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) handleLine(line);
    });
    child.once('error', (error) => {
      handleLine(`spawn error: ${error.message}`);
      this.setStatus('failed');
      this.emit('fatal', error);
    });
    let ready = false;
    child.once('exit', (code, signal) => {
      const wasStopping = this.stopping;
      this.child = null;
      this._pid = null;
      this._props = null;
      if (wasStopping) {
        this.setStatus('stopped');
        return;
      }
      handleLine(`llama-server exited (${code ?? signal ?? 'unknown'})`);
      if (!ready) return;
      this.emit('crash', { code, signal });
      this.scheduleRestart();
    });
    try {
      const props = await this.waitForHealth(child);
      this._props = props;
      const seen = Number(props.n_ctx || props.default_generation_settings?.n_ctx || 0);
      if (seen > 0 && seen < this.options.context) {
        throw new Error(`llama-server loaded context ${seen}, below the locked ${this.options.context}`);
      }
      ready = true;
      this.failuresSinceReady = 0;
      this.setStatus('ready');
      this.emit('ready', props);
      return props;
    } catch (error) {
      this.setStatus(this.stopping ? 'stopped' : 'failed');
      child.removeAllListeners('exit');
      this.child = null;
      this._pid = null;
      await killTree(child);
      throw error;
    }
  }

  private async waitForHealth(child: ChildProcess): Promise<LlamaProps> {
    const timeoutMs = this.options.healthTimeoutMs ?? 180_000;
    const started = Date.now();
    let lastError = '';
    while (Date.now() - started < timeoutMs) {
      if (this.stopping) throw new Error('llama-server start was cancelled');
      if (child.exitCode != null || !this.child) throw new Error(`llama-server exited during startup (${child.exitCode ?? 'signal'})`);
      try {
        const health = await fetch(`${this._url}/health`, { signal: AbortSignal.timeout(2_000) });
        if (health.ok) {
          const props = await fetch(`${this._url}/props`, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
          if (props?.ok) return await props.json() as LlamaProps;
          return {};
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(500);
    }
    throw new Error(`llama-server did not become healthy within ${Math.round(timeoutMs / 1000)}s${lastError ? ` (${lastError})` : ''}`);
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const restart = this.options.restart;
    if (restart === false) {
      this.setStatus('failed');
      return;
    }
    const maxRestarts = restart?.maxRestarts ?? 5;
    const windowMs = restart?.windowMs ?? 120_000;
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < windowMs);
    const reason = this.failuresSinceReady >= maxRestarts
      ? `llama-server did not become ready after ${this.failuresSinceReady} restarts`
      : this.restartTimes.length >= maxRestarts
        ? `llama-server crashed ${this.restartTimes.length} times in ${Math.round(windowMs / 1000)}s`
        : null;
    if (reason) {
      this.setStatus('failed');
      this.emit('fatal', new Error(reason));
      return;
    }
    this.restartTimes.push(now);
    this.failuresSinceReady++;
    this._restarts++;
    this.setStatus('restarting');
    const delay = restart?.delayMs ?? 500;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void this.start().catch((error) => {
        this.logger?.error('llama-server restart failed', { error: error instanceof Error ? error.message : String(error) });
        this.scheduleRestart();
      });
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    this._props = null;
    if (child) await killTree(child);
    this.logStream?.end();
    this.logStream = null;
    this.setStatus('stopped');
  }

  async isHealthy(): Promise<boolean> {
    if (!this._url || this._status !== 'ready') return false;
    try {
      const res = await fetch(`${this._url}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
