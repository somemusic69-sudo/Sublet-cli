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