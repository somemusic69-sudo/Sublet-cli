import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeServer, wsUrl } from '../src/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

async function home(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-cli-polish-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function cli(dir: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUBLET_|https?_proxy$|no_proxy$)/i.test(key)));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', entry, ...args], {
      cwd: root, env: { ...env, SUBLET_HOME: dir, ...extra }, timeout: 8_000,
    }, (error, out, err) => {
      if (error?.killed) { reject(new Error(`CLI hung: ${err}`)); return; }
      resolve({ code: typeof error?.code === 'number' ? error.code : error ? -1 : 0, out, err });
    });
  });
}

test('help and command errors advertise Sublera commands', async (t) => {
  const dir = await home(t);
  const help = await cli(dir, ['--help']);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /Sublera GPU Terminal Agent/);
  assert.match(help.out, /Usage: sublera <command>/);
  assert.match(help.out, /sublera login/);
  assert.match(help.out, /sublera doctor --fix/);
  assert.doesNotMatch(help.out, /\bsublet (?:login|doctor|start|host|jobs|config)\b/i);
  const unknown = await cli(dir, ['unknown', '--json']);
  assert.equal(unknown.code, 2);
  assert.match(JSON.parse(unknown.out).error, /Run sublera --help/);
});

test('unattended commands fail fast without starting browser login', async (t) => {
  const dir = await home(t);
  for (const command of [['start'], ['login'], ['host', 'https://huggingface.co/a/b/resolve/main/x.gguf']]) {
    const result = await cli(dir, [...command, '--non-interactive', '--json'], { SUBLET_SERVER: 'http://127.0.0.1:9', SUBLET_LOG_FILE: 'off' });
    assert.equal(result.code, 2, result.err);
    assert.match(JSON.parse(result.out).error, /host key|SUBLET_KEY/);
    assert.doesNotMatch(result.out, /verificationUrl|deviceCode/);
  }
});

test('JSON usage errors are machine-readable and do not echo credentials', async (t) => {
  const dir = await home(t);
  for (const args of [
    ['start', '--slots=0'], ['start', '--ctx=0'], ['start', '--simulation=maybe'],
    ['unknown'], ['config', 'invalid'], ['start', '--price=sh_secret123456789'],
  ]) {
    const result = await cli(dir, [...args, '--json']);
    assert.equal(result.code, 2, result.err);
    assert.equal(JSON.parse(result.out).ok, false);
    assert.doesNotMatch(result.out + result.err, /sh_secret123456789/);
  }
});

test('configuration validates version, missing explicit files, and values; help still works', async (t) => {
  const dir = await home(t);
  for (const content of ['{"version":99}', '{"slots":0}', '{"context":1}', '{"token":"opaque-secret", broken}']) {
    await writeFile(join(dir, 'agent.json'), content);
    const result = await cli(dir, ['config', '--json']);
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.out + result.err, /opaque-secret/);
  }
  assert.equal((await cli(dir, ['--help'])).code, 0);
  assert.equal((await cli(dir, ['config', '--json'], { SUBLET_CONFIG: join(dir, 'missing.json') })).code, 2);
});

test('explicit false overrides a true settings switch and config works with an invalid proxy', async (t) => {
  const dir = await home(t);
  await writeFile(join(dir, 'agent.json'), JSON.stringify({ noBrowser: true, nonInteractive: true }));
  const result = await cli(dir, ['config', '--json', '--no-browser=false'], { HTTPS_PROXY: 'socks5://user:supersecret@proxy.test:1080' });
  assert.equal(result.code, 0, result.err);
  const settings = JSON.parse(result.out).settings;
  assert.equal(settings.find((row: { key: string }) => row.key === 'noBrowser').value, false);
  assert.doesNotMatch(result.out + result.err, /supersecret/);
});

test('a saved key is scoped to its server, even with a command-line server override', async (t) => {
  const dir = await home(t);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ server: 'https://original.test', token: 'sh_original123456', wsPath: '/tunnel' }));
  const result = await cli(dir, ['status', '--json', '--server', 'http://127.0.0.1:9']);
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.out).error, /different server/);
  assert.doesNotMatch(result.err + result.out, /sh_original123456/);
});

test('server and tunnel URLs reject embedded credentials and cross-origin forwarding', () => {
  assert.throws(() => normalizeServer('https://user:password@server.test'), /credentials/);
  assert.throws(() => normalizeServer('https://server.test?token=x'), /query/);
  assert.throws(() => wsUrl('https://server.test', 'sh_secret', 'wss://other.test/tunnel'), /same server origin/);
  assert.throws(() => wsUrl('https://server.test', 'sh_secret', 'ws://server.test/tunnel'), /same server origin/);
  assert.equal(wsUrl('https://server.test', 'sh_secret', 'wss://server.test/custom', 'header'), 'wss://server.test/custom');
});

test('local operational commands do not require a proxy and maintenance is dry-run by default', async (t) => {
  const dir = await home(t);
  const extra = { HTTPS_PROXY: 'invalid-proxy' };
  const storage = await cli(dir, ['storage', 'prune', '--json'], extra);
  assert.equal(storage.code, 0, storage.err);
  assert.equal(JSON.parse(storage.out).dryRun, true);
  const health = await cli(dir, ['health', '--json'], extra);
  assert.equal(health.code, 1);
  assert.equal(JSON.parse(health.out).ok, false);
  const invalid = await cli(dir, ['start', '--drain-timeout=300001', '--json']);
  assert.equal(invalid.code, 2);
});
test('help and agent.json document the hourly price, and out-of-range prices are usage errors', async (t) => {
  const dir = await home(t);
  const help = await cli(dir, ['--help']);
  assert.match(help.out, /--price-hour <usd>/);
  await writeFile(join(dir, 'agent.json'), JSON.stringify({ priceHour: 1.5 }));
  const shown = await cli(dir, ['config', '--json']);
  assert.equal(shown.code, 0, shown.err);
  const row = JSON.parse(shown.out).settings.find((entry: { key: string }) => entry.key === 'priceHour');
  assert.deepEqual([row.value, row.source, row.env], [1.5, 'file', 'SUBLERA_PRICE_HOUR']);
  for (const args of [['host', 'x.gguf', '--price-hour', '51'], ['host', 'x.gguf', '--price-hour=-1']]) {
    const result = await cli(dir, [...args, '--json']);
    assert.equal(result.code, 2, result.err);
  }
  await writeFile(join(dir, 'agent.json'), JSON.stringify({ priceHour: 80 }));
  assert.equal((await cli(dir, ['config', '--json'])).code, 2);
});

/**
 * A fake Sublera server for the process-lifetime tests. Every booking it starts is listed in
 * /api/agent/me until it ends, like the real server's activeRequests.
 */
async function lifetimeServer(onStart: (book: (id: string, endsInMs: number) => void) => void): Promise<{ url: string; end: (id: string) => void; close: () => Promise<void> }> {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const live = new Map<string, Record<string, unknown>>();
  let socket: import('ws').WebSocket | undefined;
  const send = (frame: Record<string, unknown>) => socket?.send(JSON.stringify(frame));
  const book = (id: string, endsInMs: number) => {
    const now = Date.now();
    const frame = { requestId: id, timerStartedAt: now, timerEndsAt: now + endsInMs, hours: 1, pricePerHourNanos: 1e9 };
    live.set(id, { id, status: 'active', ...frame });
    send({ type: 'booking', ...frame });
  };
  const http = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/agent/requests/') && req.method === 'POST') {
      res.end(JSON.stringify({ claimId: 'c1', status: 'claimed' }));
      setTimeout(() => onStart(book), 50);
      return;
    }
    if (req.url === '/api/agent/requests') {
      res.end(JSON.stringify({ requests: [{ id: 'r_target', status: 'open', hours: 1, pricePerHourNanos: 1e9 }] }));
      return;
    }
    const rows = [...live.values()].filter((row) => Number(row.timerEndsAt) > Date.now()).reverse();
    res.end(JSON.stringify({ user: { id: '1', username: 'ada' }, wallet: { availableNanos: 0, pendingNanos: 0, escrowNanos: 0 }, host: null, activeRequest: rows[0] ?? null, activeRequests: rows, serverNow: Date.now() }));
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (client) => {
    socket = client;
    client.send(JSON.stringify({ type: 'welcome', username: 'ada' }));
    client.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; requestId?: string };
      if (frame.type === 'hello' && frame.requestId) setTimeout(() => onStart(book), 50);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    end: (id) => { live.delete(id); send({ type: 'reject', requestId: id, reason: 'Cancelled by the buyer' }); },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

for (const mode of ['start', 'jobs'] as const) {
  test(`${mode}: the process stays up while another booking is active and exits when the last one ends`, async (t) => {
    const dir = await home(t);
    const server = await lifetimeServer((book) => {
      // Another renter's booking appears first; the target booking ends after one second.
      book('r_other', 10 * 60_000);
      book('r_target', 1_000);
    });
    t.after(() => server.close());
    const { spawn } = await import('node:child_process');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUBLET_|SUBLERA_|https?_proxy$|no_proxy$)/i.test(key)));
    const command = mode === 'start' ? ['start', 'r_target'] : ['jobs', '--claim', 'r_target'];
    // No --json: `jobs --claim --json` only claims and exits.
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...command, '--simulation', '--non-interactive', '--no-color',
      '--server', server.url, '--key', 'sh_lifetime_test_key', '--gpu', 'Fake GPU', '--vram', '8192'], {
      cwd: root, env: { ...env, SUBLET_HOME: dir, SUBLET_LOG_FILE: 'off' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
    const waitFor = async (pattern: RegExp, ms: number) => {
      const deadline = Date.now() + ms;
      while (!pattern.test(output)) {
        if (child.exitCode != null) throw new Error(`exited early with ${child.exitCode}: ${output.slice(-800)}`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}: ${output.slice(-800)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    // The target ends by its own timer or by the server's status list, whichever comes first.
    await waitFor(/other rentals are still active/i, 20_000);
    assert.equal(/Booking r_target finished/.test(output), false);
    // The target is over, but r_other still uses the GPU.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(child.exitCode, null, `exited while another booking was active: ${output.slice(-800)}`);
    server.end('r_other');
    const code = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 10_000))]);
    assert.equal(code, 0, output.slice(-800));
  });
}
test('status lists every booking, and falls back to the single activeRequest of an older server', async () => {
  const { statusBookingLines } = await import('../src/commands.js');
  const now = 1_000_000;
  const text = statusBookingLines({
    activeRequest: null,
    activeRequests: [
      { id: 'r_a', status: 'active', timerEndsAt: now + 3_600_000, tokS: 50, shared: true },
      { id: 'r_b', status: 'active', timerEndsAt: now + 600_000, tokS: null, shared: false },
    ],
  }, now);
  assert.equal(text, 'bookings    2 active\nbooking     r_a · active · 50 tok/s seat · 1h 00m 00s left\nbooking     r_b · active · full GPU · 10m 00s left\n');
  assert.equal(statusBookingLines({ activeRequest: { id: 'r_old', status: 'active', timerEndsAt: now + 5_000 } }, now), 'booking     r_old · active · 5s left\n');
  assert.equal(statusBookingLines({ activeRequest: null }, now), '');
  // Rows with a malformed id are skipped and server text is printed without control characters.
  assert.equal(statusBookingLines({
    activeRequest: null,
    activeRequests: [
      { id: 'r_ok', status: 'active\u001b[2J\u0007', timerEndsAt: String(now + 5_000) as unknown as number },
      { id: 'r_bad\u001b[31m', status: 'active' },
      { id: 'x', status: 'active' },
    ],
  }, now), 'booking     r_ok · active[2J · 5s left\n');
});
