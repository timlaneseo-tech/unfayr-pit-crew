import { describe, it, expect } from 'vitest';
import { selectTop } from '../scripts/lib/select-top.ts';
import type { PageRecord } from '../scripts/lib/types.ts';

function page(path: string, o: Partial<PageRecord> = {}): PageRecord {
  const url = `https://x.com${path}`;
  return {
    url, slug: path, type: path === '' ? 'home' : 'other', title: null, meta: null,
    h1s: [], h2s: [], intro: '', text: '', jsonLdTypes: [], altMissing: 0, altTotal: 0,
    cta: null, inlinks: 0, navLinked: false, ogTitle: null, ogDescription: null, ...o,
  };
}
const u = (p: string) => `https://x.com${p}`;

describe('selectTop', () => {
  it('with clicks: homepage first, then clicks desc, ties on inlinks', () => {
    const pages = [page('/a', { inlinks: 1 }), page('/b', { inlinks: 5 }), page('/c', { inlinks: 2 }), page('', { inlinks: 0 })];
    const clicks = new Map([[u('/a'), 10], [u('/b'), 10], [u('/c'), 50]]);
    expect(selectTop(pages, clicks)).toEqual([u(''), u('/c'), u('/b'), u('/a')]);
  });

  it('without clicks: home, nav-linked by inlinks, then rest by inlinks', () => {
    const pages = [
      page('/r1', { inlinks: 9 }), page('/n1', { inlinks: 2, navLinked: true }),
      page('/n2', { inlinks: 7, navLinked: true }), page('/r2', { inlinks: 3 }), page('', {}),
    ];
    expect(selectTop(pages)).toEqual([u(''), u('/n2'), u('/n1'), u('/r1'), u('/r2')]);
  });

  it('zero-click pages rank after clicked pages, by the no-clicks rule', () => {
    const pages = [
      page('/z1', { inlinks: 9 }), page('/zn', { inlinks: 1, navLinked: true }), page('/c', { inlinks: 0 }),
    ];
    expect(selectTop(pages, new Map([[u('/c'), 1]]))).toEqual([u('/c'), u('/zn'), u('/z1')]);
  });

  it('caps at n, has no duplicates, and is deterministic on full ties', () => {
    const pages = Array.from({ length: 40 }, (_, i) => page(`/p${String(i).padStart(2, '0')}`));
    const out = selectTop([...pages, pages[3]!]);
    expect(out).toHaveLength(25);
    expect(new Set(out).size).toBe(25);
    expect(out).toEqual(selectTop([...pages].reverse()));
    expect(out[0]).toBe(u('/p00'));
    expect(selectTop(pages, undefined, 3)).toHaveLength(3);
  });

  it('matches clicks keyed with trailing slash or query', () => {
    const pages = [page('/a'), page('/b'), page('/c')];
    const clicks = new Map([['https://x.com/b/', 5], ['https://x.com/c?utm=1', 9]]);
    expect(selectTop(pages, clicks)).toEqual([u('/c'), u('/b'), u('/a')]);
  });
});
