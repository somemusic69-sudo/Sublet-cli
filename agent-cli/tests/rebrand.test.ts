import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { subletHome } from '../src/config.js';
import { readSettingsEnv, settingsPath } from '../src/settings.js';
import { storagePolicy } from '../src/util/storage.js';
import { brandEnv } from '../src/util/env.js';
import { AGENT_NAME, BRAND } from '../src/version.js';

test('Sublera branding and executable aliases match package and lockfile', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(BRAND, 'Sublera');
  assert.equal(AGENT_NAME, 'sublera-cli');
  assert.equal(pkg.name, AGENT_NAME);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.deepEqual(lock.packages[''].bin, pkg.bin);
  for (const name of ['sublera', 'sublera-cli', 'sublet', 'sublet-cli']) assert.equal(pkg.bin[name], 'dist/index.js');
});

test('new environment names win while legacy settings and home remain compatible', () => {
  assert.deepEqual(readSettingsEnv({ SUBLERA_KEY: 'new', SUBLET_KEY: 'old', SUBLERA_CTX: '4096', SUBLET_CTX: '8192', SUBLERA_NO_BROWSER: 'false', SUBLET_NO_BROWSER: 'true' }), { token: 'new', context: 4096, noBrowser: false });
  assert.equal(readSettingsEnv({ SUBLET_KEY: 'old' }).token, 'old');
  assert.equal(subletHome({ SUBLERA_HOME: './new-home', SUBLET_HOME: './old-home' }), resolve('./new-home'));
  assert.equal(subletHome({ SUBLET_HOME: './old-home' }), resolve('./old-home'));
  assert.equal(settingsPath({ SUBLERA_CONFIG: './new.json', SUBLET_CONFIG: './old.json' }), resolve('./new.json'));
  assert.equal(storagePolicy({ SUBLERA_MODEL_CACHE_GB: '2', SUBLET_MODEL_CACHE_GB: '1' }).modelCacheBytes, 2 * 1024 ** 3);
  assert.equal(brandEnv({ SUBLERA_LLAMA_SHA256: 'new', SUBLET_LLAMA_SHA256: 'old' }, 'SUBLET_LLAMA_SHA256'), 'new');
  assert.throws(() => readSettingsEnv({ SUBLERA_CTX: 'invalid', SUBLET_CTX: '4096' }), /whole number|integer|number/);
});

test('CI package smoke test installs the renamed package and exercises both command names', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('ls sublera-cli-*.tgz'));
  assert.ok(workflow.includes('node_modules/sublera-cli/dist/index.js'));
  assert.ok(workflow.includes('node_modules/.bin/sublera --version'));
  assert.ok(workflow.includes('node_modules/.bin/sublet --version'));
  assert.ok(!workflow.includes('node_modules/sublet-cli/'));
});