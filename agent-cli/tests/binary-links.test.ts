import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as tar from 'tar';
import { extractArchive } from '../src/engine/binaryManager.js';

// The fixtures need real symlinks; Windows allows them only in an admin terminal or with Developer Mode.
async function canSymlink(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'sublet-symlink-'));
  try {
    await symlink('target', join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const skip = (await canSymlink()) ? false : 'this computer cannot create symlinks (Windows needs Developer Mode or an admin terminal)';

test('Linux and macOS archives with library link chains extract as plain files', { skip }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'sublet-links-'));
  try {
    const src = join(work, 'src', 'llama-b1');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'llama-server'), 'server');
    await writeFile(join(src, 'libllama.so.0.9.0'), 'library');
    await symlink('libllama.so.0.9.0', join(src, 'libllama.so.0'));
    await symlink('libllama.so.0', join(src, 'libllama.so'));
    const archive = join(work, 'llama-b1-bin-ubuntu-x64.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: join(work, 'src') }, ['llama-b1']);

    const out = join(work, 'out');
    await extractArchive(archive, out);
    const dir = join(out, 'llama-b1');
    assert.deepEqual((await readdir(dir)).sort(), ['libllama.so', 'libllama.so.0', 'libllama.so.0.9.0', 'llama-server']);
    for (const name of ['libllama.so', 'libllama.so.0']) {
      assert.equal((await lstat(join(dir, name))).isSymbolicLink(), false);
      assert.equal(await readFile(join(dir, name), 'utf8'), 'library');
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('an archive link that points outside the install folder is refused', { skip }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'sublet-links-'));
  try {
    const src = join(work, 'src', 'pkg');
    await mkdir(src, { recursive: true });
    await symlink('../../../etc/passwd', join(src, 'evil.so'));
    const archive = join(work, 'evil.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: join(work, 'src') }, ['pkg']);
    await assert.rejects(extractArchive(archive, join(work, 'out')), /escapes/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
