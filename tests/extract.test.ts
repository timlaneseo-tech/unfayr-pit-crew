import { describe, it, expect } from 'vitest';
import { crawl, sampleFetcher } from '../scripts/lib/crawl.ts';
import { extractPage, linkGraph } from '../scripts/lib/extract.ts';
import type { PageRecord } from '../scripts/lib/types.ts';

const RIDGE = 'https://ridgeline-plumbing.example';
const TRAIL = 'https://trailhead-parts.example';

async function records(origin: string, domain: string): Promise<PageRecord[]> {
  const r = await crawl(origin, { fetcher: sampleFetcher(domain) });
  const g = linkGraph(r.pages);
  return r.pages.map((p) => extractPage(p.url, p.html, g));
}
const by = (rs: PageRecord[], path: string) => rs.find((r) => new URL(r.url).pathname === path)!;

describe('extract: ridgeline', () => {
  it('assigns page types in rule order', async () => {
    const rs = await records(RIDGE, 'ridgeline-plumbing.example');
    expect(rs).toHaveLength(12);
    expect(by(rs, '/').type).toBe('home');
    expect(by(rs, '/service-areas/boise').type).toBe('location');
    expect(by(rs, '/blog/frozen-pipes-boise').type).toBe('article');
    expect(by(rs, '/water-heater-repair').type).toBe('service');
    expect(by(rs, '/water-heater-repair').navLinked).toBe(true);
    expect(by(rs, '/about').type).toBe('other');
  });
  it('extracts fields', async () => {
    const rs = await records(RIDGE, 'ridgeline-plumbing.example');
    const home = by(rs, '/');
    expect(home.title).toBe('Ridgeline Plumbing | Boise Plumber for Homes and Shops');
    expect(home.h1s).toHaveLength(1);
    expect(home.intro.split(' ')).toHaveLength(100);
    expect(home.text).not.toContain('Licensed and insured');
    expect(home.text.length).toBeLessThanOrEqual(20000);
    expect(by(rs, '/blog/frozen-pipes-boise').jsonLdTypes).toContain('BlogPosting');
    expect(by(rs, '/service-areas/nampa').h1s).toEqual([]);
    expect(by(rs, '/service-areas/nampa').h2s.length).toBeGreaterThan(0);
    expect(by(rs, '/water-heater-repair').inlinks).toBeGreaterThan(0);
  });
});

describe('extract: trailhead and synthetic', () => {
  it('types shopify paths', async () => {
    const rs = await records(TRAIL, 'trailhead-parts.example');
    expect(rs.filter((r) => r.type === 'product').length).toBe(12);
    expect(rs.filter((r) => r.type === 'collection').length).toBe(6);
    expect(rs.filter((r) => r.type === 'article').length).toBe(6);
  });
  const links = { inlinks: new Map<string, number>(), nav: new Set<string>() };
  it('uses JSON-LD for product, collection and article', () => {
    const ld = (t: string) => `<html><head><title>x</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"${t}"}]}</script></head><body><main>hi</main></body></html>`;
    expect(extractPage('https://a.example/thing', ld('Product'), links).type).toBe('product');
    expect(extractPage('https://a.example/thing', ld('ItemList'), links).type).toBe('collection');
    expect(extractPage('https://a.example/thing', ld('Article'), links).type).toBe('article');
    expect(extractPage('https://a.example/thing', '<html><body>x</body></html>', links).type).toBe('other');
  });
  it('caps text at 20000, falls back to body minus chrome, finds cta in main', () => {
    const html = `<html><body><header>HEAD</header><nav>NAV</nav><p>${'word '.repeat(10000)}</p><footer>FOOT</footer></body></html>`;
    const r = extractPage('https://a.example/x/', html, links);
    expect(r.text.length).toBe(20000);
    expect(r.text).not.toMatch(/HEAD|NAV|FOOT/);
    const r2 = extractPage('https://a.example/x', '<html><body><main><a href="/q">Call us now</a></main></body></html>', links);
    expect(r2.cta).toBe('Call us now');
    expect(r2.cta).not.toBeNull();
  });
  it('keeps entities and non-ASCII in titles, counts alt', () => {
    const r = extractPage('https://a.example/x', '<html><head><title>Leak &amp; Repair é 😀</title></head><body><img src="a" alt=""><img src="b" alt="ok"></body></html>', links);
    expect(r.title).toBe('Leak & Repair é 😀');
    expect([r.altMissing, r.altTotal]).toEqual([1, 2]);
  });
});

describe('extract: fix round 1', () => {
  const links = { inlinks: new Map<string, number>(), nav: new Set<string>() };
  it('stores title, meta, h1 and h2 decoded', () => {
    const r = extractPage('https://a.example/x', '<html><head><title>Tom &amp; Jerry&#146;s</title><meta name="description" content="A &raquo; B &amp; C"></head><body><h1>H &amp; 1</h1><h2>H &eacute; 2</h2></body></html>', links);
    expect([r.title, r.meta, r.h1s, r.h2s]).toEqual(['Tom & Jerry’s', 'A » B & C', ['H & 1'], ['H é 2']]);
  });
  it('slices text by code points at the 20000 boundary', () => {
    const html = `<html><body><main>${'a'.repeat(19999)}😀 tail</main></body></html>`;
    const r = extractPage('https://a.example/x', html, links);
    expect([...r.text]).toHaveLength(20000);
    expect(r.text.endsWith('😀')).toBe(true);
  });
  it('no-body fallback does not leak head or title text', () => {
    const r = extractPage('https://a.example/x', '<html><head><title>LEAKTITLE</title></head><p>hello there</p></html>', links);
    expect(r.text).toBe('hello there');
  });
  it('cta: class tokens only, capped at 80 chars', () => {
    const m = (inner: string) => extractPage('https://a.example/x', `<html><body><main>${inner}</main></body></html>`, links).cta;
    expect(m('<a class="shop-header" href="/">Home</a>')).toBeNull();
    expect(m('<a class="btn primary" href="/">Learn more</a>')).toBe('Learn more');
    expect(m('<a href="/">Call ' + 'x'.repeat(200) + '</a>')!.length).toBe(80);
  });
});
