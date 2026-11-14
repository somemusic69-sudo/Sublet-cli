import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LogFile, Logger, redactSecrets } from '../src/logger.js';
import { applySettings, readSettingsEnv, readSettingsFile, resolveSettings } from '../src/settings.js';
import { parseArgv } from '../src/index.js';
import { EXIT } from '../src/exitCodes.js';

function memoryStream(): { stream: NodeJS.WriteStream; text: () => string } {
  const chunks: string[] = [];
  const stream = { isTTY: false, write: (chunk: string) => { chunks.push(chunk); return true; } } as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join('') };
}

test('secrets are redacted from messages, fields, JSON logs, and the log file', async () => {
  assert.equal(redactSecrets('key sh_abcdef1234567890 ok'), 'key sh_abc*** ok');
  assert.equal(redactSecrets('Authorization: Bearer sk-abcdef123456'), 'Authorization: Bearer ***');
  assert.equal(redactSecrets('wss://x/tunnel?token=sh_secret123&a=1'), 'wss://x/tunnel?token=***&a=1');
  const dir = await mkdtemp(join(tmpdir(), 'sublet-log-'));
  try {
    const out = memoryStream();
    const file = new LogFile({ path: join(dir, 'agent.log') });
    const logger = new Logger({ level: 'info', json: true, color: false, stream: out.stream, file });
    logger.info('connected with sh_abcdef1234567890', { token: 'sh_zzzzzzzzzzzz', url: 'https://s/?token=abc123' });
    logger.debug('debug goes to the file only');
    const terminal = out.text();
    const saved = await readFile(join(dir, 'agent.log'), 'utf8');
    for (const text of [terminal, saved]) assert.doesNotMatch(text, /sh_abcdef1234567890|sh_zzzzzzzzzzzz|abc123/);
    assert.doesNotMatch(terminal, /debug goes/);
    assert.match(saved, /debug goes to the file only/);
    const lines = saved.trim().split('\n').map((line) => JSON.parse(line) as { level: string; ts: string });
    assert.deepEqual(lines.map((l) => l.level), ['info', 'debug']);
    assert.ok(lines.every((l) => !Number.isNaN(Date.parse(l.ts))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the agent log file rotates by size and keeps a bounded number of files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-rotate-'));
  try {
    const file = new LogFile({ path: join(dir, 'agent.log'), maxBytes: 64 * 1024, keep: 2 });
    for (let i = 0; i < 300; i++) file.write('x'.repeat(1000));
    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, ['agent.log', 'agent.log.1', 'agent.log.2']);
    for (const name of names) assert.ok((await readFile(join(dir, name))).length <= 64 * 1024, `${name} is over the limit`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a log file that cannot be written never throws into the agent', () => {
  const file = new LogFile({ path: join(tmpdir(), '\u0000bad', 'agent.log') });
  assert.doesNotThrow(() => file.write('hello'));
  assert.doesNotThrow(() => file.write('again'));
});

test('settings: flag beats env beats agent.json, and values are typed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-settings-'));
  try {
    const file = join(dir, 'agent.json');
    await writeFile(file, JSON.stringify({ server: 'https://file.example', context: 4096, slots: 2, noBrowser: true }));
    const env = { SUBLET_CONFIG: file, SUBLET_SERVER: 'https://env.example', SUBLET_SLOTS: '6', SUBLET_LOG_LEVEL: 'WARN' };
    const resolved = resolveSettings({ slots: 8 }, env);
    assert.deepEqual([resolved.values.server, resolved.sources.server], ['https://env.example', 'env']);
    assert.deepEqual([resolved.values.context, resolved.sources.context], [4096, 'file']);
    assert.deepEqual([resolved.values.slots, resolved.sources.slots], [8, 'flag']);
    assert.equal(resolved.values.noBrowser, true);
    assert.equal(resolved.values.logLevel, 'warn');

    const parsed = parseArgv(['start', '--ctx', '16384']);
    applySettings(parsed.flags, parsed.explicit, env);
    assert.equal(parsed.flags.context, 16384, 'a typed flag is never overridden');
    assert.equal(parsed.flags.slots, 6);
    assert.equal(parsed.flags.server, 'https://env.example');
    assert.equal(parsed.flags.noBrowser, true);
    assert.equal(parsed.flags.logLevel, 'warn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('settings: a broken or misspelled agent.json and bad values are clear errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-settings-'));
  try {
    const file = join(dir, 'agent.json');
    assert.deepEqual(readSettingsFile(join(dir, 'missing.json')), {});
    await writeFile(file, '{ not json');
    assert.throws(() => readSettingsFile(file), /not valid JSON/);
    await writeFile(file, JSON.stringify({ sever: 'https://typo.example' }));
    assert.throws(() => readSettingsFile(file), /unknown setting "sever"/);
    await writeFile(file, JSON.stringify({ slots: 1.5 }));
    assert.throws(() => readSettingsFile(file), /whole number/);
    await writeFile(file, `\uFEFF${JSON.stringify({ $schema: 'x', version: 1, vram: 8192 })}`);
    assert.deepEqual(readSettingsFile(file), { vram: 8192 });
    assert.throws(() => readSettingsEnv({ SUBLET_CTX: 'big' }), /SUBLET_CTX must be a number/);
    assert.throws(() => readSettingsEnv({ SUBLET_NO_INSTALL: 'maybe' }), /true or false/);
    assert.throws(() => readSettingsEnv({ SUBLET_LOG_LEVEL: 'loud' }), /debug, info/);
    assert.throws(() => parseArgv(['start', '--log-level', 'loud']), /--log-level/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exit codes are a stable contract', () => {
  assert.deepEqual(EXIT, { OK: 0, ERROR: 1, USAGE: 2, INTERRUPTED: 130, TERMINATED: 143 });
});
test('settings: the hourly price comes from SUBLERA_PRICE_HOUR, legacy SUBLET_PRICE_HOUR, or agent.json, within 0 to 50', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-settings-'));
  try {
    const file = join(dir, 'agent.json');
    await writeFile(file, JSON.stringify({ priceHour: 2 }));
    const base = { SUBLET_CONFIG: file };
    assert.deepEqual([resolveSettings({}, base).values.priceHour, resolveSettings({}, base).sources.priceHour], [2, 'file']);
    const legacy = resolveSettings({}, { ...base, SUBLET_PRICE_HOUR: '1.25' });
    assert.deepEqual([legacy.values.priceHour, legacy.sources.priceHour], [1.25, 'env']);
    assert.equal(resolveSettings({}, { ...base, SUBLERA_PRICE_HOUR: '3', SUBLET_PRICE_HOUR: '1' }).values.priceHour, 3);
    assert.deepEqual(readSettingsEnv({ SUBLERA_PRICE_HOUR: '0' }), { priceHour: 0 });
    assert.throws(() => resolveSettings({}, { ...base, SUBLERA_PRICE_HOUR: '51' }), /priceHour must be between 0 and 50/);
    assert.throws(() => readSettingsEnv({ SUBLERA_PRICE_HOUR: '-1' }), /must not be negative/);
    const parsed = parseArgv(['host', 'model.gguf', '--price-hour', '0.75']);
    assert.equal(parsed.flags.priceHour, 0.75);
    applySettings(parsed.flags, parsed.explicit, { ...base, SUBLERA_PRICE_HOUR: '9' });
    assert.equal(parsed.flags.priceHour, 0.75, 'a typed flag is never overridden');
    assert.throws(() => parseArgv(['host', 'model.gguf', '--price-hour', '50.5']), /--price-hour must be between 0 and 50/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
