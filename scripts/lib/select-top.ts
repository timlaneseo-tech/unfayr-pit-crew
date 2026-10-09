import { normaliseUrl } from './urls.ts';
import type { Interview, PageRecord } from './types.ts';

/** Answers that name what the business sells or does; pages about these rank first after home. */
const FOCUS_IDS = new Set(['categories', 'services_main']);
const STOP = new Set(['and', 'the', 'for', 'with', 'that', 'this', 'from', 'your', 'our', 'are', 'all', 'any', 'more', 'other', 'also', 'such', 'parts', 'part', 'products', 'product', 'services', 'service', 'tools', 'accessories', 'quality', 'equipment', 'shop', 'store', 'online', 'best']);
/** Legal and utility pages: ranked last among the top pages when their type is `other`. */
const UTILITY = /\b(privacy|opt[\s_-]?out|data[\s_-]?shar\w*|do[\s_-]not[\s_-]sell|terms|conditions|cookie\w*|search[\s_-]?results?|cart|account|login|log[\s_-]?in|sign[\s_-]?in|checkout|policy|policies|disclaimer)\b/i;
const THIN_WORDS = 40;

/** Singular/plural-insensitive stem: brakes and brake both give brak, batteries and battery both give battery. */
const stem = (w: string) => (/ies$/.test(w) ? w.replace(/ies$/, 'y') : w.replace(/(es|(?<!s)s)$/, '')).replace(/e$/, '');
const tokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

function focusWords(interview?: Pick<Interview, 'answers'> | null): Set<string> {
  const out = new Set<string>();
  for (const a of interview?.answers ?? []) {
    if (!FOCUS_IDS.has(a.id) || !a.answer) continue;
    for (const w of tokens(a.answer)) if (w.length >= 4 && !STOP.has(w)) out.add(stem(w));
  }
  return out;
}

/** Picks the pages that get deep research, in rank order. Home first; then by clicks if known. */
export function selectTop(pages: PageRecord[], clicks?: Map<string, number>, n = 25, interview?: (Pick<Interview, 'answers'> & { brand?: string }) | null): string[] {
  const clickByUrl = new Map<string, number>();
  if (clicks) {
    for (const [key, count] of clicks) {
      const k = normaliseUrl(key);
      clickByUrl.set(k, (clickByUrl.get(k) ?? 0) + count);
    }
  }
  const seen = new Set<string>();
  const unique = pages.filter((p) => !seen.has(p.url) && seen.add(p.url));
  const clickOf = (p: PageRecord) => clickByUrl.get(p.url) ?? 0;

  const byStructure = (a: PageRecord, b: PageRecord) =>
    Number(b.navLinked) - Number(a.navLinked) || b.inlinks - a.inlinks || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  const byClicks = (a: PageRecord, b: PageRecord) =>
    clickOf(b) - clickOf(a) || b.inlinks - a.inlinks || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);

  const focus = focusWords(interview);
  const brand = (interview?.brand ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const pathOf = (p: PageRecord) => `${p.slug} ${p.url.replace(/^https?:\/\/[^/]+/, '')}`;
  const titleOf = (p: PageRecord) =>
    (p.title ?? '').split(/ [|–—·»-] |[|·»]/).filter((seg) => seg.toLowerCase().replace(/\s+/g, ' ').trim() !== brand).join(' ');
  const hits = (text: string) => focus.size > 0 && tokens(text).some((w) => focus.has(stem(w)));
  const label = (p: PageRecord) => `${pathOf(p)} ${titleOf(p)}`;
  const isUtility = (p: PageRecord) => p.type === 'other' && UTILITY.test(label(p).replace(/[_/]/g, ' '));
  const isThin = (p: PageRecord) => p.text.split(/\s+/).filter(Boolean).length < THIN_WORDS;
  // 0: path matches the owner's categories or services; 1: title matches; 2: ordinary; 3: near-empty; 4: legal or utility.
  const bucket = (p: PageRecord) => (isUtility(p) ? 4 : hits(pathOf(p)) ? 0 : hits(titleOf(p)) ? 1 : isThin(p) ? 3 : 2);

  const home = unique.filter((p) => p.type === 'home').sort(byStructure).slice(0, 1);
  const rest = unique.filter((p) => !home.includes(p));
  // Pages with click data keep click order first; the buckets only order the pages without clicks.
  const withClicks = clicks ? rest.filter((p) => clickOf(p) > 0).sort(byClicks) : [];
  const noClicks = rest.filter((p) => !withClicks.includes(p)).sort(byStructure)
    .map((p) => [bucket(p), p] as const).sort((a, b) => a[0] - b[0]).map(([, p]) => p); // stable
  return [...home, ...withClicks, ...noClicks].slice(0, n).map((p) => p.url);
}
