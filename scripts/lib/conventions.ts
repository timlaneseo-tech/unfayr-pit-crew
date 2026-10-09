import type { Convention, PageRecord, PageType } from './types.ts';
import { charLen } from './text.ts';
import { SEPARATORS } from './readout.ts';

export interface TitleAnalysis {
  separators: Record<string, number>;
  brandFirst: number; brandLast: number; brandMissing: number;
  titleCase: number; sentenceCase: number;
  lengthP50: number; lengthP90: number;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Nearest-rank percentile of a sorted list. */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Segments of a title split on the common separators (not ':' so "Topic: Promise" stays whole). */
const SEGMENT_SPLIT = / [|–—·»-] |[|·»]/;

/** 'title' | 'sentence' | null (cannot tell) for the page's own wording, brand excluded. */
function caseOf(title: string, brand: string): 'title' | 'sentence' | null {
  const b = norm(brand);
  const seg = title.split(SEGMENT_SPLIT).map((s) => s.trim()).find((s) => s && norm(s) !== b);
  if (!seg) return null;
  const words = seg.split(/\s+/).slice(1).filter((w) => /^\p{L}{4,}/u.test(w));
  if (words.length === 0) return null;
  return words.every((w) => /^\p{Lu}/u.test(w)) ? 'title' : 'sentence';
}

export function analyseTitles(pages: PageRecord[], brand: string): TitleAnalysis {
  const a: TitleAnalysis = { separators: {}, brandFirst: 0, brandLast: 0, brandMissing: 0, titleCase: 0, sentenceCase: 0, lengthP50: 0, lengthP90: 0 };
  const lens: number[] = [];
  const b = norm(brand);
  for (const p of pages) {
    if (!p.title) continue;
    const t = p.title;
    lens.push(charLen(t));
    for (const [name, re] of SEPARATORS) if (re.test(t)) a.separators[name] = (a.separators[name] ?? 0) + 1;
    const n = norm(t);
    if (b && n.startsWith(b)) a.brandFirst++;
    else if (b && n.endsWith(b)) a.brandLast++;
    else a.brandMissing++; // absent, or only buried mid-title
    const c = caseOf(t, brand);
    if (c === 'title') a.titleCase++;
    else if (c === 'sentence') a.sentenceCase++;
  }
  lens.sort((x, y) => x - y);
  a.lengthP50 = pct(lens, 50);
  a.lengthP90 = pct(lens, 90);
  return a;
}

const DEFAULT_PATTERNS: Partial<Record<PageType, string>> = {
  home: '{Brand promise}',
  service: '{Service} in {City}',
  location: '{Service} in {City}',
  product: '{Product} {Key spec}',
  collection: '{Category} {Qualifier}',
  article: '{Topic}: {Promise}',
};

function toConventionSep(s: string | undefined): Convention['separator'] {
  if (s === ':') return ':';
  if (s === '–' || s === '-' || s === '—') return '–';
  return '|';
}

export function candidateConventions(a: TitleAnalysis, brand: string, types: PageType[]): Convention[] {
  const patterns: Partial<Record<PageType, string>> = {};
  for (const t of types) if (DEFAULT_PATTERNS[t]) patterns[t] = DEFAULT_PATTERNS[t];
  const make = (separator: Convention['separator'], c: Convention['case']): Convention =>
    ({ separator, brand, brandPosition: 'end-if-fits', case: c, patterns: { ...patterns } });

  let top: string | undefined;
  let topN = 0;
  for (const [s, n] of Object.entries(a.separators)) if (n > topN) { top = s; topN = n; }
  const siteCase: Convention['case'] = a.sentenceCase > a.titleCase ? 'sentence' : 'title';

  const first = make(toConventionSep(top), siteCase);
  let second = make('|', 'title');
  let third = make('–', 'sentence');
  // Keep all three distinct without touching the site-matching first option.
  if (second.separator === first.separator && second.case === first.case) second = make('|', first.case === 'title' ? 'sentence' : 'title');
  if (third.separator === first.separator && third.case === first.case) third = make('–', 'title');
  return [first, second, third];
}

export function applyBrand(core: string, c: Convention, type: PageType): string {
  if (!c.brand) return core;
  const branded = `${core} ${c.separator} ${c.brand}`;
  if (type === 'home') return branded;
  return charLen(branded) > 60 ? core : branded;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function patternRegex(c: Convention, type: PageType): RegExp | null {
  const pat = c.patterns[type];
  if (!pat) return null;
  const body = pat.split(/(\{[^}]+\})/).map((part) => (/^\{[^}]+\}$/.test(part) ? '(.+?)' : esc(part))).join('');
  const suffix = c.brand ? `${esc(` ${c.separator} ${c.brand}`)}` : '';
  const tail = !suffix ? '' : c.brandPosition === 'end' ? suffix : `(?:${suffix})?`;
  return new RegExp(`^${body}${tail}$`);
}

const SUBDOMAIN_PREFIXES = new Set(['www', 'shop', 'store', 'parts', 'm', 'en', 'us', 'blog']);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

const GENERIC_SEGMENT = new Set(['home', 'shop', 'store', 'products', 'product', 'collections', 'collection', 'page', 'pages', 'blog', 'news', 'search']);
const isGenericSegment = (seg: string) => seg.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).every((w) => GENERIC_SEGMENT.has(w));

/** The first label of the registrable domain, title-cased: parts.rtlequipment.com gives Rtlequipment. */
function brandFromHost(host: string): string {
  const labels = host.toLowerCase().split(':')[0]!.split('.').filter(Boolean);
  while (labels.length > 2 && SUBDOMAIN_PREFIXES.has(labels[0]!)) labels.shift();
  const tld = labels[labels.length - 1] ?? '';
  const sld = labels[labels.length - 2] ?? '';
  const keep = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  const label = labels.length >= keep ? labels[labels.length - keep]! : labels[0] ?? host;
  return label.replace(/^./, (c) => c.toUpperCase());
}

/**
 * Best guess at the brand name: the string most titles end (or start) with after a separator, else the
 * registrable domain's first label, title-cased (subdomain prefixes such as www, shop and parts are ignored).
 */
export function guessBrand(host: string, pages: PageRecord[]): string {
  const titles = pages.map((p) => p.title).filter((t): t is string => !!t);
  if (titles.length >= 3) {
    for (const pick of ['last', 'first'] as const) {
      const counts = new Map<string, { text: string; n: number }>();
      for (const t of titles) {
        const segs = t.split(SEGMENT_SPLIT).map((x) => x.trim()).filter(Boolean);
        if (segs.length < 2) continue;
        const seg = pick === 'last' ? segs[segs.length - 1]! : segs[0]!;
        if (isGenericSegment(seg)) continue;
        const key = norm(seg);
        const cur = counts.get(key);
        if (cur) cur.n++;
        else counts.set(key, { text: seg, n: 1 });
      }
      const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
      const [best, n] = top ? [top.text, top.n] : ['', 0];
      if (best && n >= 3 && n * 10 >= titles.length * 6) return best;
    }
  }
  return brandFromHost(host);
}
