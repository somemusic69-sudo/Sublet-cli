import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { subletHome } from './config.js';

export type AgentHealth = {
  schemaVersion: 1;
  agentVersion: string;
  pid: number;
  updatedAt: number;
  live: boolean;
  ready: boolean;
  draining: boolean;
  simulation: boolean;
  tunnel: string;
  engine: string;
  activeJobs: number;
  loading: boolean;
};

export function healthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(subletHome(env), 'health.json');
}

/** Local readiness only: not server attestation, billing approval, or a GPU benchmark. */
export async function readHealth(env: NodeJS.ProcessEnv = process.env): Promise<AgentHealth> {
  const data = JSON.parse(await readFile(healthPath(env), 'utf8')) as AgentHealth;
  const now = Date.now();
  if (!data || typeof data !== 'object' || data.schemaVersion !== 1 || !Number.isSafeInteger(data.pid) || data.pid <= 0
    || !Number.isFinite(data.updatedAt) || data.updatedAt > now + 5_000 || now - data.updatedAt > 15_000
    || typeof data.live !== 'boolean' || typeof data.ready !== 'boolean'
    || typeof data.draining !== 'boolean' || typeof data.simulation !== 'boolean'
    || !Number.isSafeInteger(data.activeJobs) || data.activeJobs < 0
    || typeof data.tunnel !== 'string' || typeof data.engine !== 'string'
    || typeof data.agentVersion !== 'string' || typeof data.loading !== 'boolean'
    || (data.ready && (!data.live || data.draining || data.loading || data.tunnel !== 'open'
      || (data.simulation ? data.engine !== 'simulation' : data.engine !== 'ready')))) {
    throw new Error('Agent health snapshot is stale or invalid');
  }
  try { process.kill(data.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw new Error('Agent process is not running');
  }
  // Return a fixed allowlist: a damaged or user-edited snapshot must not cause
  // arbitrary extra fields (credentials, prompts) to be printed by health.
  return {
    schemaVersion: 1, agentVersion: String(data.agentVersion), pid: data.pid,
    updatedAt: data.updatedAt, live: data.live, ready: data.ready,
    draining: data.draining, simulation: data.simulation, tunnel: data.tunnel,
    engine: data.engine, activeJobs: data.activeJobs, loading: data.loading === true,
  };
}