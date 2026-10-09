import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';
import { USER_AGENT, fetchRaw } from './fetch.ts';
import { hostOf, normaliseUrl, sectionOf, slugFor } from './urls.ts';

export type Fetcher = (url: string, opts?: { anyType?: boolean }) => Promise<{
  status: number | null;
  type: string;
  body: string;
  finalUrl: string;
  headers: Record<string, string>;
  error?: string;
}>;

export type DropReason = 'robots' | 'noindex' | 'canonical' | 'status' | 'not-html' | 'pagination' | 'query';

export interface CrawlResult {
  /** headers: the page's response headers (lowercased names), for platform detection. */
  pages: { url: string; html: string; headers?: Record<string, string> }[];
  /** httpStatus: the HTTP status for a 'status' drop, when the server answered. */
  dropped: { url: string; reason: DropReason; httpStatus?: number }[];
  sections: Record<string, number>;
  source: 'sitemap' | 'links';
  capped: boolean;
  /** With include: how many URLs the chosen sections held before the cap (I6). */
  selected?: number;
  /** robots.txt could not be read after 3 tries (server error, 429 or no answer): nothing was crawled. */
  robotsUnreachable?: boolean;
  /** Plain description of the robots.txt problem, such as "HTTP 503". */
  robotsProblem?: string;
  /** With include: the sections that matched no URL (a typo, or a Git Bash path recovered to the wrong name). */
  emptySections?: string[];
}

export interface CrawlOptions {
  fetcher: Fetcher;
  cap?: number;
  include?: string[];
  concurrency?: number;
  /** Waits between robots.txt tries; tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CAP = 1000;

/**
 * PITCREW_CAP is a test-only override: it lets the tests exercise the cap on a small fixture. It can only lower the
 * cap, so it is clamped to 1..1,000; anything that is not a positive finite number is ignored.
 */
export function capFromEnv(raw: string | undefined): number | undefined {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(1, Math.min(Math.floor(n), DEFAULT_CAP));
}
/** M3: a page that answers 429 or 503 is tried once more after Retry-After (at most 30 s). */
const PAGE_RETRY_DEFAULT_S = 2;
const PAGE_RETRY_MAX_S = 30;

const fmt = (n: number) => n.toLocaleString('en-US');
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** I6: the plain-English note when --include still left more pages than the cap. */
export function truncationMessage(kept: number, total: number, sections: string[]): string {
  return `Kept the first ${fmt(kept)} of ${fmt(total)} pages in ${listOf(sections)}.`;
}

/** M3: when every page was refused with 403, the site is almost certainly blocking bots; say so and how to fix it. Null otherwise. */
export function crawlBlockedMessage(dropped: CrawlResult['dropped'], host: string): string | null {
  const status = dropped.filter((d) => d.reason === 'status');
  if (!status.length || !status.every((d) => d.httpStatus === 403)) return null;
  return `${host} refused every page with "403 Forbidden". That is usually bot protection (Cloudflare or a security plugin) blocking Pit Crew. Allow the user agent "${USER_AGENT}" in that tool, or ask your host to, then run Pit Crew again.`;
}
const MAX_SITEMAP_DEPTH = 3;
const SKIP_EXT = /\.(?:jpe?g|png|gif|webp|svg|ico|pdf|zip|css|js|json|xml|txt|mp4|mp3|woff2?)$/i;

/** The real-network fetcher: fetchRaw (UA, timeout, curl 403 retry) plus final URL and headers. */
export const networkFetcher: Fetcher = async (url, opts) => {
  const r = await fetchRaw(url, { anyType: opts?.anyType });
  return { status: r.status, type: r.type, body: r.body, finalUrl: r.finalUrl ?? url, headers: r.headers ?? {}, error: r.error };
};

const FIXTURES_ROOT = fileURLToPath(new URL('../../fixtures/', import.meta.url));

/**
 * Serves a fixture site from fixtures/<domain>/ with no network.
 * `/sitemap.xml`, `/robots.txt` and any other `.xml`/`.txt` path map to the same path in the
 * fixture folder; every other URL maps to pages/<slugFor(url)>.html. A missing file is a 404.
 */
export function sampleFetcher(fixtureDomain: string): Fetcher {
  const root = `${FIXTURES_ROOT}${fixtureDomain}/`;
  return async (url) => {
    const miss = { status: 404, type: '', body: '', finalUrl: url, headers: {} };
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return miss;
    }
    const isFile = /\.(xml|txt)$/i.test(path);
    const rel = isFile ? path.replace(/^\/+/, '') : `pages/${slugFor(url)}.html`;
    if (rel.includes('..')) return miss;
    try {
      const body = await readFile(root + rel, 'utf8');
      const type = rel.endsWith('.xml') ? 'application/xml' : rel.endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8';
      return { status: 200, type, body, finalUrl: url, headers: {} };
    } catch {
      return miss;
    }
  };
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
}

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function readSitemap(fetcher: Fetcher, url: string, depth: number, seen: Set<string>): Promise<string[]> {
  if (depth > MAX_SITEMAP_DEPTH || seen.has(url)) return [];
  seen.add(url);
  const r = await fetcher(url);
  if (r.status !== 200 || !r.body) return [];
  const found = locs(r.body);
  if (/<sitemapindex/i.test(r.body)) {
    const out: string[] = [];
    for (const child of found) out.push(...(await readSitemap(fetcher, child, depth + 1, seen)));
    return out;
  }
  return found;
}

async function sitemapUrls(origin: string, fetcher: Fetcher, robots: Robots): Promise<string[]> {
  const seen = new Set<string>();
  const direct = await readSitemap(fetcher, `${origin}/sitemap.xml`, 1, seen);
  if (direct.length) return direct;
  if (robots.status !== 200) return [];
  const lines = [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const out: string[] = [];
  for (const l of lines) out.push(...(await readSitemap(fetcher, l, 1, seen)));
  return out;
}

interface RobotsRule { allow: boolean; re: RegExp; len: number }
type Robots = { status: number | null; body: string; problem: string };

/**
 * Rules for our user agent, chosen as RFC 9309 says: the group(s) naming `pitcrew` if any exist (several are merged),
 * otherwise the `*` group(s). The two are never combined. Longest matching rule wins; on a tie Allow wins.
 * `*` matches any run and a trailing `$` anchors the end.
 */
function parseRobots(body: string): (pathAndQuery: string) => boolean | null {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let inRules = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || inRules) { current = { agents: [], rules: [] }; groups.push(current); inRules = false; }
      current.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (!current || value === '') continue;
      const anchored = value.endsWith('$');
      const pattern = (anchored ? value.slice(0, -1) : value).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      current.rules.push({ allow: key === 'allow', re: new RegExp(`^${pattern}${anchored ? '$' : ''}`), len: value.replace(/\$$/, '').length });
    }
  }
  const named = groups.filter((g) => g.agents.includes('pitcrew'));
  const rules = (named.length ? named : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  return (target) => {
    let best: RobotsRule | null = null;
    for (const r of rules) {
      if (!r.re.test(target)) continue;
      if (!best || r.len > best.len || (r.len === best.len && r.allow && !best.allow)) best = r;
    }
    return best === null ? null : best.allow;
  };
}

const ROBOTS_TRIES = 3;
const ROBOTS_BACKOFF_MS = [500, 1500];
const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** 5xx, 429 (Google treats it the same) and no answer are worth another try; anything else is the site's answer. */
const robotsTransient = (status: number | null) => status === null || status >= 500 || status === 429;

/** Fetches robots.txt, up to 3 tries with a short wait between. The body is read whatever its content type. */
async function fetchRobots(origin: string, fetcher: Fetcher, sleep: (ms: number) => Promise<void>): Promise<Robots> {
  let last: Robots = { status: null, body: '', problem: 'no answer' };
  for (let n = 0; n < ROBOTS_TRIES; n++) {
    if (n > 0) await sleep(ROBOTS_BACKOFF_MS[n - 1] ?? 1500);
    try {
      const r = await fetcher(`${origin}/robots.txt`, { anyType: true });
      last = { status: r.status, body: r.body, problem: r.status === null ? (r.error ?? 'no answer') : `HTTP ${r.status}` };
    } catch (e) {
      last = { status: null, body: '', problem: e instanceof Error ? e.message : String(e) };
    }
    if (!robotsTransient(last.status)) break;
  }
  return last;
}

/**
 * RFC 9309: 2xx means obey the file; 4xx (other than 429) means no robots.txt, so everything is allowed. Server errors
 * are handled before this (the crawl stops). The URL is checked as requested; only when that matches no rule is its
 * normalised form (query and trailing slash removed) checked too.
 */
function robotsAllows(robots: Robots): (url: string) => boolean {
  if (robots.status === null || robots.status < 200 || robots.status >= 300) return () => true;
  const allowed = parseRobots(robots.body);
  const check = (url: string) => { const u = new URL(url); return allowed(u.pathname + u.search); };
  return (url) => {
    try {
      return check(url) ?? check(normaliseUrl(url)) ?? true;
    } catch {
      return true;
    }
  };
}

/** Pagination and query variants are not separate pages. Query is checked on the raw URL, before normalising. */
function preFilter(url: string): DropReason | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'status';
  }
  if (/\/page\/\d+(?:\/|$)/i.test(u.pathname) || u.searchParams.has('page')) return 'pagination';
  if (u.search) return 'query';
  return null;
}

async function pool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (i < items.length) await work(items[i++]);
  });
  await Promise.all(lanes);
}

type Verdict = { kind: 'keep'; html: string; links: string[]; headers: Record<string, string> } | { kind: 'drop'; reason: DropReason; links: string[]; httpStatus?: number };

function linksIn(root: ReturnType<typeof parse>, base: string): string[] {
  const out: string[] = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (!href || /^(?:mailto|tel|javascript|sms):/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      out.push(u.toString());
    } catch {
      // malformed href: skip
    }
  }
  return out;
}

async function inspect(fetcher: Fetcher, url: string, sleep: (ms: number) => Promise<void>): Promise<Verdict> {
  let r;
  try {
    r = await fetcher(url);
    if (r.status === 429 || r.status === 503) {
      const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const secs = Number(h['retry-after']);
      await sleep(Math.min(Number.isFinite(secs) && secs > 0 ? secs : PAGE_RETRY_DEFAULT_S, PAGE_RETRY_MAX_S) * 1000);
      r = await fetcher(url);
    }
  } catch {
    return { kind: 'drop', reason: 'status', links: [] };
  }
  if (r.status === null) return { kind: 'drop', reason: 'status', links: [] };
  if (r.status < 200 || r.status > 299) return { kind: 'drop', reason: 'status', links: [], httpStatus: r.status };
  if (!/html/i.test(r.type) && !/^\s*(?:<!doctype html|<html)/i.test(r.body)) return { kind: 'drop', reason: 'not-html', links: [] };
  const root = parse(r.body);
  const links = linksIn(root, r.finalUrl || url);
  const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (/noindex/i.test(headers['x-robots-tag'] ?? '')) return { kind: 'drop', reason: 'noindex', links };
  for (const m of root.querySelectorAll('meta')) {
    if ((m.getAttribute('name') ?? '').toLowerCase() === 'robots' && /noindex/i.test(m.getAttribute('content') ?? '')) {
      return { kind: 'drop', reason: 'noindex', links };
    }
  }
  for (const l of root.querySelectorAll('link')) {
    if ((l.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) {
      const href = l.getAttribute('href');
      if (href) {
        try {
          if (normaliseUrl(new URL(href, r.finalUrl || url).toString()) !== normaliseUrl(url)) return { kind: 'drop', reason: 'canonical', links };
        } catch {
          // unparseable canonical: ignore
        }
      }
      break;
    }
  }
  return { kind: 'keep', html: r.body, links, headers };
}

function countSections(urls: string[]): Record<string, number> {
  const sections: Record<string, number> = {};
  for (const u of urls) {
    const s = sectionOf(u);
    sections[s] = (sections[s] ?? 0) + 1;
  }
  return sections;
}

/** The site root is listed as "home" in a section listing the owner picks from. */
function homeKey(sections: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k === '/' ? 'home' : k, v]));
}

const sameHost = (a: string, b: string) => hostOf(a) === hostOf(b);
const dropOf = (url: string, v: Extract<Verdict, { kind: 'drop' }>): CrawlResult['dropped'][number] =>
  (v.httpStatus !== undefined ? { url, reason: v.reason, httpStatus: v.httpStatus } : { url, reason: v.reason });

export async function crawl(origin: string, opts: CrawlOptions): Promise<CrawlResult> {
  const { fetcher } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const cap = opts.cap ?? DEFAULT_CAP;
  const concurrency = opts.concurrency ?? 4;
  const include = opts.include?.map((s) => s.toLowerCase());
  /** The include sections none of these URLs fall in, as a spreadable result field. */
  const emptyOf = (urls: string[]): { emptySections?: string[] } => {
    const empty = (include ?? []).filter((s) => !urls.some((u) => sectionOf(u) === s));
    return empty.length ? { emptySections: empty.map((e) => (e === '/' ? 'home' : e)) } : {};
  };
  const base = origin.replace(/\/+$/, '');
  const dropped: CrawlResult['dropped'] = [];
  const pages: CrawlResult['pages'] = [];

  const robots = await fetchRobots(base, fetcher, sleep);
  if (robotsTransient(robots.status)) {
    return { pages: [], dropped: [], sections: {}, source: 'links', capped: false, robotsUnreachable: true, robotsProblem: robots.problem };
  }
  const allowed = robotsAllows(robots);
  const raw = (await sitemapUrls(base, fetcher, robots)).filter((u) => sameHost(u, base));
  if (raw.length) return fromSitemap(raw);
  return fromLinks();

  async function fromSitemap(rawUrls: string[]): Promise<CrawlResult> {
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const u of rawUrls) {
      const reason = preFilter(u);
      if (reason) {
        if (!dropped.some((d) => d.url === u)) dropped.push({ url: u, reason });
        continue;
      }
      if (!allowed(u)) {
        if (!dropped.some((d) => d.url === u)) dropped.push({ url: u, reason: 'robots' });
        continue;
      }
      const n = normaliseUrl(u);
      if (seen.has(n)) continue;
      seen.add(n);
      candidates.push(n);
    }
    const sections = countSections(candidates);
    if (!include && candidates.length > cap) return { pages: [], dropped, sections: homeKey(sections), source: 'sitemap', capped: true };
    let chosen = include ? candidates.filter((u) => include.includes(sectionOf(u))) : candidates;
    const selected = chosen.length;
    const capped = chosen.length > cap;
    if (capped) chosen = chosen.slice(0, cap);

    const verdicts = new Map<string, Verdict>();
    await pool(chosen, concurrency, async (u) => {
      verdicts.set(u, await inspect(fetcher, u, sleep));
    });
    for (const u of chosen) {
      const v = verdicts.get(u)!;
      if (v.kind === 'keep') pages.push({ url: u, html: v.html, headers: v.headers });
      else dropped.push(dropOf(u, v));
    }
    return {
      pages, dropped, sections: countSections(pages.map((p) => p.url)), source: 'sitemap', capped, ...(include ? { selected } : {}),
      ...emptyOf(candidates),
    };
  }

  async function fromLinks(): Promise<CrawlResult> {
    const home = normaliseUrl(`${base}/`);
    const queued = new Set<string>([home]);
    const droppedSeen = new Set<string>();
    const queue: string[] = [];
    if (allowed(home)) queue.push(home);
    else dropped.push({ url: home, reason: 'robots' });
    const ceiling = cap * 2; // dropped pages do not count toward the cap, so allow some slack
    let fetches = 0;
    let capped = false;
    while (queue.length && !capped) {
      if (fetches >= ceiling) {
        capped = true;
        break;
      }
      const batch = queue.splice(0, Math.min(concurrency, ceiling - fetches));
      fetches += batch.length;
      const verdicts = new Map<string, Verdict>();
      await pool(batch, concurrency, async (u) => {
        verdicts.set(u, await inspect(fetcher, u, sleep));
      });
      for (const u of batch) {
        const v = verdicts.get(u)!;
        if (v.kind === 'keep') {
          if (!include || include.includes(sectionOf(u))) {
            if (pages.length >= cap) capped = true;
            else pages.push({ url: u, html: v.html, headers: v.headers });
          }
        } else {
          dropped.push(dropOf(u, v));
        }
        for (const l of v.links) {
          if (!sameHost(l, base) || SKIP_EXT.test(new URL(l).pathname)) continue;
          const reason = preFilter(l);
          if (reason) {
            if (!droppedSeen.has(l)) {
              droppedSeen.add(l);
              dropped.push({ url: l, reason });
            }
            continue;
          }
          if (!allowed(l)) {
            if (!droppedSeen.has(l)) {
              droppedSeen.add(l);
              dropped.push({ url: l, reason: 'robots' });
            }
            continue;
          }
          const n = normaliseUrl(l);
          if (queued.has(n)) continue;
          queued.add(n);
          queue.push(n);
        }
      }
      if (pages.length >= cap && queue.length) capped = true;
    }
    return { pages, dropped, sections: countSections(pages.map((p) => p.url)), source: 'links', capped, ...emptyOf(pages.map((p) => p.url)) };
  }
}
