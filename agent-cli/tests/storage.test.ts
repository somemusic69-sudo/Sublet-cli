import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { availableWriteBytes, directoryBytes, storagePolicy } from '../src/util/storage.js';
import { downloadModel, modelPathFor } from '../src/engine/modelManager.js';
import { installLlamaServer } from '../src/engine/binaryManager.js';

test('storage defaults and environment limits are finite and positive', () => {
  assert.deepEqual(storagePolicy({}), { modelCacheBytes: 20 * 1024 ** 3, reserveBytes: 5 * 1024 ** 3 });
  assert.equal(storagePolicy({ SUBLET_MODEL_CACHE_GB: '40' }).modelCacheBytes, 40 * 1024 ** 3);
  for (const value of ['', '0', '-1', 'NaN', 'Infinity', '1048577']) {
    assert.throws(() => storagePolicy({ SUBLET_MODEL_CACHE_GB: value }), /positive/);
  }
  assert.equal(availableWriteBytes(100, 40), 60);
  assert.equal(availableWriteBytes(20, 40), 0);
});

test('storage accounting includes nested models, partials, and other files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'nested'));
  await writeFile(join(dir, 'model.gguf'), '123');
  await writeFile(join(dir, 'nested', 'model.part'), '12345');
  assert.equal(await directoryBytes(dir), 8);
});

test('model cache budget refuses new downloads without deleting existing data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-storage-model-'));
  const old = process.env.SUBLET_MODEL_CACHE_GB;
  process.env.SUBLET_MODEL_CACHE_GB = '0.0001';
  t.after(async () => {
    if (old == null) delete process.env.SUBLET_MODEL_CACHE_GB; else process.env.SUBLET_MODEL_CACHE_GB = old;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, 'existing.gguf'), Buffer.alloc(100_000, 1));
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(downloadModel({ url: 'https://huggingface.co/test/model/resolve/main/new.gguf', cacheDir: dir, showProgress: false, fetchImpl: (async () => new Response(body, { headers: { 'content-length': '1000' } })) as typeof fetch }), /storage budget/);
  assert.equal(cancelled, true);
  assert.equal((await readFile(join(dir, 'existing.gguf'))).length, 100_000);
});

test('unknown-length model streams cannot exceed the cache budget', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-storage-stream-'));
  const old = process.env.SUBLET_MODEL_CACHE_GB;
  process.env.SUBLET_MODEL_CACHE_GB = '0.0001';
  t.after(async () => {
    if (old == null) delete process.env.SUBLET_MODEL_CACHE_GB; else process.env.SUBLET_MODEL_CACHE_GB = old;
    await rm(dir, { recursive: true, force: true });
  });
  const url = 'https://huggingface.co/test/model/resolve/main/new.gguf';
  await assert.rejects(downloadModel({ url, cacheDir: dir, showProgress: false, fetchImpl: (async () => new Response(new Uint8Array(200_000))) as typeof fetch }), /storage budget/);
  assert.ok(await directoryBytes(dir) < 0.0001 * 1024 ** 3);
  await assert.rejects(readFile(modelPathFor(url, dir)), /ENOENT/);
});

test('engine install refuses insufficient headroom before fetching archives', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-storage-engine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(installLlamaServer({ env: { SUBLET_HOME: dir, SUBLET_MIN_FREE_DISK_GB: '1048576' }, platform: 'win32', arch: 'x64', release: { tag_name: 'test', assets: [{ name: 'llama-bin-win-cpu-x64.zip', browser_download_url: 'https://example.test/engine.zip', size: 100 }] }, fetchImpl: (async () => { calls++; throw new Error('must not download'); }) as typeof fetch }), /Not enough disk space/);
  assert.equal(calls, 0);
});

test('model size validation rejects invalid sizes without starting a request', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-storage-size-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const expectedSize of [-1, 0, NaN, Infinity, 1.5]) {
    await assert.rejects(downloadModel({ url: 'https://huggingface.co/test/model/resolve/main/model.gguf', cacheDir: dir, expectedSize, fetchImpl: (async () => { throw new Error('must not fetch'); }) as typeof fetch }), /positive safe integer/);
  }
});