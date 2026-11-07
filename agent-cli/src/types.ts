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

export type CanaryJob = {
  type: 'canary';
  jobId: string;
  prompt: string;
  seed: number;
  maxTokens: number;
  temperature: number;
};

export type LoadJob = {
  type: 'load';
  requestId: string;
  url: string;
  file: string | null;
  sha256: string | null;
  layers: number | null;
  context: number;
};

export type ServerMessage =
  | { type: 'welcome'; username?: string }
  | CanaryJob
  | WorkerJob
  | LoadJob
  | { type: 'cancel'; jobId: string }
  | { type: 'verified'; requestId: string; fingerprint?: string }
  | { type: 'booking'; requestId: string; timerStartedAt?: number; timerEndsAt?: number; hours?: number; pricePerHourNanos?: number; minTokS?: number }
  | { type: 'reject'; requestId: string; reason?: string }
  | { type: 'error'; message?: string }
  | { type: string; [key: string]: unknown };

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
  simulate: boolean;
  publicMode: boolean;
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
};

export type AgentMe = {
  user: { id: string; username: string; email?: string; isAdmin?: boolean };
  wallet: WalletView;
  host: AgentHost | null;
  activeRequest: ActiveRequest | null;
  serverNow: number;
};

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
};
