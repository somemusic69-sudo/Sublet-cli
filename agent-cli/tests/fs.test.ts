import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWrite } from '../src/util/fs.js';

test('concurrent atomic writes cannot share a temporary file or leave partial JSON', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const writes = Array.from({ length: 10 }, (_, i) => JSON.stringify({ i, content: String(i).repeat(10000) }));
  await Promise.all(writes.map((data) => atomicWrite(file, data)));
  assert.ok(writes.includes(await readFile(file, 'utf8')));
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('a failed atomic replacement cleans up its temporary file without removing the target', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-atomic-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'blocked');
  await mkdir(target);
  await assert.rejects(atomicWrite(target, 'data'));
  assert.deepEqual(await readdir(dir), ['blocked']);
});