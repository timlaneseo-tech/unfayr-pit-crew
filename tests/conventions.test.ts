import { describe, it, expect } from 'vitest';
import { crawl, sampleFetcher } from '../scripts/lib/crawl.ts';
import { extractPage, linkGraph } from '../scripts/lib/extract.ts';
import { analyseTitles, candidateConventions, applyBrand, patternRegex, guessBrand } from '../scripts/lib/conventions.ts';
import { charLen } from '../scripts/lib/text.ts';
import type { Convention, PageRecord, PageType } from '../scripts/lib/types.ts';

const base: Omit<PageRecord, 'url' | 'title'> = { slug: '', type: 'other', meta: null, h1s: ['h'], h2s: [], intro: '', text: '', jsonLdTypes: [], altMissing: 0, altTotal: 0, cta: null, inlinks: 0, navLinked: false, ogTitle: null, ogDescription: null };
const pg = (title: string | null): PageRecord => ({ ...base, url: 'https://x.example/' + Math.random(), title });

const conv = (over: Partial<Convention> = {}): Convention => ({
  separator: '|', brand: 'Ridgeline Plumbing', brandPosition: 'end-if-fits', case: 'title', patterns: {}, ...over,
});

describe('analyseTitles', () => {
  it('counts separators, brand position, case and length percentiles', () => {
    const a = analyseTitles([
      pg('Drain Cleaning in Nampa | Ridgeline Plumbing'),
      pg('Ridgeline Plumbing | Home'),
      pg('How to flush a water heater'),
      pg('Leak detection near me – Ridgeline Plumbing'),
      pg(null),
    ], 'Ridgeline Plumbing');
    expect(a.separators['|']).toBe(2);
    expect(a.separators['–']).toBe(1);
    expect(a.brandLast).toBe(2);
    expect(a.brandFirst).toBe(1);
    expect(a.brandMissing).toBe(1);
    expect(a.titleCase).toBe(1);
    expect(a.sentenceCase).toBe(2);
    expect(a.lengthP50).toBeGreaterThan(0);
    expect(a.lengthP90).toBeGreaterThanOrEqual(a.lengthP50);
  });
  it('handles no titles', () => {
    const a = analyseTitles([], 'X');
    expect(a.lengthP50).toBe(0);
    expect(a.separators).toEqual({});
  });
});

describe('candidateConventions', () => {
  const types: PageType[] = ['home', 'service', 'article', 'other'];
  const mk = (t: string) => analyseTitles([pg(t + ' A'), pg(t + ' B')], 'Ridgeline Plumbing');
  it('returns 3 distinct conventions with the specified shape', async () => {
    const r = await crawl('https://ridgeline-plumbing.example', { fetcher: sampleFetcher('ridgeline-plumbing.example') });
    const g = linkGraph(r.pages);
    const recs = r.pages.map((p) => extractPage(p.url, p.html, g));
    const a = analyseTitles(recs, 'Ridgeline Plumbing');
    const cs = candidateConventions(a, 'Ridgeline Plumbing', types);
    expect(cs).toHaveLength(3);
    expect(new Set(cs.map((c) => c.separator + c.case)).size).toBe(3);
    expect(cs[1]!.separator).toBe('|');
    expect(cs[2]!.separator).toBe('–');
    expect(cs[2]!.case).toBe('sentence');
    for (const c of cs) {
      expect(c.brand).toBe('Ridgeline Plumbing');
      expect(c.brandPosition).toBe('end-if-fits');
      expect(c.patterns.home).toBeDefined();
      expect(c.patterns.service).toBe('{Service} in {City}');
      expect(c.patterns.article).toBe('{Topic}: {Promise}');
      expect(c.patterns.other).toBeUndefined();
      expect(c.patterns.product).toBeUndefined();
    }
  });
  it('first keeps the most-used separator', () => {
    const cs = candidateConventions(mk('Foo Bar : Baz'), 'Ridgeline Plumbing', types);
    expect(cs[0]!.separator).toBe(':');
    expect(new Set(cs.map((c) => c.separator + c.case)).size).toBe(3);
  });
  it('stays distinct when the site already uses | or sentence-case –', () => {
    for (const t of ['Foo Bar | Baz', 'Foo bar baz – Qux quux']) {
      const cs = candidateConventions(mk(t), 'Ridgeline Plumbing', types);
      expect(new Set(cs.map((c) => c.separator + c.case)).size).toBe(3);
    }
  });
});

describe('applyBrand', () => {
  it('appends the brand when it fits', () => {
    const out = applyBrand('Water Heater Repair in Boise', conv(), 'service');
    expect(out).toBe('Water Heater Repair in Boise | Ridgeline Plumbing');
    expect(charLen(out)).toBe(49);
  });
  it('uses the convention separator with spaces both sides', () => {
    expect(applyBrand('Drain Cleaning', conv({ separator: '–' }), 'service')).toBe('Drain Cleaning – Ridgeline Plumbing');
    expect(applyBrand('Drain Cleaning', conv({ separator: ':' }), 'service')).toBe('Drain Cleaning : Ridgeline Plumbing');
  });
  it('drops the brand when result passes 60, keeps at exactly 60', () => {
    const core50 = 'x'.repeat(50);
    expect(applyBrand(core50, conv(), 'service')).toBe(core50);
    const core = 'x'.repeat(60 - ' | Ridgeline Plumbing'.length);
    expect(charLen(applyBrand(core, conv(), 'service'))).toBe(60);
    expect(applyBrand(core + 'y', conv(), 'service')).toBe(core + 'y');
  });
  it('always keeps the brand on home', () => {
    const core50 = 'x'.repeat(50);
    expect(applyBrand(core50, conv(), 'home')).toBe(core50 + ' | Ridgeline Plumbing');
  });
});

describe('patternRegex', () => {
  const c = conv({ patterns: { service: '{Service} in {City}', product: '{Product} {Key spec}', article: '{Topic}: {Promise}' } });
  it('matches with and without the brand, and rejects others', () => {
    const re = patternRegex(c, 'service')!;
    expect(re.test('Drain Cleaning in Nampa | Ridgeline Plumbing')).toBe(true);
    expect(re.test('Drain Cleaning in Nampa')).toBe(true);
    expect(re.test('Ridgeline Plumbing - Drain Cleaning')).toBe(false);
  });
  it('escapes literals and mirrors applyBrand', () => {
    const re = patternRegex(c, 'article')!;
    expect(re.test('Anode Rods: When To Replace Them')).toBe(true);
    const c2 = conv({ separator: ':', patterns: { service: '{Service} in {City}' } });
    const re2 = patternRegex(c2, 'service')!;
    expect(re2.test(applyBrand('Drain Cleaning in Nampa', c2, 'service'))).toBe(true);
  });
  it('returns null when no pattern for the type', () => {
    expect(patternRegex(c, 'other')).toBeNull();
  });
});

describe('guessBrand', () => {
  it('prefers the suffix most titles share after a separator', () => {
    const pages = ['A', 'B', 'C', 'D'].map((x) => pg(`${x} Part – RTL Equipment Parts Store`));
    expect(guessBrand('parts.rtlequipment.com', pages)).toBe('RTL Equipment Parts Store');
  });
  it('prefers a shared prefix brand too', () => {
    const pages = ['A', 'B', 'C'].map((x) => pg(`Acme Tools | ${x} drill`));
    expect(guessBrand('www.acme.com', pages)).toBe('Acme Tools');
  });
  it('falls back to the registrable domain label, title-cased, skipping subdomain prefixes', () => {
    const pages = [pg('Alpha thing'), pg('Beta other'), pg('Gamma – Delta')];
    expect(guessBrand('shop.example.com', pages)).toBe('Example');
    expect(guessBrand('www.example.co.uk', [])).toBe('Example');
    expect(guessBrand('example.com', [])).toBe('Example');
  });
});

describe('guessBrand: casing and generic segments', () => {
  it('counts segments case-insensitively', () => {
    const pages = ['A', 'B', 'C', 'D'].map((x, i) => pg(`${x} Part | ${i % 2 ? 'Acme Tools' : 'ACME TOOLS'}`));
    expect(guessBrand('acme.com', pages).toLowerCase()).toBe('acme tools');
  });
  it('ignores segments that are only generic words', () => {
    const pages = ['A', 'B', 'C', 'D'].map((x) => pg(`${x} drills | Home`));
    expect(guessBrand('shop.acme.com', pages)).toBe('Acme');
    const pages2 = ['A', 'B', 'C'].map((x) => pg(`${x} drill – Products`));
    expect(guessBrand('acme.com', pages2)).toBe('Acme');
  });
});
