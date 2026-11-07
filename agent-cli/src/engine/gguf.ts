import { readFirstBytes } from '../util/fs.js';

export type GgufInfo = {
  version: number;
  architecture: string | null;
  name: string | null;
  layers: number | null;
  embeddingLength: number | null;
  fileType: number | null;
  quantLabel: string | null;
  headCount: number | null;
  headCountKv: number | null;
  feedForward: number | null;
  contextTrain: number | null;
  vocabSize: number | null;
  paramB: number | null;
  keysRead: number;
  complete: boolean;
};

const FILE_TYPE_QUANT: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K',
};

export function quantBytesPerParam(quant: string): number {
  const q = quant.toUpperCase();
  if (q.includes('Q2')) return 0.35;
  if (q.includes('Q3')) return 0.42;
  if (q.includes('Q4') || q.includes('IQ4')) return 0.55;
  if (q.includes('Q5')) return 0.66;
  if (q.includes('Q6')) return 0.78;
  if (q.includes('Q8')) return 1.05;
  if (q.includes('F16') || q.includes('FP16') || q.includes('BF16')) return 2;
  if (q.includes('F32')) return 4;
  return 0.6;
}

export function guessLayers(paramB: number): number {
  if (paramB < 4) return 24;
  if (paramB < 9) return 32;
  if (paramB < 16) return 40;
  if (paramB < 35) return 48;
  if (paramB < 75) return 80;
  return 96;
}

export function estimateVramMb(opts: { paramB: number; quant: string; context: number; layers?: number }): number {
  const modelMb = opts.paramB * quantBytesPerParam(opts.quant) * 1024;
  const layers = opts.layers || guessLayers(opts.paramB);
  const kvMb = (opts.context * layers * 4096) / (1024 * 1024);
  return Math.round(modelMb + kvMb + 700);
}

export function paramBFromName(name: string): number | null {
  const matches = [...name.matchAll(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/g)];
  if (!matches.length) return null;
  const n = Number(matches[matches.length - 1]?.[1]);
  if (Number.isFinite(n) && n >= 0.1 && n <= 2000) return n;
  return null;
}

export function quantFromName(name: string): string | null {
  const match = name.match(/\b(IQ\d_[A-Z0-9]+|Q\d(?:_[A-Z0-9]+)?|F16|F32|BF16)\b/i);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function layerMismatch(claimedParamB: number | null, layers: number | null): string | null {
  if (claimedParamB == null || layers == null) return null;
  if (claimedParamB >= 50 && layers < 48) return `GGUF header has ${layers} layers, which cannot be a ${claimedParamB}B model`;
  if (claimedParamB <= 8 && layers >= 64) return `GGUF header has ${layers} layers, which is too deep for a ${claimedParamB}B model`;
  return null;
}

export function rejectModelFile(file: string): string | null {
  const lower = file.toLowerCase();
  if (lower.endsWith('.gguf')) return null;
  if (/\.(bin|pkl|pickle|pt|pth|safetensors|onnx|ggml|ckpt)$/.test(lower)) {
    return 'Kiln only runs GGUF weights. Pickle and PyTorch files can execute code on a host PC, so they are refused.';
  }
  return 'Model file must be a .gguf from HuggingFace.';
}

class Reader {
  offset = 0;
  constructor(readonly buf: Buffer) {}
  private need(n: number) {
    if (n < 0 || this.offset + n > this.buf.length) throw new Error('truncated header');
  }
  u8() { this.need(1); const v = this.buf.readUInt8(this.offset); this.offset += 1; return v; }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.offset); this.offset += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.offset); this.offset += 4; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.offset); this.offset += 4; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.offset); this.offset += 4; return v; }
  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('integer too large');
    return Number(v);
  }
  i64() { this.need(8); const v = this.buf.readBigInt64LE(this.offset); this.offset += 8; return Number(v); }
  f64() { this.need(8); const v = this.buf.readDoubleLE(this.offset); this.offset += 8; return v; }
  str(max = 4_000_000): string {
    const len = this.u64();
    if (len > max) throw new Error('string too large');
    this.need(len);
    const s = this.buf.subarray(this.offset, this.offset + len).toString('utf8');
    this.offset += len;
    return s;
  }
  skipString() {
    const len = this.u64();
    if (len > this.buf.length) throw new Error('string too large');
    this.need(len);
    this.offset += len;
  }
}

function skipValue(r: Reader, type: number): void {
  switch (type) {
    case 0: case 1: case 7: r.u8(); return;
    case 2: case 3: r.u16(); return;
    case 4: case 5: case 6: r.u32(); return;
    case 10: case 11: case 12: r.u64(); return;
    case 8: r.skipString(); return;
    case 9: {
      const elem = r.u32();
      const count = r.u64();
      if (count > 5_000_000) throw new Error('array too large');
      for (let i = 0; i < count; i++) skipValue(r, elem);
      return;
    }
    default: throw new Error(`unknown GGUF type ${type}`);
  }
}

function readScalar(r: Reader, type: number): number | string | null {
  switch (type) {
    case 0: case 1: case 7: return r.u8();
    case 2: case 3: return r.u16();
    case 4: return r.u32();
    case 5: return r.i32();
    case 6: return r.f32();
    case 8: return r.str();
    case 10: return r.u64();
    case 11: return r.i64();
    case 12: return r.f64();
    default: skipValue(r, type); return null;
  }
}

export function parseGgufHeader(buf: Buffer): GgufInfo {
  const info: GgufInfo = {
    version: 0, architecture: null, name: null, layers: null, embeddingLength: null,
    fileType: null, quantLabel: null, headCount: null, headCountKv: null, feedForward: null,
    contextTrain: null, vocabSize: null, paramB: null, keysRead: 0, complete: false,
  };
  if (buf.length < 24 || buf.subarray(0, 4).toString('latin1') !== 'GGUF') throw new Error('Not a GGUF file');
  const r = new Reader(buf);
  r.offset = 4;
  info.version = r.u32();
  if (info.version < 2) throw new Error('GGUF version 1 is not supported');
  r.u64();
  const kvCount = r.u64();
  if (kvCount > 1_000_000) throw new Error('GGUF metadata count is invalid');
  try {
    for (let i = 0; i < kvCount; i++) {
      const key = r.str(4096);
      const type = r.u32();
      const known = /^(general\.(architecture|name|file_type)|.*\.(block_count|embedding_length|feed_forward_length|attention\.head_count|attention\.head_count_kv|context_length|vocab_size)|tokenizer\.ggml\.vocab_size)$/.test(key);
      const value = known ? readScalar(r, type) : (skipValue(r, type), null);
      info.keysRead++;
      if (key === 'general.architecture' && typeof value === 'string') info.architecture = value;
      if (key === 'general.name' && typeof value === 'string') info.name = value;
      if (key === 'general.file_type' && typeof value === 'number') {
        info.fileType = value;
        info.quantLabel = FILE_TYPE_QUANT[value] || null;
      }
      if (key.endsWith('.block_count') && typeof value === 'number') info.layers = value;
      if (key.endsWith('.embedding_length') && typeof value === 'number') info.embeddingLength = value;
      if (key.endsWith('.feed_forward_length') && typeof value === 'number') info.feedForward = value;
      if (key.endsWith('.attention.head_count') && typeof value === 'number') info.headCount = value;
      if (key.endsWith('.attention.head_count_kv') && typeof value === 'number') info.headCountKv = value;
      if (key.endsWith('.context_length') && typeof value === 'number') info.contextTrain = value;
      if ((key.endsWith('.vocab_size') || key === 'tokenizer.ggml.vocab_size') && typeof value === 'number') info.vocabSize = value;
      const essential = info.architecture && info.layers && info.embeddingLength && info.fileType != null;
      if (essential && i > 12) break;
    }
    info.complete = true;
  } catch {
    info.complete = false;
  }
  if (info.layers && info.embeddingLength) {
    const kvRatio = info.headCount && info.headCountKv ? info.headCountKv / info.headCount : 0.25;
    const ffn = info.feedForward ?? info.embeddingLength * 3.5;
    const L = info.layers;
    const E = info.embeddingLength;
    const attn = L * (E * E + 2 * E * E * kvRatio + E * E);
    const mlp = L * 3 * E * ffn;
    const embed = (info.vocabSize ?? 128256) * E;
    info.paramB = Math.round(((attn + mlp + embed) / 1e9) * 10) / 10;
  }
  return info;
}

export async function readGgufHeader(path: string, maxBytes = 4 * 1024 * 1024): Promise<GgufInfo> {
  const buf = await readFirstBytes(path, maxBytes);
  if (buf.length < 4 || buf.subarray(0, 4).toString('latin1') !== 'GGUF') throw new Error('Not a GGUF file (bad magic)');
  return parseGgufHeader(buf);
}

export type HfParsedUrl = { repo: string; file: string; rev: string; downloadUrl: string };

const HF_HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co', 'www.hf.co']);

export function parseHfUrl(raw: string): HfParsedUrl | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || !HF_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts.length < 5) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  const mode = parts[2];
  if (mode !== 'resolve' && mode !== 'blob' && mode !== 'raw') return null;
  const rev = parts[3] || 'main';
  const file = parts.slice(4).join('/');
  const encoded = parts.slice(4).map((p) => encodeURIComponent(p)).join('/');
  return {
    repo,
    file,
    rev,
    downloadUrl: `https://huggingface.co/${repo}/resolve/${rev}/${encoded}`,
  };
}

export type HfFileInfo = { sha256: string | null; size: number | null; siblings: string[] };

export async function fetchHfFileInfo(repo: string, file: string, timeoutMs = 15_000): Promise<HfFileInfo> {
  const response = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, {
    headers: { 'user-agent': 'kiln-agent/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HuggingFace API returned ${response.status}`);
  const data = await response.json() as { siblings?: { rfilename: string; lfs?: { oid?: string; sha256?: string; size?: number } }[] };
  const siblings = data.siblings || [];
  const hit = siblings.find((s) => s.rfilename === file);
  return {
    sha256: hit?.lfs?.sha256 || hit?.lfs?.oid || null,
    size: hit?.lfs?.size ?? null,
    siblings: siblings.map((s) => s.rfilename),
  };
}

export type InspectedModel = {
  repo: string;
  file: string;
  url: string;
  sha256: string | null;
  size: number | null;
  info: GgufInfo | null;
  paramB: number | null;
  quant: string | null;
  layers: number | null;
  contextTrain: number | null;
  needsMb: number | null;
  headerChecked: boolean;
  note: string;
};

export async function inspectHuggingFace(rawUrl: string, timeoutMs = 15_000): Promise<InspectedModel> {
  const parsed = parseHfUrl(rawUrl);
  if (!parsed) throw new Error('Paste a full HuggingFace resolve link to a .gguf file');
  const refused = rejectModelFile(parsed.file);
  if (refused) throw new Error(refused);
  const nameParam = paramBFromName(`${parsed.repo} ${parsed.file}`);
  const nameQuant = quantFromName(parsed.file);
  const result: InspectedModel = {
    repo: parsed.repo,
    file: parsed.file,
    url: parsed.downloadUrl,
    sha256: null,
    size: null,
    info: null,
    paramB: nameParam,
    quant: nameQuant,
    layers: null,
    contextTrain: null,
    needsMb: nameParam ? estimateVramMb({ paramB: nameParam, quant: nameQuant || 'Q4_K_M', context: 8192 }) : null,
    headerChecked: false,
    note: 'Filename only - header was not read',
  };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const meta = await fetchHfFileInfo(parsed.repo, parsed.file, timeoutMs);
    result.sha256 = meta.sha256;
    result.size = meta.size;
  } catch {
    /* still try header */
  }
  try {
    const response = await fetch(parsed.downloadUrl, {
      headers: { range: 'bytes=0-4194303', 'user-agent': 'kiln-agent/1.0' },
      signal,
      redirect: 'follow',
    });
    if (response.ok || response.status === 206) {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.subarray(0, 4).toString('latin1') === 'GGUF') {
        const info = parseGgufHeader(buf);
        result.info = info;
        result.layers = info.layers;
        result.contextTrain = info.contextTrain;
        result.headerChecked = info.layers != null;
        if (info.quantLabel) result.quant = info.quantLabel;
        const mismatch = layerMismatch(nameParam, info.layers);
        if (mismatch) throw new Error(mismatch);
        if (info.paramB && (!result.paramB || Math.abs(info.paramB - result.paramB) / result.paramB < 0.45)) result.paramB = info.paramB;
        if (result.paramB) {
          result.needsMb = estimateVramMb({
            paramB: result.paramB,
            quant: result.quant || 'Q4_K_M',
            context: 8192,
            layers: info.layers ?? undefined,
          });
        }
        result.note = result.headerChecked ? 'GGUF header read' : 'Partial header';
      }
    }
  } catch (error) {
    if (error instanceof Error && /layers/.test(error.message)) throw error;
  }
  return result;
}

export class BufferWriter {
  private parts: Buffer[] = [];
  u8(n: number) { const b = Buffer.alloc(1); b.writeUInt8(n); this.parts.push(b); }
  u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); this.parts.push(b); }
  u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.parts.push(b); }
  i32(n: number) { const b = Buffer.alloc(4); b.writeInt32LE(n); this.parts.push(b); }
  u64(n: number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); this.parts.push(b); }
  str(s: string) { const body = Buffer.from(s); this.u64(body.length); this.parts.push(body); }
  raw(b: Buffer) { this.parts.push(b); }
  buf() { return Buffer.concat(this.parts); }
}

export function buildGgufSample(pairs: { key: string; type: number; write: (b: BufferWriter) => void }[]): Buffer {
  const w = new BufferWriter();
  w.raw(Buffer.from('GGUF'));
  w.u32(3);
  w.u64(0);
  w.u64(pairs.length);
  for (const pair of pairs) {
    w.str(pair.key);
    w.u32(pair.type);
    pair.write(w);
  }
  return w.buf();
}
