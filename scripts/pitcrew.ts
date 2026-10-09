import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { flagBool, flagString, parseArgs, parseSections, type ParsedArgs } from './lib/args.ts';
import { capFromEnv, crawl, crawlBlockedMessage, networkFetcher, sampleFetcher, truncationMessage } from './lib/crawl.ts';
import { extractPage, linkGraph } from './lib/extract.ts';
import { detectPlatform } from './lib/platform.ts';
import { readout } from './lib/readout.ts';
import { analyseTitles, candidateConventions, guessBrand } from './lib/conventions.ts';
import { selectTop } from './lib/select-top.ts';
import { lintAll } from './lib/lint.ts';
import {
  publishablePages, makeBatches, mergeBatches, readInterview, readPages, readProposals,
  writeInterview, writePages, writeProposals,
} from './lib/store.ts';
import { readApprovals, writeWorkbook } from './lib/workbook.ts';
import { markHandoff, writeHandoff } from './lib/handoff.ts';
import type { ChangeStatus } from './lib/handoff.ts';
import { getCredential, jsonErrorAt, setCredential } from './lib/credentials.ts';
import { configDir, runDir, siteDir } from './lib/paths.ts';
import { hostOf, normaliseUrl } from './lib/urls.ts';
import { openCommand } from './lib/open.ts';
import { fetchHtml } from './lib/fetch.ts';
import type { Convention, Field, Interview, PageRecord, PageType, Platform, Proposal } from './lib/types.ts';
import { redact, heldBack, noAccessBlocker, noAccessWarnings, publishable, publishDelayMs, applyChanges, planChanges, readBackup, readPlan, rollback, snapshot, verifyLive, writePlan } from './lib/publish/common.ts';
import type { Adapter } from './lib/publish/common.ts';
import { shopifyAdapter } from './lib/publish/shopify.ts';
import { wordpressAdapter, wordpressCsv } from './lib/publish/wordpress.ts';
import { webflowAdapter } from './lib/publish/webflow.ts';
import { gitAdapter } from './lib/publish/git.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** A failure with a plain-English message; the CLI prints it as {"error": ...}. */
class CliError extends Error {}
const fail = (msg: string): never => { throw new CliError(msg); };

const PLATFORMS = ['shopify', 'wordpress', 'webflow', 'git'];
const FIELDS: Field[] = ['title', 'meta', 'h1'];
const STATUSES: ChangeStatus[] = ['proposed', 'approved', 'published', 'verified', 'rolled-back'];

function need(args: ParsedArgs, name: string): string {
  return flagString(args, name) ?? fail(`Missing --${name}.`);
}

function siteHost(args: ParsedArgs): string {
  const site = flagString(args, 'site') ?? flagString(args, 'sample');
  if (!site) return fail('Missing --site (a host such as example.com, or a full URL).');
  const host = hostOf(site.includes('://') ? site : `https://${site}`);
  return host || fail(`Cannot work out a host from "${site}".`);
}

const today = () => new Date().toISOString().slice(0, 10);

function latestDate(host: string): string | null {
  const dir = join(siteDir(host), 'runs');
  if (!existsSync(dir)) return null;
  const dates = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  return dates.length ? dates[dates.length - 1]! : null;
}

function ctx(args: ParsedArgs): { host: string; date: string; run: string } {
  const host = siteHost(args);
  const date = flagString(args, 'date') ?? latestDate(host) ?? fail(`No Pit Crew run found for ${host}. Run the crawl first.`);
  const run = runDir(host, date);
  if (!existsSync(run)) fail(`No run for ${host} on ${date}. Run the crawl first.`);
  return { host, date, run };
}

function readJsonFile<T>(file: string, what: string): T {
  if (!existsSync(file)) return fail(`Cannot find ${what}: ${file}`);
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fail(`${what} is not valid JSON: ${file}`); }
}

function pagesOf(run: string): PageRecord[] {
  const pages = [...readPages(run).values()];
  if (!pages.length) fail(`No pages saved for this run (${run}). Run the crawl first.`);
  return pages;
}

function interviewOf(host: string): Interview {
  return readInterview(host) ?? fail(`No interview saved for ${host}. Save the interview first (interview-save).`);
}

const workbookFile = (run: string, host: string, date: string) => join(run, `Pit Crew - ${host} - ${date}.xlsx`);

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------- crawl

async function cmdCrawl(args: ParsedArgs) {
  const sample = flagString(args, 'sample');
  let fetcher = networkFetcher;
  let origin: string;
  if (sample) {
    if (!existsSync(join(FIXTURES, sample))) fail(`There is no sample site called "${sample}" in fixtures/.`);
    fetcher = sampleFetcher(sample);
    origin = `https://${sample}`;
  } else {
    const site = flagString(args, 'site') ?? fail('Missing --site (the site address, such as https://example.com).');
    try { origin = new URL(site.includes('://') ? site : `https://${site}`).origin; } catch { return fail(`"${site}" is not a web address.`); }
  }
  const host = hostOf(origin);
  const date = flagString(args, 'date') ?? today();
  // Sections may be given with or without slashes; parseSections also undoes Git Bash's rewrite of /collections/ into a Windows path.
  const includeRaw = flagString(args, 'include');
  const include = includeRaw !== undefined ? parseSections(includeRaw) : undefined;
  // PITCREW_CAP is a test-only override that can lower the 1,000 page cap (clamped to 1..1,000 in capFromEnv).
  const cap = capFromEnv(process.env.PITCREW_CAP);
  const result = await crawl(origin, { fetcher, include: include?.length ? include : undefined, ...(cap !== undefined ? { cap } : {}) });
  if (result.robotsUnreachable) fail(`Couldn't read robots.txt (${result.robotsProblem ?? 'no answer'}) after 3 tries, so Pit Crew didn't crawl. Try again in a few minutes.`);
  const dropped = countBy(result.dropped, (d) => d.reason);
  if (result.capped && !include?.length) {
    return { host, date, capped: true, source: result.source, sections: result.sections, dropped, message: 'This site is larger than the 1,000 page cap. Choose which sections to include and run the crawl again with --include.' };
  }
  const empty = result.emptySections ?? [];
  if (result.pages.length === 0 && empty.length && empty.length === include?.length) {
    fail(`None of the --include sections (${empty.join(', ')}) matched a page on ${host}. Check the names against the sections the first crawl listed, and pass them without slashes, for example --include collections,pages.`);
  }
  if (result.pages.length === 0) {
    const blocked = crawlBlockedMessage(result.dropped, host);
    if (blocked) fail(blocked);
    const why = Object.entries(dropped).map(([r, n]) => `${n} ${r}`).join(', ');
    fail(`Pit Crew found no pages Pit Crew can read on ${host}${why ? ` (skipped: ${why})` : ''}. Check that the address is right, the site is public, and its pages are not set to noindex.`);
  }
  const links = linkGraph(result.pages);
  const pages = result.pages.map((p) => extractPage(p.url, p.html, links));
  const home = result.pages.find((p) => normaliseUrl(p.url) === normaliseUrl(`${origin}/`)) ?? result.pages[0]!;
  // M8: response headers (x-shopify-*, x-pingback ...) count too, not just the HTML.
  const platform = detectPlatform(home.html, home.headers ?? {});
  const run = runDir(host, date);
  mkdirSync(run, { recursive: true });
  // I5: a same-day re-crawl that finds different pages makes the later steps stale, so they are cleared.
  const cleared: string[] = [];
  const pagesFile = join(run, 'pages.json');
  if (existsSync(pagesFile) && readFileSync(pagesFile, 'utf8') !== JSON.stringify(pages, null, 2)) {
    for (const f of ['top.json', 'batches', 'proposals.json']) {
      if (existsSync(join(run, f))) { rmSync(join(run, f), { recursive: true, force: true }); cleared.push(f); }
    }
  }
  writePages(run, pages);
  const truncated = include?.length && result.capped
    ? { truncatedTo: pages.length, message: result.selected !== undefined ? truncationMessage(pages.length, result.selected, include) : `Kept the first ${pages.length.toLocaleString('en-US')} pages in ${include.join(', ')}; there are more.` }
    : {};
  writeFileSync(join(run, 'crawl.json'), JSON.stringify({
    origin, host, date, platform, source: result.source, capped: result.capped, sections: result.sections, dropped: result.dropped,
  }, null, 2), 'utf8');
  return {
    host, date, run, platform, source: result.source, capped: result.capped, sections: result.sections,
    readout: readout(pages), dropped, droppedUrls: result.dropped, ...truncated, ...(cleared.length ? { cleared } : {}),
    ...(empty.length ? { warnings: [`No page matched --include section${empty.length === 1 ? '' : 's'} ${empty.join(', ')}, so ${empty.length === 1 ? 'it was' : 'they were'} left out. Check the name${empty.length === 1 ? '' : 's'}, and pass sections without slashes, for example --include collections,pages.`] } : {}),
  };
}

// ---------------------------------------------------------------- status

/** I5: how far a run got, so a resumed run starts from the right step instead of crawling again. */
function cmdStatus(args: ParsedArgs) {
  const host = siteHost(args);
  const date = flagString(args, 'date') ?? latestDate(host);
  const run = date ? runDir(host, date) : null;
  if (!date || !run || !existsSync(join(run, 'pages.json'))) {
    return { host, date, stage: 'none', next: `Crawl the site: crawl --site ${host}.` };
  }
  const has = (f: string) => existsSync(join(run, f));
  const bdir = join(run, 'batches');
  const files = existsSync(bdir) ? readdirSync(bdir) : [];
  const ids = files.filter((f) => /^\d+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
  const done = ids.filter((id) => files.includes(`${id}.out.json`));
  const batches = { total: ids.length, done: done.length, pending: ids.filter((id) => !done.includes(id)) };
  let published = false;
  if (has('publish-log.json')) {
    try {
      const j = JSON.parse(readFileSync(join(run, 'publish-log.json'), 'utf8'));
      const entries: any[] = Array.isArray(j) ? j : Array.isArray(j?.entries) ? j.entries : [];
      published = entries.some((e) => e && e.ok === true && e.action === 'apply');
    } catch { /* treat as not published */ }
  }
  const steps: [boolean, string, string][] = [
    [true, 'crawled', 'Run the interview (or confirm the saved one), then interview-save.'],
    [!!readInterview(host), 'interviewed', 'Pick the top pages with top, then research them.'],
    [has('top.json'), 'top', 'Run batches and write the pending batches.'],
    [ids.length > 0, `batches pending ${batches.pending.length}`, batches.pending.length ? 'Write the pending batches, then run merge.' : 'Every batch is written. Run merge.'],
    [has('proposals.json'), 'merged', 'Build the workbook with workbook.'],
    [has(`Pit Crew - ${host} - ${date}.xlsx`), 'workbook', 'Wait for the owner to approve rows, then read them with approvals and offer to publish.'],
    [published, 'published', 'Published. Offer the rollback command if they need it.'],
  ];
  let stage = 'crawled';
  let next = steps[0]![2];
  for (const [ok, name, hint] of steps) {
    if (!ok) break;
    stage = name; next = hint;
  }
  return { host, date, run, stage, next, batches };
}

// ---------------------------------------------------------------- analysis

function cmdConventions(args: ParsedArgs) {
  const { host, run } = ctx(args);
  const pages = pagesOf(run);
  const brand = flagString(args, 'brand') ?? readInterview(host)?.brand ?? guessBrand(host, pages);
  const analysis = analyseTitles(pages, brand);
  const types = [...new Set(pages.map((p) => p.type))];
  return { host, brand, analysis, candidates: candidateConventions(analysis, brand, types) };
}

function cmdTop(args: ParsedArgs) {
  const { host, run } = ctx(args);
  const pages = pagesOf(run);
  let clicks: Map<string, number> | undefined;
  const cf = flagString(args, 'clicks');
  if (cf) {
    const raw = readJsonFile<unknown>(cf, 'the clicks file');
    clicks = new Map();
    if (Array.isArray(raw)) {
      for (const r of raw as { url?: string; clicks?: number }[]) if (r && typeof r.url === 'string') clicks.set(r.url, Number(r.clicks) || 0);
    } else if (raw && typeof raw === 'object') {
      for (const [u, n] of Object.entries(raw)) clicks.set(u, Number(n) || 0);
    } else fail('The clicks file must be an object of url to clicks, or a list of {url, clicks}.');
  }
  const top = selectTop(pages, clicks, 25, readInterview(host));
  writeFileSync(join(run, 'top.json'), JSON.stringify(top, null, 2), 'utf8');
  return { run, count: top.length, top, usedClicks: !!clicks };
}

function cmdBatches(args: ParsedArgs) {
  const { run } = ctx(args);
  const pages = pagesOf(run);
  const topFile = join(run, 'top.json');
  let top: string[];
  if (existsSync(topFile)) top = readJsonFile<string[]>(topFile, 'top.json');
  else {
    top = selectTop(pages);
    writeFileSync(topFile, JSON.stringify(top, null, 2), 'utf8');
  }
  const topSet = new Set(top.map(normaliseUrl));
  const ordered = [...top, ...pages.map((p) => p.url).filter((u) => !topSet.has(normaliseUrl(u)))];
  const skipped: string[] = [];
  const pending = makeBatches(run, ordered, 25, skipped);
  return {
    run, total: new Set(ordered.map(normaliseUrl)).size - skipped.length,
    pending: pending.map((id) => ({ id, file: join(run, 'batches', `${id}.json`), out: join(run, 'batches', `${id}.out.json`) })),
    skipped,
  };
}

function cmdMerge(args: ParsedArgs) {
  const { host, run } = ctx(args);
  interviewOf(host);
  const copied: string[] = [];
  if (flagBool(args, 'sample-outs')) {
    const src = join(FIXTURES, host, 'proposals.out');
    if (!existsSync(src)) fail(`There are no canned writer outputs for ${host} (expected ${src}).`);
    mkdirSync(join(run, 'batches'), { recursive: true });
    for (const f of readdirSync(src).filter((n) => /^\d+\.out\.json$/.test(n))) {
      copyFileSync(join(src, f), join(run, 'batches', f));
      copied.push(f);
    }
  }
  const { proposals, missing, duplicates, unknown } = mergeBatches(run);
  const counts = countBy(proposals, (p) => p.status);
  const pages = readPages(run);
  const retry = new Set<string>(proposals.filter((p) => p.status === 'needs review').map((p) => p.url));
  for (const id of missing) {
    const b = readJsonFile<{ pages: PageRecord[] }>(join(run, 'batches', `${id}.json`), `batch ${id}`);
    for (const p of b.pages) retry.add(p.url);
  }
  const covered = new Set(proposals.map((p) => normaliseUrl(p.url)));
  const uncovered = [...pages.keys()].filter((u) => !covered.has(normaliseUrl(u)) && !retry.has(u));
  return {
    run, proposals: proposals.length, counts, retry: [...retry], missingBatches: missing, duplicates, unknown,
    pagesWithoutProposal: uncovered, copiedSampleOuts: copied,
  };
}

// ---------------------------------------------------------------- workbook

function openFile(file: string): void {
  if (flagBoolEnv()) return;
  try {
    const { cmd, args } = openCommand(file);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* opening is a convenience */ });
    child.unref();
  } catch { /* ignore */ }
}
const flagBoolEnv = () => process.env.PITCREW_NO_OPEN === '1';

async function cmdWorkbook(args: ParsedArgs) {
  const { host, date, run } = ctx(args);
  const pages = pagesOf(run);
  const proposals = readProposals(run);
  if (!proposals.length) fail('There are no proposals yet. Run merge first.');
  const interview = interviewOf(host);
  const file = workbookFile(run, host, date);
  await writeWorkbook(file, {
    host, date, readoutBefore: readout(pages), readoutAfter: readout(publishablePages(pages, proposals)), interview, proposals,
    ogTitleDiffers: pages.filter((p) => p.ogTitle != null && p.title != null && p.ogTitle !== p.title).length,
  });
  writeHandoff(run, host, date, proposals);
  const opened = !flagBool(args, 'no-open') && !flagBoolEnv();
  if (opened) openFile(file);
  return { workbook: file, onpage: join(run, 'onpage.json'), proposals: proposals.length, opened };
}

async function cmdApprovals(args: ParsedArgs) {
  const { host, date, run } = ctx(args);
  const file = flagString(args, 'file') ?? workbookFile(run, host, date);
  if (!existsSync(file)) fail(`Cannot find the workbook: ${file}`);
  const current = readProposals(run);
  if (!current.length) fail('There are no proposals to read approvals against. Run merge first.');
  const read = await readApprovals(file, current);
  const pages = readPages(run);
  const linted = lintAll(read.proposals, pages, interviewOf(host));
  writeProposals(run, linted);
  writeHandoff(run, host, date, linted);
  return {
    run, workbook: file, proposals: linted.length,
    approved: linted.filter((p) => p.approve === true).length,
    rejected: linted.filter((p) => p.approve === false).length,
    undecided: linted.filter((p) => p.approve === null).length,
    approvedNeedingReview: linted.filter((p) => p.approve === true && p.status !== 'ok').map((p) => p.url),
    unknownUrls: read.unknownUrls, duplicateUrls: read.duplicateUrls,
  };
}

// ---------------------------------------------------------------- interview and credentials

const SEPARATORS = ['|', '–', ':'];
const PAGE_TYPES: PageType[] = ['home', 'service', 'location', 'product', 'collection', 'article', 'other'];
function cmdInterviewSave(args: ParsedArgs) {
  const host = siteHost(args);
  const file = need(args, 'file');
  const raw = readJsonFile<Record<string, any>>(file, 'the interview file');
  const bad = (m: string): never => fail(`The interview file is not valid: ${m}`);
  if (!raw || typeof raw !== 'object') bad('it must be a JSON object.');
  if (typeof raw.brand !== 'string' || !raw.brand.trim()) bad('"brand" must be a non-empty string.');
  if (!Array.isArray(raw.answers)) bad('"answers" must be a list.');
  for (const a of raw.answers) {
    if (!a || typeof a.id !== 'string' || typeof a.question !== 'string' || !(typeof a.answer === 'string' || a.answer === null)) {
      bad('each answer needs "id", "question" and "answer" (text or null).');
    }
    if (a.appliesTo !== undefined && (!Array.isArray(a.appliesTo) || !a.appliesTo.length || a.appliesTo.some((t: unknown) => !PAGE_TYPES.includes(t as PageType)))) {
      bad(`answer "${a.id}": appliesTo must be a list of page types (${PAGE_TYPES.join(', ')}).`);
    }
  }
  const c = raw.convention as Convention | undefined;
  if (!c || typeof c !== 'object') bad('"convention" is missing.');
  if (!SEPARATORS.includes(c!.separator)) bad('convention.separator must be "|", "–" or ":".');
  if (typeof c!.brand !== 'string') bad('convention.brand must be text.');
  if (c!.brandPosition !== 'end' && c!.brandPosition !== 'end-if-fits') bad('convention.brandPosition must be "end" or "end-if-fits".');
  if (c!.case !== 'title' && c!.case !== 'sentence') bad('convention.case must be "title" or "sentence".');
  if (!c!.patterns || typeof c!.patterns !== 'object' || Array.isArray(c!.patterns)) bad('convention.patterns must be an object of page type to pattern.');
  for (const v of Object.values(c!.patterns)) if (typeof v !== 'string') bad('every convention pattern must be text.');
  const interview: Interview = {
    brand: raw.brand.trim(),
    answers: raw.answers.map((a: any) => ({ id: a.id, question: a.question, answer: a.answer, ...(a.appliesTo ? { appliesTo: [...a.appliesTo] } : {}) })),
    convention: { separator: c!.separator, brand: c!.brand, brandPosition: c!.brandPosition, case: c!.case, patterns: c!.patterns },
    updatedAt: new Date().toISOString(),
  };
  writeInterview(host, interview);
  return { host, saved: join(siteDir(host), 'interview.json'), brand: interview.brand, answers: interview.answers.length };
}

function platformArg(args: ParsedArgs, run?: string): string {
  let p = flagString(args, 'platform');
  if (!p && run && existsSync(join(run, 'crawl.json'))) {
    const c = readJsonFile<{ platform?: string }>(join(run, 'crawl.json'), 'crawl.json');
    if (c.platform && c.platform !== 'unknown') p = c.platform;
  }
  if (!p) return fail('Missing --platform (shopify, wordpress, webflow or git).');
  if (!PLATFORMS.includes(p)) fail(`Pit Crew cannot publish to "${p}" directly. Use shopify, wordpress, webflow or git (or the CSV export).`);
  return p;
}

/** M11: true when the file sits in the system temp folder or the Pit Crew config folder's tmp folder (where the skill makes it). */
function inTempFolder(file: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolvePath(p); } };
  const f = real(file);
  return [tmpdir(), join(configDir(), 'tmp')].some((dir) => {
    const rel = relative(real(dir), f);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
}

function cmdCredentialsSave(args: ParsedArgs) {
  const file = need(args, 'file');
  // Only a temp file the skill created is deleted; a file anywhere else is the user's, and stays.
  let remove = inTempFolder(file);
  try {
    const host = siteHost(args);
    const platform = platformArg(args);
    if (!existsSync(file)) fail(`Cannot find the credentials file: ${file}`);
    const text = readFileSync(file, 'utf8');
    const at = jsonErrorAt(text);
    if (at) {
      // Keep the file so they can fix the typo; the message never quotes its contents.
      remove = false;
      fail(`The credentials file is not valid JSON: the problem is on line ${at.line}, character ${at.char} (often a missing comma or quote just before it). Fix it in ${file}, save it, and say done.`);
    }
    const value = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('The credentials file must be a JSON object.');
    setCredential(host, platform as Platform, value as object);
    return { host, platform, saved: true, deleted: remove };
  } finally {
    if (remove) { try { unlinkSync(file); } catch { /* already gone */ } }
  }
}

// ---------------------------------------------------------------- publishing

/** Which account/repo a credential points at (no secrets). Saved with the plan so apply and rollback hit the same target. */
function targetOf(host: string, platform: string): string {
  const cred = getCredential<Record<string, any>>(host, platform as Platform) ?? {};
  const v = platform === 'shopify' ? cred.shop : platform === 'wordpress' ? cred.base : platform === 'webflow' ? cred.siteId
    : platform === 'git' ? JSON.stringify([cred.repoDir, cred.origin]) : '';
  return String(v ?? '');
}
const metaFile = (run: string, id: string) => join(run, 'plans', `${id}.meta.json`);
function writePlanMeta(run: string, id: string, platform: string, target: string): void {
  writeFileSync(metaFile(run, id), JSON.stringify({ platform, target }, null, 2), 'utf8');
}
/** Platform and target recorded at publish-plan time; --platform may only confirm it. */
function planPlatform(args: ParsedArgs, host: string, run: string, id: string): string {
  if (!/^[0-9A-Za-z.-]+$/.test(id)) fail(`"${id}" is not a valid backup id.`);
  if (!existsSync(join(run, 'plans', `${id}.json`)) || !existsSync(join(run, 'backups', `${id}.json`))) {
    fail(`No saved plan and backup for "${id}" in this run. Run publish-plan first, and use the backup id it printed.`);
  }
  const mf = metaFile(run, id);
  if (!existsSync(mf)) fail(`The plan ${id} has no record of its platform. Run publish-plan again.`);
  const meta = readJsonFile<{ platform: string; target: string }>(mf, 'the plan record');
  const given = flagString(args, 'platform');
  if (given && given !== meta.platform) fail(`Backup ${id} was planned for ${meta.platform}, not ${given}. Use --platform ${meta.platform} or drop the flag.`);
  if (targetOf(host, meta.platform) !== meta.target) {
    fail(`The saved ${meta.platform} credentials now point at a different target than the one this plan was made for. Run publish-plan again.`);
  }
  return meta.platform;
}

async function adapterFor(host: string, platform: string): Promise<Adapter & Record<string, unknown>> {
  const cred = getCredential<Record<string, any>>(host, platform as Platform);
  const missing = (fields: string): never =>
    fail(`No usable ${platform} credentials saved for ${host} (needs ${fields}). Save them with credentials-save first.`);
  if (!cred) return missing('the connection details');
  switch (platform) {
    case 'shopify':
      if (!cred.shop || !cred.token) missing('shop and token');
      return shopifyAdapter({ shop: cred.shop, token: cred.token }) as any;
    case 'wordpress':
      if (!cred.base || !cred.user || !cred.appPassword) missing('base, user and appPassword');
      return (await wordpressAdapter({ base: cred.base, user: cred.user, appPassword: cred.appPassword })) as any;
    case 'webflow':
      if (!cred.token || !cred.siteId) missing('token and siteId');
      return webflowAdapter({ token: cred.token, siteId: cred.siteId, cmsFields: cred.cmsFields }) as any;
    case 'git':
      if (!cred.repoDir || !cred.origin) missing('repoDir and origin');
      return gitAdapter({ repoDir: cred.repoDir, origin: cred.origin }) as any;
  }
  return fail(`Unknown platform "${platform}".`);
}

async function cmdPublishPlan(args: ParsedArgs) {
  const { host, run } = ctx(args);
  const platform = platformArg(args, run);
  const adapter = await adapterFor(host, platform);
  const all = readProposals(run);
  if (!all.some((p) => p.approve === true)) fail('No approved proposals. Read the approvals from the workbook first (approvals).');
  const excluded = heldBack(all);
  let approved = all.filter(publishable);
  if (!approved.length) fail(`None of the approved rows passed the checks (${excluded.map((e) => e.status).join(', ')}), so there is nothing to publish. Fix them in the workbook and read the approvals again.`);
  const kinds = flagString(args, 'kinds')?.split(',').map((s) => s.trim()).filter(Boolean);
  let outsideKinds: string[] = [];
  if (kinds?.length) {
    const resolved = await adapter.resolve(approved.map((p) => normaliseUrl(p.url)));
    const byNorm = new Map([...resolved].map(([k, v]) => [normaliseUrl(k), v]));
    const denied = new Set([...(adapter.noAccess?.keys() ?? [])].map(normaliseUrl));
    const keep: Proposal[] = [];
    for (const p of approved) {
      const ref = byNorm.get(normaliseUrl(p.url));
      // A page the credentials may not read has no known kind; it stays in so the plan reports it as no-access with the fix.
      if ((ref && kinds.includes(ref.kind)) || (!ref && denied.has(normaliseUrl(p.url)))) keep.push(p);
      else outsideKinds.push(p.url);
    }
    approved = keep;
    if (!approved.length) fail(`None of the approved pages are of kind ${kinds.join(', ')}.`);
  }
  // R1: the live check compares what each page renders (a git file is its own page, so it is not fetched).
  const backup = await snapshot(adapter, run, approved, undefined, { render: renderPage });
  // A permission missing for one kind of record skips those pages; missing it for every page stops here.
  const blocked = noAccessBlocker(backup);
  if (blocked) fail(blocked);
  const plan = planChanges(backup, approved, { includeRenamingH1: flagBool(args, 'include-renaming-h1') });
  writePlan(run, backup.id, plan);
  writePlanMeta(run, backup.id, platform, targetOf(host, platform));
  const extra: Record<string, unknown> = {};
  for (const k of ['seoPlugin', 'metaWritable', 'metaWritableByKind']) if (k in adapter) extra[k] = adapter[k];
  const warnings = noAccessWarnings(backup);
  return {
    backupId: backup.id, platform, changes: plan.changes.length,
    byKind: countBy(plan.changes, (c) => c.ref.kind), byField: countBy(plan.changes, (c) => c.field),
    preview: plan.changes.map((c) => ({ url: c.ref.url, kind: c.ref.kind, field: c.field, from: c.was !== undefined ? c.was : c.from, to: c.to })),
    skipped: plan.skipped, skippedByReason: countBy(plan.skipped, (s) => s.reason),
    excludedByKinds: outsideKinds, excluded, ...(warnings.length ? { warnings } : {}), ...extra,
  };
}

function priorApplyCount(run: string, id: string): number {
  const f = join(run, 'publish-log.json');
  if (!existsSync(f)) return 0;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const entries: any[] = Array.isArray(j) ? j : Array.isArray(j?.entries) ? j.entries : [];
    return entries.filter((e) => e && e.backupId === id && e.ok === true && e.action === 'apply').length;
  } catch { return 0; }
}

async function cmdPublishApply(args: ParsedArgs) {
  const { host, run } = ctx(args);
  const id = need(args, 'backup');
  const platform = planPlatform(args, host, run, id);
  const plan = readPlan(run, id);
  const priorApplies = priorApplyCount(run, id);
  const backup = readBackup(run, id);
  const adapter = await adapterFor(host, platform);
  const log = await applyChanges(adapter, run, plan, { delayMs: publishDelayMs(platform) });
  const warnings = [...(log.warnings ?? [])];
  if (priorApplies > 0) {
    warnings.push(`Backup ${id} was already applied (${priorApplies} change${priorApplies === 1 ? '' : 's'} logged earlier in publish-log.json). Fields that already had the new value were left as they are.`);
  }
  const liveChanged = log.entries.filter((e) => e.reason === 'live-changed').map((e) => ({ url: e.url, field: e.field }));
  const ok = log.entries.filter((e) => e.ok);
  const okKeys = new Set(ok.map((e) => JSON.stringify([normaliseUrl(e.url), e.field])));
  const applied = plan.changes.filter((c) => okKeys.has(JSON.stringify([normaliseUrl(c.ref.url), c.field])));
  const approvedUrl = (refUrl: string) =>
    backup.records.find((r) => normaliseUrl(r.ref.url) === normaliseUrl(refUrl))?.url ?? normaliseUrl(refUrl);
  const mark = (url: string, field: Field, status: ChangeStatus) => {
    try { markHandoff(run, approvedUrl(url), field, status); } catch (e) { warnings.push(e instanceof Error ? e.message : String(e)); }
  };
  for (const c of applied) mark(c.ref.url, c.field, 'published');
  const verification = await verifyLive(applied, renderPage);
  for (const v of verification) if (v.result === 'verified') mark(v.url, v.field, 'verified');
  const notVerified = verification.filter((v) => v.result !== 'verified').length;
  // T13: on the git route the files changed locally; the live site shows them only after a deploy.
  const gitNote = platform === 'git' && notVerified > 0
    ? { notDeployedYet: notVerified, deployNote: `Not deployed yet: ${notVerified} change${notVerified === 1 ? ' is' : 's are'} saved in your site folder but not on the live site. They show once you deploy.` }
    : {};
  return {
    backupId: id, log: log.entries, applied: ok.length, failed: log.entries.length - ok.length,
    liveChanged, verification, verified: verification.filter((v) => v.result === 'verified').length,
    pending: verification.filter((v) => v.result === 'pending').length, warnings, ...gitNote,
  };
}

/** The page as served, for the live checks; throws when it cannot be read. */
async function renderPage(url: string): Promise<string> {
  const r = await fetchHtml(url);
  if (r.error) throw new Error(r.error);
  return r.html;
}

async function cmdRollback(args: ParsedArgs) {
  const { host, run } = ctx(args);
  const id = need(args, 'backup');
  const platform = planPlatform(args, host, run, id);
  const backup = readBackup(run, id);
  const plan = readPlan(run, id);
  const adapter = await adapterFor(host, platform);
  const log = await rollback(adapter, backup, { run, plan, render: renderPage, delayMs: publishDelayMs(platform), allFields: flagBool(args, 'all-fields') });
  const warnings = [...(log.warnings ?? [])];
  // M6: onpage.json records the restored fields as rolled back.
  const approvedUrl = (refUrl: string) =>
    backup.records.find((r) => normaliseUrl(r.ref.url) === normaliseUrl(refUrl))?.url ?? normaliseUrl(refUrl);
  const at = new Date().toISOString();
  for (const e of log.entries) {
    if (!e.ok) continue;
    try { markHandoff(run, approvedUrl(e.url), e.field, 'rolled-back', at); } catch (err) { warnings.push(err instanceof Error ? err.message : String(err)); }
  }
  return {
    backupId: backup.id, log: log.entries, restored: log.entries.filter((e) => e.ok).length,
    failed: log.entries.filter((e) => !e.ok && e.reason !== 'live-changed').length,
    leftAlone: log.entries.filter((e) => e.reason === 'live-changed').map((e) => ({ url: e.url, field: e.field })),
    warnings,
  };
}

function cmdWpCsv(args: ParsedArgs) {
  const { run } = ctx(args);
  const all = readProposals(run);
  if (!all.some((p) => p.approve === true)) fail('No approved proposals. Read the approvals from the workbook first (approvals).');
  const rows = all.filter(publishable);
  const excluded = heldBack(all);
  if (!rows.length) fail(`None of the approved rows passed the checks (${excluded.map((e) => e.status).join(', ')}), so there is nothing to export. Fix them in the workbook and read the approvals again.`);
  const file = join(run, 'wordpress-import.csv');
  writeFileSync(file, wordpressCsv(rows), 'utf8');
  return { csv: file, rows: rows.length, excluded };
}

function cmdMark(args: ParsedArgs) {
  const { run } = ctx(args);
  const url = need(args, 'url');
  // A path such as /services/x would be rewritten by Git Bash into a Windows path, so only a full address is accepted.
  if (!/^https?:\/\/[^/]/i.test(url)) fail(`--url must be the page's full address, such as https://example.com/services/drain-cleaning (got "${url}").`);
  const field = need(args, 'field') as Field;
  const status = need(args, 'status') as ChangeStatus;
  if (!FIELDS.includes(field)) fail(`--field must be one of ${FIELDS.join(', ')}.`);
  if (!STATUSES.includes(status)) fail(`--status must be one of ${STATUSES.join(', ')}.`);
  markHandoff(run, normaliseUrl(url), field, status);
  return { url: normaliseUrl(url), field, status };
}

// ---------------------------------------------------------------- dispatch

const COMMANDS: Record<string, (a: ParsedArgs) => unknown | Promise<unknown>> = {
  crawl: cmdCrawl, conventions: cmdConventions, top: cmdTop, batches: cmdBatches, merge: cmdMerge,
  workbook: cmdWorkbook, approvals: cmdApprovals, 'publish-plan': cmdPublishPlan, 'publish-apply': cmdPublishApply,
  rollback: cmdRollback, 'wp-csv': cmdWpCsv, 'interview-save': cmdInterviewSave,
  'credentials-save': cmdCredentialsSave, mark: cmdMark, status: cmdStatus,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const name = args.positional[0];
  const fn = name ? COMMANDS[name] : undefined;
  if (!fn) {
    fail(`${name ? `Unknown command "${name}".` : 'No command given.'} Commands: ${Object.keys(COMMANDS).join(', ')}.`);
    return;
  }
  const out = await fn!(args);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((e: unknown) => {
  const msg = redact(e instanceof Error ? e.message : String(e));
  process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  process.exitCode = 1;
});
