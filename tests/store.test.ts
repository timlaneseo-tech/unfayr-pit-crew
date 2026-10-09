import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBatches, mergeBatches, writePages, readPages, writeInterview, applyProposals, readProposals, publishablePages } from '../scripts/lib/store.ts';
import { runDir } from '../scripts/lib/paths.ts';
import type { Interview, PageRecord, Proposal } from '../scripts/lib/types.ts';

const host = 'shop.example';
let tmp: string; let run: string; let old: string | undefined;
const page = (n: number, extra: Partial<PageRecord> = {}): PageRecord => ({
  url: `https://shop.example/p${n}`, slug: `p${n}`, type: 'service', title: `Old title ${n}`, meta: `Old meta ${n}`, h1s: [`Old H1 ${n}`], h2s: [],
  intro: '', text: 'We fix pipes.', jsonLdTypes: [], altMissing: 0, altTotal: 0, cta: null, inlinks: 0, navLinked: false, ogTitle: null, ogDescription: null, ...extra,
});
const interview: Interview = { brand: 'Shop', answers: [], convention: { separator: '|', brand: 'Shop', brandPosition: 'end', case: 'title', patterns: {} }, updatedAt: '2026-10-09' };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pitcrew-store-'));
  old = process.env.PITCREW_HOME; process.env.PITCREW_HOME = tmp;
  run = runDir(host, '2026-10-09');
  writePages(run, Array.from({ length: 60 }, (_, i) => page(i + 1)));
  writeInterview(host, interview);
});
afterEach(() => { if (old === undefined) delete process.env.PITCREW_HOME; else process.env.PITCREW_HOME = old; rmSync(tmp, { recursive: true, force: true }); });

describe('store', () => {
  it('splits 60 urls into 25/25/10 and writes {pages, interview}', () => {
    const urls = [...readPages(run).keys()];
    expect(makeBatches(run, urls)).toEqual(['01', '02', '03']);
    const b3 = JSON.parse(readFileSync(join(run, 'batches', '03.json'), 'utf8'));
    expect(b3.pages).toHaveLength(10);
    expect(b3.interview.brand).toBe('Shop');
    expect(JSON.parse(readFileSync(join(run, 'batches', '01.json'), 'utf8')).pages).toHaveLength(25);
  });

  it('resumes: skips ids with an out file', () => {
    const urls = [...readPages(run).keys()];
    makeBatches(run, urls);
    writeFileSync(join(run, 'batches', '01.out.json'), '[]');
    expect(makeBatches(run, urls)).toEqual(['02', '03']);
  });

  it('merges present batches, reports missing, decodes once, and lints', () => {
    const urls = [...readPages(run).keys()];
    makeBatches(run, urls);
    writeFileSync(join(run, 'batches', '01.out.json'), JSON.stringify([
      { url: 'https://shop.example/p1/', title: 'Plumbing &amp; Heating Repairs | Shop', meta: 'Old meta 1', h1: 'New H1 One', reason: 'r', sources: ['page'] },
      { url: 'https://shop.example/p2', title: 'Old title 2', meta: null, h1: null, reason: 'r', sources: ['page'], deep: { query: 'q', intro: 'i', h2s: [], faq: [], schema: '', altFixes: [] } },
    ]));
    const { proposals, missing } = mergeBatches(run);
    expect(missing).toEqual(['02', '03']);
    expect(proposals).toHaveLength(2);
    const p1 = proposals[0]!;
    expect(p1.url).toBe('https://shop.example/p1');
    expect(p1.proposed.title).toBe('Plumbing & Heating Repairs | Shop');
    expect(p1.proposed.meta).toBeNull();
    expect(p1.proposed.h1).toBe('New H1 One');
    expect(p1.current.h1).toBe('Old H1 1');
    expect(p1.type).toBe('service');
    expect(p1.tier).toBe('pattern'); expect(p1.approve).toBeNull();
    expect(proposals[1]!.tier).toBe('top');
    expect(proposals[1]!.proposed.title).toBeNull();
    expect(proposals.every((p) => ['ok', 'needs review', 'has [ADD]'].includes(p.status))).toBe(true);
    expect(readProposals(run)).toHaveLength(2);
  });

  it('throws a clear error when the interview is missing', () => {
    rmSync(join(tmp, 'sites', host, 'interview.json'));
    mkdirSync(join(run, 'batches'), { recursive: true });
    expect(() => mergeBatches(run)).toThrow(/interview/i);
  });

  it('applyProposals substitutes non-null fields and sets h1s without mutating', () => {
    const pages = [page(1)];
    const p = { url: pages[0]!.url, proposed: { title: 'T', meta: null, h1: 'H' } } as Proposal;
    const out = applyProposals(pages, [p]);
    expect(out[0]!.title).toBe('T'); expect(out[0]!.meta).toBe('Old meta 1'); expect(out[0]!.h1s).toEqual(['H']);
    expect(pages[0]!.title).toBe('Old title 1');
  });

  it('makeBatches skips unknown urls and does not rewrite a batch that has an out file', () => {
    const urls = [...readPages(run).keys()];
    const skipped: string[] = [];
    makeBatches(run, [...urls, 'https://shop.example/nope'], 25, skipped);
    expect(skipped).toEqual(['https://shop.example/nope']);
    const f = join(run, 'batches', '01.json');
    // I5: the out file is kept only while the batch's pagesHash still matches, so the sentinel keeps the real hash.
    const sentinel = JSON.stringify({ pagesHash: JSON.parse(readFileSync(f, 'utf8')).pagesHash, sentinel: 1 });
    writeFileSync(f, sentinel);
    writeFileSync(join(run, 'batches', '01.out.json'), '[]');
    makeBatches(run, urls);
    expect(readFileSync(f, 'utf8')).toBe(sentinel);
  });

  it('mergeBatches dedupes by normalised url, reports unknown urls, defaults partial deep', () => {
    makeBatches(run, [...readPages(run).keys()]);
    writeFileSync(join(run, 'batches', '01.out.json'), JSON.stringify([
      { url: 'https://shop.example/p1', title: 'First title that is long enough | Shop', meta: null, h1: null, reason: 'a', sources: ['page'] },
      { url: 'https://shop.example/p1/?x=1', title: 'Second', meta: null, h1: null, reason: 'b', sources: ['page'] },
      { url: 'https://shop.example/ghost', title: 'G', meta: null, h1: null, reason: 'c', sources: [] },
      { url: 'https://shop.example/p3', title: null, meta: null, h1: null, reason: 'd', sources: [], deep: { query: 'q' } },
    ]));
    const r = mergeBatches(run);
    expect(r.proposals.map((p) => p.url)).toEqual(['https://shop.example/p1', 'https://shop.example/p3']);
    expect(r.proposals[0]!.proposed.title).toBe('First title that is long enough | Shop');
    expect(r.duplicates).toEqual(['https://shop.example/p1']);
    expect(r.unknown).toEqual(['https://shop.example/ghost']);
    expect(r.proposals[1]!.deep).toEqual({ query: 'q', intro: '', h2s: [], faq: [], schema: '', altFixes: [], citationFacts: [] });
  });

  it('mergeBatches turns an unsourced numeric or claim citationFact into an [ADD] slot and keeps sourced ones', () => {
    writePages(run, Array.from({ length: 60 }, (_, i) => page(i + 1, i === 2 ? { text: 'Rated 4.9 stars from 312 reviews.' } : {})));
    makeBatches(run, [...readPages(run).keys()]);
    const facts = ['Ships in 987654 days', 'Industry-leading warranty', '[ADD: starting price]', 'Plain fact with no number', 'Rated 4.9 stars from 312 reviews', 'Free shipping over $500 [ADD: confirm]', '[ADD: a] and 777 more'];
    writeFileSync(join(run, 'batches', '01.out.json'), JSON.stringify([
      { url: 'https://shop.example/p3', title: null, meta: null, h1: null, reason: 'd', sources: [], deep: { query: 'q', citationFacts: facts } },
    ]));
    const d = mergeBatches(run).proposals[0]!.deep!;
    expect(d.citationFacts).toEqual(['[ADD: Ships in 987654 days]', '[ADD: Industry-leading warranty]', '[ADD: starting price]', 'Plain fact with no number', 'Rated 4.9 stars from 312 reviews', '[ADD: Free shipping over $500 confirm]', '[ADD: a and 777 more]']);
  });
});

describe('deep fixes follow the never-invent rule (R7)', () => {
  it('wraps an unsourced intro, H2, FAQ question or answer and alt fix as [ADD: ...] and keeps sourced ones', () => {
    writePages(run, Array.from({ length: 60 }, (_, i) => page(i + 1, i === 2 ? { text: 'We fix pipes. Rated 4.9 stars from 312 reviews.' } : {})));
    makeBatches(run, [...readPages(run).keys()]);
    writeFileSync(join(run, 'batches', '01.out.json'), JSON.stringify([
      { url: 'https://shop.example/p3', title: null, meta: null, h1: null, reason: 'd', sources: [], deep: {
        query: 'q',
        intro: 'We have fixed pipes for 40 years.',
        h2s: ['Rated 4.9 stars from 312 reviews', 'The best plumbers in town', 'How we fix pipes'],
        faq: [{ q: 'Do you fix pipes?', a: 'Yes, with a 10-year warranty [ADD: confirm].' }, { q: 'Are you the cheapest?', a: 'We fix pipes.' }],
        schema: 'Service',
        altFixes: ['Plumber fixing a pipe', 'Our 25 vans'],
      } },
    ]));
    const d = mergeBatches(run).proposals[0]!.deep!;
    expect(d.intro).toBe('[ADD: We have fixed pipes for 40 years.]');
    expect(d.h2s).toEqual(['Rated 4.9 stars from 312 reviews', '[ADD: The best plumbers in town]', 'How we fix pipes']);
    expect(d.faq).toEqual([
      { q: 'Do you fix pipes?', a: '[ADD: Yes, with a 10-year warranty confirm.]' },
      { q: '[ADD: Are you the cheapest?]', a: 'We fix pipes.' },
    ]);
    expect(d.altFixes).toEqual(['Plumber fixing a pipe', '[ADD: Our 25 vans]']);
  });
});

describe('summary After counts publishable rows only (M7)', () => {
  it('applies ok rows and keeps current values for rows that are not ok, approved or not', () => {
    const pages = [page(1), page(2), page(3)];
    const mkP = (n: number, status: Proposal['status']) => ({ url: pages[n - 1]!.url, status, approve: null, proposed: { title: `New ${n}`, meta: null, h1: null } }) as unknown as Proposal;
    const out = publishablePages(pages, [mkP(1, 'ok'), mkP(2, 'needs review'), mkP(3, 'has [ADD]')]);
    expect(out.map((p) => p.title)).toEqual(['New 1', 'Old title 2', 'Old title 3']);
  });
});
