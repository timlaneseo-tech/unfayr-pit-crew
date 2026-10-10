import { describe, it, expect } from 'vitest';
import { crawl, sampleFetcher } from '../scripts/lib/crawl.ts';
import type { Fetcher } from '../scripts/lib/crawl.ts';
import { normaliseUrl } from '../scripts/lib/urls.ts';

const RIDGE = 'https://ridgeline-plumbing.example';
const TRAIL = 'https://trailhead-parts.example';

const html = (body: string, head = '') => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const ok = (url: string, body: string, headers: Record<string, string> = {}, type = 'text/html') => ({ status: 200, type, body, finalUrl: url, headers });
const missing = (url: string) => ({ status: 404, type: '', body: '', finalUrl: url, headers: {} });
const xml = (u: string, body: string) => ok(u, body, {}, 'application/xml');

describe('crawl: ridgeline (sitemap, filters)', () => {
  it('uses the sitemap and drops canonical, noindex, pagination and query URLs', async () => {
    const r = await crawl(RIDGE, { fetcher: sampleFetcher('ridgeline-plumbing.example') });
    expect(r.source).toBe('sitemap');
    expect(r.capped).toBe(false);
    expect(r.pages).toHaveLength(12);
    const reasons = Object.fromEntries(r.dropped.map((d) => [new URL(d.url).pathname + new URL(d.url).search, d.reason]));
    expect(reasons['/old-page']).toBe('canonical');
    expect(reasons['/thanks']).toBe('noindex');
    expect(reasons['/blog/page/2']).toBe('pagination');
    expect(Object.entries(reasons).filter(([, v]) => v === 'query')).toHaveLength(1);
    expect(r.dropped).toHaveLength(4);
    expect(r.sections['/']).toBeGreaterThan(0);
    expect(r.pages.every((p) => p.html.includes('<html'))).toBe(true);
  });
});

describe('crawl: trailhead (sitemap index, cap)', () => {
  it('follows the sitemap index into both child sitemaps', async () => {
    const r = await crawl(TRAIL, { fetcher: sampleFetcher('trailhead-parts.example') });
    expect(r.source).toBe('sitemap');
    expect(r.pages).toHaveLength(30);
    expect(r.capped).toBe(false);
    expect(r.sections['/products/']).toBeGreaterThan(0);
  });

  it('over the cap with no include returns section counts and no pages', async () => {
    const r = await crawl(TRAIL, { fetcher: sampleFetcher('trailhead-parts.example'), cap: 10 });
    expect(r.capped).toBe(true);
    expect(r.pages).toEqual([]);
    expect(Object.keys(r.sections).sort()).toEqual(['/blogs/', '/collections/', '/pages/', '/products/']);
    expect(Object.values(r.sections).reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('include narrows to the chosen sections, at most cap', async () => {
    const r = await crawl(TRAIL, { fetcher: sampleFetcher('trailhead-parts.example'), cap: 10, include: ['/collections/', '/pages/'] });
    expect(r.pages.length).toBeGreaterThan(0);
    expect(r.pages.length).toBeLessThanOrEqual(10);
    expect(r.pages.every((p) => /\/(collections|pages)\//.test(p.url))).toBe(true);
  });
});

describe('crawl: include home', () => {
  it('home selects the root URL only; a capped listing names the root home', async () => {
    const urls = ['/', '/a', '/b', '/collections/c'].map((x) => `<url><loc>https://h.example${x}</loc></url>`).join('');
    const small: Fetcher = async (u) => (u.endsWith('/sitemap.xml') ? xml(u, `<urlset>${urls}</urlset>`) : u.endsWith('/robots.txt') ? missing(u) : ok(u, html('<h1>x</h1>')));
    const capped = await crawl('https://h.example', { fetcher: small, cap: 3 });
    expect(capped.capped).toBe(true);
    expect(capped.sections.home).toBe(1);
    expect(capped.sections['/']).toBeUndefined();
    const r = await crawl('https://h.example', { fetcher: small, cap: 3, include: ['/', '/collections/'] });
    const paths = r.pages.map((p) => new URL(p.url).pathname);
    expect(paths).toContain('/');
    expect(paths.filter((x) => x !== '/').every((x) => x.startsWith('/collections/'))).toBe(true);
    expect(r.emptySections).toBeUndefined();
    const only = await crawl('https://h.example', { fetcher: small, cap: 3, include: ['/'] });
    expect(only.pages.map((p) => new URL(p.url).pathname)).toEqual(['/']);
  });
});

describe('crawl: link fallback', () => {
  const noMaps = (): Fetcher => {
    const base = sampleFetcher('ridgeline-plumbing.example');
    return async (u) => (/\/(sitemap\.xml|robots\.txt)$/.test(u) ? missing(u) : base(u));
  };

  it('falls back to links from the homepage when /sitemap.xml 404s, same host only', async () => {
    const r = await crawl(RIDGE, { fetcher: noMaps() });
    expect(r.source).toBe('links');
    expect(r.pages.length).toBeGreaterThanOrEqual(10);
    expect(r.pages.every((p) => new URL(p.url).host === 'ridgeline-plumbing.example')).toBe(true);
    expect(r.pages.some((p) => p.url.includes('elsewhere.example'))).toBe(false);
  });

  it('respects the cap in link mode', async () => {
    const r = await crawl(RIDGE, { fetcher: noMaps(), cap: 3 });
    expect(r.pages.length).toBeLessThanOrEqual(3);
    expect(r.capped).toBe(true);
  });
});

describe('crawl: edge cases', () => {
  it('Review Focus 5: a site with no HTML pages resolves empty and does not throw', async () => {
    const r = await crawl('https://nothing.example', { fetcher: async (u) => missing(u) });
    expect(r.pages).toEqual([]);
    expect(r.capped).toBe(false);
    expect(r.source).toBe('links');
  });

  it('a network failure (status null) does not throw', async () => {
    const fetcher: Fetcher = async (u) => ({ status: null, type: '', body: '', finalUrl: u, headers: {} });
    const r = await crawl('https://down.example', { fetcher });
    expect(r.pages).toEqual([]);
    expect(r.capped).toBe(false);
  });

  it('Review Focus 1: /a and /a/ in a sitemap yield one page', async () => {
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/sitemap.xml')) {
        return xml(u, '<urlset><url><loc>https://v.example/a</loc></url><url><loc>https://v.example/a/</loc></url><url><loc>https://v.example/a?utm=x</loc></url></urlset>');
      }
      return /\/a\/?$/.test(u) ? ok(u, html('<h1>A</h1>')) : missing(u);
    };
    const r = await crawl('https://v.example', { fetcher });
    expect(r.pages.filter((p) => normaliseUrl(p.url) === 'https://v.example/a')).toHaveLength(1);
    expect(r.pages).toHaveLength(1);
  });

  it('noindex via the x-robots-tag header drops the page', async () => {
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/sitemap.xml')) return xml(u, '<urlset><url><loc>https://h.example/x</loc></url><url><loc>https://h.example/y</loc></url></urlset>');
      if (u.endsWith('/x')) return ok(u, html('<h1>x</h1>'), { 'x-robots-tag': 'noindex, nofollow' });
      return ok(u, html('<h1>y</h1>'));
    };
    const r = await crawl('https://h.example', { fetcher });
    expect(r.pages.map((p) => p.url)).toEqual(['https://h.example/y']);
    expect(r.dropped).toEqual([{ url: 'https://h.example/x', reason: 'noindex' }]);
  });

  it('records status and not-html drops', async () => {
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/sitemap.xml')) return xml(u, '<urlset><url><loc>https://s.example/gone</loc></url><url><loc>https://s.example/file.pdf</loc></url><url><loc>https://s.example/ok</loc></url></urlset>');
      if (u.endsWith('/gone')) return missing(u);
      if (u.endsWith('.pdf')) return ok(u, '%PDF', {}, 'application/pdf');
      return ok(u, html('<h1>ok</h1>'));
    };
    const r = await crawl('https://s.example', { fetcher });
    expect(r.pages).toHaveLength(1);
    expect(Object.fromEntries(r.dropped.map((d) => [d.reason, d.url]))).toEqual({ status: 'https://s.example/gone', 'not-html': 'https://s.example/file.pdf' });
  });

  it('reads Sitemap: lines from robots.txt when /sitemap.xml is missing', async () => {
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/robots.txt')) return ok(u, 'User-agent: *\nSitemap: https://r.example/map.xml\n', {}, 'text/plain');
      if (u.endsWith('/map.xml')) return xml(u, '<urlset><url><loc>https://r.example/p</loc></url></urlset>');
      if (u.endsWith('/p')) return ok(u, html('<h1>p</h1>'));
      return missing(u);
    };
    const r = await crawl('https://r.example', { fetcher });
    expect(r.source).toBe('sitemap');
    expect(r.pages).toHaveLength(1);
  });
});

describe('ridgeline fixture designed properties', () => {
  it('has the title/meta/h1 mix later tasks rely on', async () => {
    const { parse } = await import('node-html-parser');
    const r = await crawl(RIDGE, { fetcher: sampleFetcher('ridgeline-plumbing.example') });
    const docs = r.pages.map((p) => {
      const root = parse(p.html);
      return {
        title: (root.querySelector('title')?.text ?? '').replace(/&amp;/g, '&'),
        meta: root.querySelector('meta[name=description]')?.getAttribute('content') ?? '',
        h1s: root.querySelectorAll('h1').length,
        words: (root.querySelector('main')?.text ?? '').split(/\s+/).filter(Boolean).length,
        text: root.querySelector('main')?.text ?? '',
      };
    });
    expect(docs.filter((d) => [...d.title].length > 60)).toHaveLength(3);
    const counts = new Map<string, number>();
    for (const d of docs) counts.set(d.meta, (counts.get(d.meta) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBe(6);
    expect([...counts.values()].filter((n) => n > 1)).toEqual([6]);
    expect(docs.filter((d) => d.h1s === 0)).toHaveLength(1);
    expect(docs.filter((d) => d.h1s === 1)).toHaveLength(11);
    expect(docs.every((d) => d.words >= 150)).toBe(true);
    expect(docs.some((d) => d.title.includes('&'))).toBe(true);
    expect(docs.some((d) => d.title.includes('’'))).toBe(true);
    expect(docs.filter((d) => d.text.includes('Serving Boise since 1998') && d.text.includes('4.9 stars from 312 reviews'))).toHaveLength(2);
    expect(r.pages.filter((p) => p.html.includes('BlogPosting'))).toHaveLength(3);
    expect(r.pages.some((p) => /shopify|wp-content/i.test(p.html))).toBe(false);
  });
});

describe('trailhead fixture', () => {
  it('is Shopify-shaped with Product JSON-LD', async () => {
    const r = await crawl(TRAIL, { fetcher: sampleFetcher('trailhead-parts.example') });
    expect(r.pages.every((p) => p.html.includes('cdn.shopify.com'))).toBe(true);
    expect(r.pages.filter((p) => p.html.includes('"@type":"Product"'))).toHaveLength(12);
    expect(r.sections).toEqual({ '/products/': 12, '/collections/': 6, '/pages/': 6, '/blogs/': 6 });
  });
});

describe('crawl: request bounds, hosts, include in link mode', () => {
  it('link mode bounds requests: 3,000 links with cap 10 makes at most 20 fetches', async () => {
    let calls = 0;
    const links = Array.from({ length: 3000 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
    const fetcher: Fetcher = async (u) => {
      calls++;
      if (/\/(sitemap\.xml|robots\.txt)$/.test(u)) return missing(u);
      return ok(u, html(u.endsWith('/') ? links : '<h1>x</h1>'));
    };
    const r = await crawl('https://big.example', { fetcher, cap: 10 });
    expect(r.pages.length).toBeLessThanOrEqual(10);
    expect(r.capped).toBe(true);
    expect(calls).toBeLessThanOrEqual(22); // 2 sitemap probes + 20 page fetches
  });

  it('treats www and apex as the same host (sitemap and links)', async () => {
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/sitemap.xml')) return xml(u, '<urlset><url><loc>https://www.ex.com/a</loc></url><url><loc>https://other.com/b</loc></url></urlset>');
      return u.includes('/a') ? ok(u, html('<h1>a</h1>')) : missing(u);
    };
    const r = await crawl('https://ex.com', { fetcher });
    expect(r.pages.map((p) => p.url)).toEqual(['https://www.ex.com/a']);

    const linkFetcher: Fetcher = async (u) => {
      if (/\/(sitemap\.xml|robots\.txt)$/.test(u)) return missing(u);
      if (u === 'https://ex.com/') return ok(u, html('<a href="https://www.ex.com/a">a</a><a href="https://other.com/b">b</a>'));
      return u.includes('/a') ? ok(u, html('<h1>a</h1>')) : missing(u);
    };
    const r2 = await crawl('https://ex.com', { fetcher: linkFetcher });
    expect(r2.pages.map((p) => p.url).sort()).toEqual(['https://ex.com/', 'https://www.ex.com/a']);
  });

  it('link mode applies include before a page counts toward the cap', async () => {
    const fetcher: Fetcher = async (u) => {
      if (/\/(sitemap\.xml|robots\.txt)$/.test(u)) return missing(u);
      if (u === 'https://inc.example/') return ok(u, html('<a href="/blog/1">1</a><a href="/blog/2">2</a><a href="/shop/1">s1</a><a href="/shop/2">s2</a>'));
      return ok(u, html('<h1>x</h1>'));
    };
    const r = await crawl('https://inc.example', { fetcher, cap: 3, include: ['/shop/'] });
    expect(r.pages.map((p) => p.url).sort()).toEqual(['https://inc.example/shop/1', 'https://inc.example/shop/2']);
  });

  it('offset skips the first chosen sitemap pages so a large section can run in parts', async () => {
    const urls = Array.from({ length: 7 }, (_, i) => `<url><loc>https://o.example/products/p${i}</loc></url>`).join('')
      + '<url><loc>https://o.example/pages/about</loc></url>';
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/sitemap.xml')) return xml(u, `<urlset>${urls}</urlset>`);
      if (u.endsWith('/robots.txt')) return missing(u);
      return ok(u, html('<h1>x</h1>'));
    };
    const part2 = await crawl('https://o.example', { fetcher, cap: 3, include: ['/products/'], offset: 3 });
    expect(part2.pages.map((p) => p.url)).toEqual(['https://o.example/products/p3', 'https://o.example/products/p4', 'https://o.example/products/p5']);
    expect(part2.selected).toBe(7);
    expect(part2.capped).toBe(true);
    const last = await crawl('https://o.example', { fetcher, cap: 3, include: ['/products/'], offset: 6 });
    expect(last.pages.map((p) => p.url)).toEqual(['https://o.example/products/p6']);
    expect(last.capped).toBe(false);
  });

  it('keeps backing off on 429 so a rate-limited store is still crawled, and gives up after 5 tries', async () => {
    const hits: Record<string, number> = {};
    const waits: number[] = [];
    const urls = '<url><loc>https://r.example/products/slow</loc></url><url><loc>https://r.example/products/never</loc></url>';
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/sitemap.xml')) return xml(u, `<urlset>${urls}</urlset>`);
      if (u.endsWith('/robots.txt')) return missing(u);
      hits[u] = (hits[u] ?? 0) + 1;
      if (u.endsWith('/never') || hits[u]! <= 3) return { status: 429, type: '', body: '', finalUrl: u, headers: {} };
      return ok(u, html('<h1>x</h1>'));
    };
    const r = await crawl('https://r.example', { fetcher, include: ['/products/'], sleep: async (ms) => { waits.push(ms); } });
    expect(r.pages.map((p) => p.url)).toEqual(['https://r.example/products/slow']);
    expect(hits['https://r.example/products/never']).toBe(5);
    expect(r.dropped).toEqual([{ url: 'https://r.example/products/never', reason: 'status', httpStatus: 429 }]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(30_000);
  });

  it('after the first 429 the crawl slows to one fetch at a time with a gap, and still keeps every page', async () => {
    let inflight = 0;
    let limited = false;
    let maxAfter = 0;
    const waits: number[] = [];
    const urls = Array.from({ length: 20 }, (_, i) => `<url><loc>https://t.example/p${i}</loc></url>`).join('');
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/sitemap.xml')) return xml(u, `<urlset>${urls}</urlset>`);
      if (u.endsWith('/robots.txt')) return missing(u);
      inflight++;
      await new Promise((r) => setTimeout(r, 2));
      inflight--;
      if (u.endsWith('/p0') && !limited) { limited = true; return { status: 429, type: '', body: '', finalUrl: u, headers: {} }; }
      if (limited) maxAfter = Math.max(maxAfter, inflight + 1);
      return ok(u, html('<h1>x</h1>'));
    };
    const r = await crawl('https://t.example', { fetcher, sleep: async (ms) => { waits.push(ms); await new Promise((res) => setTimeout(res, 1)); } });
    expect(r.pages).toHaveLength(20);
    expect(waits.filter((w) => w === 1000).length).toBeGreaterThan(5);
    expect(maxAfter).toBeLessThanOrEqual(4);
  });

  it('never runs more than 4 fetches at once', async () => {
    let inflight = 0;
    let max = 0;
    const urls = Array.from({ length: 30 }, (_, i) => `<url><loc>https://c.example/p${i}</loc></url>`).join('');
    const fetcher: Fetcher = async (u) => {
      if (u.endsWith('/sitemap.xml')) return xml(u, `<urlset>${urls}</urlset>`);
      inflight++;
      max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight--;
      return ok(u, html('<h1>x</h1>'));
    };
    const r = await crawl('https://c.example', { fetcher });
    expect(r.pages).toHaveLength(30);
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1);
  });
});

describe('PITCREW_CAP override', () => {
  it('is clamped to 1..1000 and ignored when not a positive number', async () => {
    const { capFromEnv } = await import('../scripts/lib/crawl.ts');
    expect(capFromEnv('3')).toBe(3);
    expect(capFromEnv('5000')).toBe(1000);
    expect(capFromEnv('1000')).toBe(1000);
    expect(capFromEnv('0.5')).toBe(1);
    expect(capFromEnv('2.7')).toBe(2);
    for (const v of [undefined, '', '0', '-4', 'abc', 'Infinity']) expect(capFromEnv(v), String(v)).toBeUndefined();
  });
});

describe('include sections that match nothing', () => {
  it('sitemap mode lists them in emptySections', async () => {
    const r = await crawl(TRAIL, { fetcher: sampleFetcher('trailhead-parts.example'), include: ['/collections/', '/nope/'] });
    expect(r.pages.length).toBeGreaterThan(0);
    expect(r.emptySections).toEqual(['/nope/']);
  });
  it('is absent when every section matched', async () => {
    const r = await crawl(TRAIL, { fetcher: sampleFetcher('trailhead-parts.example'), include: ['/collections/'] });
    expect(r.emptySections).toBeUndefined();
  });
});
