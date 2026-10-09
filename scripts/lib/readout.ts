import type { PageRecord } from './types.ts';
import { charLen } from './text.ts';

export interface Readout {
  pages: number; titlesOver60: number; dupTitles: number; dupMetas: number; missingH1: number;
  boilerplateMeta: { text: string; count: number } | null; separators: Record<string, number>;
}

const key = (s: string | null) => (s === null ? '' : s.trim().replace(/\s+/g, ' ').toLowerCase());

function groups(values: (string | null)[]): Map<string, { count: number; first: string }> {
  const m = new Map<string, { count: number; first: string }>();
  for (const v of values) {
    const k = key(v);
    if (!k) continue;
    const e = m.get(k);
    if (e) e.count++;
    else m.set(k, { count: 1, first: v!.trim() });
  }
  return m;
}

/** Number of pages whose value is shared with at least one other page. */
const sharedPages = (g: Map<string, { count: number }>) =>
  [...g.values()].filter((e) => e.count > 1).reduce((a, e) => a + e.count, 0);

export const SEPARATORS: [string, RegExp][] = [
  ['|', /\|/], ['-', / [-‐-‒] /], ['–', /–/], ['—', /—/], [':', /:/], ['·', /·/], ['»', /»/],
];

export function readout(pages: PageRecord[]): Readout {
  const metas = groups(pages.map((p) => p.meta));
  let boilerplateMeta: Readout['boilerplateMeta'] = null;
  for (const e of metas.values()) {
    if (e.count >= 5 && (!boilerplateMeta || e.count > boilerplateMeta.count)) boilerplateMeta = { text: e.first, count: e.count };
  }
  const separators: Record<string, number> = {};
  for (const p of pages) {
    if (!p.title) continue;
    const t = p.title;
    for (const [name, re] of SEPARATORS) if (re.test(t)) separators[name] = (separators[name] ?? 0) + 1;
  }
  return {
    pages: pages.length,
    titlesOver60: pages.filter((p) => p.title !== null && charLen(p.title) > 60).length,
    dupTitles: sharedPages(groups(pages.map((p) => p.title))),
    dupMetas: sharedPages(metas),
    missingH1: pages.filter((p) => p.h1s.length === 0).length,
    boilerplateMeta,
    separators,
  };
}
