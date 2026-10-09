import { parse } from 'node-html-parser';
import type { HTMLElement } from 'node-html-parser';
import type { PageRecord, PageType } from './types.ts';
import { decodeEntities } from './text.ts';
import { hostOf, normaliseUrl, slugFor } from './urls.ts';

export interface SiteLinks { inlinks: Map<string, number>; nav: Set<string> }

const TEXT_CAP = 20_000;
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Decoded plain text, whitespace-collapsed. */
const raw = (el: HTMLElement) => collapse(decodeEntities(el.rawText));

function resolve(base: string, href: string | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || /^(mailto:|tel:|javascript:|#)/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    return /^https?:$/.test(u.protocol) ? normaliseUrl(u.toString()) : null;
  } catch {
    return null;
  }
}

const isHome = (url: string) => {
  try { return new URL(url).pathname === '/'; } catch { return false; }
};

export function linkGraph(pages: { url: string; html: string }[]): SiteLinks {
  const inlinks = new Map<string, number>();
  const nav = new Set<string>();
  const host = pages.length ? hostOf(pages[0]!.url) : '';
  for (const p of pages) {
    const self = normaliseUrl(p.url);
    const root = parse(p.html);
    const seen = new Set<string>();
    for (const a of root.querySelectorAll('a')) {
      const t = resolve(p.url, a.getAttribute('href'));
      if (!t || t === self || hostOf(t) !== host || seen.has(t)) continue;
      seen.add(t);
      inlinks.set(t, (inlinks.get(t) ?? 0) + 1);
    }
    if (isHome(self)) {
      for (const a of root.querySelectorAll('nav a, header a')) {
        const t = resolve(p.url, a.getAttribute('href'));
        if (t && t !== self && hostOf(t) === host) nav.add(t);
      }
    }
  }
  return { inlinks, nav };
}

function jsonLdTypes(root: HTMLElement): string[] {
  const out = new Set<string>();
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      const t = o['@type'];
      if (typeof t === 'string') out.add(t);
      else if (Array.isArray(t)) t.forEach((x) => { if (typeof x === 'string') out.add(x); });
      if (o['@graph']) visit(o['@graph']);
    }
  };
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(s.rawText)); } catch { /* ignore malformed JSON-LD */ }
  }
  return [...out];
}

const CTA_RE = /\b(call|book|quote|schedule|contact|buy|add to cart|shop|get started|order)\b/i;

const CTA_CLASS = /(^|\s)(btn|button|cta)(\s|$)/i;

function findCta(main: HTMLElement): string | null {
  for (const el of main.querySelectorAll('a, button')) {
    const text = collapse(decodeEntities(el.rawText));
    if (text && (CTA_RE.test(text) || CTA_CLASS.test(el.getAttribute('class') ?? ''))) return [...text].slice(0, 80).join('');
  }
  return null;
}

const OTHER_PATH = /^\/(about|contact|privacy|terms|faq|careers)/i;
/** M16: a location page has one whole path segment from this list (so /products/city-bike-tire is not a location). */
const LOCATION_SEGMENTS = new Set(['areas', 'service-areas', 'locations', 'location', 'cities', 'city']);

function pageType(url: string, types: string[], isNav: boolean): PageType {
  const path = new URL(url).pathname;
  const has = (...t: string[]) => t.some((x) => types.includes(x));
  if (path === '/') return 'home';
  // Product, collection and article are checked before location: their path or JSON-LD is the stronger signal.
  if (/^\/products?\//i.test(path) || has('Product')) return 'product';
  if (/^\/collections?\//i.test(path) || has('ItemList')) return 'collection';
  if (/^\/blogs?(\/|$)/i.test(path) || has('Article', 'BlogPosting', 'NewsArticle')) return 'article';
  if (path.split('/').some((s) => LOCATION_SEGMENTS.has(s.toLowerCase()))) return 'location';
  if (isNav && !OTHER_PATH.test(path)) return 'service';
  return 'other';
}

export function extractPage(url: string, html: string, siteLinks: SiteLinks): PageRecord {
  const norm = normaliseUrl(url);
  const root = parse(html);
  const titleEl = root.querySelector('title');
  const metaEl = root.querySelectorAll('meta').find((m) => (m.getAttribute('name') ?? '').toLowerCase() === 'description');
  const metaRaw = metaEl?.rawAttributes['content'];
  const og = (prop: string) => {
    const el = root.querySelectorAll('meta').find((m) => (m.getAttribute('property') ?? '').toLowerCase() === prop);
    const v = el?.rawAttributes['content'];
    return v !== undefined ? collapse(decodeEntities(v)) || null : null;
  };
  const title = titleEl ? raw(titleEl) || null : null;
  const meta = metaRaw !== undefined ? collapse(decodeEntities(metaRaw)) || null : null;

  const mainEl = root.querySelector('main');
  const main = mainEl ?? root.querySelector('body') ?? root;
  const content = parse(main.outerHTML);
  if (!mainEl) {
    for (const el of content.querySelectorAll('nav, header, footer')) el.remove();
  }
  for (const el of content.querySelectorAll('script, style, noscript, head, title')) el.remove();
  const text = [...collapse(decodeEntities(content.rawText))].slice(0, TEXT_CAP).join('');
  const intro = text.split(' ').filter(Boolean).slice(0, 100).join(' ');

  const imgs = (root.querySelector('body') ?? root).querySelectorAll('img');
  const altMissing = imgs.filter((i) => !(i.getAttribute('alt') ?? '').trim()).length;
  const types = jsonLdTypes(root);
  const navLinked = siteLinks.nav.has(norm);

  return {
    url: norm,
    slug: slugFor(norm),
    type: pageType(norm, types, navLinked),
    title, meta,
    h1s: root.querySelectorAll('h1').map(raw).filter(Boolean),
    h2s: root.querySelectorAll('h2').map(raw).filter(Boolean),
    intro, text,
    jsonLdTypes: types,
    altMissing, altTotal: imgs.length,
    cta: mainEl ? findCta(mainEl) : null,
    inlinks: siteLinks.inlinks.get(norm) ?? 0,
    navLinked,
    ogTitle: og('og:title'), ogDescription: og('og:description'),
  };
}
