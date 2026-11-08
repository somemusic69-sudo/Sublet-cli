import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchHfFileInfo,
  BufferWriter,
  buildGgufSample,
  estimateVramMb,
  layerMismatch,
  paramBFromName,
  parseGgufHeader,
  parseHfUrl,
  quantFromName,
  rejectModelFile,
} from '../src/engine/gguf.js';

function sample(layers = 32, embedding = 4096, name = 'tiny'): Buffer {
  return buildGgufSample([
    { key: 'general.architecture', type: 8, write: (b) => b.str('llama') },
    { key: 'general.name', type: 8, write: (b) => b.str(name) },
    { key: 'llama.block_count', type: 4, write: (b) => b.u32(layers) },
    { key: 'llama.embedding_length', type: 4, write: (b) => b.u32(embedding) },
    { key: 'llama.feed_forward_length', type: 4, write: (b) => b.u32(14336) },
    { key: 'llama.context_length', type: 4, write: (b) => b.u32(131072) },
    { key: 'llama.attention.head_count', type: 4, write: (b) => b.u32(32) },
    { key: 'llama.attention.head_count_kv', type: 4, write: (b) => b.u32(8) },
    { key: 'llama.vocab_size', type: 4, write: (b) => b.u32(128256) },
    { key: 'general.file_type', type: 4, write: (b) => b.u32(15) },
  ]);
}

test('GGUF header exposes layers, architecture, and quantization', () => {
  const info = parseGgufHeader(sample(32, 4096));
  assert.equal(info.version, 3);
  assert.equal(info.architecture, 'llama');
  assert.equal(info.layers, 32);
  assert.equal(info.embeddingLength, 4096);
  assert.equal(info.contextTrain, 131072);
  assert.equal(info.quantLabel, 'Q4_K_M');
  assert.ok((info.paramB || 0) > 1);
  assert.equal(info.complete, true);
});

test('GGUF parser refuses non-GGUF bytes and version 1', () => {
  assert.throws(() => parseGgufHeader(Buffer.from('hello world')), /Not a GGUF/);
  const w = new BufferWriter();
  w.raw(Buffer.from('GGUF'));
  w.u32(1);
  w.u64(0);
  w.u64(0);
  assert.throws(() => parseGgufHeader(w.buf()), /version 1/);
});

test('renamed files cannot lie about layers or parameter size', () => {
  assert.match(layerMismatch(70, 28) || '', /cannot be a 70B/);
  assert.match(layerMismatch(7, 80) || '', /too deep/);
  assert.equal(layerMismatch(8, 32), null);
  assert.equal(paramBFromName('Llama-3.3-70B-Instruct-Q4_K_M.gguf'), 70);
  assert.equal(paramBFromName('Qwen2.5-Coder-32B-Instruct-GGUF'), 32);
  assert.equal(quantFromName('Meta-Llama-3.1-8B-Instruct-Q8_0.gguf'), 'Q8_0');
});

test('only GGUF model files are accepted', () => {
  assert.match(rejectModelFile('model.pkl') || '', /GGUF|Pickle/);
  assert.match(rejectModelFile('pytorch_model.bin') || '', /GGUF|Pickle/);
  assert.equal(rejectModelFile('model.gguf'), null);
});

test('split GGUF shards are refused before download', () => {
  assert.match(rejectModelFile('qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf') || '', /Split GGUF/);
  assert.equal(rejectModelFile('Qwen2.5-7B-Instruct-Q4_K_M.gguf'), null);
});

test('HuggingFace resolve, blob, and hf.co links are parsed', () => {
  const resolve = parseHfUrl('https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf');
  assert.equal(resolve?.repo, 'Qwen/Qwen2.5-7B-Instruct-GGUF');
  assert.equal(resolve?.file, 'qwen2.5-7b-instruct-q4_k_m.gguf');
  assert.match(resolve?.downloadUrl || '', /^https:\/\/huggingface\.co\/Qwen\/Qwen2\.5-7B-Instruct-GGUF\/resolve\/main\//);
  assert.equal(parseHfUrl('https://hf.co/a/b/resolve/main/model.gguf')?.repo, 'a/b');
  assert.equal(parseHfUrl('https://example.com/a/b/resolve/main/model.gguf'), null);
  assert.equal(parseHfUrl('not a url'), null);
});

test('VRAM estimate grows with context and quantization', () => {
  const q4 = estimateVramMb({ paramB: 8, quant: 'Q4_K_M', context: 8192, layers: 32 });
  const q8 = estimateVramMb({ paramB: 8, quant: 'Q8_0', context: 8192, layers: 32 });
  const long = estimateVramMb({ paramB: 8, quant: 'Q4_K_M', context: 32768, layers: 32 });
  assert.ok(q8 > q4);
  assert.ok(long > q4);
  assert.ok(q4 > 4000);
});

test('general.file_type uses the llama.cpp llama_ftype ids', () => {
  const quantFor = (fileType: number) => parseGgufHeader(buildGgufSample([
    { key: 'general.architecture', type: 8, write: (b) => b.str('llama') },
    { key: 'general.file_type', type: 4, write: (b) => b.u32(fileType) },
  ])).quantLabel;
  assert.equal(quantFor(7), 'Q8_0');
  assert.equal(quantFor(8), 'Q5_0');
  assert.equal(quantFor(9), 'Q5_1');
  assert.equal(quantFor(15), 'Q4_K_M');
  assert.equal(quantFor(30), 'IQ4_XS');
  assert.equal(quantFor(32), 'BF16');
  assert.equal(quantFor(6), null);
});

test('VRAM estimate reserves KV cache for every parallel slot', () => {
  const one = estimateVramMb({ paramB: 8, quant: 'Q4_K_M', context: 8192, layers: 32 });
  const four = estimateVramMb({ paramB: 8, quant: 'Q4_K_M', context: 8192, layers: 32, slots: 4 });
  assert.equal(estimateVramMb({ paramB: 8, quant: 'Q4_K_M', context: 8192, layers: 32, slots: 1 }), one);
  assert.equal(four - one, 3 * 1024);
});

test('the SHA-256 lookup uses the revision from the model link', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ siblings: [{ rfilename: 'm.gguf', lfs: { sha256: 'f'.repeat(64), size: 9 } }] }), { status: 200 });
  }) as typeof fetch;
  const info = await fetchHfFileInfo('org/repo', 'm.gguf', 1_000, 'refs/pr/3', fetchImpl);
  assert.equal(seen[0], 'https://huggingface.co/api/models/org/repo/revision/refs%2Fpr%2F3?blobs=true');
  assert.equal(info.sha256, 'f'.repeat(64));
  assert.equal(info.size, 9);
});
