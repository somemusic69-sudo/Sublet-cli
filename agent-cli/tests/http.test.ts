import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';
import { fetchJson, measureDownloadSpeed } from '../src/util/http.js';
import { compareVersions, VERSION } from '../src/version.js';

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test('an HTTP 426 from the server becomes an update instruction', async () => {
  let userAgent = '';
  const { url, close } = await withServer((req, res) => {
    userAgent = String(req.headers['user-agent']);
    res.writeHead(426, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent too old', minVersion: '2.0.0' }));
  });
  try {
    await assert.rejects(fetchJson(`${url}/api/agent/me`), (error: Error) => {
      assert.match(error.message, /needs v2\.0\.0/);
      assert.match(error.message, /npx sublera-cli@latest/);
      return true;
    });
    assert.equal(userAgent, `sublera-cli/${VERSION}`);
  } finally {
    await close();
  }
});

test('versions compare numerically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('2.0.0-beta.1', '1.9.9'), 1);
});

test('the download speed check asks for a byte range and stops at the byte cap', async () => {
  let range = '';
  const chunk = Buffer.alloc(64 * 1024, 1);
  const { url, close } = await withServer((req, res) => {
    range = String(req.headers.range);
    res.writeHead(206, { 'content-type': 'application/octet-stream' });
    for (let i = 0; i < 16; i++) res.write(chunk);
    res.end();
  });
  try {
    const sample = await measureDownloadSpeed(url, { maxBytes: 256 * 1024, maxMs: 5_000 });
    assert.equal(range, 'bytes=0-262143');
    assert.ok(sample.bytes >= 256 * 1024 && sample.bytes < 16 * chunk.length, `read ${sample.bytes} bytes`);
    assert.ok(sample.bytesPerSec > 0);
  } finally {
    await close();
  }
});

test('the download speed check stops at the time cap on a slow server', async () => {
  const { url, close } = await withServer((_req, res) => {
    res.writeHead(206, { 'content-type': 'application/octet-stream' });
    const timer = setInterval(() => res.write(Buffer.alloc(1024)), 20);
    res.on('close', () => clearInterval(timer));
  });
  try {
    const started = Date.now();
    const sample = await measureDownloadSpeed(url, { maxBytes: 64 * 1024 * 1024, maxMs: 250 });
    assert.ok(Date.now() - started < 2_000, 'the time cap was not applied');
    assert.ok(sample.bytes > 0 && sample.bytes < 64 * 1024 * 1024);
  } finally {
    await close();
  }
});
