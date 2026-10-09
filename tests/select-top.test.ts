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

describe('selectTop tie-breaks (v1.0.1)', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
  const body = { text: words(80) };
  const interview = (answer: string, id = 'categories') => ({ answers: [{ id, question: 'q', answer }] });

  it('ranks pages matching the categories answer first after home', () => {
    const pages = [
      page('', {}),
      page('/collections/aaa-misc', { type: 'collection', inlinks: 5, ...body }),
      page('/collections/hydraulic-hoses', { type: 'collection', inlinks: 5, ...body }),
      page('/collections/brakes', { type: 'collection', inlinks: 5, title: 'Brake Parts', ...body }),
    ];
    const top = selectTop(pages, undefined, 25, interview('Hydraulic hoses and brake parts'));
    expect(top).toEqual([u(''), u('/collections/brakes'), u('/collections/hydraulic-hoses'), u('/collections/aaa-misc')]);
  });

  it('also reads services_main', () => {
    const pages = [page('', {}), page('/a', { ...body }), page('/drain-cleaning', { ...body })];
    expect(selectTop(pages, undefined, 25, interview('drain cleaning', 'services_main'))[1]).toBe(u('/drain-cleaning'));
  });

  it('pushes legal and utility pages of type other to the end', () => {
    const pages = [
      page('', {}),
      page('/pages/privacy-policy', { inlinks: 9, navLinked: true, ...body }),
      page('/pages/data-sharing-opt-out', { inlinks: 9, ...body }),
      page('/pages/about', { inlinks: 1, ...body }),
      page('/collections/x', { type: 'collection', inlinks: 1, ...body }),
    ];
    const top = selectTop(pages);
    expect(top.slice(0, 3)).toEqual([u(''), u('/collections/x'), u('/pages/about')]);
    expect(top.slice(3).sort()).toEqual([u('/pages/data-sharing-opt-out'), u('/pages/privacy-policy')]);
  });

  it('ranks near-empty pages (under 40 words) after pages with content', () => {
    const pages = [
      page('', {}),
      page('/pages/empty', { inlinks: 9, text: words(10) }),
      page('/pages/full', { inlinks: 1, text: words(60) }),
    ];
    expect(selectTop(pages)).toEqual([u(''), u('/pages/full'), u('/pages/empty')]);
  });

  it('keeps the old order when no interview is given', () => {
    const pages = [page('/b', { inlinks: 1, ...body }), page('/a', { inlinks: 1, ...body }), page('', {})];
    expect(selectTop(pages)).toEqual([u(''), u('/a'), u('/b')]);
  });
});

describe('selectTop review fixes (v1.0.1)', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
  const body = { text: words(80) };
  const iv = (answer: string, brand?: string) => ({ ...(brand ? { brand } : {}), answers: [{ id: 'categories', question: 'q', answer }] });

  it('matches singular and plural either way', () => {
    const pages = [page('', {}), page('/collections/aaa', { ...body }), page('/collections/brake-pads', { ...body }), page('/collections/hose', { ...body }), page('/pages/battery', { ...body })];
    const top = selectTop(pages, undefined, 25, iv('brakes, hoses and batteries'));
    expect(top.slice(1, 4).sort()).toEqual([u('/collections/brake-pads'), u('/collections/hose'), u('/pages/battery')].sort());
    expect(top[4]).toBe(u('/collections/aaa'));
    const rev = selectTop([page('', {}), page('/collections/aaa', { ...body }), page('/collections/brakes', { ...body })], undefined, 25, iv('brake'));
    expect(rev[1]).toBe(u('/collections/brakes'));
  });

  it('ignores the brand segment and generic words, so a brand word does not match every page', () => {
    const t = (x: string) => `${x} – RTL Equipment Parts Store`;
    const pages = [
      page('', {}),
      page('/collections/aaa', { type: 'collection', title: t('Aaa'), ...body }),
      page('/collections/zzz-filters', { type: 'collection', title: t('Zzz'), ...body }),
      page('/collections/bbb', { type: 'collection', title: t('Bbb'), ...body }),
    ];
    const top = selectTop(pages, undefined, 25, iv('equipment filters', 'RTL Equipment Parts Store'));
    expect(top).toEqual([u(''), u('/collections/zzz-filters'), u('/collections/aaa'), u('/collections/bbb')]);
  });

  it('path matches rank before title-only matches', () => {
    const pages = [page('', {}), page('/a', { title: 'Hydraulic hoses', ...body }), page('/hoses', { ...body })];
    expect(selectTop(pages, undefined, 25, iv('hoses'))).toEqual([u(''), u('/hoses'), u('/a')]);
  });

  it('pages with clicks keep click order first; buckets order only unclicked pages', () => {
    const pages = [
      page('', {}),
      page('/pages/privacy', { ...body }),
      page('/collections/brakes', { ...body }),
      page('/x', { ...body }),
      page('/y', { ...body }),
    ];
    const clicks = new Map([[u('/pages/privacy'), 50], [u('/x'), 10]]);
    expect(selectTop(pages, clicks, 25, iv('brakes'))).toEqual([u(''), u('/pages/privacy'), u('/x'), u('/collections/brakes'), u('/y')]);
  });
});
