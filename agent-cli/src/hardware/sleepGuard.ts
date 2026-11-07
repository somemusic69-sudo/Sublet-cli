import type { ChildProcess } from 'node:child_process';
import { spawn as realSpawn } from 'node:child_process';
import { killTree, which } from '../util/exec.js';
import type { Logger } from '../logger.js';

type SpawnFn = typeof realSpawn;

export type SleepGuardOptions = {
  platform?: NodeJS.Platform;
  spawnFn?: SpawnFn;
  logger?: Logger;
  whichFn?: typeof which;
  killFn?: typeof killTree;
};

export type SleepGuardState = {
  active: boolean;
  supported: boolean;
  platform: NodeJS.Platform;
  mechanism: string;
  since: number | null;
  lastError: string | null;
};

export function windowsSleepScript(): string {
  return [
    "$src = @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class KilnSleepGuard {',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern uint SetThreadExecutionState(uint esFlags);',
    '}',
    "'@",
    'Add-Type -TypeDefinition $src',
    'while ($true) {',
    '  [KilnSleepGuard]::SetThreadExecutionState([uint32]2147483651) | Out-Null',
    '  Start-Sleep -Seconds 20',
    '}',
  ].join('\n');
}

export class SleepGuard {
  private readonly platform: NodeJS.Platform;
  private readonly spawnFn: SpawnFn;
  private readonly logger?: Logger;
  private readonly whichFn: typeof which;
  private readonly killFn: typeof killTree;
  private child: ChildProcess | null = null;
  private state: SleepGuardState;
  private stopping = false;
  private exitHandler: (() => void) | null = null;

  constructor(options: SleepGuardOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnFn = options.spawnFn ?? realSpawn;
    this.logger = options.logger;
    this.whichFn = options.whichFn ?? which;
    this.killFn = options.killFn ?? killTree;
    this.state = {
      active: false,
      supported: this.platform === 'win32' || this.platform === 'darwin' || this.platform === 'linux',
      platform: this.platform,
      mechanism: this.mechanismName(),
      since: null,
      lastError: null,
    };
  }

  private mechanismName(): string {
    if (this.platform === 'win32') return 'SetThreadExecutionState';
    if (this.platform === 'darwin') return 'caffeinate';
    if (this.platform === 'linux') return 'systemd-inhibit';
    return 'unsupported';
  }

  status(): SleepGuardState {
    return { ...this.state };
  }

  async acquire(reason: string): Promise<boolean> {
    if (this.state.active) return true;
    try {
      if (this.platform === 'win32') return this.startWindows(reason);
      if (this.platform === 'darwin') return this.startDarwin(reason);
      if (this.platform === 'linux') return this.startLinux(reason);
      this.state.lastError = `Sleep blocking is not implemented on ${this.platform}`;
      return false;
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.logger?.warn('Could not block sleep', { error: this.state.lastError });
      return false;
    }
  }

  private startWindows(reason: string): boolean {
    const child = this.spawnFn('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-Command', windowsSleepScript(),
    ], { windowsHide: true, stdio: 'ignore' });
    return this.attach(child, `Windows wake-lock (${reason})`);
  }

  private startDarwin(reason: string): boolean {
    const child = this.spawnFn('caffeinate', ['-dimsu'], { stdio: 'ignore' });
    return this.attach(child, `caffeinate (${reason})`);
  }

  private startLinux(reason: string): boolean {
    const child = this.spawnFn('systemd-inhibit', [
      '--what=sleep:idle',
      '--who=kiln-agent',
      `--why=${reason.slice(0, 80)}`,
      'sleep', 'infinity',
    ], { stdio: 'ignore' });
    return this.attach(child, `systemd-inhibit (${reason})`);
  }

  private attach(child: ChildProcess, description: string): boolean {
    this.child = child;
    this.stopping = false;
    this.state = {
      active: true,
      supported: true,
      platform: this.platform,
      mechanism: this.mechanismName(),
      since: Date.now(),
      lastError: null,
    };
    child.once('error', (error) => {
      this.state.active = false;
      this.state.lastError = error.message;
      this.logger?.warn(`Sleep guard failed: ${error.message}`);
    });
    child.once('exit', (code) => {
      this.state.active = false;
      this.state.since = null;
      if (!this.stopping) {
        this.logger?.warn(`Sleep guard exited unexpectedly (${description}, code ${code ?? '?'})`);
      }
    });
    this.exitHandler = () => { void this.stop(); };
    process.once('exit', this.exitHandler);
    this.logger?.info(`Sleep blocked: ${description}`);
    return true;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }
    const child = this.child;
    this.child = null;
    this.state.active = false;
    this.state.since = null;
    if (child) await this.killFn(child);
  }
}

export async function sleepGuardAvailable(platform = process.platform, whichFn = which): Promise<boolean> {
  if (platform === 'win32') return true;
  if (platform === 'darwin') return (await whichFn('caffeinate')) != null;
  if (platform === 'linux') return (await whichFn('systemd-inhibit')) != null;
  return false;
}
