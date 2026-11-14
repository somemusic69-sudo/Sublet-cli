import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { subletHome } from './config.js';
import { atomicWrite } from './util/fs.js';
import { finiteNumber, isRequestId, validTime } from './types.js';

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
  /** A speed seat that shares the GPU; absent in files written before seats existed. */
  shared?: boolean;
  /** The reserved speed of a seat; null or absent means the full GPU. */
  tokS?: number | null;
  savedAt: number;
};

export type PersistedState = {
  version: 1;
  /**
   * One booking, for older agents and scripts that read only this field: the server's `activeRequest`
   * when the agent knows it (an older agent drops the booking unless it is that one), else the newest.
   */
  booking: PersistedBooking;
  /** Every active booking, newest first. Files from older agents only have `booking`. */
  bookings?: PersistedBooking[];
  updatedAt: number;
};

/**
 * A saved booking with every number checked (a hand-edited or damaged file can hold strings, NaN or
 * nonsense), or null when it has no valid request id, model or end time.
 */
function readBooking(value: unknown): PersistedBooking | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isRequestId(raw.requestId) || !raw.model || typeof raw.model !== 'object') return null;
  const timerEndsAt = validTime(raw.timerEndsAt);
  if (timerEndsAt == null) return null;
  const booking: PersistedBooking = {
    ...(raw as unknown as PersistedBooking),
    context: finiteNumber(raw.context) ?? 0,
    slots: finiteNumber(raw.slots) ?? 1,
    timerStartedAt: validTime(raw.timerStartedAt),
    timerEndsAt,
    hours: finiteNumber(raw.hours),
    pricePerHourNanos: finiteNumber(raw.pricePerHourNanos),
    minTokS: finiteNumber(raw.minTokS),
    guaranteedNanos: finiteNumber(raw.guaranteedNanos),
    savedAt: finiteNumber(raw.savedAt) ?? 0,
  };
  if (raw.tokS !== undefined) booking.tokS = finiteNumber(raw.tokS);
  if (raw.shared !== undefined) booking.shared = raw.shared === true;
  return booking;
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'state.json');
}

/** Reads state.json. The result always has `bookings`; a file with only the legacy `booking` field becomes a list of one. */
export async function readAgentState(env: NodeJS.ProcessEnv = process.env): Promise<(PersistedState & { bookings: PersistedBooking[] }) | null> {
  try {
    const raw = await readFile(statePath(env), 'utf8');
    const data = JSON.parse(raw) as Partial<PersistedState> | null;
    if (!data || data.version !== 1) return null;
    const bookings: PersistedBooking[] = [];
    const seen = new Set<string>();
    // New files repeat one of the bookings in `booking`; the requestId check drops the copy.
    for (const entry of [...(Array.isArray(data.bookings) ? data.bookings : []), data.booking]) {
      const booking = readBooking(entry);
      if (!booking || seen.has(booking.requestId)) continue;
      seen.add(booking.requestId);
      bookings.push(booking);
    }
    if (!bookings.length) return null;
    return { version: 1, booking: bookings[0]!, bookings, updatedAt: Number(data.updatedAt) || 0 };
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
