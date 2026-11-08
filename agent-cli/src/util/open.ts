import { spawn } from 'node:child_process';

/** Opens a URL in the default browser. Returns false when no browser could start. */
export function openUrl(url: string): boolean {
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    // A missing opener (no xdg-open) is reported as an 'error' event, which would crash the process without a listener.
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** A browser on this machine helps only in a local desktop session, not over SSH or on a headless server. */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}
