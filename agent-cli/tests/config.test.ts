import assert from 'node:assert/strict';
import test from 'node:test';
import { maskToken, normalizeServer, wsUrl } from '../src/config.js';
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
