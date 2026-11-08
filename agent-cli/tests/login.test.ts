import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { deviceLogin } from '../src/commands.js';

type Handler = (url: string, body: Record<string, unknown>, res: ServerResponse) => void;

async function withServer(handler: Handler, run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      handler(req.url || '', raw ? JSON.parse(raw) as Record<string, unknown> : {}, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const code = (base: string, expiresIn = 60_000) => ({
  deviceCode: 'd'.repeat(43),
  userCode: 'BCDF-GHJK',
  verificationUrl: `${base}/link`,
  verificationUrlComplete: `${base}/link?code=BCDF-GHJK`,
  expiresAt: Date.now() + expiresIn,
  intervalMs: 10,
});

test('device login shows the code, polls until the person approves, then returns the host key', async () => {
  let polls = 0;
  let sentName = '';
  await withServer((url, body, res) => {
    if (url === '/api/cli/login') {
      sentName = String(body.name);
      res.end(JSON.stringify(code(`http://${'127.0.0.1'}`)));
    } else if (url === '/api/cli/login/poll') {
      assert.equal(body.deviceCode, 'd'.repeat(43));
      polls++;
      res.end(JSON.stringify(polls < 3 ? { status: 'pending' } : { status: 'approved', token: 'sh_linked123', username: 'ada' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  }, async (base) => {
    const shown: string[] = [];
    const linked = await deviceLogin(base, { name: 'gaming-pc', onCode: (c) => shown.push(c.userCode) });
    assert.deepEqual(linked, { token: 'sh_linked123', username: 'ada' });
    assert.deepEqual(shown, ['BCDF-GHJK']);
    assert.equal(sentName, 'gaming-pc');
    assert.equal(polls, 3);
  });
});

test('device login returns null on a server without device login, so login can ask for a key', async () => {
  await withServer((_url, _body, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not Found' }));
  }, async (base) => {
    assert.equal(await deviceLogin(base, { name: 'pc', onCode: () => assert.fail('no code expected') }), null);
  });
});

test('device login stops with the server message when the code is no longer valid', async () => {
  await withServer((url, _body, res) => {
    if (url === '/api/cli/login') {
      res.end(JSON.stringify(code('http://x')));
      return;
    }
    res.statusCode = 410;
    res.end(JSON.stringify({ error: 'This login code expired. Run sublet login again.' }));
  }, async (base) => {
    await assert.rejects(deviceLogin(base, { name: 'pc', onCode: () => undefined }), /expired/);
  });
});

test('device login gives up when the code expires while it waits', async () => {
  await withServer((url, _body, res) => {
    res.end(JSON.stringify(url === '/api/cli/login' ? code('http://x', 50) : { status: 'pending' }));
  }, async (base) => {
    await assert.rejects(deviceLogin(base, { name: 'pc', onCode: () => undefined }), /expired/);
  });
});
