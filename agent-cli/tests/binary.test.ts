import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { installLlamaServer, pickReleaseAsset, variantFor, findExistingLlama } from '../src/engine/binaryManager.js';

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
  const home = await mkdtemp(join(tmpdir(), 'kiln-bin-'));
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
  const env = { ...process.env, KILN_HOME: home, KILN_LLAMA_SHA256: sha };
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
  const home = await mkdtemp(join(tmpdir(), 'kiln-bin-'));
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
  const env = { ...process.env, KILN_HOME: home, KILN_LLAMA_SHA256: '0'.repeat(64) };
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
