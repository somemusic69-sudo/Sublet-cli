import assert from 'node:assert/strict';
import test from 'node:test';
import { maskToken, normalizeServer, wsUrl } from '../src/config.js';
import { parseArgv } from '../src/index.js';

test('server URLs are normalized and websocket URLs keep the token', () => {
  assert.equal(normalizeServer('localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeServer('kiln.run/'), 'https://kiln.run');
  assert.equal(normalizeServer('https://kiln.run/api/'), 'https://kiln.run/api');
  const ws = wsUrl('https://kiln.run', 'kh_abc123', '/tunnel');
  assert.match(ws, /^wss:\/\/kiln\.run\/tunnel\?token=kh_abc123$/);
  const headerMode = wsUrl('https://kiln.run', 'kh_abc123', '/tunnel', 'header');
  assert.equal(headerMode, 'wss://kiln.run/tunnel');
  const local = wsUrl('http://127.0.0.1:8787', 'kh_x');
  assert.match(local, /^ws:\/\/127\.0\.0\.1:8787\/tunnel\?token=kh_x$/);
});

test('tokens are masked in logs', () => {
  assert.equal(maskToken(null), 'not set');
  assert.equal(maskToken('kh_1234567890abcdef'), 'kh_1234...cdef');
});

test('argv parser handles commands, equals values, and numbers', () => {
  const parsed = parseArgv(['start', '--server=https://kiln.run', '--ctx', '16384', '--simulation', '--json']);
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.flags.server, 'https://kiln.run');
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
