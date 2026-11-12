import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LogFile, Logger } from '../src/logger.js';

test('nested secrets, URL credentials and control characters are redacted before JSON serialization', () => {
  for (const json of [false, true]) {
    const records: string[] = [];
    const logger = new Logger({ json, color: false, stream: { write: (s: string) => { records.push(s); return true; } } as NodeJS.WriteStream });
    const fields: Record<string, unknown> = {
      nested: [{ api_key: 'opaque-credential', headers: { 'Proxy-Authorization': 'Basic opaque' }, password: 'hunter-value' }],
      endpoint: 'https://some-user:private-pass@proxy.example/path?access_token=opaque-value',
      path: 'C:\\models\\weights', counter: 12n,
      level: 'forged', message: 'forged', ts: 'forged',
    };
    fields.self = fields;
    Object.defineProperty(fields, 'computed', { enumerable: true, get: () => { throw new Error('must not invoke'); } });
    logger.info('server\u001b[2J\nline', fields);
    assert.equal(records.length, 1);
    const text = records[0]!;
    assert.doesNotMatch(text, /opaque-credential|hunter-value|private-pass|some-user|opaque-value|Basic opaque|\u001b/);
    assert.equal(text.split('\n').length, 2, 'one record cannot forge new log lines');
    assert.match(text, /circular/);
    if (json) {
      const record = JSON.parse(text);
      assert.equal(record.level, 'info');
      assert.notEqual(record.message, 'forged');
      assert.notEqual(record.ts, 'forged');
      assert.equal(record.path, 'C:\\models\\weights');
      assert.equal(record.counter, '12');
    }
  }
});

test('rotation counts UTF-8 bytes and oversized records remain bounded valid JSON', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-log-bounds-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = new LogFile({ path: join(dir, 'agent.log'), maxBytes: 65536, keep: 2 });
  for (let i = 0; i < 100; i++) file.write(JSON.stringify({ message: '界'.repeat(1000) }));
  file.write(JSON.stringify({ message: '界'.repeat(65536) }));
  const names = await readdir(dir);
  assert.equal(names.length, 3);
  for (const name of names) {
    const data = await readFile(join(dir, name));
    assert.ok(data.length <= 65536);
    for (const line of data.toString().trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.match(await readFile(join(dir, 'agent.log'), 'utf8'), /Oversized log record omitted/);
});

test('a file logging failure emits one notification and never throws into a booking', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-log-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'blocked'), 'not a directory');
  let notices = 0;
  const file = new LogFile({ path: join(dir, 'blocked', 'agent.log'), onError: () => { notices++; } });
  assert.doesNotThrow(() => { file.write('one'); file.write('two'); });
  assert.equal(notices, 1);
});