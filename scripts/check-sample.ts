// The no-network sample run behind `npm run check`. Uses a throwaway PITCREW_HOME so it never writes to the user's Documents.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SITE = 'ridgeline-plumbing.example';
const cli = join(import.meta.dirname, 'pitcrew.ts');
const home = mkdtempSync(join(tmpdir(), 'pitcrew-check-'));
const env = { ...process.env, PITCREW_HOME: home, PITCREW_NO_OPEN: '1' };

const steps: string[][] = [
  ['crawl', '--sample', SITE, '--date', '2026-01-01'],
  ['interview-save', '--site', SITE, '--file', join(import.meta.dirname, '..', 'fixtures', SITE, 'answers.json')],
  ['top', '--site', SITE],
  ['batches', '--site', SITE],
  ['merge', '--site', SITE, '--sample-outs'],
  ['workbook', '--site', SITE, '--no-open'],
];

let last = '';
let code = 0;
for (const step of steps) {
  const r = spawnSync(process.execPath, [cli, ...step], { env, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`sample check failed at "${step[0]}": ${r.stdout}${r.stderr}`);
    code = 1;
    break;
  }
  last = r.stdout;
}
if (code === 0) console.log(`sample check ok. Workbook: ${JSON.parse(last).workbook}`);
rmSync(home, { recursive: true, force: true });
process.exit(code);
