import { describe, it, expect } from 'vitest';
import { crawl, sampleFetcher } from '../scripts/lib/crawl.ts';
import { extractPage, linkGraph } from '../scripts/lib/extract.ts';
import { readout } from '../scripts/lib/readout.ts';
import type { PageRecord } from '../scripts/lib/types.ts';

describe('readout', () => {
  it('matches the ridgeline fixture design', async () => {
    const r = await crawl('https://ridgeline-plumbing.example', { fetcher: sampleFetcher('ridgeline-plumbing.example') });
    const g = linkGraph(r.pages);
    const ro = readout(r.pages.map((p) => extractPage(p.url, p.html, g)));
    expect(ro.pages).toBe(12);
    expect(ro.titlesOver60).toBe(3);
    expect(ro.dupMetas).toBe(6);
    expect(ro.boilerplateMeta?.count).toBe(6);
    expect(ro.missingH1).toBe(1);
    expect(ro.separators['|']).toBeGreaterThan(0);
  });

  const base: Omit<PageRecord, 'url' | 'title' | 'meta'> = { slug: '', type: 'other', h1s: ['h'], h2s: [], intro: '', text: '', jsonLdTypes: [], altMissing: 0, altTotal: 0, cta: null, inlinks: 0, navLinked: false, ogTitle: null, ogDescription: null };
  const mk = (u: string, title: string | null, meta: string | null = null) => ({ ...base, url: u, title, meta });

  it('counts pages sharing a value, case-insensitive and decoded', () => {
    const ro = readout([mk('a', 'A & B'), mk('b', 'a & b '), mk('c', 'Other')]);
    expect(ro.dupTitles).toBe(2);
    expect(ro.boilerplateMeta).toBeNull();
  });
  it('boilerplate needs 5 sharing pages', () => {
    const four = readout([1, 2, 3, 4].map((i) => mk(String(i), 't' + i, 'same')));
    expect(four.boilerplateMeta).toBeNull();
    const five = readout([1, 2, 3, 4, 5].map((i) => mk(String(i), 't' + i, 'Same')));
    expect(five.boilerplateMeta).toEqual({ text: 'Same', count: 5 });
  });
});
