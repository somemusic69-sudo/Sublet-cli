import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { isLoopbackHost } from '../config.js';
/**
 * The link to hand to the browser, or null when it is not a plain web link. A link that came from the server is
 * opened only on the server's own origin (`sameOriginAs`), so a server cannot make this machine open a program,
 * a file share or another site. Without `sameOriginAs`, only https and this machine's http are allowed.
 */
export function browserUrl(raw: string, sameOriginAs?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (sameOriginAs !== undefined) {
    try {
      return new URL(sameOriginAs).origin === url.origin ? url.href : null;
    } catch {
      return null;
    }
  }
  return url.protocol === 'https:' || isLoopbackHost(url.hostname) ? url.href : null;
}
/**
 * Opens a web link in the default browser. Returns false when the link is refused or no browser could start.
 * On Windows it goes through rundll32 by its full path, not `cmd /c start`, so characters like `&` in the link are
 * never read as commands and a program named `cmd` in the current folder is never run.
 */
export function openUrl(raw: string, sameOriginAs?: string): boolean {
  const url = browserUrl(raw, sameOriginAs);
  if (!url) return false;
  try {
    const child = process.platform === 'win32'
      ? spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    // A missing opener (no xdg-open) is reported as an 'error' event, which would crash the process without a listener.
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
/** Text from the server, safe to print: control characters (terminal escape sequences) are removed. */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}
/** A browser on this machine helps only in a local desktop session, not over SSH or on a headless server. */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}
