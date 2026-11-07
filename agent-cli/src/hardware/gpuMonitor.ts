import { execFile as realExecFile } from '../util/exec.js';
import type { FitResult, GpuMonitorOptions, GpuProcess, GpuSnapshot, GpuStats, GpuVendor } from './types.js';

type ExecFn = typeof realExecFile;

function num(value: string | undefined | null): number | null {
  if (value == null) return null;
  const cleaned = String(value).replace(/[^\d.+-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '+') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function clampMb(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

export function parseNvidiaCsv(text: string): GpuStats[] {
  const gpus: GpuStats[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 3) continue;
    const name = cols[0] || 'NVIDIA GPU';
    const total = clampMb(num(cols[1]));
    const freeRaw = num(cols[2]);
    const free = freeRaw == null ? total : clampMb(freeRaw);
    const used = Math.max(0, total - free);
    const utilization = num(cols[3]);
    const temp = num(cols[4]);
    const power = num(cols[5]);
    const limit = num(cols[6]);
    gpus.push({
      index,
      name,
      vendor: 'nvidia',
      totalVramMb: total,
      freeVramMb: free,
      usedVramMb: used,
      utilizationPct: utilization,
      temperatureC: temp,
      powerW: power,
      powerLimitW: limit,
      processes: [],
    });
  }
  return gpus;
}

export function parseNvidiaProcesses(text: string): GpuProcess[] {
  const out: GpuProcess[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 3) continue;
    const pid = Number(cols[0]);
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, name: cols[1] || 'process', usedMb: clampMb(num(cols[2])) });
  }
  return out;
}

type RocmJson = Record<string, Record<string, string>>;

export function parseRocmJson(raw: unknown): GpuStats[] {
  if (!raw || typeof raw !== 'object') return [];
  const data = raw as RocmJson;
  const gpus: GpuStats[] = [];
  let index = 0;
  for (const [card, values] of Object.entries(data)) {
    if (!/^card\d+$/i.test(card) || !values || typeof values !== 'object') continue;
    const entries = Object.entries(values).reduce<Record<string, string>>((acc, [key, value]) => {
      acc[key.toLowerCase()] = String(value);
      return acc;
    }, {});
    const name = entries['card series'] || entries['card model'] || entries['product name'] || entries['card sku'] || 'AMD GPU';
    const total = clampMb(num(entries['vram total memory (b)']) ? Number(entries['vram total memory (b)']) / 1024 / 1024 : num(entries['vram total size']));
    const usedBytes = entries['vram total used memory (b)'] ?? entries['vram used memory (b)'];
    const used = clampMb(num(usedBytes) ? Number(usedBytes) / 1024 / 1024 : num(entries['vram used size']));
    gpus.push({
      index,
      name,
      vendor: 'amd',
      totalVramMb: total,
      freeVramMb: Math.max(0, total - used),
      usedVramMb: used,
      utilizationPct: num(entries['gpu use (%)'] || entries['gpu utilization']),
      temperatureC: num(entries['temperature (sensor edge) (c)'] || entries['temperature (sensor junction) (c)'] || entries['temperature']),
      powerW: num(entries['average power (w)'] || entries['power (w)']),
      powerLimitW: num(entries['max power (w)']),
      processes: [],
    });
    index++;
  }
  return gpus;
}

type AppleDisplay = {
  _name?: string;
  sppci_model?: string;
  spdisplays_vram?: string;
  spdisplays_vram_shared?: string;
  spdisplays_vendor?: string;
};

export function parseSystemProfiler(raw: unknown, totalSystemMemoryMb = 0): GpuStats[] {
  if (!raw || typeof raw !== 'object') return [];
  const displays = (raw as { SPDisplaysDataType?: AppleDisplay[] }).SPDisplaysDataType;
  if (!Array.isArray(displays) || !displays.length) return [];
  return displays.map((display, index) => {
    const name = display.sppci_model || display._name || 'Apple GPU';
    const vramText = display.spdisplays_vram || display.spdisplays_vram_shared || '';
    const match = vramText.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
    let vram = 0;
    if (match) vram = clampMb(Number(match[1]) * (/gb/i.test(match[2] || '') ? 1024 : 1));
    else if (totalSystemMemoryMb > 0) vram = totalSystemMemoryMb;
    return {
      index,
      name,
      vendor: 'apple' as GpuVendor,
      totalVramMb: vram,
      // macOS does not expose a reliable free-VRAM number for unified memory.
      freeVramMb: vram,
      usedVramMb: 0,
      utilizationPct: null,
      temperatureC: null,
      powerW: null,
      powerLimitW: null,
      processes: [],
    };
  });
}

export function parseWmicJson(raw: unknown): GpuStats[] {
  let rows: Array<{ Name?: string; AdapterRAM?: number | string }> = [];
  if (Array.isArray(raw)) rows = raw;
  else if (raw && typeof raw === 'object') rows = [raw as { Name?: string; AdapterRAM?: number | string }];
  const out: GpuStats[] = [];
  for (const row of rows) {
    const name = row.Name || 'GPU';
    if (/microsoft basic|remote display|virtual/i.test(name)) continue;
    let ram = Number(row.AdapterRAM || 0);
    if (!Number.isFinite(ram) || ram < 0) ram = Math.abs(ram);
    const total = clampMb(ram / 1024 / 1024);
    const vendor: GpuVendor = /nvidia/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'unknown';
    out.push({
      index: out.length,
      name,
      vendor,
      totalVramMb: total,
      freeVramMb: total,
      usedVramMb: 0,
      utilizationPct: null,
      temperatureC: null,
      powerW: null,
      powerLimitW: null,
      processes: [],
    });
  }
  return out;
}

export function choosePrimary(gpus: GpuStats[]): GpuStats | null {
  if (!gpus.length) return null;
  const discrete = gpus.filter((g) => g.vendor === 'nvidia' || g.vendor === 'amd' || g.vendor === 'apple');
  const pool = discrete.length ? discrete : gpus;
  return [...pool].sort((a, b) => b.totalVramMb - a.totalVramMb || (b.utilizationPct || 0) - (a.utilizationPct || 0))[0] || null;
}

export function checkFit(needsMb: number, gpu: GpuStats | null, safetyRatio = 0.02): FitResult {
  if (!gpu) {
    return { ok: false, reason: 'No GPU detected', freeMb: 0, needsMb, headroomMb: -needsMb };
  }
  const budget = gpu.freeVramMb;
  const overhead = Math.max(256, Math.round(needsMb * safetyRatio));
  const required = needsMb + overhead;
  return {
    ok: required <= budget,
    reason: required <= budget
      ? undefined
      : `Needs about ${(required / 1024).toFixed(1)}GB free, this GPU has ${(budget / 1024).toFixed(1)}GB free`,
    freeMb: budget,
    needsMb: required,
    headroomMb: budget - required,
  };
}

export class GpuMonitor {
  private readonly platform: NodeJS.Platform;
  private readonly exec: ExecFn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cacheMs: number;
  private cached: GpuSnapshot | null = null;

  constructor(options: GpuMonitorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.exec = options.exec ?? realExecFile;
    this.env = options.env ?? process.env;
    this.cacheMs = options.cacheMs ?? 1_000;
  }

  async scan(force = false): Promise<GpuSnapshot> {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < this.cacheMs) return this.cached;
    const snapshot = await this.detect();
    this.cached = snapshot;
    return snapshot;
  }

  private async detect(): Promise<GpuSnapshot> {
    const warnings: string[] = [];
    const nvidia = await this.detectNvidia(warnings);
    if (nvidia.length) return this.snapshot(nvidia, 'nvidia-smi', warnings);
    const rocm = await this.detectRocm(warnings);
    if (rocm.length) return this.snapshot(rocm, 'rocm-smi', warnings);
    if (this.platform === 'darwin') {
      const apple = await this.detectApple(warnings);
      if (apple.length) return this.snapshot(apple, 'system_profiler', warnings);
    }
    if (this.platform === 'win32') {
      const wmic = await this.detectWindows(warnings);
      if (wmic.length) return this.snapshot(wmic, 'win32_VideoController', warnings);
    }
    const lspci = await this.detectLspci(warnings);
    if (lspci.length) return this.snapshot(lspci, 'lspci', warnings);
    warnings.push('No supported GPU detected. Use --gpu and --vram to run in test mode.');
    return this.snapshot([], 'none', warnings);
  }

  private snapshot(gpus: GpuStats[], source: string, warnings: string[]): GpuSnapshot {
    return {
      gpus,
      primary: choosePrimary(gpus),
      source,
      platform: this.platform,
      checkedAt: Date.now(),
      warnings,
    };
  }

  private async detectNvidia(warnings: string[]): Promise<GpuStats[]> {
    const fields = 'name,memory.total,memory.free,utilization.gpu,temperature.gpu,power.draw,power.limit';
    const result = await this.exec('nvidia-smi', [
      `--query-gpu=${fields}`,
      '--format=csv,noheader,nounits',
    ], { timeoutMs: 10_000 });
    if (result.code !== 0 || !result.stdout.trim()) {
      if (result.error && !/ENOENT|not found/i.test(result.error)) warnings.push(`nvidia-smi: ${result.error}`);
      return [];
    }
    const gpus = parseNvidiaCsv(result.stdout);
    if (!gpus.length) return [];
    const processes = await this.exec('nvidia-smi', [
      '--query-compute-apps=pid,process_name,used_memory',
      '--format=csv,noheader,nounits',
    ], { timeoutMs: 10_000 });
    if (processes.code === 0 && processes.stdout.trim()) {
      const all = parseNvidiaProcesses(processes.stdout);
      const ownPid = process.pid;
      for (const gpu of gpus) {
        gpu.processes = all.filter((p) => p.pid !== ownPid && p.pid !== 0 && p.usedMb >= 128);
      }
    }
    return gpus;
  }

  private async detectRocm(warnings: string[]): Promise<GpuStats[]> {
    const result = await this.exec('rocm-smi', [
      '--showproductname', '--showmeminfo', 'vram', '--showuse', '--showtemp', '--showpower', '--json',
    ], { timeoutMs: 10_000 });
    if (result.code !== 0 || !result.stdout.trim()) {
      if (result.error && !/ENOENT|not found/i.test(result.error)) warnings.push(`rocm-smi: ${result.error}`);
      return [];
    }
    try {
      return parseRocmJson(JSON.parse(result.stdout));
    } catch {
      warnings.push('Could not parse rocm-smi JSON');
      return [];
    }
  }

  private async detectApple(warnings: string[]): Promise<GpuStats[]> {
    const display = await this.exec('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 15_000 });
    if (display.code !== 0 || !display.stdout.trim()) return [];
    let totalMb = 0;
    const mem = await this.exec('sysctl', ['-n', 'hw.memsize'], { timeoutMs: 5_000 });
    if (mem.code === 0) totalMb = Math.round(Number(mem.stdout.trim()) / 1024 / 1024);
    try {
      const gpus = parseSystemProfiler(JSON.parse(display.stdout), totalMb);
      if (gpus.length && !gpus.some((g) => g.totalVramMb > 0)) warnings.push('Apple unified memory size was not reported');
      return gpus;
    } catch {
      warnings.push('Could not parse system_profiler output');
      return [];
    }
  }

  private async detectWindows(warnings: string[]): Promise<GpuStats[]> {
    const script = "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress";
    const result = await this.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15_000 });
    if (result.code !== 0 || !result.stdout.trim()) return [];
    try {
      const gpus = parseWmicJson(JSON.parse(result.stdout));
      if (gpus.length && gpus.every((g) => g.totalVramMb < 512)) {
        warnings.push('Windows reported less than 512MB VRAM; use --vram to override.');
      }
      return gpus;
    } catch {
      warnings.push('Could not parse Windows video controller output');
      return [];
    }
  }

  private async detectLspci(warnings: string[]): Promise<GpuStats[]> {
    if (this.platform !== 'linux') return [];
    const result = await this.exec('lspci', [], { timeoutMs: 8_000 });
    if (result.code !== 0) return [];
    const lines = result.stdout.split(/\r?\n/).filter((l) => /VGA|3D controller|Display controller/i.test(l));
    return lines.map((line, index) => {
      const name = line.replace(/^[0-9a-f:.]+\s+[^:]+:\s*/i, '').trim();
      const vendor: GpuVendor = /nvidia/i.test(name) ? 'nvidia' : /amd|ati|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'unknown';
      return {
        index,
        name,
        vendor,
        totalVramMb: 0,
        freeVramMb: 0,
        usedVramMb: 0,
        utilizationPct: null,
        temperatureC: null,
        powerW: null,
        powerLimitW: null,
        processes: [],
      };
    }).filter((g) => g.name.length > 0);
  }
}

export async function gpuSummary(monitor: GpuMonitor, force = false): Promise<GpuSnapshot> {
  const snapshot = await monitor.scan(force);
  if (!snapshot.gpus.length) void 0;
  return snapshot;
}
