import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { installLlamaServer, pickReleaseAsset, variantFor, findExistingLlama, verifyInstalledBinary, ensureLlamaServer } from '../src/engine/binaryManager.js';

test('strict checksum mode refuses an existing custom engine without downloading', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-strict-engine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'custom-engine');
  await writeFile(binary, 'custom');
  const env = { SUBLET_HOME: dir, LLAMA_SERVER: binary };
  assert.equal((await ensureLlamaServer({ env })).found, true);
  const strict = await ensureLlamaServer({ env, fix: true, requireChecksum: true, fetchImpl: async () => { throw new Error('must not download'); } });
  assert.equal(strict.found, false);
  if (!strict.found) assert.match(strict.reason, /require-checksum/);
});

function release(name: string, url: string, size: number) {
  return {
    tag_name: 'b9999',
    assets: [{ name, browser_download_url: url, size }],
  };
}

test('release assets follow the GPU and operating system', () => {
  const assets = [
    { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', browser_download_url: 'http://x/cudart' },
    { name: 'llama-b1-bin-win-cuda-x64.zip', browser_download_url: 'http://x/cuda' },
    { name: 'llama-b1-bin-win-vulkan-x64.zip', browser_download_url: 'http://x/vulkan' },
    { name: 'llama-b1-bin-win-cpu-x64.zip', browser_download_url: 'http://x/cpu' },
    { name: 'llama-b1-bin-ubuntu-x64.zip', browser_download_url: 'http://x/linux' },
    { name: 'llama-b1-bin-ubuntu-cuda-12.8-x64.tar.gz', browser_download_url: 'http://x/linux-cuda' },
    { name: 'llama-b1-bin-macos-arm64.tar.gz', browser_download_url: 'http://x/mac' },
  ];
  const rel = { tag_name: 'b1', assets };
  assert.equal(pickReleaseAsset(rel, 'win32', 'x64', 'cuda').main?.name, 'llama-b1-bin-win-cuda-x64.zip');
  assert.equal(pickReleaseAsset(rel, 'win32', 'x64', 'vulkan').main?.name, 'llama-b1-bin-win-vulkan-x64.zip');
  assert.equal(pickReleaseAsset(rel, 'linux', 'x64', 'cuda').main?.name, 'llama-b1-bin-ubuntu-cuda-12.8-x64.tar.gz');
  assert.equal(pickReleaseAsset(rel, 'linux', 'x64', 'cpu').main?.name, 'llama-b1-bin-ubuntu-x64.zip');
  assert.equal(pickReleaseAsset(rel, 'darwin', 'arm64', 'metal').main?.name, 'llama-b1-bin-macos-arm64.tar.gz');
  assert.equal(pickReleaseAsset(rel, 'win32', 'x64', 'cuda').companions[0]?.name, 'cudart-llama-bin-win-cuda-12.4-x64.zip');
  assert.equal(variantFor('win32', 'x64', 'nvidia'), 'cuda');
  assert.equal(variantFor('linux', 'x64', 'amd'), 'vulkan');
  assert.equal(variantFor('darwin', 'arm64', 'apple'), 'metal');
  assert.equal(variantFor('darwin', 'x64', 'apple'), 'cpu');
});

test('an archive is downloaded, checksum-verified, extracted, and recorded', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sublet-bin-'));
  const zip = new AdmZip();
  zip.addFile('bin/llama-server.exe', Buffer.from('fake llama binary'));
  const archive = join(home, 'fixture.zip');
  zip.writeZip(archive);
  const bytes = await readFile(archive);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const env = { ...process.env, SUBLET_HOME: home, SUBLET_LLAMA_SHA256: sha };
  try {
    const install = await installLlamaServer({
      platform: 'win32',
      arch: 'x64',
      env,
      gpu: {
        primary: { vendor: 'nvidia' } as never,
        gpus: [],
        source: 'test',
        platform: 'win32',
        checkedAt: Date.now(),
        warnings: [],
      },
      release: release('llama-b9999-bin-win-cuda-x64.zip', `http://127.0.0.1:${port}/llama.zip`, bytes.length),
      showProgress: false,
    });
    assert.equal(install.variant, 'cuda');
    assert.equal(install.verified, true);
    assert.equal(install.sha256, sha);
    assert.ok(install.path.endsWith('llama-server.exe'));
    await stat(install.path);
    const manifest = JSON.parse(await readFile(join(home, 'bin', 'manifest.json'), 'utf8'));
    assert.equal(manifest.latest, install.path);
    assert.ok(install.binarySha256);
    const found = await findExistingLlama({ env });
    assert.equal(found?.path, install.path);
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('a bad binary checksum is rejected before extraction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sublet-bin-'));
  const zip = new AdmZip();
  zip.addFile('llama-server.exe', Buffer.from('fake'));
  const archive = join(home, 'fixture.zip');
  zip.writeZip(archive);
  const bytes = await readFile(archive);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const env = { ...process.env, SUBLET_HOME: home, SUBLET_LLAMA_SHA256: '0'.repeat(64) };
  try {
    await assert.rejects(installLlamaServer({
      platform: 'win32',
      arch: 'x64',
      env,
      gpu: { primary: { vendor: 'nvidia' } as never, gpus: [], source: 'test', platform: 'win32', checkedAt: Date.now(), warnings: [] },
      release: release('llama-b9999-bin-win-cuda-x64.zip', `http://127.0.0.1:${port}/llama.zip`, bytes.length),
      showProgress: false,
    }), /Checksum mismatch/);
    await assert.rejects(stat(join(home, 'bin', 'manifest.json')), /ENOENT/);
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});

async function serveFiles(files: Record<string, Buffer>) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    const body = files[req.url || ''];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}`, requests: () => requests };
}

function zipWith(name: string, content: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('a modified or unhashed installed binary is reinstalled instead of reused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sublet-bin-'));
  const bytes = zipWith('bin/llama-server', 'genuine llama binary');
  const { server, base, requests } = await serveFiles({ '/llama.zip': bytes });
  const env = { ...process.env, SUBLET_HOME: home };
  const options = {
    platform: 'linux' as const,
    arch: 'x64',
    env,
    release: { tag_name: 'b9999', assets: [{ name: 'llama-b9999-bin-ubuntu-x64.zip', browser_download_url: `${base}/llama.zip`, digest: `sha256:${sha256(bytes)}` }] },
    showProgress: false,
  };
  try {
    const first = await installLlamaServer(options);
    await writeFile(first.path, 'tampered');
    assert.notEqual((await findExistingLlama({ env }))?.path, first.path);
    const second = await installLlamaServer(options);
    assert.equal(requests(), 2);
    assert.equal(second.path, first.path);
    assert.equal(await readFile(second.path, 'utf8'), 'genuine llama binary');
    assert.equal(await verifyInstalledBinary(second), true);

    const manifestFile = join(home, 'bin', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    for (const install of manifest.installs) delete install.binarySha256;
    await writeFile(manifestFile, JSON.stringify(manifest));
    assert.notEqual((await findExistingLlama({ env }))?.path, first.path);
    await installLlamaServer(options);
    assert.equal(requests(), 3);
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('SUBLET_LLAMA_SHA256 pins only the main archive, not the CUDA runtime companion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sublet-bin-'));
  const main = zipWith('llama-server.exe', 'cuda llama');
  const cudart = zipWith('cudart64_12.dll', 'cuda runtime');
  const { server, base } = await serveFiles({ '/main.zip': main, '/cudart.zip': cudart });
  const env = { ...process.env, SUBLET_HOME: home, SUBLET_LLAMA_SHA256: sha256(main) };
  try {
    const install = await installLlamaServer({
      platform: 'win32',
      arch: 'x64',
      env,
      gpu: { primary: { vendor: 'nvidia' } as never, gpus: [], source: 'test', platform: 'win32', checkedAt: Date.now(), warnings: [] },
      release: {
        tag_name: 'b9999',
        assets: [
          { name: 'llama-b9999-bin-win-cuda-12.4-x64.zip', browser_download_url: `${base}/main.zip` },
          { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', browser_download_url: `${base}/cudart.zip`, digest: `sha256:${sha256(cudart)}` },
        ],
      },
      showProgress: false,
    });
    assert.equal(install.verified, true);
    assert.equal(install.sha256, sha256(main));
    await stat(join(install.dir || '', 'cudart64_12.dll'));
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});
