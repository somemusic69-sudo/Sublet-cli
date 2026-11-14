import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect as netConnect, createServer as createNetServer, type Socket, type Server } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TLSSocket } from 'node:tls';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { bypassProxy, ConnectProxyAgent, ConnectProxyHttpAgent, openConnectTunnel, parseProxyUrl, proxyFor, proxySettings, redactProxy, websocketAgentFor } from '../src/network/proxy.js';
import { TunnelClient } from '../src/network/tunnelClient.js';

async function listen(server: Server, host = '127.0.0.1') {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    port: (server.address() as { port: number }).port,
    sockets,
    close: () => new Promise<void>((resolve) => {
      // closeAllConnections does not close CONNECT/upgraded sockets.
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function child(script: string, env: NodeJS.ProcessEnv = {}): Promise<any> {
  const clean = { ...process.env };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    delete clean[name];
    delete clean[name.toLowerCase()];
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...clean, ...env },
      timeout: 15_000,
    }, (error, out, err) => error ? reject(new Error(`Proxy test child failed (${error.code}): ${err}`)) : resolve(out));
  });
  return JSON.parse(stdout.trim());
}

// Keep name resolution offline even for NO_PROXY destinations and TLS names.
const LOCAL_DNS = `
  import dns from 'node:dns';
  dns.lookup = (_host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    queueMicrotask(() => options?.all
      ? callback(null, [{ address: '127.0.0.1', family: 4 }])
      : callback(null, '127.0.0.1', 4));
  };
`;

async function withCA(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'sublet-proxy-ca-'));
  try {
    const path = join(directory, 'ca.pem');
    await writeFile(path, TEST_CERT);
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('proxy: HTTPS_PROXY, NO_PROXY, loopback bypass, and credential redaction', () => {
  const settings = proxySettings({ https_proxy: 'http://user:p%40ss@proxy.corp:3128', NO_PROXY: 'internal.corp, .lan,10.0.0.5:8080' });
  assert.equal(proxyFor('https://sublet.duckdns.org/api', settings)?.host, 'proxy.corp:3128');
  assert.equal(proxyFor('wss://sublet.duckdns.org/tunnel', settings)?.host, 'proxy.corp:3128');
  assert.equal(proxyFor('http://plain.example', settings), null, 'no HTTP_PROXY means http goes direct');
  assert.equal(proxyFor('https://api.internal.corp', settings), null);
  assert.equal(proxyFor('https://nas.lan', settings), null);
  const withHttp = { ...settings, httpProxy: 'proxy:1' };
  assert.equal(proxyFor('http://10.0.0.5:8080/x', withHttp), null);
  assert.notEqual(proxyFor('http://10.0.0.5:9090/x', withHttp), null);
  assert.equal(bypassProxy(new URL('http://127.0.0.1:5000'), []), true, 'llama-server is never proxied');
  assert.equal(bypassProxy(new URL('http://localhost:5000'), []), true);
  assert.equal(bypassProxy(new URL('https://anything'), ['*']), true);
  assert.equal(redactProxy('http://user:secret@proxy.corp:3128'), 'http://***@proxy.corp:3128');
  assert.equal(parseProxyUrl('proxy.corp:3128').href, 'http://proxy.corp:3128/');
  assert.throws(() => parseProxyUrl('socks5://proxy:1080'), /Unsupported proxy protocol/);
});

test('NO_PROXY uses exact IPs, IPv6 ports, domain boundaries and every loopback form', () => {
  const cases: [string, string[], boolean][] = [
    ['http://127.0.0.2', [], true],
    ['http://127.255.255.254', [], true],
    ['http://127.example.test', [], false],
    ['http://localhost.', [], true],
    ['http://[::1]', [], true],
    ['http://[::ffff:127.0.0.2]', [], true],
    ['http://[::ffff:126.0.0.2]', [], false],
    ['https://anything.test', ['ignored.test', '*'], true],
    ['https://API.Example.test.', [' .EXAMPLE.TEST. '], true],
    ['https://example.test', ['*.example.test'], true],
    ['https://notexample.test', ['example.test'], false],
    ['https://example.test.attacker.test', ['example.test'], false],
    ['https://10.0.0.5', ['0.0.5'], false],
    ['wss://api.example.test', ['example.test:443'], true],
    ['ws://api.example.test', ['example.test:443'], false],
    ['http://[2001:db8::1]:8080', ['[2001:db8::1]:8080'], true],
    ['http://[2001:db8::1]:9090', ['[2001:db8::1]:8080'], false],
    ['http://[2001:db8::1]:9090', ['2001:0db8:0:0:0:0:0:1'], true],
    ['http://[2001:db8::1]', ['[2001:db8::1]'], true],
    ['http://[2001:db8::1]', ['fe80::1%eth0'], false],
    ['https://external.test', ['', '.', '*.'], false],
  ];
  for (const [url, entries, expected] of cases) {
    assert.equal(bypassProxy(new URL(url), entries), expected, `${url}: ${entries}`);
    const settings = { httpsProxy: 'http://proxy.test:3128', httpProxy: 'http://proxy.test:3128', noProxy: entries };
    assert.equal(proxyFor(url, settings) === null, expected);
    const agent = websocketAgentFor(url.replace(/^http/, 'ws'), settings);
    assert.equal(agent === undefined, expected);
    agent?.destroy();
  }
});

test('proxy errors and redaction never echo malformed credentials or URL suffixes', () => {
  for (const raw of [
    'alice:s3cret@proxy.test:3128',
    'http://alice:s3cret@proxy.test:bad',
    'http://alice:s3cret@[invalid',
    'http://alice:s3cret%ZZ@proxy.test',
    'socks5://alice:s3cret@proxy.test',
    'http://alice:s3cret@proxy.test/private-token?token=secret-token#fragment-token',
  ]) {
    assert.doesNotMatch(redactProxy(raw), /alice|s3cret|private-token|secret-token|fragment-token/);
    try { parseProxyUrl(raw); } catch (error) {
      assert.doesNotMatch(String(error), /alice|s3cret|private-token|secret-token|fragment-token/);
    }
  }
  assert.equal(redactProxy('alice:s3cret@proxy.test:3128'), 'http://***@proxy.test:3128');
  assert.throws(() => parseProxyUrl('http://alice:s3cret%ZZ@proxy.test'), /percent-encoding/);
});

/**
 * A minimal HTTP CONNECT proxy. It dials 127.0.0.1 for every target, so tests
 * can use a non-loopback hostname (which is not bypassed) without real DNS.
 */
async function connectProxy(secure = false): Promise<{ url: string; targets: string[]; auth: string[]; close: () => Promise<void> }> {
  const targets: string[] = [];
  const auth: string[] = [];
  const server = secure ? createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }) : createServer();
  const upstreams = new Set<Socket>();
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    targets.push(String(req.url));
    auth.push(String(req.headers['proxy-authorization'] || ''));
    const port = Number(String(req.url).split(':').pop());
    const upstream = netConnect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstreams.add(upstream);
    upstream.on('close', () => { upstreams.delete(upstream); client.destroy(); });
    client.on('close', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  const { port, close } = await listen(server);
  return {
    url: `${secure ? 'https' : 'http'}://alice:s3cret@127.0.0.1:${port}`,
    targets,
    auth,
    close: async () => { for (const socket of upstreams) socket.destroy(); await close(); },
  };
}

test('the CONNECT proxy agent tunnels a request and sends proxy credentials', async () => {
  const proxy = await connectProxy();
  const target = createServer((_req, res) => res.end('through the proxy'));
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const address = target.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const agent = new ConnectProxyHttpAgent(new URL(proxy.url));
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: 'gpu-server.test', port, path: '/', agent: agent as never }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, 'through the proxy');
    assert.deepEqual(proxy.targets, [`gpu-server.test:${port}`]);
    assert.equal(proxy.auth[0], `Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
  } finally {
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await proxy.close();
  }
});

test('the WebSocket tunnel goes through HTTP_PROXY and the host key stays inside the tunnel', async () => {
  const proxy = await connectProxy();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as { port: number }).port;
  let auth = '';
  wss.on('connection', (socket, request) => {
    auth = String(request.headers.authorization || '');
    socket.send(JSON.stringify({ type: 'welcome', username: 'ada' }));
  });
  const saved = { http: process.env.HTTP_PROXY, no: process.env.NO_PROXY, allow: process.env.SUBLERA_ALLOW_HTTP };
  process.env.HTTP_PROXY = proxy.url;
  process.env.NO_PROXY = '';
  // A plain-http server off this machine is refused unless allowed; this test needs one to see the proxy CONNECT.
  process.env.SUBLERA_ALLOW_HTTP = '1';
  const tunnel = new TunnelClient({
    server: `http://sublet-server.test:${port}`,
    token: 'sh_test123456',
    hello: () => ({ type: 'hello' }) as never,
    autoReconnect: false,
  });
  try {
    tunnel.start();
    await tunnel.waitForWelcome(8_000);
    assert.equal(tunnel.username, 'ada');
    assert.deepEqual(proxy.targets, [`sublet-server.test:${port}`]);
    assert.equal(auth, 'Bearer sh_test123456');
    assert.doesNotMatch(proxy.auth[0] || '', /sh_test/);
  } finally {
    await tunnel.stop();
    if (saved.http == null) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = saved.http;
    if (saved.no == null) delete process.env.NO_PROXY; else process.env.NO_PROXY = saved.no;
    if (saved.allow == null) delete process.env.SUBLERA_ALLOW_HTTP; else process.env.SUBLERA_ALLOW_HTTP = saved.allow;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await proxy.close();
  }
});

test('fetch and Node CONNECT both decode username-only credentials without forwarding them', { timeout: 10_000 }, async () => {
  const proxy = await connectProxy();
  const upstreamAuth: unknown[] = [];
  const target = await listen(createServer((req, res) => {
    upstreamAuth.push(req.headers['proxy-authorization']);
    res.end('ok');
  }));
  const url = new URL(proxy.url);
  url.username = 'al%40ice';
  url.password = '';
  const agent = new ConnectProxyHttpAgent(url);
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: 'origin.proxy.test', port: target.port, agent }, (res) => {
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    await child(`
      const { installFetchProxy } = await import('./src/network/proxy.ts');
      await installFetchProxy(process.env);
      await (await fetch('http://origin.proxy.test:${target.port}/')).text();
      const { getGlobalDispatcher } = await import('undici');
      await getGlobalDispatcher().close();
      console.log('true');
    `, { HTTP_PROXY: url.href });
    const expected = `Basic ${Buffer.from('al@ice:').toString('base64')}`;
    assert.deepEqual(proxy.auth, [expected, expected]);
    assert.deepEqual(upstreamAuth, [undefined, undefined]);
  } finally { agent.destroy(); await Promise.all([proxy.close(), target.close()]); }
});

test('fetch() goes through HTTP_PROXY after installFetchProxy, and loopback stays direct', async () => {
  // undici tunnels every proxied request with CONNECT, like real corporate proxies expect.
  const proxy = await connectProxy();
  const upstream = createServer((req, res) => res.end(`upstream ${req.url}`));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const direct = createServer((_req, res) => res.end('direct'));
  await new Promise<void>((resolve) => direct.listen(0, '127.0.0.1', resolve));
  const directPort = (direct.address() as { port: number }).port;
  const script = [
    "const keys = ['fetch', 'Request', 'Response', 'Headers', 'FormData', 'WebSocket'];",
    'const before = keys.map(key => globalThis[key]);',
    `const nativeRequest = new Request('http://127.0.0.1:${directPort}/');`,
    "const { installFetchProxy } = await import('./src/network/proxy.ts');",
    'const inactive = await installFetchProxy({});',
    'let invalid = false; try { await installFetchProxy({HTTP_PROXY:"http://alice:s3cret@proxy:bad"}); } catch { invalid = true; }',
    'const installs = await Promise.all([installFetchProxy(process.env), installFetchProxy(process.env)]);',
    'const installed = installs.every(Boolean);',
    `const viaProxy = await (await fetch('http://updates.example.test:${upstreamPort}/check')).text();`,
    'const local = await (await fetch(nativeRequest)).text();',
    "const { getGlobalDispatcher } = await import('undici');",
    'const dispatcher = getGlobalDispatcher(); await installFetchProxy({});',
    'const stable = dispatcher === getGlobalDispatcher();',
    'await dispatcher.close();',
    'console.log(JSON.stringify({ installed, viaProxy, local, inactive, invalid, stable, globalsUnchanged: keys.every((key, i) => globalThis[key] === before[i]) }));',
  ].join('\n');
  try {
    const result = await child(script, { HTTP_PROXY: proxy.url, HTTPS_PROXY: '', NO_PROXY: '' });
    assert.equal(result.installed, true);
    assert.equal(result.viaProxy, 'upstream /check');
    assert.equal(result.local, 'direct', 'loopback (llama-server) must never be proxied');
    assert.equal(result.inactive, false);
    assert.equal(result.invalid, true);
    assert.equal(result.stable, true);
    assert.equal(result.globalsUnchanged, true);
    assert.deepEqual(proxy.targets, [`updates.example.test:${upstreamPort}`]);
    assert.equal(proxy.auth[0], `Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
  } finally {
    upstream.closeAllConnections();
    direct.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await new Promise<void>((resolve) => direct.close(() => resolve()));
    await proxy.close();
  }
});

/** Whether this machine answers on 127.0.0.2. Linux and Windows do; macOS has only 127.0.0.1 unless an alias is added. */
async function canBind(host: string): Promise<boolean> {
  const server = createNetServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => resolve()); });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const ALT_LOOPBACK = await canBind('127.0.0.2');

test('native fetch shares NO_PROXY matching with ws, including wildcard lists and alternate loopback', { timeout: 20_000, skip: ALT_LOOPBACK ? false : 'this machine has no 127.0.0.2 loopback address' }, async () => {
  const proxy = await connectProxy();
  const direct = await listen(createServer((_req, res) => res.end('ok')));
  const loopback = await listen(createServer((_req, res) => res.end('loopback')), '127.0.0.2');
  const cases = [
    { host: 'outside.example.test', no: '', proxied: true },
    { host: 'api.internal.test', no: '.internal.test', proxied: false },
    { host: 'api.internal.test', no: `internal.test:${direct.port}`, proxied: false },
    { host: 'api.internal.test', no: `internal.test:${direct.port === 1 ? 2 : 1}`, proxied: true },
    { host: 'outside.example.test', no: 'unused.test,*', proxied: false },
    { host: '127.attacker.test', no: '', proxied: true },
    { host: 'localhost.', no: '', proxied: false },
  ];
  try {
    for (const entry of cases) {
      const start = proxy.targets.length;
      const result = await child(`${LOCAL_DNS}
        const { installFetchProxy } = await import('./src/network/proxy.ts');
        await installFetchProxy(process.env);
        const body = await (await fetch(${JSON.stringify(`http://${entry.host}:${direct.port}/`)}, { signal: AbortSignal.timeout(3000) })).text();
        const loopback = await (await fetch('http://127.0.0.2:${loopback.port}/')).text();
        const { getGlobalDispatcher } = await import('undici');
        await getGlobalDispatcher().close();
        console.log(JSON.stringify({ body, loopback }));
      `, { HTTP_PROXY: proxy.url.replace('http://', ''), NO_PROXY: entry.no });
      assert.deepEqual(result, { body: 'ok', loopback: 'loopback' });
      assert.deepEqual(proxy.targets.slice(start), entry.proxied ? [`${entry.host}:${direct.port}`] : [], entry.no);
    }
    // Explicit settings must not fall back to conflicting ambient proxy variables.
    const start = proxy.targets.length;
    await child(`${LOCAL_DNS}
      const { installFetchProxy } = await import('./src/network/proxy.ts');
      await installFetchProxy({ HTTPS_PROXY: ${JSON.stringify(proxy.url)}, NO_PROXY: '' });
      await (await fetch('http://plain.example.test:${direct.port}/')).text();
      const { getGlobalDispatcher } = await import('undici');
      await getGlobalDispatcher().close();
      console.log('true');
    `, { http_proxy: proxy.url, no_proxy: '*' });
    assert.equal(proxy.targets.length, start);
  } finally {
    await Promise.all([proxy.close(), direct.close(), loopback.close()]);
  }
});

test('a proxy that answers 407 gives an actionable error', async () => {
  const server = createServer();
  server.on('connect', (_req: IncomingMessage, client: Socket) => {
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const agent = new ConnectProxyHttpAgent(new URL(`http://127.0.0.1:${port}`));
    const error = await new Promise<Error>((resolve) => {
      const req = httpRequest({ host: 'gpu-server.test', port: 1, path: '/', agent: agent as never }, () => resolve(new Error('unexpected response')));
      req.on('error', resolve);
      req.end();
    });
    assert.match(error.message, /HTTP 407/);
    assert.match(error.message, /user:password/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('CONNECT preserves head bytes and brackets IPv6 authorities', { timeout: 5000 }, async () => {
  const server = createServer();
  const authorities: string[] = [];
  server.on('connect', (req, socket) => {
    authorities.push(`${req.url}|${req.headers.host}`);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\nhello from upstream');
  });
  const proxy = await listen(server);
  try {
    const socket = await openConnectTunnel(new URL(`http://127.0.0.1:${proxy.port}`), '2001:db8::1', 443);
    try {
      const [data] = await once(socket, 'data');
      assert.equal(String(data), 'hello from upstream');
      assert.deepEqual(authorities, ['[2001:db8::1]:443|[2001:db8::1]:443']);
    } finally { socket.destroy(); }
  } finally { await proxy.close(); }
});

test('CONNECT timeout and abort destroy the pending socket; refused/parser errors hide credentials', { timeout: 5000 }, async () => {
  for (const mode of ['timeout', 'abort', 'refused', 'malformed'] as const) {
    const server = createServer();
    let peer!: Socket;
    let closed!: Promise<unknown>;
    const connected = new Promise<void>((resolve) => server.on('connect', (_req, socket) => {
      peer = socket as Socket;
      closed = once(peer, 'close');
      // Resume so a remote FIN is observed even when no data is expected.
      peer.on('end', () => peer.end());
      peer.resume();
      resolve();
      if (mode === 'refused') peer.write('HTTP/1.1 407 s3cret\r\n\r\n');
      if (mode === 'malformed') peer.write('s3cret not an HTTP response\r\n\r\n');
    }));
    const proxy = await listen(server);
    const controller = new AbortController();
    try {
      const operation = openConnectTunnel(new URL(`http://alice:s3cret@127.0.0.1:${proxy.port}/secret-path?token=secret-token`), 'target.test', 80, 150, controller.signal);
      const rejected = assert.rejects(operation, (error: Error) => {
        assert.doesNotMatch(error.message, /alice|s3cret|secret-path|secret-token/);
        assert.match(error.message, mode === 'timeout' ? /within 150ms/ : mode === 'abort' ? /aborted/ : mode === 'refused' ? /HTTP 407/ : /Could not reach proxy/);
        return true;
      });
      await connected;
      if (mode === 'abort') controller.abort(new Error('s3cret abort reason'));
      await rejected;
      await closed;
      assert.equal(peer.destroyed, true);
    } finally { await proxy.close(); }
  }
});

test('TLS validates the origin chain and hostname, retains CA options, and omits IP SNI', { timeout: 10_000 }, async () => {
  const proxy = await connectProxy();
  const server = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (_req, res) => res.end('verified'));
  const names: (string | false | null)[] = [];
  server.on('secureConnection', (socket) => names.push(socket.servername));
  const target = await listen(server);
  const fetchOrigin = async (host: string, ca?: string) => {
    const agent = new ConnectProxyAgent(new URL(proxy.url), { ca, rejectUnauthorized: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        const req = httpsRequest({ host, port: target.port, agent }, (res) => {
          assert.equal((res.socket as TLSSocket).authorized, true);
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (data) => { body += data; });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
    } finally { agent.destroy(); }
  };
  try {
    await assert.rejects(fetchOrigin('origin.proxy.test'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    assert.equal(await fetchOrigin('origin.proxy.test', TEST_CERT), 'verified');
    await assert.rejects(fetchOrigin('wrong.proxy.test', TEST_CERT), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    assert.equal(await fetchOrigin('127.0.0.1', TEST_CERT), 'verified');
    assert.deepEqual(names, ['origin.proxy.test', false]);
  } finally { await Promise.all([proxy.close(), target.close()]); }
});

test('native fetch and HTTPS CONNECT validate both TLS hops with NODE_EXTRA_CA_CERTS', { timeout: 15_000 }, async () => {
  const httpProxy = await connectProxy();
  const httpsProxy = await connectProxy(true);
  const leakedAuth: unknown[] = [];
  const target = await listen(createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    leakedAuth.push(req.headers['proxy-authorization']);
    res.end('secure origin');
  }));
  try {
    const untrusted = await child(`
      const { installFetchProxy, openConnectTunnel } = await import('./src/network/proxy.ts');
      let proxyError;
      try { (await openConnectTunnel(new URL(${JSON.stringify(httpsProxy.url)}), 'origin.proxy.test', ${target.port})).destroy(); }
      catch (error) { proxyError = error.message; }
      await installFetchProxy(process.env);
      let code;
      try { await fetch('https://origin.proxy.test:${target.port}/'); }
      catch (error) { code = error.cause?.code; }
      const { getGlobalDispatcher } = await import('undici');
      await getGlobalDispatcher().close();
      console.log(JSON.stringify({ code, proxyError }));
    `, { HTTPS_PROXY: httpProxy.url });
    assert.equal(untrusted.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    assert.match(untrusted.proxyError, /SELF_SIGNED_CERT/);
    assert.doesNotMatch(untrusted.proxyError, /alice|s3cret/);
    assert.deepEqual(httpsProxy.targets, [], 'an untrusted proxy must receive no CONNECT or credentials');

    await withCA(async (ca) => {
      const result = await child(`${LOCAL_DNS}
        const { installFetchProxy, ConnectProxyAgent, openConnectTunnel } = await import('./src/network/proxy.ts');
        const { request } = await import('node:https');
        await installFetchProxy(process.env);
        const body = await (await fetch('https://origin.proxy.test:${target.port}/', { signal: AbortSignal.timeout(3000) })).text();
        let wrongOrigin;
        try { await fetch('https://wrong.proxy.test:${target.port}/', { signal: AbortSignal.timeout(3000) }); }
        catch (error) { wrongOrigin = error.cause?.code; }
        const wrongProxy = new URL(process.env.HTTPS_PROXY); wrongProxy.hostname = 'wrong.proxy.test';
        let wrongProxyError;
        try { (await openConnectTunnel(wrongProxy, 'origin.proxy.test', ${target.port})).destroy(); }
        catch (error) { wrongProxyError = error.message; }
        const agent = new ConnectProxyAgent(new URL(process.env.HTTPS_PROXY));
        const nodeBody = await new Promise((resolve, reject) => {
          const req = request({ hostname: 'origin.proxy.test', port: ${target.port}, agent }, res => {
            let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve(data));
          });
          req.on('error', reject); req.end();
        });
        agent.destroy();
        const { getGlobalDispatcher } = await import('undici');
        await getGlobalDispatcher().close();
        console.log(JSON.stringify({ body, nodeBody, wrongOrigin, wrongProxyError }));
      `, { HTTPS_PROXY: httpsProxy.url, NODE_EXTRA_CA_CERTS: ca });
      assert.equal(result.body, 'secure origin');
      assert.equal(result.nodeBody, 'secure origin');
      assert.equal(result.wrongOrigin, 'ERR_TLS_CERT_ALTNAME_INVALID');
      assert.match(result.wrongProxyError, /ERR_TLS_CERT_ALTNAME_INVALID/);
      assert.doesNotMatch(result.wrongProxyError, /alice|s3cret/);
    });
    assert.equal(leakedAuth.length, 2);
    assert.ok(leakedAuth.every((value) => value === undefined));
  } finally { await Promise.all([httpProxy.close(), httpsProxy.close(), target.close()]); }
});

test('TLS connection callback is one-shot after success, failure, initialization error and timeout', { timeout: 10_000 }, async () => {
  const proxy = await connectProxy();
  const target = await listen(createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }));
  const silentServer = createNetServer((socket) => socket.resume());
  const silent = await listen(silentServer);
  const earlyClose = await listen(createNetServer((socket) => socket.once('data', () => socket.end())));
  try {
    for (const mode of ['success', 'untrusted', 'invalid-options', 'timeout', 'destroy', 'early-close'] as const) {
      const agent = new ConnectProxyAgent(new URL(proxy.url));
      let count = 0;
      let stream: TLSSocket | undefined;
      try {
        const started = mode === 'destroy'
          ? new Promise<void>((resolve) => silentServer.once('connection', (socket) => socket.once('data', () => resolve())))
          : Promise.resolve();
        const result = new Promise<Error | null>((resolve) => {
          agent.createConnection({
            host: 'origin.proxy.test',
            port: mode === 'timeout' || mode === 'destroy' ? silent.port : mode === 'early-close' ? earlyClose.port : target.port,
            ca: mode === 'untrusted' ? undefined : TEST_CERT,
            rejectUnauthorized: true,
            ciphers: mode === 'invalid-options' ? 'NOT-A-CIPHER' : undefined,
            timeout: mode === 'timeout' ? 150 : 2000,
          }, (error, socket) => {
            count++;
            stream = socket as TLSSocket | undefined;
            stream?.on('error', () => {});
            resolve(error);
          });
        });
        if (mode === 'destroy') { await started; agent.destroy(); }
        const error = await result;
        if (mode === 'success') {
          assert.equal(error, null);
          assert.equal(stream?.authorized, true);
          stream!.emit('error', new Error('late transport error'));
        } else {
          assert.ok(error);
          assert.equal(stream, undefined);
          if (mode === 'timeout') assert.match(error.message, /TLS negotiation timed out/);
          if (mode === 'invalid-options') assert.match(error.message, /initialize TLS/);
          if (mode === 'destroy') assert.match(error.message, /aborted/);
        }
        if (stream) {
          const closed = once(stream, 'close');
          stream.destroy();
          await closed;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(count, 1, mode);
      } finally { stream?.destroy(); agent.destroy(); }
    }
  } finally { await Promise.all([proxy.close(), target.close(), silent.close(), earlyClose.close()]); }
});

test('destroying an HTTP agent cancels pending CONNECT and closes the socket', { timeout: 5000 }, async () => {
  const server = createServer();
  let closed!: Promise<unknown>;
  const connected = new Promise<void>((resolve) => server.on('connect', (_req, socket) => {
    socket.on('end', () => socket.end());
    socket.resume();
    closed = once(socket, 'close');
    resolve();
  }));
  const proxy = await listen(server);
  const agent = new ConnectProxyHttpAgent(new URL(`http://127.0.0.1:${proxy.port}`));
  let count = 0;
  try {
    const result = new Promise<Error | null>((resolve) => agent.createConnection({ host: 'target.test', port: 80 }, (error) => {
      count++;
      resolve(error);
    }));
    await connected;
    agent.destroy();
    assert.match((await result)!.message, /aborted/);
    await closed;
    assert.equal(count, 1);
  } finally { agent.destroy(); await proxy.close(); }
});

// Public, test-only self-signed CA/server fixture, valid 2020–2126. Its SANs
// deliberately cover only origin.proxy.test and 127.0.0.1. No openssl at runtime.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDRJ08gD3IaS+wC
Af1St0xewbaNXzXccHvcDRA9nhVWlPW7vh2XQhRb9iIPZkW8YGV8y3CLoio3mxJX
BhZNb/4wDppdk1iQTJGNXtniMjpc7MACmF3pit4vdkg9G7TemTlgfOoggoWaUPFW
d57m7Y6ewfQAN5Set6MKYYqb6KOF48dj4zHbLSXHd7OFy/Ohw33q7Wqbl2mOhqR7
rY8Nigaih1QH9kjs6MZTpdfSdEfEtdyLPv7Lu3vBRnb/zhSX3cpai2xY8ZITg/88
UNvMoboUgQb5g8qyr+yHVFRyHmSUvMMwxNzVxJERlUzmLnmtuYJjMGvmPKGCcraZ
2XFQPj0HAgMBAAECggEAEOF80+gbO/8btc/GS+pKai11V/Syyq9zd7/AK1D6hOnx
6Wy/Q6mMLh3wAtEs2LbpCgj7dPGqOaG0+bweibJ70BIlqF7Pm5nqd4AL0uNd7YkY
OD1m+wX/x9Hio7f8QakZRe3fEa+nK9zTlbiC5T2QMMUTtf7GaocEzD4yK0I8DH7A
CLShiFryR+1BAtvdANCaZThZ5lsG2RT6hn64G4q1hTcde0xpdOt/Q5U8EUC+oLEY
qyc4kuKyQ6fXOlJ04wsnrKes+Pu0MLB5Rny2+/DBuhd8dCLeEM3mHdaEVtLTPASo
84s+dhurozSQ6J4uQB7Tb+5mcJBfKjG/0H/edBHl4QKBgQDs77wK+CYj1LfTs94D
ovUg3BxddzAfwTRIWYQ+q8/mPBPGgHtE0GInl1lQIHl/1rJDvDk8M2K+78a815+J
W6evSFQlynxcE5oT/FDJxmqWSRgfbJKmxr7lJCIGKnXLMVuUh09hOFqJcD6XY3si
/KdRit46QV5Ci6EQMZ0MItn24QKBgQDh+1HmWVxmHRJY23577coFkDI0PNLd3qgR
MNaY5KbirClsEPvWrI9SoE0H7PxPsEWYEhU8hzNkNY5luBucOQoNoDKyIxQwcGgL
lOPz45+fXIUqpeyCMTNQPSY/BKTYdUSIQrN0ubJAaCWand8e7EIBSCC2pJAsXG8o
/xtqF7d45wKBgDdCjpPsXlDbCui4OZ6VgiBg1cjCxJmTYRNCtYI8ZieneWFBk/5v
r4TWWsFCYbP8KeV8X8j3nx8zIyHmFFJf6xMJhn6t5CVBeR0SKvF0cmWMtLCXjPiS
v/EHZVwUyRZT860Hhe8ByrPlVuPOEukNDiUJg10I4+gXUsBJIfyzoCxhAoGADW45
XN5cvnjl2UAaUVU9l30NbstaoPMVvAfSCT41qO0gfRq5TPXugrOiQGFWUYohaLtS
ZcmHRWJldygtA+jj7xFhUfMBxSs5E88iiSEzIG6IP5Oi7c3sxc0Mk9w7y92UWCDW
t449yNQnv/u4Agd6mMbnotM++lP4C1C2GWUVc2sCgYEAwUiRxpvFvD9Tc7opWRRg
R8PPvwnSZZa6s+OvLELNsZMQIHzURK075ut/oi38qRWapBNbnYcQ0shVQoNk8U76
sdE3Psu9JtB+LvpKZnkV5Wg4Peoj0N0I7dTkH++le4sNV1PBBqUFx8QQ6gRMqpMG
hFhXZirjpDDgFJHx4G3mwdA=
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDPzCCAiegAwIBAgIUcWEjOjDgOqyElfeZXG8KraAj6pYwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRb3JpZ2luLnByb3h5LnRlc3QwIBcNMjAwMTAxMDAwMDAw
WhgPMjEyNjEwMTkxNDMyMDVaMBwxGjAYBgNVBAMMEW9yaWdpbi5wcm94eS50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0SdPIA9yGkvsAgH9UrdM
XsG2jV813HB73A0QPZ4VVpT1u74dl0IUW/YiD2ZFvGBlfMtwi6IqN5sSVwYWTW/+
MA6aXZNYkEyRjV7Z4jI6XOzAAphd6YreL3ZIPRu03pk5YHzqIIKFmlDxVnee5u2O
nsH0ADeUnrejCmGKm+ijhePHY+Mx2y0lx3ezhcvzocN96u1qm5dpjoake62PDYoG
oodUB/ZI7OjGU6XX0nRHxLXciz7+y7t7wUZ2/84Ul93KWotsWPGSE4P/PFDbzKG6
FIEG+YPKsq/sh1RUch5klLzDMMTc1cSREZVM5i55rbmCYzBr5jyhgnK2mdlxUD49
BwIDAQABo3cwdTAdBgNVHQ4EFgQUnxougjyOAKWInsQAot9H1wCrZXgwHwYDVR0j
BBgwFoAUnxougjyOAKWInsQAot9H1wCrZXgwDwYDVR0TAQH/BAUwAwEB/zAiBgNV
HREEGzAZghFvcmlnaW4ucHJveHkudGVzdIcEfwAAATANBgkqhkiG9w0BAQsFAAOC
AQEAHf7lEDzRhTuAenB/Rd6gqYJKb6g7z++85M23J1VBXAd67UKBGcNe5/WOipny
H2V1oRkqAIPahFd7rWwus6XNGVtsGlhMvtuXJmp4aFiI/nwTktgJsVgxGi6dNeNS
wk6a+yZiatWdT4vmihxRQfQQfQWF3TxGbVil+7tk/5pbQGIoGHTBwtVT5HN2q/ux
5TvvoqMlrXUSCQ5pVz0cOvY4t/PWAkW1jn0nEmuZcdYZv6RCmIi3bCqBWfgkKAKS
uVXplsie7KCn0I3Gp0IFf+NemA9eOa+//pbmBAab3EfMheiUO7KcYzUtFjtMm3NN
8wlZ1Jj+1447MDEv/Yvcef+coQ==
-----END CERTIFICATE-----`;
