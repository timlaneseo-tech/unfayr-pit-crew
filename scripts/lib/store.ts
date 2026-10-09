import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Interview, PageRecord, Proposal } from './types.ts';
import { siteDir } from './paths.ts';
import { normaliseUrl } from './urls.ts';
import { decodeEntities } from './text.ts';
import { lintAll, unsourcedIn } from './lint.ts';

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

export function writePages(run: string, pages: PageRecord[]): void {
  writeJson(join(run, 'pages.json'), pages);
}
export function readPages(run: string): Map<string, PageRecord> {
  const file = join(run, 'pages.json');
  const m = new Map<string, PageRecord>();
  if (!existsSync(file)) return m;
  for (const p of readJson<PageRecord[]>(file)) m.set(p.url, p);
  return m;
}

export function readInterview(host: string): Interview | null {
  const file = join(siteDir(host), 'interview.json');
  return existsSync(file) ? readJson<Interview>(file) : null;
}
export function writeInterview(host: string, i: Interview): void {
  writeJson(join(siteDir(host), 'interview.json'), i);
}

export function readProposals(run: string): Proposal[] {
  const file = join(run, 'proposals.json');
  return existsSync(file) ? readJson<Proposal[]>(file) : [];
}
export function writeProposals(run: string, p: Proposal[]): void {
  writeJson(join(run, 'proposals.json'), p);
}

const batchId = (n: number) => String(n).padStart(2, '0');
const interviewFile = (run: string) => join(run, '..', '..', 'interview.json');

/** I7: the writer reads only these fields, and at most this much text per page, so a batch file stays readable in one go. */
export const BATCH_TEXT_CAP = 4000;
export type BatchPage = Pick<PageRecord, 'url' | 'type' | 'title' | 'meta' | 'h1s' | 'h2s' | 'intro' | 'text' | 'cta'>;
const forWriter = (p: PageRecord): BatchPage => ({
  url: p.url, type: p.type, title: p.title, meta: p.meta, h1s: p.h1s, h2s: p.h2s, intro: p.intro,
  text: [...p.text].slice(0, BATCH_TEXT_CAP).join(''), cta: p.cta,
});

/** I5: sha1 of the batch's sorted URLs plus those pages' title, meta and H1s. A re-crawl or a new top order changes it. */
export function pagesHash(pages: PageRecord[]): string {
  const rows = [...pages].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)).map((p) => [p.url, p.title, p.meta, p.h1s]);
  return createHash('sha1').update(JSON.stringify(rows)).digest('hex');
}

function storedHash(file: string): string | null {
  try { const h = readJson<{ pagesHash?: unknown }>(file).pagesHash; return typeof h === 'string' ? h : null; } catch { return null; }
}

/**
 * Split urls into batches of `size`; write batches/NN.json {pagesHash, pages, interview}. Returns ids still to do (no NN.out.json).
 * An NN.out.json written for a batch whose pages have changed since (pagesHash differs) is deleted and the batch is pending again.
 * Urls with no PageRecord are pushed to `skipped`.
 */
export function makeBatches(run: string, urls: string[], size = 25, skipped: string[] = []): string[] {
  const pages = readPages(run);
  const ifile = interviewFile(run);
  const interview = existsSync(ifile) ? readJson<Interview>(ifile) : null;
  const dir = join(run, 'batches');
  mkdirSync(dir, { recursive: true });
  const todo: string[] = [];
  const known: PageRecord[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    const pg = pages.get(normaliseUrl(u));
    if (!pg) { skipped.push(u); continue; }
    if (seen.has(pg.url)) continue;
    seen.add(pg.url);
    known.push(pg);
  }
  for (let i = 0, n = 1; i < known.length; i += size, n++) {
    const id = batchId(n);
    const chunk = known.slice(i, i + size);
    const hash = pagesHash(chunk);
    const out = join(dir, `${id}.out.json`);
    if (existsSync(out)) {
      if (storedHash(join(dir, `${id}.json`)) === hash) continue;
      rmSync(out, { force: true });
    }
    writeJson(join(dir, `${id}.json`), { pagesHash: hash, pages: chunk.map(forWriter), interview });
    todo.push(id);
  }
  return todo;
}

interface OutEntry {
  url: string; title: string | null; meta: string | null; h1: string | null;
  reason: string; sources: Proposal['sources']; deep?: Proposal['deep'];
}

/** Merge writer outputs into linted proposals. Writer output is decoded once here; proposals are plain text from then on. */
export function mergeBatches(run: string): { proposals: Proposal[]; missing: string[]; duplicates: string[]; unknown: string[] } {
  const ifile = interviewFile(run);
  if (!existsSync(ifile)) throw new Error(`Cannot merge batches: the interview is missing (${ifile}). Run the interview first.`);
  const interview = readJson<Interview>(ifile);
  const pages = readPages(run);
  const dir = join(run, 'batches');
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const ids = files.filter((f) => /^\d+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
  const missing: string[] = [];
  const raw: Proposal[] = [];
  const duplicates: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const dec = (v: string | null | undefined, cur: string | null): string | null => {
    if (v === null || v === undefined) return null;
    const d = decodeEntities(v).trim();
    return d === '' || d === cur ? null : d;
  };
  for (const id of ids) {
    const out = join(dir, `${id}.out.json`);
    if (!existsSync(out)) { missing.push(id); continue; }
    for (const e of readJson<OutEntry[]>(out)) {
      const url = normaliseUrl(e.url);
      const page = pages.get(url);
      if (!page) { unknown.push(e.url); continue; }
      if (seen.has(url)) { duplicates.push(url); continue; }
      seen.add(url);
      const current = { title: page.title, meta: page.meta, h1: page.h1s[0] ?? null };
      const p: Proposal = {
        url, type: page.type, tier: e.deep ? 'top' : 'pattern',
        current,
        proposed: { title: dec(e.title, current.title), meta: dec(e.meta, current.meta), h1: dec(e.h1, current.h1) },
        reason: decodeEntities(e.reason ?? ''), sources: e.sources ?? [],
        issues: [], status: 'ok', approve: null,
      };
      if (e.deep) {
        const x = e.deep as Partial<NonNullable<Proposal['deep']>>;
        // R7: every piece of deep-fix copy follows the never-invent rule; an unsourced one becomes one [ADD: ...] slot.
        const slot = (f: string) => (f === '' || /^\[ADD:[^\]]*\]$/.test(f) || !unsourcedIn(f, page, interview) ? f : `[ADD: ${f.replace(/\[ADD:\s*([^\]]*)\]/g, '$1')}]`);
        const clean = (f: unknown) => (typeof f === 'string' ? decodeEntities(f).trim() : '');
        p.deep = {
          query: x.query ?? '', intro: slot(clean(x.intro)),
          h2s: (x.h2s ?? []).map(clean).filter(Boolean).map(slot),
          faq: (x.faq ?? []).map((f) => ({ q: slot(clean(f?.q)), a: slot(clean(f?.a)) })),
          schema: x.schema ?? '',
          altFixes: (x.altFixes ?? []).map(clean).filter(Boolean).map(slot),
          citationFacts: (x.citationFacts ?? []).map(clean).filter(Boolean).map(slot),
        };
      }
      raw.push(p);
    }
  }
  const proposals = lintAll(raw, pages, interview);
  writeProposals(run, proposals);
  return { proposals, missing, duplicates, unknown };
}

/** M7: pages as they would be after publishing every row that passed lint (status ok); other rows keep their current values. */
export function publishablePages(pages: PageRecord[], proposals: Proposal[]): PageRecord[] {
  return applyProposals(pages, proposals.filter((p) => p.status === 'ok'));
}

/** Pages as they would be after applying non-null proposed values (h1 becomes the only H1). */
export function applyProposals(pages: PageRecord[], proposals: Proposal[]): PageRecord[] {
  const byUrl = new Map(proposals.map((p) => [p.url, p]));
  return pages.map((pg) => {
    const p = byUrl.get(pg.url);
    const copy: PageRecord = { ...pg, h1s: [...pg.h1s] };
    if (!p) return copy;
    if (p.proposed.title !== null) copy.title = p.proposed.title;
    if (p.proposed.meta !== null) copy.meta = p.proposed.meta;
    if (p.proposed.h1 !== null) copy.h1s = [p.proposed.h1];
    return copy;
  });
}

