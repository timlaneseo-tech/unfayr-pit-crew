// Pit Crew benchmark: Pit Crew vs plain Claude on the same page extracts, scored by Pit Crew's own lint.
//
//   node evals/run.ts                  run the ridgeline fixture (12 pages), write evals/benchmarks/2026-10-pitcrew-v1.md
//   node evals/run.ts --site example.com --answers answers.json
//                                      also run one real site (its first 25 pages). answers.json is an interview file
//                                      shaped like fixtures/<site>/answers.json. The site is only read, never changed.
//   node evals/run.ts --dry            set up and print the two prompts, run nothing
//
// Both arms run `claude -p` headless with no tools, in an empty temp folder, with only project and local settings.
// Each arm gets one run. The raw replies and scores are saved next to the report as 2026-10-pitcrew-v1.raw.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagBool, flagString, parseArgs } from '../scripts/lib/args.ts';
import { patternRegex } from '../scripts/lib/conventions.ts';
import { mergeBatches } from '../scripts/lib/store.ts';
import type { Interview, PageRecord, Proposal } from '../scripts/lib/types.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_FILE = join(ROOT, 'evals', 'benchmarks', '2026-10-pitcrew-v1.md');
const CLI = join(ROOT, 'scripts', 'pitcrew.ts');
const DATE = '2026-01-01';

export interface Metrics {
  rows: number; expected: number;
  unsourcedRows: number; unsourcedIssues: number;
  lengthRows: number; duplicateRows: number;
  conventionMatched: number; conventionTotal: number;
  slotRows: number; inventedWithoutSlot: number;
  needsReview: number; noPatternTypes: string[];
}

const has = (p: Proposal, ...rules: string[]) => p.issues.some((i) => rules.includes(i.rule));

/** Score linted proposals. Convention match looks at the title the page would have after the run (new, or current when kept). */
export function score(proposals: Proposal[], interview: Interview, expected: number): Metrics {
  const m: Metrics = {
    rows: proposals.length, expected, unsourcedRows: 0, unsourcedIssues: 0, lengthRows: 0, duplicateRows: 0,
    conventionMatched: 0, conventionTotal: 0, slotRows: 0, inventedWithoutSlot: 0, needsReview: 0, noPatternTypes: [],
  };
  for (const p of proposals) {
    const unsourced = p.issues.filter((i) => i.rule === 'unsourced-number' || i.rule === 'unsourced-claim');
    if (unsourced.length) { m.unsourcedRows++; m.unsourcedIssues += unsourced.length; }
    if (has(p, 'title-length', 'meta-length')) m.lengthRows++;
    if (has(p, 'duplicate')) m.duplicateRows++;
    if (has(p, 'add-slot')) m.slotRows++;
    if (unsourced.length && !has(p, 'add-slot')) m.inventedWithoutSlot++;
    if (p.status === 'needs review') m.needsReview++;
    const re = patternRegex(interview.convention, p.type);
    const title = p.proposed.title ?? p.current.title;
    if (re) {
      m.conventionTotal++;
      if (title && re.test(title)) m.conventionMatched++;
    } else if (!m.noPatternTypes.includes(p.type)) m.noPatternTypes.push(p.type);
  }
  return m;
}

/** Pull the JSON array out of a model reply, tolerating a code fence or a sentence around it. */
export function extractJsonArray(text: string): unknown[] {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('No JSON array found in the reply.');
  const v = JSON.parse(text.slice(a, b + 1)) as unknown;
  if (!Array.isArray(v)) throw new Error('The reply is not a JSON array.');
  return v;
}

function cli(args: string[], env: NodeJS.ProcessEnv): unknown {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pitcrew ${args[0]} failed: ${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout);
}

interface ClaudeRun { text: string; model: string; seconds: number; costUsd: number | null }

/**
 * Work out which program runs `claude`. On Windows the npm shim is a .cmd file that cannot be spawned without a shell,
 * so the native claude.exe beside it is used. If it cannot be found this throws: there is no shell fallback,
 * because cmd drops the empty --tools argument and swallows the next flag.
 */
export function resolveClaude(platform: string, whereOutput: string, exists: (file: string) => boolean): string {
  if (platform !== 'win32') return 'claude';
  const cmd = whereOutput.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('.cmd'));
  if (cmd) {
    const exe = win32.join(win32.dirname(cmd), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (exists(exe)) return exe;
  }
  throw new Error('Could not find the native claude.exe next to the claude.cmd that npm installed. Reinstall Claude Code, or run this benchmark on macOS or Linux.');
}

function claudeCommand(): string {
  const where = process.platform === 'win32' ? (spawnSync('where', ['claude.cmd'], { encoding: 'utf8' }).stdout ?? '') : '';
  return resolveClaude(process.platform, where, existsSync);
}

function runClaude(prompt: string, model: string): ClaudeRun {
  const cwd = mkdtempSync(join(tmpdir(), 'pitcrew-bench-cwd-'));
  const t0 = Date.now();
  try {
    const bin = claudeCommand();
    const r = spawnSync(bin, [
      '-p', '--model', model, '--output-format', 'json', '--tools', '', '--setting-sources', 'project,local',
      '--strict-mcp-config', '--no-session-persistence',
    ], { cwd, input: prompt, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
    const seconds = Math.round((Date.now() - t0) / 1000);
    if (r.error) throw new Error(`claude could not run: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`claude exited with ${r.status}: ${(r.stderr || r.stdout).slice(0, 500)}`);
    const j = JSON.parse(r.stdout) as { result?: string; is_error?: boolean; total_cost_usd?: number; modelUsage?: Record<string, unknown> };
    if (j.is_error || typeof j.result !== 'string') throw new Error(`claude returned an error: ${String(j.result).slice(0, 500)}`);
    return { text: j.result, model: Object.keys(j.modelUsage ?? {}).join(', ') || model, seconds, costUsd: j.total_cost_usd ?? null };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function skillBody(): string {
  const raw = readFileSync(join(ROOT, 'skills', 'write-page', 'SKILL.md'), 'utf8');
  return raw.replace(/^---[\s\S]*?\n---\n/, '').trim();
}

const OUTPUT_NOTE = 'Reply with the JSON array only, as your whole reply: no file writes, no commentary, no code fence.';

export function pitcrewPrompt(batch: { pages: PageRecord[]; interview: Interview }): string {
  return [
    'You are the Pit Crew page writer. Follow these instructions exactly.',
    '', skillBody(), '',
    'There are no files in this run. The batch file content is below. Instead of writing batches/NN.out.json, reply with the contents of that file.',
    OUTPUT_NOTE, '',
    'BATCH FILE:', JSON.stringify(batch),
  ].join('\n');
}

export function plainPrompt(pages: PageRecord[]): string {
  return [
    'Rewrite the titles, metas and H1s for these pages.',
    'Here are the pages as JSON.',
    `Reply as a JSON array with one object per page: {"url", "title", "meta", "h1"}. ${OUTPUT_NOTE}`, '',
    JSON.stringify(pages),
  ].join('\n');
}

interface ArmResult { name: string; metrics?: Metrics; error?: string; run?: ClaudeRun }
const RAW: unknown[] = [];

function scoreArm(name: string, prompt: string, model: string, run: string, interview: Interview, expected: number): ArmResult {
  const outFile = join(run, 'batches', '01.out.json');
  try {
    const r = runClaude(prompt, model);
    writeFileSync(outFile, JSON.stringify(extractJsonArray(r.text)), 'utf8');
    const { proposals } = mergeBatches(run);
    const metrics = score(proposals, interview, expected);
    RAW.push({ arm: name, model: r.model, seconds: r.seconds, costUsd: r.costUsd, reply: r.text, metrics });
    return { name, metrics, run: r };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    RAW.push({ arm: name, error });
    return { name, error };
  } finally {
    rmSync(outFile, { force: true });
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((a / b) * 1000) / 10}%)` : 'n/a');

function table(a: ArmResult, b: ArmResult): string {
  const cell = (r: ArmResult, f: (m: Metrics) => string) => (r.metrics ? f(r.metrics) : 'run failed');
  const rows: [string, (m: Metrics) => string][] = [
    ['Pages covered', (m) => `${m.rows}/${m.expected}`],
    ['Rows with an unsourced number or claim', (m) => `${m.unsourcedRows}/${m.rows} (issues: ${m.unsourcedIssues})`],
    ['Rows with a title or meta length failure', (m) => `${m.lengthRows}/${m.rows}`],
    ['Rows with a duplicate title or meta', (m) => `${m.duplicateRows}/${m.rows}`],
    ['Convention match (title after the run)', (m) => pct(m.conventionMatched, m.conventionTotal)],
    ['Rows using an [ADD] slot for a missing fact', (m) => `${m.slotRows}/${m.rows}`],
    ['Rows with an invented fact and no [ADD] slot', (m) => `${m.inventedWithoutSlot}/${m.rows}`],
    ['Rows Pit Crew would mark needs review', (m) => `${m.needsReview}/${m.rows}`],
  ];
  return ['| Metric | Pit Crew | Plain Claude |', '|---|---|---|', ...rows.map(([k, f]) => `| ${k} | ${cell(a, f)} | ${cell(b, f)} |`)].join('\n');
}

function claim(pages: number, a: ArmResult, b: ArmResult): string {
  if (!a.metrics || !b.metrics) return 'No claim: at least one arm did not produce a scorable result (see the failure noted below).';
  const A = a.metrics;
  const B = b.metrics;
  return `In one fixture site of ${pages} pages (one run each, scored by Pit Crew's own lint), Pit Crew's rewrites had unsourced numbers or claims in ${plural(A.unsourcedRows, 'row', 'rows')}, length failures in ${A.lengthRows} and duplicates in ${A.duplicateRows}, and ${pct(A.conventionMatched, A.conventionTotal)} of titles matched the naming convention, against ${B.unsourcedRows}, ${B.lengthRows}, ${B.duplicateRows} and ${pct(B.conventionMatched, B.conventionTotal)} for plain Claude.`;
}

interface Target { id: string; site: string; kind: 'fixture' | 'site'; answers: string }

function runTarget(t: Target, model: string, home: string, env: NodeJS.ProcessEnv, dry: boolean): { section: string[]; headline: string } {
  if (t.kind === 'fixture') cli(['crawl', '--sample', t.site, '--date', DATE], env);
  else cli(['crawl', '--site', t.site, '--date', DATE], env);
  cli(['interview-save', '--site', t.site, '--file', t.answers], env);
  cli(['top', '--site', t.site, '--date', DATE], env);
  cli(['batches', '--site', t.site, '--date', DATE], env);
  const run = join(home, 'sites', t.site, 'runs', DATE);
  const batch = JSON.parse(readFileSync(join(run, 'batches', '01.json'), 'utf8')) as { pages: PageRecord[]; interview: Interview };
  if (dry) {
    console.log(pitcrewPrompt(batch));
    console.log('\n=====\n');
    console.log(plainPrompt(batch.pages));
    return { section: [], headline: '' };
  }
  const n = batch.pages.length;
  console.error(`${t.id}: ${n} pages. Running the Pit Crew arm...`);
  const a = scoreArm('Pit Crew', pitcrewPrompt(batch), model, run, batch.interview, n);
  console.error(a.error ? `  failed: ${a.error}` : `  done in ${a.run!.seconds}s. Running the plain Claude arm...`);
  const b = scoreArm('Plain Claude', plainPrompt(batch.pages), model, run, batch.interview, n);
  console.error(b.error ? `  failed: ${b.error}` : `  done in ${b.run!.seconds}s.`);
  const noPattern = a.metrics && a.metrics.conventionTotal < n ? ` Convention match is out of ${a.metrics.conventionTotal} because ${plural(n - a.metrics.conventionTotal, 'page is', 'pages are')} of a type with no pattern in the naming convention (${a.metrics.noPatternTypes.join(', ')}).` : '';
  const section = [`## ${t.kind === 'fixture' ? 'Fixture' : 'Real site'}: ${t.id} (${t.site}, ${n} pages)`, '', table(a, b), '', `Counts are rows (pages) unless stated.${noPattern}${a.metrics && b.metrics && a.metrics.slotRows + b.metrics.slotRows === 0 ? ' No row in either arm used an [ADD] slot, so the [ADD] rows say nothing about slot honesty here.' : ''}`, ''];
  for (const r of [a, b]) {
    section.push(r.error ? `- ${r.name}: FAILED. ${r.error}` : `- ${r.name}: model ${r.run!.model}, ${r.run!.seconds} s${r.run!.costUsd != null ? `, reported cost $${r.run!.costUsd.toFixed(2)}` : ''}.`);
  }
  section.push('');
  return { section, headline: claim(n, a, b) };
}

export interface ReportInput {
  headline: string; sections: string[]; model: string; noSlots: boolean; realSite: boolean;
  /** M13: the commit of skills/write-page/SKILL.md the Pit Crew arm read, and whether the file had uncommitted edits. */
  skillCommit?: string; skillDirty?: boolean;
}

/** The last commit that touched the write-page skill, and whether the working copy differs from it. */
function skillVersion(): { skillCommit?: string; skillDirty?: boolean } {
  const git = (...a: string[]) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
  const c = git('log', '-1', '--format=%h', '--', 'skills/write-page/SKILL.md').stdout?.trim();
  if (!c) return {};
  const dirty = (git('status', '--porcelain', '--', 'skills/write-page/SKILL.md').stdout ?? '').trim() !== '';
  return { skillCommit: c, skillDirty: dirty };
}

export function renderReport(r: ReportInput): string {
  return [
    '# Pit Crew v1 benchmark: Pit Crew vs plain Claude',
    '',
    'Date: 2026-10-09 · Runner: `evals/run.ts` · Scenarios: `evals/scenarios.json`',
    ...(r.skillCommit ? ['', `The Pit Crew arm read the write-page skill at commit \`${r.skillCommit}\`${r.skillDirty ? ' plus uncommitted edits' : ''}.`] : []),
    '',
    '## Headline',
    '',
    `**${r.headline}**`,
    '',
    "Quote only that sentence, with its qualifier. The convention, sources and length checks are Pit Crew's own rules, so this measures how well each arm follows Pit Crew's way of writing, not general quality.",
    '',
    ...r.sections,
    '## Method',
    '',
    `- Both arms: \`claude -p --model ${r.model} --output-format json --tools "" --setting-sources project,local --strict-mcp-config --no-session-persistence\`, prompt on stdin, run in an empty temp folder. No tools, no skills, no MCP servers, so each arm answers from the prompt alone.`,
    '- Pit Crew arm: the `write-page` skill instructions, then the batch file (the page extracts plus the interview) and the instruction to reply with the contents of the output file.',
    '- Plain arm: "Rewrite the titles, metas and H1s for these pages." and the same page extracts as JSON. It does not get the interview.',
    '- Scoring: each reply is parsed as a JSON array, merged and linted by `mergeBatches` (the code the product runs, which also decodes entities and treats a value equal to the current one as "keep"), then counted by `evals/run.ts`. Convention match uses the title the page would have after the run, so a kept title that does not follow the pattern counts as a miss. A row with an invented fact and no [ADD] slot is a row with an unsourced number or claim and no slot.',
    '',
    '## Caveats',
    '',
    '- One run per arm, so the numbers move from run to run.',
    '- The site is a fictional fixture built alongside Pit Crew, with long titles and shared metas on purpose.',
    "- The lint is Pit Crew's own and Pit Crew's instructions encode it, so Pit Crew is expected to do well on it. The plain arm was not told the rules.",
    '- The plain arm was not given the interview, which is part of the product. The lint still accepts facts found in the interview answers.',
    '- Convention match is only counted for page types that have a pattern in the naming convention.',
    ...(r.noSlots ? ['- No row in either arm used an [ADD] slot, so this benchmark does not test slot honesty.'] : []),
    ...(r.realSite ? [] : ['- No real-site arm is part of this result.']),
    '',
    'Built by Unfayr · unfayr.com',
    '',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dry = flagBool(args, 'dry');
  const cfg = JSON.parse(readFileSync(join(ROOT, 'evals', 'scenarios.json'), 'utf8')) as { model: string; scenarios: { id: string; site: string }[] };
  const model = flagString(args, 'model') ?? cfg.model;
  const targets: Target[] = cfg.scenarios.map((s) => ({ id: s.id, site: s.site, kind: 'fixture', answers: join(ROOT, 'fixtures', s.site, 'answers.json') }));
  const realSite = flagString(args, 'site');
  if (realSite) {
    const answers = flagString(args, 'answers');
    if (!answers) throw new Error('--site needs --answers <interview file>.');
    targets.push({ id: 'real', site: realSite, kind: 'site', answers });
  }
  const home = mkdtempSync(join(tmpdir(), 'pitcrew-bench-'));
  const env = { ...process.env, PITCREW_HOME: home, PITCREW_NO_OPEN: '1' };
  const sections: string[] = [];
  let headline = '';
  try {
    for (const t of targets) {
      const r = runTarget(t, model, home, env, dry);
      sections.push(...r.section);
      if (t.kind === 'fixture' && !headline) headline = r.headline;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  if (dry) return;

  const noSlots = RAW.every((r) => { const m = (r as { metrics?: Metrics }).metrics; return !m || m.slotRows === 0; });
  const md = renderReport({ headline, sections, model, noSlots, realSite: !!realSite, ...skillVersion() });
  mkdirSync(join(ROOT, 'evals', 'benchmarks'), { recursive: true });
  writeFileSync(OUT_FILE, md, 'utf8');
  writeFileSync(OUT_FILE.replace(/\.md$/, '.raw.json'), JSON.stringify(RAW, null, 2), 'utf8');
  console.log(`Wrote ${OUT_FILE}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
