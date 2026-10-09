import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { crawl } from '../scripts/lib/crawl.ts';
import type { Fetcher } from '../scripts/lib/crawl.ts';
import { fetchRaw } from '../scripts/lib/fetch.ts';

const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const res = (url: string, status: number | null, body = '', type = 'text/plain') => ({ status, type, body, finalUrl: url, headers: {} });
const paths = ['/', '/a', '/private/open/', '/private/secret'];

interface Script { robots: (n: number) => ReturnType<typeof res> | 'throw'; calls: { robots: number; others: string[]; robotsOpts: unknown[] } }
function site(robots: Script['robots']): { fetcher: Fetcher; s: Script } {
  const s: Script = { robots, calls: { robots: 0, others: [], robotsOpts: [] } };
  const fetcher: Fetcher = async (u, opts) => {
    const p = new URL(u).pathname;
    if (p === '/robots.txt') {
      s.calls.robots++;
      s.calls.robotsOpts.push(opts);
      const r = robots(s.calls.robots);
      if (r === 'throw') throw new Error('timed out');
      return { ...r, finalUrl: u };
    }
    s.calls.others.push(p);
    if (p === '/sitemap.xml') return res(u, 200, `<urlset>${paths.map((x) => `<url><loc>https://r.example${x}</loc></url>`).join('')}</urlset>`, 'application/xml');
    if (paths.includes(p) || paths.includes(p + '/')) return res(u, 200, html(`<h1>${p}</h1>`), 'text/html');
    return res(u, 404);
  };
  return { fetcher, s };
}
const RULES = 'User-agent: *\nDisallow: /private/secret\n';
const sleeper = () => { const waits: number[] = []; return { waits, sleep: async (ms: number) => { waits.push(ms); } }; };
const kept = (r: Awaited<ReturnType<typeof crawl>>) => r.pages.map((p) => new URL(p.url).pathname).sort();

describe('crawl: robots.txt retries', () => {
  it.each([[503], [500], [429], [null]])('a transient %s then 200 still crawls (and obeys the file)', async (bad) => {
    const { fetcher, s } = site((n) => (n === 1 ? res('', bad) : res('', 200, RULES)));
    const { sleep, waits } = sleeper();
    const r = await crawl('https://r.example', { fetcher, sleep });
    expect(r.robotsUnreachable).toBeFalsy();
    expect(s.calls.robots).toBe(2);
    expect(waits).toHaveLength(1);
    expect(kept(r)).toEqual(['/', '/a', '/private/open'].sort());
    expect(r.dropped.filter((d) => d.reason === 'robots')).toHaveLength(1);
  });

  it('a thrown error then 200 crawls', async () => {
    const { fetcher } = site((n) => (n < 3 ? 'throw' : res('', 200, RULES)));
    const { sleep, waits } = sleeper();
    const r = await crawl('https://r.example', { fetcher, sleep });
    expect(waits).toHaveLength(2);
    expect(r.pages.length).toBe(3);
  });

  it.each([[503], [429], [null]])('persistent %s: three tries, then robotsUnreachable with no pages and no per-URL robots drops', async (bad) => {
    const { fetcher, s } = site(() => res('', bad));
    const { sleep, waits } = sleeper();
    const r = await crawl('https://r.example', { fetcher, sleep });
    expect(s.calls.robots).toBe(3);
    expect(waits).toHaveLength(2);
    expect(r.robotsUnreachable).toBe(true);
    expect(r.pages).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(s.calls.others).toEqual([]);
    expect(r.robotsProblem).toBe(bad === null ? 'no answer' : `HTTP ${bad}`);
  });

  it('persistent thrown errors report the error text', async () => {
    const { fetcher } = site(() => 'throw');
    const r = await crawl('https://r.example', { fetcher, sleep: async () => {} });
    expect(r.robotsUnreachable).toBe(true);
    expect(r.robotsProblem).toContain('timed out');
  });

  it('a 404 is not retried and allows everything', async () => {
    const { fetcher, s } = site(() => res('', 404));
    const r = await crawl('https://r.example', { fetcher, sleep: async () => {} });
    expect(s.calls.robots).toBe(1);
    expect(r.pages).toHaveLength(4);
  });

  it('asks for the robots.txt body whatever its content type', async () => {
    const { fetcher, s } = site(() => res('', 200, RULES, 'application/octet-stream'));
    const r = await crawl('https://r.example', { fetcher, sleep: async () => {} });
    expect(s.calls.robotsOpts[0]).toEqual({ anyType: true });
    expect(r.dropped.filter((d) => d.reason === 'robots')).toHaveLength(1);
  });

  it('fetchRaw keeps a non-text body only when anyType is set', async () => {
    const fetchImpl = (async () => new Response('User-agent: *\nDisallow: /x\n', { status: 200, headers: { 'content-type': 'application/octet-stream' } })) as typeof fetch;
    expect((await fetchRaw('https://r.example/robots.txt', { fetchImpl })).body).toBe('');
    expect((await fetchRaw('https://r.example/robots.txt', { fetchImpl, anyType: true })).body).toContain('Disallow');
  });

  it('an Allow on the as-requested URL is not overridden by the normalised form', async () => {
    const { fetcher } = site(() => res('', 200, 'User-agent: *\nAllow: /private/open/\nDisallow: /private/\n'));
    const r = await crawl('https://r.example', { fetcher, sleep: async () => {} });
    expect(kept(r)).toContain('/private/open');
    expect(r.dropped.filter((d) => d.reason === 'robots').map((d) => new URL(d.url).pathname)).toEqual(['/private/secret']);
  });

  it('falls back to the normalised form when the as-requested URL matches no rule', async () => {
    const { fetcher } = site(() => res('', 200, 'User-agent: *\nDisallow: /private/open$\n'));
    const r = await crawl('https://r.example', { fetcher, sleep: async () => {} });
    expect(kept(r)).not.toContain('/private/open');
  });
});

describe('cli crawl: robots.txt unreachable', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => { if (server) server.close(() => done()); else done(); }));

  it('exits 1 with a plain message and crawls nothing', async () => {
    server = createServer((req, rsp) => { rsp.statusCode = req.url === '/robots.txt' ? 503 : 200; rsp.end('x'); });
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    const root = join(import.meta.dirname, '..');
    const out = await new Promise<{ code: number | null; stdout: string }>((done) => {
      const child = spawn(process.execPath, [join(root, 'scripts', 'pitcrew.ts'), 'crawl', '--site', `http://127.0.0.1:${port}`], { env: { ...process.env, PITCREW_NO_OPEN: '1' } });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (code) => done({ code, stdout }));
    });
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout).error).toBe("Couldn't read robots.txt (HTTP 503) after 3 tries, so Pit Crew didn't crawl. Try again in a few minutes.");
  }, 30000);
});
