import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { webflowAdapter } from '../scripts/lib/publish/webflow.ts';

const fx = (n: string) => readFileSync(new URL(`../fixtures/recorded/webflow/${n}.json`, import.meta.url), 'utf8');
const TOKEN = 'wf_SECRET_TOKEN';
const SITE = '5f0000000000000000000001';
const COL = '6c0000000000000000000001';
const API = 'https://api.webflow.com';
interface Call { url: string; method: string; headers: Record<string, string>; body: any; redirect?: string }
type Reply = string | { status: number; body?: string; headers?: Record<string, string> };

function fake(handler: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: any = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect };
    calls.push(c);
    const r = handler(c);
    const o = typeof r === 'string' ? { status: 200, body: r } : r;
    return new Response(o.body ?? '{}', { status: o.status, headers: o.headers });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const cms = { [COL]: { title: 'seo-title', meta: 'seo-desc' } };
function site(extra: (c: Call) => Reply | undefined = () => undefined) {
  return fake((c) => {
    const x = extra(c);
    if (x !== undefined) return x;
    if (c.url.startsWith(`${API}/v2/sites/${SITE}/pages`)) return c.url.includes('offset=2') ? fx('pages-p2') : fx('pages-p1');
    if (c.url.startsWith(`${API}/v2/collections/${COL}/items?`)) return c.url.includes('offset=1') ? fx('items-p2') : fx('items-p1');
    if (c.url === `${API}/v2/pages/6a0000000000000000000002`) return c.method === 'GET' ? fx('page-about') : fx('update-ok');
    if (c.url === `${API}/v2/pages/6a0000000000000000000003`) return fx('page-contact');
    if (c.url === `${API}/v2/collections/${COL}/items/6i0000000000000000000002`) return fx('item-second');
    return '{}';
  });
}
const mk = (f: ReturnType<typeof fake>, extra: object = {}) =>
  webflowAdapter({ token: TOKEN, siteId: SITE, cmsFields: cms, fetchImpl: f.fetchImpl, sleep: async () => {}, ...extra });

describe('resolve', () => {
  it('paginates pages and matches publishedPath case/slash-insensitively', async () => {
    const f = site();
    const m = await mk(f).resolve(['https://x.example/about/', 'https://x.example/CONTACT', 'https://x.example/nope']);
    expect(m.get('https://x.example/about/')).toEqual({ url: 'https://x.example/about/', kind: 'page', id: '6a0000000000000000000002', h1RenamesRecord: false });
    expect(m.get('https://x.example/CONTACT')?.id).toBe('6a0000000000000000000003');
    expect(m.get('https://x.example/nope')).toBeNull();
    const listCalls = f.calls.filter((c) => c.url.includes('/pages?'));
    expect(listCalls.length).toBe(2);
    expect(listCalls[1]!.url).toContain('offset=2');
  });
  it('maps the root to the home page', async () => {
    const m = await mk(site()).resolve(['https://x.example/', 'https://x.example']);
    expect(m.get('https://x.example/')?.id).toBe('6a0000000000000000000001');
    expect(m.get('https://x.example')?.id).toBe('6a0000000000000000000001');
  });
  it('resolves CMS items by slug across item pages when mapped', async () => {
    const m = await mk(site()).resolve(['https://x.example/blog/second-post']);
    const r = m.get('https://x.example/blog/second-post')!;
    expect(r.kind).toBe('cms-item');
    expect(r.id).toBe(`${COL}:6i0000000000000000000002`);
    expect(r.h1RenamesRecord).toBe(false);
  });
  it('CMS item resolves to null without a cmsFields mapping, or when slug is unknown', async () => {
    const f = site();
    const a = mk(f, { cmsFields: undefined });
    expect((await a.resolve(['https://x.example/blog/second-post'])).get('https://x.example/blog/second-post')).toBeNull();
    expect(f.calls.some((c) => c.url.includes('/items'))).toBe(false);
    expect((await mk(site()).resolve(['https://x.example/blog/ghost'])).get('https://x.example/blog/ghost')).toBeNull();
  });
});

describe('read', () => {
  it('reads seo title/description, h1 null, and null for empty', async () => {
    const a = mk(site());
    expect(await a.read({ url: 'u', kind: 'page', id: '6a0000000000000000000002', h1RenamesRecord: false })).toEqual({ title: 'About us', meta: 'About old', h1: null });
    expect(await a.read({ url: 'u', kind: 'page', id: '6a0000000000000000000003', h1RenamesRecord: false })).toEqual({ title: 'Contact', meta: null, h1: null });
  });
  it('reads CMS fields via cmsFields', async () => {
    const v = await mk(site()).read({ url: 'u', kind: 'cms-item', id: `${COL}:6i0000000000000000000002`, h1RenamesRecord: false });
    expect(v).toEqual({ title: 'Second t', meta: 'Second d', h1: null });
  });
});

describe('write', () => {
  const page = { url: 'u', kind: 'page', id: '6a0000000000000000000002', h1RenamesRecord: false };
  it('PUTs the full seo object (unchanged half from a fresh GET), ignores h1, never publishes', async () => {
    const f = site();
    await mk(f).write(page, { title: 'New', meta: undefined, h1: 'Ignored' });
    const seq = f.calls.map((c) => `${c.method} ${c.url.replace(API, '')}`);
    expect(seq).toEqual(['GET /v2/pages/6a0000000000000000000002', 'PUT /v2/pages/6a0000000000000000000002']);
    const puts = f.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(`${API}/v2/pages/6a0000000000000000000002`);
    expect(puts[0]!.body).toEqual({ seo: { title: 'New', description: 'About old' } });
    expect(f.calls.some((c) => c.url.includes('/publish'))).toBe(false);
  });
  it('never sends empty or null values and sends nothing for h1-only', async () => {
    const f = site();
    await mk(f).write(page, { title: '', meta: null as any, h1: 'x' });
    expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    await mk(f).write(page, { meta: 'M' });
    expect(f.calls.find((c) => c.method === 'PUT')!.body).toEqual({ seo: { title: 'About us', description: 'M' } });
  });
  it('omits an unchanged subfield whose fresh value is empty', async () => {
    const f = site();
    await mk(f).write({ ...page, id: '6a0000000000000000000003' }, { title: 'T' });
    expect(f.calls.find((c) => c.method === 'PUT')!.body).toEqual({ seo: { title: 'T' } });
  });
  it('treats whitespace-only values as empty', async () => {
    const f = site();
    await mk(f).write(page, { title: '   ', meta: ' ' });
    expect(f.calls).toHaveLength(0);
  });
  it('PATCHes CMS item fieldData via cmsFields', async () => {
    const f = site();
    await mk(f).write({ url: 'u', kind: 'cms-item', id: `${COL}:6i0000000000000000000002`, h1RenamesRecord: false }, { title: 'T', meta: 'M' });
    const p = f.calls.find((c) => c.method === 'PATCH')!;
    expect(p.url).toBe(`${API}/v2/collections/${COL}/items/6i0000000000000000000002`);
    expect(p.body).toEqual({ fieldData: { 'seo-title': 'T', 'seo-desc': 'M' } });
  });
  it('refuses a CMS write when the collection has no mapping', async () => {
    const a = mk(site(), { cmsFields: {} });
    await expect(a.write({ url: 'u', kind: 'cms-item', id: `${COL}:x`, h1RenamesRecord: false }, { title: 'T' })).rejects.toThrow(/field mapping/);
  });
});

describe('live-record filtering', () => {
  it('skips draft pages and archived items', async () => {
    const m = await mk(site()).resolve(['https://x.example/about', 'https://x.example/blog/second-post']);
    expect(m.get('https://x.example/about')?.id).toBe('6a0000000000000000000002');
    expect(m.get('https://x.example/blog/second-post')?.id).toBe(`${COL}:6i0000000000000000000002`);
  });
  it('returns null when two live candidates match', async () => {
    const dup = JSON.stringify({ pages: [
      { id: 'a1', publishedPath: '/x', seo: {} }, { id: 'a2', publishedPath: '/X/', seo: {} }], pagination: { total: 2 } });
    const m = await mk(site((c) => (c.url.includes('/pages?') ? dup : undefined))).resolve(['https://x.example/x']);
    expect(m.get('https://x.example/x')).toBeNull();
    const items = JSON.stringify({ items: [{ id: 'i1', fieldData: { slug: 'second-post' } }, { id: 'i2', fieldData: { slug: 'second-post' } }], pagination: { total: 2 } });
    const m2 = await mk(site((c) => (c.url.includes('/items?') ? items : undefined))).resolve(['https://x.example/blog/second-post']);
    expect(m2.get('https://x.example/blog/second-post')).toBeNull();
  });
});

describe('transport and errors', () => {
  it('caps Retry-After at 60 seconds', async () => {
    const waits: number[] = [];
    let n = 0;
    const f = site((c) => (c.url.includes('/pages?') && n++ < 1 ? { status: 429, headers: { 'Retry-After': '86400' } } : undefined));
    await mk(f, { sleep: async (ms: number) => { waits.push(ms); } }).resolve(['https://x.example/about']);
    expect(waits).toEqual([60000]);
  });
  it('uses bearer header, https base, manual redirects', async () => {
    const f = site();
    await mk(f).resolve(['https://x.example/about']);
    for (const c of f.calls) {
      expect(c.url.startsWith(API + '/')).toBe(true);
      expect(c.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
      expect(c.redirect).toBe('manual');
    }
  });
  it('401 gives a safe message; other errors omit the body', async () => {
    await expect(mk(site(() => ({ status: 401, body: TOKEN }))).resolve(['https://x.example/a'])).rejects.toThrow('Webflow rejected the API token');
    const e = await mk(site(() => ({ status: 500, body: 'secret body ' + TOKEN }))).resolve(['https://x.example/a']).catch((x) => x);
    expect(e.message).toBe('Webflow API error 500');
    const r = await mk(site(() => ({ status: 302, headers: { location: 'http://evil' } }))).resolve(['https://x.example/a']).catch((x) => x);
    expect(r.message).toMatch(/redirect/i);
  });
  it('retries 429 using Retry-After, max 3 times', async () => {
    const waits: number[] = [];
    let n = 0;
    const f = site((c) => (c.url.includes('/pages?') && n++ < 2 ? { status: 429, headers: { 'Retry-After': '7' } } : undefined));
    const a = mk(f, { sleep: async (ms: number) => { waits.push(ms); } });
    await a.resolve(['https://x.example/about']);
    expect(waits).toEqual([7000, 7000]);
    const g = site(() => ({ status: 429, headers: { 'Retry-After': '1' } }));
    const w2: number[] = [];
    await expect(mk(g, { sleep: async (ms: number) => { w2.push(ms); } }).resolve(['https://x.example/about'])).rejects.toThrow('Webflow API error 429');
    expect(w2).toHaveLength(3);
  });
});

describe('a scope missing for one kind (no-access)', () => {
  it('CMS items the token may not read are no-access; static pages still resolve', async () => {
    const f = site((c) => (c.url.startsWith(`${API}/v2/collections/${COL}/items?`) ? { status: 403, body: '{"message":"secret"}' } : undefined));
    const a = mk(f);
    const urls = ['https://x.example/about', 'https://x.example/blog/first-post'];
    const m = await a.resolve(urls);
    expect(m.get(urls[0]!)?.kind).toBe('page');
    expect(m.get(urls[1]!)).toBeNull();
    expect(a.noAccess!.get(urls[1]!)).toMatch(/cms:read/);
    expect([...a.noAccess!.keys()]).toEqual([urls[1]]);
  });
  it('a token that may not list pages marks every URL no-access with the pages:read fix', async () => {
    const f = site((c) => (c.url.startsWith(`${API}/v2/sites/${SITE}/pages`) ? { status: 403 } : undefined));
    const a = mk(f);
    const m = await a.resolve(['https://x.example/about']);
    expect(m.get('https://x.example/about')).toBeNull();
    expect(a.noAccess!.get('https://x.example/about')).toMatch(/pages:read/);
  });
  it('a 401 still fails loudly', async () => {
    const f = site(() => ({ status: 401 }));
    await expect(mk(f).resolve(['https://x.example/about'])).rejects.toThrow('Webflow rejected the API token');
  });
});
