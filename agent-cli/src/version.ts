export const BRAND = 'Kiln';
export const VERSION = '1.0.0';
export const AGENT_NAME = 'kiln-agent';
export const DEFAULT_SERVER = process.env.KILN_SERVER || 'http://127.0.0.1:8787';
export const DEFAULT_WS_PATH = process.env.KILN_WS_PATH || '/tunnel';
export const HEARTBEAT_MS = 5_000;
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000];
