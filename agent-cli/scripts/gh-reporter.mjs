/**
 * A node:test reporter for GitHub Actions: every failing test becomes an error annotation (file, line, message), so a
 * failure shows on the run page and through the public checks API without opening the log.
 * CI uses it next to the spec reporter: --test-reporter=spec --test-reporter=./scripts/gh-reporter.mjs
 */
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const data = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail' || event.data.todo) continue;
    const error = event.data.details?.error;
    // A failing suite repeats its failing tests; report the tests themselves.
    if (error?.failureType === 'subtestsFailed') continue;
    const cause = error?.cause ?? error;
    const message = `${cause?.message ?? error?.message ?? 'failed'}`.slice(0, 1500);
    let file = event.data.file ?? '';
    try { file = relative(process.cwd(), file.startsWith('file:') ? fileURLToPath(file) : file).replace(/\\/g, '/'); } catch { /* keep it */ }
    yield `::error title=${prop(event.data.name)},file=${prop(`agent-cli/${file}`)},line=${event.data.line ?? 1}::${data(message)}\n`;
  }
}
