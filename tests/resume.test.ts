// Final-review fix wave: resumable runs (I5), batch sizing (I7), crawl truncation (I6), crawl retries and
// bot-protection message (M3), headers for platform detection (M8) and page-type order (M16).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBatches, writePages, writeInterview, readPages } from '../scripts/lib/store.ts';
import { runDir } from '../scripts/lib/paths.ts';
import { crawl, crawlBlockedMessage, sampleFetcher, truncationMessage, type Fetcher } from '../scripts/lib/crawl.ts';
import { extractPage } from '../scripts/lib/extract.ts';
import type { Interview, PageRecord } from '../scripts/lib/types.ts';

const host = 'shop.example';
let tmp: string; let run: string; let old: string | undefined;
const page = (n: number, extra: Partial<PageRecord> = {}): PageRecord => ({
  url: `https://shop.example/p${n}`, slug: `p${n}`, type: 'service', title: `Old title ${n}`, meta: `Old meta ${n}`, h1s: [`Old H1 ${n}`], h2s: ['A section'],
  intro: 'We fix pipes.', text: 'We fix pipes.', jsonLdTypes: ['Service'], altMissing: 1, altTotal: 3, cta: 'Call now', inlinks: 4, navLinked: true, ogTitle: 'og', ogDescription: 'ogd', ...extra,
});
const interview: Interview = { brand: 'Shop', answers: [], convention: { separator: '|', brand: 'Shop', brandPosition: 'end', case: 'title', patterns: {} }, updatedAt: '2026-10-09' };

describe('batches (I5, I7)', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pc-resume-'));
    old = process.env.PITCREW_HOME; process.env.PITCREW_HOME = tmp;
    run = runDir(host, '2026-10-09');
    writePages(run, Array.from({ length: 30 }, (_, i) => page(i + 1)));
    writeInterview(host, interview);
  });
  afterEach(() => { if (old === undefined) delete process.env.PITCREW_HOME; else process.env.PITCREW_HOME = old; rmSync(tmp, { recursive: true, force: true }); });
  const urls = () => [...readPages(run).keys()];

  it('batch files carry only the fields the writer uses, text capped at 4,000 code points, 2-space JSON', () => {
    writePages(run, [page(1, { text: '😀'.repeat(20_000) }), ...Array.from({ length: 29 }, (_, i) => page(i + 2))]);
    makeBatches(run, urls());
    const raw = readFileSync(join(run, 'batches', '01.json'), 'utf8');
    const b = JSON.parse(raw);
    expect(Object.keys(b.pages[0]).sort()).toEqual(['cta', 'h1s', 'h2s', 'intro', 'meta', 'text', 'title', 'type', 'url']);
    expect([...b.pages[0].text].length).toBe(4000);
    expect(raw).toContain('\n  "pages": [\n    {');
    expect(Math.max(...raw.split('\n').map((l) => [...l].length))).toBeLessThan(4100);
    expect(statSync(join(run, 'batches', '01.json')).size).toBeLessThan(60_000);
    expect(typeof b.pagesHash).toBe('string');
  });

  it('keeps an out file whose batch is unchanged', () => {
    makeBatches(run, urls());
    writeFileSync(join(run, 'batches', '01.out.json'), '[]');
    expect(makeBatches(run, urls())).toEqual(['02']);
    expect(existsSync(join(run, 'batches', '01.out.json'))).toBe(true);
  });

  it('deletes an out file whose pages changed since it was written (same-day re-crawl)', () => {
    makeBatches(run, urls());
    writeFileSync(join(run, 'batches', '01.out.json'), '[]');
    writeFileSync(join(run, 'batches', '02.out.json'), '[]');
    writePages(run, [page(1, { title: 'Edited title 1' }), ...Array.from({ length: 29 }, (_, i) => page(i + 2))]);
    expect(makeBatches(run, urls())).toEqual(['01']);
    expect(existsSync(join(run, 'batches', '01.out.json'))).toBe(false);
    expect(existsSync(join(run, 'batches', '02.out.json'))).toBe(true);
  });

  it('a changed batch membership (new top order) invalidates the out file too', () => {
    makeBatches(run, urls());
    writeFileSync(join(run, 'batches', '01.out.json'), '[]');
    const u = urls();
    expect(makeBatches(run, [u[29]!, ...u.slice(0, 29)])).toEqual(['01', '02']);
  });
});

describe('crawl (I6, M3, M8)', () => {
  const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
  const res = (url: string, status: number, body = '', headers: Record<string, string> = {}) => ({ status, type: status === 200 ? 'text/html' : '', body, finalUrl: url, headers });
  const O = 'https://x.example';

  it('include plus cap reports how many pages the chosen sections had (I6)', async () => {
    const r = await crawl('https://trailhead-parts.example', { fetcher: sampleFetcher('trailhead-parts.example'), cap: 3, include: ['/products/'] });
    expect(r.capped).toBe(true);
    expect(r.pages).toHaveLength(3);
    expect(r.selected).toBeGreaterThan(3);
    expect(truncationMessage(3, r.selected!, ['/products/'])).toBe(`Kept the first 3 of ${r.selected} pages in /products/.`);
    expect(truncationMessage(1000, 1234, ['/products/', '/blogs/'])).toBe('Kept the first 1,000 of 1,234 pages in /products/ and /blogs/.');
  });

  it('retries a page once after a 429 or 503, waiting Retry-After capped at 30 s (M3)', async () => {
    const waits: number[] = [];
    const tries = new Map<string, number>();
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/robots.txt') || u.endsWith('/sitemap.xml')) return res(u, 404);
      const n = (tries.get(u) ?? 0) + 1;
      tries.set(u, n);
      if (n === 1) return res(u, u.endsWith('/') ? 429 : 503, '', { 'retry-after': u.endsWith('/') ? '120' : '3' });
      return res(u, 200, html(u.endsWith('/') ? '<a href="/b">b</a>' : 'b'));
    };
    const r = await crawl(O, { fetcher, sleep: async (ms) => { waits.push(ms); } });
    expect(r.pages.map((p) => p.url)).toEqual([`${O}/`, `${O}/b`]);
    expect(waits).toEqual([30_000, 3_000]);
    expect(tries.get(`${O}/`)).toBe(2);
  });

  it('gives up after one retry and records the status', async () => {
    const fetcher: Fetcher = async (u) => (u.endsWith('/robots.txt') || u.endsWith('/sitemap.xml') ? res(u, 404) : res(u, 503));
    const r = await crawl(O, { fetcher, sleep: async () => {} });
    expect(r.pages).toEqual([]);
    expect(r.dropped).toEqual([{ url: `${O}/`, reason: 'status', httpStatus: 503 }]);
  });

  it('an all-403 crawl names bot protection and the user agent (M3)', async () => {
    const fetcher: Fetcher = async (u) => (u.endsWith('/robots.txt') || u.endsWith('/sitemap.xml') ? res(u, 404) : res(u, 403));
    const r = await crawl(O, { fetcher, sleep: async () => {} });
    const msg = crawlBlockedMessage(r.dropped, 'x.example');
    expect(msg).toMatch(/bot protection|Cloudflare/);
    expect(msg).toContain('pitcrew/1.0');
    expect(crawlBlockedMessage([{ url: `${O}/`, reason: 'status', httpStatus: 404 }], 'x.example')).toBeNull();
  });

  it('keeps each page\'s response headers so the platform can be detected from them (M8)', async () => {
    const fetcher: Fetcher = async (u) => (u.endsWith('/robots.txt') || u.endsWith('/sitemap.xml') ? res(u, 404) : res(u, 200, html('home'), { 'x-shopid': '1', 'x-shardid': '7' }));
    const r = await crawl(O, { fetcher, sleep: async () => {} });
    expect(r.pages[0]!.headers).toMatchObject({ 'x-shardid': '7' });
  });
});

describe('page type order (M16)', () => {
  const links = { inlinks: new Map<string, number>(), nav: new Set<string>() };
  const t = (path: string, html = '<html><body>x</body></html>') => extractPage(`https://a.example${path}`, html, links).type;
  it('product, collection and article win over a location word in the slug', () => {
    expect(t('/products/city-bike-tire')).toBe('product');
    expect(t('/collections/area-rugs')).toBe('collection');
    expect(t('/blog/best-area-rugs')).toBe('article');
    expect(t('/city-guide', '<html><head><script type="application/ld+json">{"@type":"Product"}</script></head><body>x</body></html>')).toBe('product');
  });
  it('location needs a whole path segment from the list', () => {
    expect(t('/service-areas/boise')).toBe('location');
    expect(t('/locations/nampa')).toBe('location');
    expect(t('/areas/eagle')).toBe('location');
    expect(t('/city/boise')).toBe('location');
    expect(t('/cities/boise')).toBe('location');
    expect(t('/location')).toBe('location');
    expect(t('/velocity-tuning')).toBe('other');
    expect(t('/area-rug-cleaning')).toBe('other');
  });
});
