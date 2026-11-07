import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { subletHome } from './config.js';
import { atomicWrite } from './util/fs.js';

export type PersistedModel = {
  url: string;
  path: string;
  file: string;
  modelId: string;
  label: string;
  repo: string;
  quant: string;
  paramB: number | null;
  layers: number | null;
  contextTrain: number | null;
  sha256: string | null;
  verified: boolean;
  needsMb: number | null;
  size: number;
  architecture: string | null;
};

export type PersistedBooking = {
  requestId: string;
  model: PersistedModel;
  context: number;
  slots: number;
  timerStartedAt: number | null;
  timerEndsAt: number | null;
  hours: number | null;
  pricePerHourNanos: number | null;
  minTokS: number | null;
  guaranteedNanos: number | null;
  savedAt: number;
};

export type PersistedState = {
  version: 1;
  booking: PersistedBooking;
  updatedAt: number;
};

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'state.json');
}

export async function readAgentState(env: NodeJS.ProcessEnv = process.env): Promise<PersistedState | null> {
  try {
    const raw = await readFile(statePath(env), 'utf8');
    const data = JSON.parse(raw) as Partial<PersistedState>;
    if (!data || data.version !== 1 || !data.booking?.requestId || !data.booking.model) return null;
    return data as PersistedState;
  } catch {
    return null;
  }
}

export async function saveAgentState(state: PersistedState, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await atomicWrite(statePath(env), `${JSON.stringify(state, null, 2)}\n`);
}

export async function clearAgentState(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(statePath(env), { force: true });
}
