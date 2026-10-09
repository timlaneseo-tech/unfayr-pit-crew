import { normaliseUrl } from './urls.ts';
import type { PageRecord } from './types.ts';

/** Picks the pages that get deep research, in rank order. Home first; then by clicks if known. */
export function selectTop(pages: PageRecord[], clicks?: Map<string, number>, n = 25): string[] {
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

  const home = unique.filter((p) => p.type === 'home').sort(byStructure).slice(0, 1);
  const rest = unique.filter((p) => !home.includes(p));
  const ranked = clicks
    ? [...rest.filter((p) => clickOf(p) > 0).sort(byClicks), ...rest.filter((p) => clickOf(p) <= 0).sort(byStructure)]
    : rest.sort(byStructure);
  return [...home, ...ranked].slice(0, n).map((p) => p.url);
}
