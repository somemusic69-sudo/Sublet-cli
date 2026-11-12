import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MIN_NODE, VERSION } from '../src/version.js';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  engines: { node: string };
  dependencies: Record<string, string>;
};

test('the CLI version, package.json, and CHANGELOG agree', async () => {
  assert.equal(VERSION, pkg.version, 'update src/version.ts together with package.json');
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.ok(changelog.includes(`## [${VERSION}]`), `CHANGELOG.md needs a "## [${VERSION}]" section`);
});

test('the minimum Node version is the same in package.json and doctor', () => {
  assert.equal(pkg.engines.node, `>=${MIN_NODE}`);
});

test('the lockfile root metadata matches the published package', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
});

test('runtime dependencies stay small and listed in THIRD_PARTY_NOTICES', async () => {
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const name of Object.keys(pkg.dependencies)) {
    assert.ok(notices.includes(`\`${name}\``), `${name} is missing from THIRD_PARTY_NOTICES.md`);
  }
  assert.ok(Object.keys(pkg.dependencies).length <= 5, 'every new runtime dependency needs a review');
});
