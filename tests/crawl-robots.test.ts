import { describe, it, expect } from 'vitest';
import { crawl, sampleFetcher } from '../scripts/lib/crawl.ts';
import type { Fetcher } from '../scripts/lib/crawl.ts';

const RIDGE = 'https://ridgeline-plumbing.example';
const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const ok = (url: string, body: string, type = 'text/html') => ({ status: 200, type, body, finalUrl: url, headers: {} });
const missing = (url: string) => ({ status: 404, type: '', body: '', finalUrl: url, headers: {} });

describe('crawl: robots.txt', () => {
  const STAR = ['User-agent: *', 'Disallow: /private/', 'Disallow: /*.htm$', 'Allow: /private/open', 'Disallow: /cart/', ''];
  const PIT = ['User-agent: pitcrew', 'Disallow: /staff', ''];
  const ROBOTS_WITH_PITCREW = ['User-agent: googlebot', 'Disallow: /', '', ...STAR, ...PIT].join('\n');
  const ROBOTS_STAR_ONLY = ['User-agent: googlebot', 'Disallow: /', '', ...STAR].join('\n');
  const paths = ['/', '/a', '/private/secret', '/private/open', '/cart/x', '/cart2', '/staff/team', '/doc.htm', '/doc.htm/x'];
  const site = (withSitemap: boolean, robots: { status: number; body: string } | 'throw', seen: string[] = []): Fetcher => async (u) => {
    const p = new URL(u).pathname;
    seen.push(p);
    if (p === '/robots.txt') {
      if (robots === 'throw') throw new Error('network down');
      return { status: robots.status, type: 'text/plain', body: robots.body, finalUrl: u, headers: {} };
    }
    if (p === '/sitemap.xml') return withSitemap ? ok(u, `<urlset>${paths.map((x) => `<url><loc>https://r.example${x}</loc></url>`).join('')}</urlset>`, 'application/xml') : missing(u);
    if (paths.includes(p)) return ok(u, html(`<h1>${p}</h1>` + paths.map((x) => `<a href="${x}">l</a>`).join('')));
    return missing(u);
  };
  const ok200 = (body: string) => ({ status: 200, body });
  const kept = (r: Awaited<ReturnType<typeof crawl>>) => r.pages.map((p) => new URL(p.url).pathname).sort();
  const robotsDropped = (r: Awaited<ReturnType<typeof crawl>>) => r.dropped.filter((d) => d.reason === 'robots').map((d) => new URL(d.url).pathname).sort();

  it.each([[true], [false]])('with a pitcrew group, only its rules apply and * is ignored (sitemap=%s)', async (withSitemap) => {
    const r = await crawl('https://r.example', { fetcher: site(withSitemap, ok200(ROBOTS_WITH_PITCREW)) });
    expect(r.source).toBe(withSitemap ? 'sitemap' : 'links');
    expect(robotsDropped(r)).toEqual(['/staff/team']);
    expect(kept(r)).toEqual(paths.filter((x) => x !== '/staff/team').sort());
  });

  it.each([[true], [false]])('with no pitcrew group, the * group applies (sitemap=%s)', async (withSitemap) => {
    const r = await crawl('https://r.example', { fetcher: site(withSitemap, ok200(ROBOTS_STAR_ONLY)) });
    expect(kept(r)).toEqual(['/', '/a', '/private/open', '/cart2', '/staff/team', '/doc.htm/x'].sort());
    expect(robotsDropped(r)).toEqual(['/cart/x', '/doc.htm', '/private/secret']);
  });

  it('merges several pitcrew groups', async () => {
    const body = ['User-agent: pitcrew', 'Disallow: /staff', '', 'User-agent: *', 'Disallow: /a', '', 'User-agent: PitCrew', 'Disallow: /cart/', ''].join('\n');
    const r = await crawl('https://r.example', { fetcher: site(true, ok200(body)) });
    expect(robotsDropped(r)).toEqual(['/cart/x', '/staff/team']);
  });

  it('never requests a disallowed URL', async () => {
    for (const withSitemap of [true, false]) {
      const seen: string[] = [];
      await crawl('https://r.example', { fetcher: site(withSitemap, ok200(ROBOTS_STAR_ONLY), seen) });
      for (const d of ['/cart/x', '/doc.htm', '/private/secret']) expect(seen).not.toContain(d);
    }
  });

  it('fetches robots.txt once per crawl', async () => {
    for (const withSitemap of [true, false]) {
      const seen: string[] = [];
      await crawl('https://r.example', { fetcher: site(withSitemap, ok200(ROBOTS_STAR_ONLY), seen) });
      expect(seen.filter((p) => p === '/robots.txt')).toHaveLength(1);
    }
  });

  it('a 4xx robots.txt allows everything', async () => {
    const r = await crawl('https://r.example', { fetcher: site(true, { status: 404, body: '' }) });
    expect(kept(r)).toEqual([...paths].sort());
    expect(robotsDropped(r)).toEqual([]);
  });

  it('matches the normalised URL too: a trailing-slash rule blocks the slashless page', async () => {
    const r = await crawl('https://r.example', { fetcher: site(true, ok200('User-agent: *\nDisallow: /cart/\n')) });
    expect(robotsDropped(r)).toEqual(['/cart/x']);
  });

  it('a sampleFetcher-backed site with a Disallow rule drops that page (longest match wins)', async () => {
    const base = sampleFetcher('ridgeline-plumbing.example');
    const f: Fetcher = async (u) => (new URL(u).pathname === '/robots.txt' ? ok(u, 'User-agent: *\nDisallow: /blog/\nAllow: /blog/frozen-pipes-boise\n', 'text/plain') : base(u));
    const r = await crawl(RIDGE, { fetcher: f });
    const kept = r.pages.map((p) => new URL(p.url).pathname);
    expect(kept).toContain('/blog/frozen-pipes-boise');
    expect(kept).not.toContain('/blog/water-heater-anode-rod');
    expect(r.dropped.filter((d) => d.reason === 'robots').map((d) => new URL(d.url).pathname).sort())
      .toEqual(['/blog/sewer-camera-inspection-cost', '/blog/water-heater-anode-rod']);
  });

  it('an empty Disallow blocks nothing', async () => {
    const base = sampleFetcher('ridgeline-plumbing.example');
    const f: Fetcher = async (u) => (new URL(u).pathname === '/robots.txt' ? ok(u, 'User-agent: *\nDisallow:\n', 'text/plain') : base(u));
    expect((await crawl(RIDGE, { fetcher: f })).pages).toHaveLength(12);
  });
});
