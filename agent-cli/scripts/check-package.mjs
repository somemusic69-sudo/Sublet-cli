#!/usr/bin/env node
// Release gate: inspects exactly what `npm publish` would upload and fails on
// anything that must never ship (source maps, tests, secrets, local state) or
// on a version mismatch between package.json, the built CLI, and CHANGELOG.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const raw = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
const [info] = JSON.parse(raw.slice(raw.indexOf('[')));
const files = info.files.map((file) => file.path.replace(/\\/g, '/'));

const required = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'dist/index.js'];
for (const name of required) if (!files.includes(name)) problems.push(`missing from the package: ${name}`);

const forbidden = [
  [/\.map$/, 'source map'],
  [/^(src|tests|scripts)\//, 'source or test file'],
  [/(^|\/)\.env/, 'environment file'],
  [/(^|\/)(config|state|agent)\.json$/, 'local agent config or state'],
  [/\.(gguf|tgz|log)$/, 'model, archive, or log'],
];
for (const file of files) {
  for (const [pattern, label] of forbidden) if (pattern.test(file)) problems.push(`${label} must not ship: ${file}`);
}

const entry = readFileSync(join(root, 'dist', 'index.js'), 'utf8');
if (!entry.startsWith('#!/usr/bin/env node')) problems.push('dist/index.js is missing its #!/usr/bin/env node line');

const built = readFileSync(join(root, 'dist', 'version.js'), 'utf8').match(/VERSION = '([^']+)'/)?.[1];
if (built !== pkg.version) problems.push(`dist/version.js says ${built}, package.json says ${pkg.version} (rebuild, or update src/version.ts)`);

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${pkg.version}]`)) problems.push(`CHANGELOG.md has no "## [${pkg.version}]" section`);

for (const file of files.filter((name) => name.endsWith('.js'))) {
  const text = readFileSync(join(root, file), 'utf8');
  if (/\b(sh_|sk-)[A-Za-z0-9]{24,}/.test(text)) problems.push(`${file} looks like it contains a real key`);
}

if (problems.length) {
  console.error(`Package check failed for ${pkg.name}@${pkg.version}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Package check passed: ${pkg.name}@${pkg.version}, ${files.length} files, ${(info.size / 1024).toFixed(1)} kB packed.`);
