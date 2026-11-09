export const BRAND = 'Sublet';
export const VERSION = '1.2.0';
export const AGENT_NAME = 'sublet-cli';
export const USER_AGENT = `${AGENT_NAME}/${VERSION}`;
export const DEFAULT_SERVER = process.env.SUBLET_SERVER || 'https://sublet.duckdns.org';
export const DEFAULT_WS_PATH = process.env.SUBLET_WS_PATH || '/tunnel';
export const HEARTBEAT_MS = 5_000;
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000];
/** WebSocket close code a server sends to refuse an agent that is too old (mirrors HTTP 426). */
export const UPGRADE_REQUIRED_CLOSE = 4426;

/** Compares dotted numeric versions. Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

export function outdatedMessage(minVersion?: string | null): string {
  const needs = minVersion ? ` (needs v${minVersion} or newer)` : '';
  return `${AGENT_NAME} v${VERSION} is too old for this server${needs}. Update with: npx ${AGENT_NAME}@latest`;
}
