import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, extname, join } from 'node:path';

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

export type ExecOptions = {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxOutputBytes?: number;
  windowsHide?: boolean;
};

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function execFile(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    windowsHide: options.windowsHide ?? true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, spawnOptions);
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: toError(error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, error });
    };
    const append = (current: string, chunk: Buffer) => {
      if (current.length >= maxBytes) return current;
      const next = current + chunk.toString('utf8');
      return next.length > maxBytes ? next.slice(0, maxBytes) : next;
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child).finally(() => finish(null, `Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (options.input != null) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

export async function killTree(child: ChildProcess | null | undefined): Promise<void> {
  if (!child || child.killed || child.exitCode != null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    await execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: 10_000 });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await sleep(800);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function which(command: string): Promise<string | null> {
  const hasExt = extname(command) !== '';
  const names = process.platform === 'win32' && !hasExt
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name);
      if (await isExecutable(full)) return full;
    }
  }
  return null;
}

export async function commandExists(command: string): Promise<boolean> {
  return (await which(command)) != null;
}

export function commandLine(command: string, args: string[]): string {
  const quote = (value: string) => /[\s"]/g.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  return [command, ...args].map(quote).join(' ');
}
