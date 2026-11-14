export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: ChatRole;
  content: string;
  name?: string;
};

export type WorkerJob = {
  type: 'infer';
  jobId: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  model?: string;
};

/** One generated token with its log probability and the top alternatives, as llama-server reports them. */
export type TokenPosition = { t: string; l: number; top: Array<[string, number]> };

export type LoadJob = {
  type: 'load';
  requestId: string;
  url: string;
  file: string | null;
  sha256: string | null;
  layers: number | null;
  context: number;
  /** Shared bookings: one llama-server slot for each buyer the host's benchmark allows. */
  slots?: number;
};

/**
 * The server starts a booking's clock. Several bookings can be active at once on the
 * loaded model: speed seats (`tokS` set) side by side, or one full-GPU rental.
 */
export type BookingFrame = {
  type: 'booking';
  requestId: string;
  timerStartedAt?: number;
  timerEndsAt?: number;
  hours?: number;
  pricePerHourNanos?: number;
  minTokS?: number;
  /** True for a speed seat that shares the GPU with other renters and per-token buyers. */
  shared?: boolean;
  /** The reserved speed of a seat booking; null or absent means the full GPU. */
  tokS?: number | null;
};

export type ServerMessage =
  | { type: 'welcome'; username?: string }
  | WorkerJob
  | LoadJob
  | { type: 'cancel'; jobId: string }
  | { type: 'verified'; requestId: string; fingerprint?: string }
  | BookingFrame
  | { type: 'reject'; requestId: string; reason?: string }
  | { type: 'error'; message?: string }
  | { type: string; [key: string]: unknown };

export type CachedModelInfo = { sha256: string; file: string; sizeBytes: number };

export type HelloPayload = {
  type: 'hello';
  agentVersion: string;
  platform: string;
  arch: string;
  gpuName: string;
  gpuVendor: string;
  vramMb: number;
  freeVramMb: number;
  modelId: string;
  modelLabel: string;
  repo: string;
  file: string;
  quant: string;
  paramB: number | null;
  layers: number | null;
  context: number;
  slots: number;
  sha256: string | null;
  hashVerified: boolean;
  tokPerSec: number;
  ttftMs: number;
  priceInUsd: number;
  priceOutUsd: number;
  /** The host's price per hour for the full GPU; 0 means no hourly rentals. The server derives seat prices from it. */
  priceHourUsd: number;
  simulate: boolean;
  publicMode: boolean;
  /** Set by `sublera start <code>`: the request this agent wants to serve. */
  requestId?: string | null;
  cachedModels?: CachedModelInfo[];
};

export type HeartbeatPayload = {
  type: 'heartbeat';
  tokPerSec: number;
  ttftMs: number;
  llamaUp: boolean;
  sha256: string | null;
  file: string;
  layers: number | null;
  activeJobId: string | null;
  wakeLock: boolean;
  gpuTempC: number | null;
  gpuPowerW: number | null;
  gpuUtilPct: number | null;
  freeVramMb: number;
  slotsUsed: number;
};

export type WalletView = {
  availableNanos: number;
  pendingNanos: number;
  escrowNanos: number;
  heldNanos?: number;
  cardFundedNanos?: number;
  cryptoFundedNanos?: number;
};

export type AgentHost = {
  username: string;
  status: string;
  kind: 'simulator' | 'live' | string;
  gpuName: string;
  vramMb: number;
  hardwareVerified: boolean;
  modelId: string;
  modelLabel: string;
  repo: string;
  file: string;
  quant: string;
  paramB: number | null;
  layers: number | null;
  context: number;
  tokPerSec: number;
  ttftMs: number;
  slotsUsed: number;
  slotsTotal: number;
  priceInNanos: number;
  priceOutNanos: number;
  trust: number;
  uptimePct: number;
  tokensServed: number;
  flagReason: string | null;
  verified: boolean;
  llamaUp: boolean;
  lastSeen: number | null;
  activeRequest?: ActiveRequest | null;
};

export type ActiveRequest = {
  id: string;
  status: string;
  modelLabel?: string | null;
  file?: string | null;
  hours?: number | null;
  pricePerHourNanos?: number | null;
  minTokS?: number | null;
  timerStartedAt?: number | null;
  timerEndsAt?: number | null;
  escrowRemainingNanos?: number;
  /** Same meaning as in the booking frame, when the server includes them. */
  shared?: boolean | null;
  tokS?: number | null;
};

export type AgentMe = {
  user: { id: string; username: string; email?: string; isAdmin?: boolean };
  wallet: WalletView;
  host: AgentHost | null;
  /** The newest live request of this host. */
  activeRequest: ActiveRequest | null;
  /** Every live request of this host, newest first. Older servers do not send it. */
  activeRequests?: ActiveRequest[];
  serverNow: number;
};

/** The shape of a request id the server issues. Frames and status rows with any other id are ignored. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** A finite number from the server or state.json, or null. Numeric strings count; NaN, Infinity, booleans and objects do not. */
export function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A positive time in ms that `Date` can represent, or null. */
export function validTime(value: unknown): number | null {
  const time = finiteNumber(value);
  return time != null && time > 0 && time <= 8.64e15 ? time : null;
}

const ROW_NUMBERS = ['hours', 'pricePerHourNanos', 'minTokS', 'tokS', 'escrowRemainingNanos'] as const;
const ROW_TIMES = ['timerStartedAt', 'timerEndsAt'] as const;

/** A status row with checked types. A field the server left out stays undefined; a broken one becomes null. */
function normalizeRow(raw: Record<string, unknown>): ActiveRequest {
  const row: Record<string, unknown> = { ...raw, status: typeof raw.status === 'string' ? raw.status : '' };
  for (const key of ROW_NUMBERS) if (raw[key] !== undefined) row[key] = finiteNumber(raw[key]);
  for (const key of ROW_TIMES) if (raw[key] !== undefined) row[key] = validTime(raw[key]);
  for (const key of ['file', 'modelLabel']) if (raw[key] != null && typeof raw[key] !== 'string') row[key] = null;
  if (raw.shared != null) row.shared = raw.shared === true;
  return row as ActiveRequest;
}

/** Every live request in a /api/agent/me answer: `activeRequests`, or the single `activeRequest` from an older server. */
export function activeRequestsOf(me: Pick<AgentMe, 'activeRequest' | 'activeRequests'>): ActiveRequest[] {
  const list: unknown[] = Array.isArray(me.activeRequests) ? me.activeRequests : me.activeRequest ? [me.activeRequest] : [];
  return list
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && isRequestId((row as { id?: unknown }).id)))
    .map(normalizeRow);
}

export type AgentRequest = {
  id: string;
  buyer?: string;
  buyerId?: string;
  repo?: string | null;
  file?: string | null;
  modelLabel?: string | null;
  quant?: string | null;
  paramB?: number | null;
  layers?: number | null;
  needsMb?: number | null;
  hours?: number | null;
  pricePerHourNanos?: number | null;
  totalPayoutNanos?: number | null;
  minContext?: number;
  minTokS?: number;
  status: string;
  createdAt?: number;
  timerStartedAt?: number | null;
  timerEndsAt?: number | null;
  fit?: string | null;
  cached?: boolean;
};
