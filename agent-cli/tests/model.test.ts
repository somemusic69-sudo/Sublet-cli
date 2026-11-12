import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadModel, forgetHashedModels, listCachedModels, modelPathFor, verifyModelFile } from '../src/engine/modelManager.js';
import { BufferWriter, buildGgufSample, checkModelUrl, fetchModelUrl } from '../src/engine/gguf.js';

const MODEL = buildGgufSample([
  { key: 'general.architecture', type: 8, write: (b) => b.str('llama') },
  { key: 'general.name', type: 8, write: (b) => b.str('test-model') },
  { key: 'llama.block_count', type: 4, write: (b) => b.u32(32) },
  { key: 'llama.embedding_length', type: 4, write: (b) => b.u32(4096) },
  { key: 'llama.context_length', type: 4, write: (b) => b.u32(8192) },
  { key: 'general.file_type', type: 4, write: (b) => b.u32(15) },
]);

const SHA = createHash('sha256').update(MODEL).digest('hex');
const STUB_URL = 'https://huggingface.co/test/model/resolve/main/model.gguf';
const modelFetch = (async () => new Response(new Uint8Array(MODEL), { headers: { 'content-length': String(MODEL.length) } })) as typeof fetch;

test('a computed hash without an expected digest never becomes verified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  try {
    const options = { url: STUB_URL, cacheDir: dir, fetchImpl: modelFetch, showProgress: false };
    const fresh = await downloadModel(options);
    assert.deepEqual([fresh.sha256, fresh.verified], [SHA, false]);
    const cached = await downloadModel(options);
    assert.deepEqual([cached.sha256, cached.verified], [SHA, false]);
    forgetHashedModels();
    assert.equal((await downloadModel(options)).verified, false);
    assert.equal((await verifyModelFile(fresh.path)).verified, false);
    assert.equal((await downloadModel({ ...options, expectedSha256: SHA.toUpperCase() })).verified, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed expected digests are rejected before any fetch', async () => {
  for (const digest of ['', 'abc', 'z'.repeat(64), 42, true]) {
    await assert.rejects(downloadModel({
      url: STUB_URL, expectedSha256: digest as string,
      fetchImpl: (async () => { throw new Error('must not fetch'); }) as typeof fetch,
    }), /Expected SHA-256/);
  }
});

test('replacing a memoized model with a same-sized inode invalidates the memo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  try {
    const options = { url: STUB_URL, cacheDir: dir, fetchImpl: modelFetch, showProgress: false };
    const first = await downloadModel(options);
    const before = await stat(first.path);
    const replacement = Buffer.from(MODEL);
    replacement[replacement.length - 1] = replacement[replacement.length - 1]! ^ 0xff;
    const other = join(dir, 'replacement.gguf');
    await writeFile(other, replacement);
    await utimes(other, before.atime, before.mtime);
    await rename(other, first.path);
    const loaded = await downloadModel(options);
    assert.equal(loaded.sha256, createHash('sha256').update(replacement).digest('hex'));
    assert.notEqual(loaded.sha256, first.sha256);
    assert.equal(loaded.verified, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mutation while hashing rejects the observation without deleting the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const path = modelPathFor(STUB_URL, dir);
  const replacement = Buffer.from(MODEL);
  replacement[replacement.length - 1] = replacement[replacement.length - 1]! ^ 0xff;
  try {
    await writeFile(path, MODEL);
    let mutated = false;
    await assert.rejects(downloadModel({
      url: STUB_URL, cacheDir: dir, expectedSha256: SHA, showProgress: false,
      fetchImpl: (async () => { throw new Error('must not fetch'); }) as typeof fetch,
      onProgress: (progress) => {
        if (progress.phase === 'verify' && progress.received === MODEL.length && !mutated) {
          mutated = true;
          writeFileSync(path, replacement);
        }
      },
    }), /changed during verification/);
    assert.ok(mutated);
    assert.deepEqual(await readFile(path), replacement);
    const loaded = await downloadModel({ url: STUB_URL, cacheDir: dir, showProgress: false });
    assert.equal(loaded.sha256, createHash('sha256').update(replacement).digest('hex'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fresh download verification does not memoize a stream digest for changed disk bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const path = modelPathFor(STUB_URL, dir);
  try {
    await assert.rejects(downloadModel({
      url: STUB_URL, cacheDir: dir, fetchImpl: modelFetch, expectedSha256: SHA, showProgress: false,
      onProgress: (progress) => {
        if (progress.phase === 'verify') writeFileSync(path, Buffer.concat([MODEL, Buffer.from('changed')]));
      },
    }), /changed during download verification/);
    assert.equal((await stat(path)).size, MODEL.length + 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replacement of the path during hashing is not mistaken for the open descriptor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const path = modelPathFor(STUB_URL, dir);
  const replacementPath = join(dir, 'replacement.gguf');
  const replacement = Buffer.concat([MODEL, Buffer.from('replacement')]);
  try {
    await writeFile(path, MODEL);
    await writeFile(replacementPath, replacement);
    await assert.rejects(downloadModel({
      url: STUB_URL, cacheDir: dir, expectedSha256: SHA, showProgress: false,
      onProgress: (progress) => {
        if (progress.phase === 'verify' && progress.received === MODEL.length) {
          // Windows permits moving the open original aside, but not replacing it in place.
          renameSync(path, `${path}.old`);
          renameSync(replacementPath, path);
        }
      },
    }), /changed during verification/);
    assert.deepEqual(await readFile(path), replacement);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('progress callback failures preserve the file and do not poison the hash memo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const path = modelPathFor(STUB_URL, dir);
  try {
    await writeFile(path, MODEL);
    await assert.rejects(downloadModel({
      url: STUB_URL, cacheDir: dir, expectedSha256: SHA, showProgress: false,
      onProgress: (progress) => { if (progress.received === MODEL.length) throw new Error('callback failed'); },
    }), /callback failed/);
    assert.deepEqual(await readFile(path), MODEL);
    const notes: string[] = [];
    const loaded = await downloadModel({ url: STUB_URL, cacheDir: dir, expectedSha256: SHA, showProgress: false, onProgress: (p) => notes.push(p.note) });
    assert.equal(loaded.verified, true);
    assert.ok(notes.some((note) => /Verifying cached/.test(note)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a syntactically valid forged sidecar digest is not reported as the measured digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  try {
    const options = { url: STUB_URL, cacheDir: dir, fetchImpl: modelFetch, showProgress: false };
    const first = await downloadModel(options);
    const sidecar = JSON.parse(await readFile(`${first.path}.sublet.json`, 'utf8')) as Record<string, unknown>;
    sidecar.sha256 = '0'.repeat(64);
    await writeFile(`${first.path}.sublet.json`, JSON.stringify(sidecar));
    forgetHashedModels();
    const loaded = await downloadModel(options);
    assert.deepEqual([loaded.sha256, loaded.verified], [SHA, false]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sidecar IO and header validation errors preserve cached model bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const path = modelPathFor(STUB_URL, dir);
  try {
    await writeFile(path, MODEL);
    await mkdir(`${path}.sublet.json`);
    await writeFile(join(`${path}.sublet.json`, 'keep.txt'), 'keep');
    await assert.rejects(downloadModel({ url: STUB_URL, cacheDir: dir, expectedSha256: SHA, showProgress: false }), /EISDIR|EPERM|EACCES/);
    assert.deepEqual(await readFile(path), MODEL);
    assert.equal(await readFile(join(`${path}.sublet.json`, 'keep.txt'), 'utf8'), 'keep');
    await assert.rejects(downloadModel({ url: STUB_URL, cacheDir: dir, expectedSha256: SHA, expectedLayers: 80, showProgress: false }), /layers/);
    assert.deepEqual(await readFile(path), MODEL);
    const badHeader = Buffer.from('not a GGUF');
    await writeFile(path, badHeader);
    await assert.rejects(downloadModel({ url: STUB_URL, cacheDir: dir, showProgress: false }), /GGUF/);
    assert.deepEqual(await readFile(path), badHeader);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed replacement hash does not delete a pre-existing cached model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const path = modelPathFor(STUB_URL, dir);
  try {
    await writeFile(path, MODEL);
    await assert.rejects(downloadModel({ url: STUB_URL, cacheDir: dir, expectedSha256: '0'.repeat(64), fetchImpl: modelFetch, showProgress: false }), /SHA-256 mismatch/);
    assert.deepEqual(await readFile(path), MODEL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('network and partial-source IO failures preserve resumable bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const part = `${modelPathFor(STUB_URL, dir)}.part`;
  const bytes = MODEL.subarray(0, 100);
  try {
    await writeFile(part, bytes);
    await writeFile(`${part}.json`, JSON.stringify({ url: STUB_URL }));
    await assert.rejects(downloadModel({ url: STUB_URL, cacheDir: dir, showProgress: false, fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch }), /offline/);
    assert.deepEqual(await readFile(part), bytes);
    await rm(`${part}.json`);
    await mkdir(`${part}.json`);
    await assert.rejects(downloadModel({ url: STUB_URL, cacheDir: dir, showProgress: false, fetchImpl: modelFetch }), /EISDIR|EPERM|EACCES/);
    assert.deepEqual(await readFile(part), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cache cleanup never recursively deletes a directory at a partial-file path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const part = `${modelPathFor(STUB_URL, dir)}.part`;
  try {
    await mkdir(part);
    await writeFile(join(part, 'keep.txt'), 'keep');
    await assert.rejects(downloadModel({ url: STUB_URL, cacheDir: dir, fetchImpl: modelFetch, showProgress: false }), /EISDIR|EPERM|EACCES/);
    assert.equal(await readFile(join(part, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/model.gguf` };
}

test('a resumable download appends only the missing range and verifies SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
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
    await writeFile(`${part}.json`, JSON.stringify({ url }));
    const progress: number[] = [];
    const loaded = await downloadModel({
      url,
      cacheDir: dir,
      allowLocalhost: true,
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
    const sidecar = JSON.parse(await readFile(`${dest}.sublet.json`, 'utf8')) as { sha256: string; size: number };
    assert.equal(sidecar.sha256, SHA);
    assert.equal(sidecar.size, MODEL.length);
    await assert.rejects(stat(`${part}.json`), /ENOENT/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a server that ignores Range restarts the file instead of corrupting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
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
    await writeFile(`${dest}.part.json`, JSON.stringify({ url }));
    const loaded = await downloadModel({ url, cacheDir: dir, allowLocalhost: true, expectedSha256: SHA, showProgress: false });
    assert.equal(loaded.sha256, SHA);
    assert.deepEqual(await readFile(dest), MODEL);
    assert.equal(ranges[0], `bytes=${garbage.length}-`);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a partial started for another URL is discarded instead of resumed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const ranges: string[] = [];
  const { server, url } = await withServer((req, res) => {
    const range = req.headers.range;
    ranges.push(range || 'none');
    const start = range ? Number(range.match(/bytes=(\d+)-/)?.[1] || 0) : 0;
    res.writeHead(range ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': MODEL.length - start,
      ...(range ? { 'content-range': `bytes ${start}-${MODEL.length - 1}/${MODEL.length}` } : {}),
    });
    res.end(MODEL.subarray(start));
  });
  try {
    const dest = modelPathFor(url, dir);
    const other = Buffer.from('bytes from a different repo with the same file name');
    for (const source of [JSON.stringify({ url: 'https://huggingface.co/other/repo/resolve/main/model.gguf' }), null]) {
      ranges.length = 0;
      await rm(dest, { force: true });
      await rm(`${dest}.sublet.json`, { force: true });
      await writeFile(`${dest}.part`, other);
      if (source) await writeFile(`${dest}.part.json`, source);
      else await rm(`${dest}.part.json`, { force: true });
      const loaded = await downloadModel({ url, cacheDir: dir, allowLocalhost: true, showProgress: false });
      assert.equal(ranges[0], 'none');
      assert.equal(loaded.sha256, SHA);
      assert.deepEqual(await readFile(dest), MODEL);
    }
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a bad hash is rejected and both files are removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const { server, url } = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
    res.end(MODEL);
  });
  try {
    const dest = modelPathFor(url, dir);
    await assert.rejects(
      downloadModel({ url, cacheDir: dir, allowLocalhost: true, expectedSha256: '0'.repeat(64), showProgress: false }),
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
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const { server, url } = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
    res.end(MODEL);
  });
  try {
    await assert.rejects(
      downloadModel({ url, cacheDir: dir, allowLocalhost: true, expectedSha256: SHA, expectedLayers: 80, showProgress: false }),
      /layers/,
    );
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cached files are reused without another request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  let requests = 0;
  const { server, url } = await withServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
    res.end(MODEL);
  });
  try {
    const first = await downloadModel({ url, cacheDir: dir, allowLocalhost: true, expectedSha256: SHA, showProgress: false });
    const second = await downloadModel({ url, cacheDir: dir, allowLocalhost: true, expectedSha256: SHA, showProgress: false });
    assert.equal(requests, 1);
    assert.equal(first.path, second.path);
    const verified = await verifyModelFile(first.path, { sha256: SHA, layers: 32 });
    assert.equal(verified.sha256, SHA);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a served model is hashed from disk: a swapped cached file is caught and downloaded again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  let requests = 0;
  const { server, url } = await withServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
    res.end(MODEL);
  });
  const notes: string[] = [];
  const serve = () => downloadModel({ url, cacheDir: dir, allowLocalhost: true, expectedSha256: SHA, showProgress: false, verifyCached: true, onProgress: (p) => notes.push(p.note) });
  try {
    forgetHashedModels();
    const first = await serve();
    assert.equal(requests, 1);

    // The same agent run hashed these bytes while downloading them: no second hash, no second download.
    notes.length = 0;
    await serve();
    assert.equal(requests, 1);
    assert.ok(!notes.some((note) => /Verifying cached/.test(note)));

    // A new agent run trusts nothing it has not hashed itself.
    forgetHashedModels();
    notes.length = 0;
    const again = await serve();
    assert.equal(requests, 1);
    assert.ok(notes.some((note) => /Verifying cached/.test(note)));
    assert.deepEqual([again.sha256, again.verified], [SHA, true]);

    // Swap the weights for other bytes of the same size and put the modified time back, so the sidecar still "matches".
    const before = await stat(first.path);
    const swapped = Buffer.from(MODEL);
    swapped[swapped.length - 1] = swapped[swapped.length - 1]! ^ 0xff;
    await writeFile(first.path, swapped);
    await utimes(first.path, before.atime, before.mtime);

    // Even in this same process, ctime/identity invalidates the memo despite restored mtime.
    // An expected hash is never trusted solely from a sidecar, including verifyCached=false.
    notes.length = 0;
    const healed = await downloadModel({ url, cacheDir: dir, allowLocalhost: true, expectedSha256: SHA, showProgress: false, verifyCached: false, onProgress: (p) => notes.push(p.note) });
    assert.equal(requests, 2);
    assert.ok(notes.some((note) => /failed verification/.test(note)));
    assert.equal(healed.sha256, SHA);
    assert.deepEqual(await readFile(first.path), MODEL);
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


test('model links are limited to https HuggingFace downloads', () => {
  const canonical = 'https://huggingface.co/org/repo/resolve/main/model-Q4_K_M.gguf';
  assert.equal(checkModelUrl(canonical), canonical);
  assert.equal(checkModelUrl('https://hf.co/org/repo/blob/main/model-Q4_K_M.gguf'), canonical);
  assert.throws(() => checkModelUrl('http://huggingface.co/org/repo/resolve/main/model.gguf'), /https/);
  assert.throws(() => checkModelUrl('https://example.com/org/repo/resolve/main/model.gguf'), /limited to HuggingFace/);
  assert.throws(() => checkModelUrl('https://huggingface.co.example.com/org/repo/resolve/main/model.gguf'), /limited to HuggingFace/);
  assert.throws(() => checkModelUrl('https://user:pass@huggingface.co/org/repo/resolve/main/model.gguf'), /credentials/);
  assert.throws(() => checkModelUrl('https://huggingface.co:8443/org/repo/resolve/main/model.gguf'), /port/);
  assert.throws(() => checkModelUrl('https://huggingface.co/org/repo/resolve/main/model.bin#.gguf'), /GGUF/);
  assert.throws(() => checkModelUrl('/home/host/.ssh/id_ed25519'), /valid URL/);
});

test('localhost model downloads need the explicit test opt-in', () => {
  assert.throws(() => checkModelUrl('http://127.0.0.1:8080/admin#.gguf'), /https/);
  assert.throws(() => checkModelUrl('https://localhost/model.gguf'), /limited to HuggingFace/);
  assert.throws(() => checkModelUrl('http://127.0.0.1:8080/admin#.gguf', { allowLocalhost: true }), /\.gguf/i);
  assert.equal(checkModelUrl('http://127.0.0.1:8080/model.gguf', { allowLocalhost: true }), 'http://127.0.0.1:8080/model.gguf');
});

function stubFetch(routes: Record<string, () => Response>): { fetchImpl: typeof fetch; calls: { url: string; range: string | null; redirect?: string }[] } {
  const calls: { url: string; range: string | null; redirect?: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, range: new Headers(init?.headers).get('range'), redirect: init?.redirect });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

test('model redirects are followed only while they stay on HuggingFace', async () => {
  const start = 'https://huggingface.co/org/repo/resolve/main/model.gguf';
  const cdn = 'https://us.aws.cdn.hf.co/xet-bridge-us/abc?sig=1';
  const ok = stubFetch({ [start]: redirect(cdn), [cdn]: () => new Response('GGUF', { status: 206 }) });
  const response = await fetchModelUrl(start, { headers: { range: 'bytes=0-3' } }, { fetchImpl: ok.fetchImpl });
  assert.equal(await response.text(), 'GGUF');
  assert.deepEqual(ok.calls.map((c) => [c.url, c.range, c.redirect]), [[start, 'bytes=0-3', 'manual'], [cdn, 'bytes=0-3', 'manual']]);

  for (const target of ['http://us.aws.cdn.hf.co/x', 'https://192.168.1.10/model.gguf', 'http://127.0.0.1:5000/admin', 'https://evil.example.com/model.gguf']) {
    const bad = stubFetch({ [start]: redirect(target) });
    await assert.rejects(fetchModelUrl(start, {}, { fetchImpl: bad.fetchImpl }), /https|HuggingFace/, target);
    assert.equal(bad.calls.length, 1, `${target} must not be requested`);
  }

  const loop = stubFetch({ [start]: redirect(start) });
  await assert.rejects(fetchModelUrl(start, {}, { fetchImpl: loop.fetchImpl }), /Too many redirects/);
});

test('a download that streams past the expected size is cut off and removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-model-'));
  const { server, url } = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(MODEL);
    res.write(MODEL);
    res.end(MODEL);
  });
  try {
    await assert.rejects(
      downloadModel({ url, cacheDir: dir, allowLocalhost: true, expectedSize: MODEL.length, showProgress: false }),
      /larger than the expected/,
    );
    const part = `${modelPathFor(url, dir)}.part`;
    await assert.rejects(stat(part), /ENOENT/);
    await assert.rejects(stat(`${part}.json`), /ENOENT/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('cached model inventory hints require matching sidecar stat identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-cache-'));
  try {
    const { server, url } = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': MODEL.length });
      res.end(MODEL);
    });
    try {
      await downloadModel({ url, cacheDir: dir, allowLocalhost: true, expectedSha256: SHA, showProgress: false });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await writeFile(join(dir, 'no-sidecar.gguf'), MODEL);
    const listed = await listCachedModels(dir);
    assert.deepEqual(listed, [{ sha256: SHA, file: 'model.gguf', sizeBytes: MODEL.length }]);
    const before = await stat(join(dir, 'model.gguf'));
    const changed = Buffer.from(MODEL);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
    await writeFile(join(dir, 'model.gguf'), changed);
    await utimes(join(dir, 'model.gguf'), before.atime, before.mtime);
    assert.deepEqual(await listCachedModels(dir), []);
    assert.deepEqual(await listCachedModels(join(dir, 'missing')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
