import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadModel, modelPathFor, verifyModelFile } from '../src/engine/modelManager.js';
import { BufferWriter, buildGgufSample } from '../src/engine/gguf.js';

const MODEL = buildGgufSample([
  { key: 'general.architecture', type: 8, write: (b) => b.str('llama') },
  { key: 'general.name', type: 8, write: (b) => b.str('test-model') },
  { key: 'llama.block_count', type: 4, write: (b) => b.u32(32) },
  { key: 'llama.embedding_length', type: 4, write: (b) => b.u32(4096) },
  { key: 'llama.context_length', type: 4, write: (b) => b.u32(8192) },
  { key: 'general.file_type', type: 4, write: (b) => b.u32(15) },
]);

const SHA = createHash('sha256').update(MODEL).digest('hex');

async function withServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/model.gguf` };
}

test('a resumable download appends only the missing range and verifies SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-model-'));
  const ranges: string[] = [];
  const { server, url } = await withServer((req, res) => {
    const range = req.headers.range;
    ranges.push(range || 'none');
    if (range) {
      const start = Number(range.match(/bytes=(\d+)-/)?.[1] || 0);
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': MODEL.length - start,
        'content-range': `bytes ${start}-${MODEL.length - 1}/${MODEL.length}`,
      });
      res.end(MODEL.subarray(start));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
    res.end(MODEL);
  });
  try {
    const dest = modelPathFor(url, dir);
    const part = `${dest}.part`;
    const already = 100;
    await writeFile(part, MODEL.subarray(0, already));
    const progress: number[] = [];
    const loaded = await downloadModel({
      url,
      cacheDir: dir,
      expectedSha256: SHA,
      expectedLayers: 32,
      context: 8192,
      showProgress: false,
      onProgress: (p) => progress.push(p.received),
    });
    assert.equal(loaded.sha256, SHA);
    assert.equal(loaded.layers, 32);
    assert.equal(loaded.quant, 'Q4_K_M');
    assert.equal(loaded.verified, true);
    assert.deepEqual(await readFile(dest), MODEL);
    assert.equal(ranges[0], `bytes=${already}-`);
    assert.ok(progress.some((n) => n >= MODEL.length));
    const sidecar = JSON.parse(await readFile(`${dest}.kiln.json`, 'utf8')) as { sha256: string; size: number };
    assert.equal(sidecar.sha256, SHA);
    assert.equal(sidecar.size, MODEL.length);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a server that ignores Range restarts the file instead of corrupting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-model-'));
  const ranges: string[] = [];
  const { server, url } = await withServer((req, res) => {
    ranges.push(req.headers.range || 'none');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
    res.end(MODEL);
  });
  try {
    const dest = modelPathFor(url, dir);
    const garbage = Buffer.from('garbage that must be discarded');
    await writeFile(`${dest}.part`, garbage);
    const loaded = await downloadModel({ url, cacheDir: dir, expectedSha256: SHA, showProgress: false });
    assert.equal(loaded.sha256, SHA);
    assert.deepEqual(await readFile(dest), MODEL);
    assert.equal(ranges[0], `bytes=${garbage.length}-`);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a bad hash is rejected and both files are removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-model-'));
  const { server, url } = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
    res.end(MODEL);
  });
  try {
    const dest = modelPathFor(url, dir);
    await assert.rejects(
      downloadModel({ url, cacheDir: dir, expectedSha256: '0'.repeat(64), showProgress: false }),
      /SHA-256 mismatch/,
    );
    await assert.rejects(stat(dest), /ENOENT/);
    await assert.rejects(stat(`${dest}.part`), /ENOENT/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a layer mismatch is rejected after the hash passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-model-'));
  const { server, url } = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
    res.end(MODEL);
  });
  try {
    await assert.rejects(
      downloadModel({ url, cacheDir: dir, expectedSha256: SHA, expectedLayers: 80, showProgress: false }),
      /layers/,
    );
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cached files are reused without another request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-model-'));
  let requests = 0;
  const { server, url } = await withServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
    res.end(MODEL);
  });
  try {
    const first = await downloadModel({ url, cacheDir: dir, expectedSha256: SHA, showProgress: false });
    const second = await downloadModel({ url, cacheDir: dir, expectedSha256: SHA, showProgress: false });
    assert.equal(requests, 1);
    assert.equal(first.path, second.path);
    const verified = await verifyModelFile(first.path, { sha256: SHA, layers: 32 });
    assert.equal(verified.sha256, SHA);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('remote model downloads must be https', async () => {
  await assert.rejects(
    downloadModel({ url: 'http://example.com/model.gguf', showProgress: false }),
    /https/,
  );
});

