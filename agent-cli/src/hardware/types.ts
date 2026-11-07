export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'unknown';

export type GpuProcess = {
  pid: number;
  name: string;
  usedMb: number;
};

export type GpuStats = {
  index: number;
  name: string;
  vendor: GpuVendor;
  totalVramMb: number;
  freeVramMb: number;
  usedVramMb: number;
  utilizationPct: number | null;
  temperatureC: number | null;
  powerW: number | null;
  powerLimitW: number | null;
  processes: GpuProcess[];
};

export type GpuSnapshot = {
  gpus: GpuStats[];
  primary: GpuStats | null;
  source: string;
  platform: NodeJS.Platform;
  checkedAt: number;
  warnings: string[];
};

export type FitResult = {
  ok: boolean;
  reason?: string;
  freeMb: number;
  needsMb: number;
  headroomMb: number;
};

export type GpuMonitorOptions = {
  platform?: NodeJS.Platform;
  exec?: typeof import('../util/exec.js').execFile;
  env?: NodeJS.ProcessEnv;
  cacheMs?: number;
};
