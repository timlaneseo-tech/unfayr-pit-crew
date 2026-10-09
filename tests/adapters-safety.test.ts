// Final-review fix wave: per-adapter tests for rendered-value checks (R1), clearing on rollback (R3),
// supported fields (M4), the Git H1 guard (I8) and WordPress 429 handling (M2). No live calls: fake fetchImpl only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shopifyAdapter } from '../scripts/lib/publish/shopify.ts';
import { wordpressAdapter } from '../scripts/lib/publish/wordpress.ts';
import { webflowAdapter } from '../scripts/lib/publish/webflow.ts';
import { gitAdapter } from '../scripts/lib/publish/git.ts';
import { PartialWriteError, planChanges, snapshot } from '../scripts/lib/publish/common.ts';
import type { Proposal } from '../scripts/lib/types.ts';

const rec = (dir: string, n: string) => readFileSync(new URL(`../fixtures/recorded/${dir}/${n}.json`, import.meta.url), 'utf8');
interface Call { url: string; method: string; body: any }
type Reply = string | { status: number; body?: string; headers?: Record<string, string> };
function fake(handler: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: any = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = handler(c);
    const o = typeof r === 'string' ? { status: 200, body: r } : r;
    return new Response(o.body ?? '{}', { status: o.status, headers: o.headers });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('Shopify', () => {
  const B = 'https://trailhead.example';
  const mk = (f: ReturnType<typeof fake>) => shopifyAdapter({ shop: 'trailhead.myshopify.com', token: 'shpat_X', fetchImpl: f.fetchImpl, sleep: async () => {} });
  it('supports title, meta and h1', () => {
    expect(mk(fake(() => '{}')).supports).toEqual(['title', 'meta', 'h1']);
  });
  it('a product with no SEO override (null) is planned, not skipped as live-changed, when the page still renders the crawled title (R1)', async () => {
    const f = fake((c) => (c.body.query.includes('productByIdentifier') ? rec('shopify', 'product-by-handle') : rec('shopify', 'node-product-no-seo')));
    const p: Proposal = {
      url: `${B}/products/brake-pads`, type: 'product', tier: 'top',
      current: { title: 'Brake Pad Set – Trailhead', meta: 'Front brake pads for trail bikes.', h1: 'Brake Pad Set' },
      proposed: { title: 'Front brake pads | Trailhead', meta: null, h1: null },
      reason: '', sources: ['page'], issues: [], status: 'ok', approve: true,
    };
    const run = mkdtempSync(join(tmpdir(), 'pc-shop-'));
    const page = '<html><head><title>Brake Pad Set – Trailhead</title><meta name="description" content="Front brake pads for trail bikes."></head><body><h1>Brake Pad Set</h1></body></html>';
    const bb = await snapshot(mk(f), run, [p], () => new Date('2026-10-09T00:00:00Z'), { render: async () => page });
    expect(bb.records[0]!.values.title).toBeNull();
    const plan = planChanges(bb, [p], { includeRenamingH1: false });
    expect(plan.skipped).toEqual([]);
    expect(plan.changes).toEqual([{ ref: bb.records[0]!.ref, field: 'title', from: null, was: 'Brake Pad Set – Trailhead', to: 'Front brake pads | Trailhead' }]);
  });
  it('clear on a product sends seo with empty strings for the cleared fields only (R3)', async () => {
    const f = fake(() => rec('shopify', 'product-update-ok'));
    await mk(f).clear!({ url: `${B}/products/brake-pads`, kind: 'product', id: 'gid://shopify/Product/1001', h1RenamesRecord: true }, ['title']);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body.query).toContain('productUpdate');
    expect(f.calls[0]!.body.variables.product).toEqual({ id: 'gid://shopify/Product/1001', seo: { title: '' } });
  });
  it('clear on a page deletes the global SEO metafields (R3)', async () => {
    const f = fake(() => rec('shopify', 'metafields-delete-ok'));
    await mk(f).clear!({ url: `${B}/pages/about-us`, kind: 'page', id: 'gid://shopify/Page/3003', h1RenamesRecord: true }, ['title', 'meta']);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body.query).toContain('metafieldsDelete');
    expect(f.calls[0]!.body.variables.metafields).toEqual([
      { ownerId: 'gid://shopify/Page/3003', namespace: 'global', key: 'title_tag' },
      { ownerId: 'gid://shopify/Page/3003', namespace: 'global', key: 'description_tag' },
    ]);
  });
  it('clear refuses the h1', async () => {
    await expect(mk(fake(() => '{}')).clear!({ url: `${B}/pages/a`, kind: 'page', id: 'gid://shopify/Page/1', h1RenamesRecord: true }, ['h1'])).rejects.toThrow(/H1/);
  });
});

describe('WordPress', () => {
  const B = 'https://trailhead.example';
  const pageRef = { url: `${B}/about-us/`, kind: 'page', id: '11', h1RenamesRecord: true };
  const route = (extra: (c: Call) => Reply | undefined = () => undefined) => fake((c) => {
    const x = extra(c);
    if (x !== undefined) return x;
    if (c.url === `${B}/wp-json`) return rec('wordpress', 'root-yoast');
    if (c.url.includes('context=edit&per_page=1')) return rec('wordpress', 'edit-list-yoast');
    return '{}';
  });
  it('supports title, meta and h1', async () => {
    expect((await wordpressAdapter({ base: B, user: 'u', appPassword: 'p', fetchImpl: route().fetchImpl })).supports).toEqual(['title', 'meta', 'h1']);
  });
  it('clear sets the SEO plugin key to an empty string (R3)', async () => {
    const f = route();
    const a = await wordpressAdapter({ base: B, user: 'u', appPassword: 'p', fetchImpl: f.fetchImpl });
    await a.clear!(pageRef, ['meta']);
    const post = f.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${B}/wp-json/wp/v2/pages/11`);
    expect(post.body).toEqual({ meta: { _yoast_wpseo_metadesc: '' } });
  });
  it('retries a 429 after Retry-After (capped at 60 s, at most 3 times) (M2)', async () => {
    const waits: number[] = [];
    let n = 0;
    const f = route((c) => (c.method === 'POST' && n++ < 2 ? { status: 429, headers: { 'Retry-After': n === 1 ? '5' : '600' } } : undefined));
    const a = await wordpressAdapter({ base: B, user: 'u', appPassword: 'p', fetchImpl: f.fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    await a.write(pageRef, { h1: 'New' });
    expect(waits).toEqual([5000, 60000]);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(3);
  });
  it('gives up after 3 retries', async () => {
    const f = route((c) => (c.method === 'POST' ? { status: 429 } : undefined));
    const a = await wordpressAdapter({ base: B, user: 'u', appPassword: 'p', fetchImpl: f.fetchImpl, sleep: async () => {} });
    await expect(a.write(pageRef, { h1: 'New' })).rejects.toThrow(/429|throttl|too many/i);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(4);
  });
});

describe('Webflow', () => {
  const API = 'https://api.webflow.com';
  const COL = '6c0000000000000000000001';
  const mk = (f: ReturnType<typeof fake>) => webflowAdapter({ token: 't', siteId: 's', cmsFields: { [COL]: { title: 'seo-title', meta: 'seo-desc' } }, fetchImpl: f.fetchImpl, sleep: async () => {} });
  it('supports title and meta only (no h1 on static pages) (M4)', () => {
    expect(mk(fake(() => '{}')).supports).toEqual(['title', 'meta']);
  });
  it('clear on a CMS item patches the mapped field to an empty string (R3)', async () => {
    const f = fake(() => '{}');
    await mk(f).clear!({ url: 'https://x.example/blog/second-post', kind: 'cms-item', id: `${COL}:6i0000000000000000000002`, h1RenamesRecord: false }, ['meta']);
    expect(f.calls[0]).toMatchObject({ method: 'PATCH', url: `${API}/v2/collections/${COL}/items/6i0000000000000000000002`, body: { fieldData: { 'seo-desc': '' } } });
  });
  it('clear on a static page keeps the other half of seo from a fresh read (R3)', async () => {
    const f = fake((c) => (c.method === 'GET' ? rec('webflow', 'page-about') : '{}'));
    await mk(f).clear!({ url: 'https://x.example/about', kind: 'page', id: '6a0000000000000000000002', h1RenamesRecord: false }, ['title']);
    const put = f.calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ seo: { title: '', description: 'About old' } });
  });
});

describe('Git', () => {
  const O = 'https://site.example';
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pc-git-fix-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, html: string) => writeFileSync(join(dir, name), html);
  const ref = (id: string) => ({ url: `${O}/${id.replace(/\.html$/, '')}`, kind: 'file', id, h1RenamesRecord: false });
  const a = () => gitAdapter({ repoDir: dir, origin: O });
  it('reads what the page renders, so the plan needs no fetch (R1)', () => {
    expect(a().rawIsRendered).toBe(true);
    expect(a().supports).toEqual(['title', 'meta', 'h1']);
  });
  it('clearing a meta description it inserted gives the file back byte for byte (R3)', async () => {
    const before = '<html>\n<head>\n  <title>About</title>\n</head>\n<body><h1>About</h1></body>\n</html>\n';
    put('about.html', before);
    await a().write(ref('about.html'), { meta: 'A new description for the about page.' });
    expect(readFileSync(join(dir, 'about.html'), 'utf8')).toContain('<meta name="description"');
    await a().clear!(ref('about.html'), ['meta']);
    expect(readFileSync(join(dir, 'about.html'), 'utf8')).toBe(before);
  });
  it('clearing a meta description it did not insert empties its content instead of removing the tag', async () => {
    put('a.html', '<html><head><title>A</title><meta charset="utf-8"><meta name="description" content="Filled by us"></head><body></body></html>');
    await a().clear!(ref('a.html'), ['meta']);
    expect(readFileSync(join(dir, 'a.html'), 'utf8')).toBe('<html><head><title>A</title><meta charset="utf-8"><meta name="description" content=""></head><body></body></html>');
  });
  it('never removes a <title>', async () => {
    put('a.html', '<html><head><title>A</title></head><body></body></html>');
    await expect(a().clear!(ref('a.html'), ['title'])).rejects.toThrow(/never removes a <title>/);
  });
  it('refuses to rewrite an <h1> that wraps a logo or other element (I8)', async () => {
    const html = '<html><head><title>Old</title></head><body><h1><a href="/"><img src="logo.png" alt="Acme"></a></h1></body></html>';
    put('a.html', html);
    const err = await a().write(ref('a.html'), { title: 'New title for the page', h1: 'New heading' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialWriteError);
    expect((err as PartialWriteError).appliedFields).toEqual(['title']);
    expect((err as Error).message).toMatch(/<h1>.*(logo|element)/i);
    const out = readFileSync(join(dir, 'a.html'), 'utf8');
    expect(out).toContain('<title>New title for the page</title>');
    expect(out).toContain('<h1><a href="/"><img src="logo.png" alt="Acme"></a></h1>');
  });
  it('rewrites an <h1> with inline formatting only', async () => {
    put('a.html', '<html><head><title>Old</title></head><body><h1>Old <em>big</em><br>heading <strong>x</strong> <b>y</b> <i>z</i> <span>w</span></h1></body></html>');
    await a().write(ref('a.html'), { h1: 'New heading' });
    expect(readFileSync(join(dir, 'a.html'), 'utf8')).toContain('<h1>New heading</h1>');
  });
  it('with no <h1>, writes the title and meta and throws PartialWriteError naming them (T13)', async () => {
    put('a.html', '<html><head><title>Old</title></head><body><p>No heading</p></body></html>');
    const err = await a().write(ref('a.html'), { title: 'New title here', meta: 'New meta here', h1: 'New heading' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialWriteError);
    expect((err as PartialWriteError).appliedFields).toEqual(['title', 'meta']);
    const out = readFileSync(join(dir, 'a.html'), 'utf8');
    expect(out).toContain('<title>New title here</title>');
    expect(out).toContain('content="New meta here"');
  });
});
