import assert from 'node:assert/strict';
import test from 'node:test';
import { hostEndpoint, maskToken, normalizeServer, wsUrl } from '../src/config.js';
import { canOpenBrowser } from '../src/util/open.js';
import { parseArgv } from '../src/index.js';

test('server URLs are normalized and websocket URLs keep the token', () => {
  assert.equal(normalizeServer('localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeServer('sublet.example.com/'), 'https://sublet.example.com');
  assert.equal(normalizeServer('https://sublet.example.com/api/'), 'https://sublet.example.com/api');
  const ws = wsUrl('https://sublet.example.com', 'sh_abc123', '/tunnel');
  assert.match(ws, /^wss:\/\/sublet\.example\.com\/tunnel\?token=sh_abc123$/);
  const headerMode = wsUrl('https://sublet.example.com', 'sh_abc123', '/tunnel', 'header');
  assert.equal(headerMode, 'wss://sublet.example.com/tunnel');
  const local = wsUrl('http://127.0.0.1:8787', 'sh_x');
  assert.match(local, /^ws:\/\/127\.0\.0\.1:8787\/tunnel\?token=sh_x$/);
});

test('tokens are masked in logs', () => {
  assert.equal(maskToken(null), 'not set');
  assert.equal(maskToken('sh_1234567890abcdef'), 'sh_1234...cdef');
});

test('argv parser handles commands, equals values, and numbers', () => {
  const parsed = parseArgv(['start', '--server=https://sublet.example.com', '--ctx', '16384', '--simulation', '--json']);
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.flags.server, 'https://sublet.example.com');
  assert.equal(parsed.flags.context, 16384);
  assert.equal(parsed.flags.simulation, true);
  assert.equal(parsed.flags.json, true);
  assert.throws(() => parseArgv(['start', '--ctx', 'nope']), /number/);
  assert.throws(() => parseArgv(['start', '--wat']), /Unknown option/);
});

test('host positional model is preserved', () => {
  const parsed = parseArgv(['host', 'https://huggingface.co/a/b/resolve/main/x.gguf', '--price', '0.25']);
  assert.equal(parsed.command, 'host');
  assert.equal(parsed.flags.positionals[0], 'https://huggingface.co/a/b/resolve/main/x.gguf');
  assert.equal(parsed.flags.price, 0.25);
});

test('argv parser rejects empty, negative, fractional and swallowed values and unknown short flags', () => {
  assert.throws(() => parseArgv(['host', 'x.gguf', '--price=']), /--price expects a number/);
  assert.throws(() => parseArgv(['host', 'x.gguf', '--price', ' ']), /--price expects a number/);
  assert.throws(() => parseArgv(['start', '--vram', '-5']), /must not be negative/);
  assert.throws(() => parseArgv(['start', '--price=-1']), /must not be negative/);
  assert.throws(() => parseArgv(['start', '--ctx', '8192.5']), /whole number/);
  assert.throws(() => parseArgv(['start', '--slots=1.5']), /whole number/);
  assert.throws(() => parseArgv(['start', '--gpu', '--simulation']), /--gpu needs a value/);
  assert.throws(() => parseArgv(['start', '--key']), /--key needs a value/);
  assert.throws(() => parseArgv(['host', 'x.gguf', '-p', '0.5']), /Unknown option: -p/);
  assert.equal(parseArgv(['host', 'x.gguf', '--price', '0']).flags.price, 0);
  assert.equal(parseArgv(['start', '--tok-s', '24.5']).flags.tokPerSec, 24.5);
  assert.equal(parseArgv(['start', '-h']).flags.help, true);
  assert.equal(parseArgv(['-v']).flags.version, true);
  assert.deepEqual(parseArgv(['host', '--', '-odd.gguf']).flags.positionals, ['-odd.gguf']);
});

test('the host endpoint is a path on the server, the same route the server serves', () => {
  assert.equal(hostEndpoint('https://sublet.example.com/', 'ada'), 'https://sublet.example.com/h/ada/v1');
  assert.equal(hostEndpoint('http://127.0.0.1:8787', null), 'http://127.0.0.1:8787/h/USERNAME/v1');
});

test('login opens a browser only in a local desktop session', () => {
  assert.equal(parseArgv(['login', '--no-browser']).flags.noBrowser, true);
  assert.equal(canOpenBrowser({ SSH_CONNECTION: '1 2 3 4' }, 'darwin'), false);
  assert.equal(canOpenBrowser({}, 'linux'), false);
  assert.equal(canOpenBrowser({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(canOpenBrowser({}, 'win32'), true);
});

test('start takes the request code as its argument', () => {
  const parsed = parseArgv(['start', 'r_abc123', '--simulation']);
  assert.equal(parsed.command, 'start');
  assert.deepEqual(parsed.flags.positionals, ['r_abc123']);
});
