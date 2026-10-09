import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { shopifyAdapter, SHOPIFY_API_VERSION } from '../scripts/lib/publish/shopify.ts';
import { PartialWriteError } from '../scripts/lib/publish/common.ts';

const fx = (name: string) => readFileSync(new URL(`../fixtures/recorded/shopify/${name}.json`, import.meta.url), 'utf8');
const TOKEN = 'shpat_SECRET123';

interface Call { url: string; headers: Record<string, string>; query: string; variables: any }
type Reply = string | { status: number; headers?: Record<string, string>; body?: string };

function fake(handler: (c: Call, n: number) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    const b = JSON.parse(init.body);
    const c: Call = { url, headers: init.headers, query: b.query, variables: b.variables };
    calls.push(c);
    const r = handler(c, calls.length);
    const o = typeof r === 'string' ? { status: 200, body: r } : r;
    return new Response(o.body ?? '{}', { status: o.status, headers: o.headers });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const waits: number[] = [];
beforeEach(() => { waits.length = 0; });
const mk = (f: ReturnType<typeof fake>) => shopifyAdapter({
  shop: 'trailhead.myshopify.com', token: TOKEN, fetchImpl: f.fetchImpl, sleep: async (ms) => { waits.push(ms); },
});
const B = 'https://trailhead.example';

describe('shopifyAdapter resolve', () => {
  it('posts to the versioned endpoint with the token header only', async () => {
    const f = fake(() => fx('product-by-handle'));
    await mk(f).resolve([`${B}/products/brake-pads`]);
    expect(f.calls[0]!.url).toBe(`https://trailhead.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(f.calls[0]!.headers['X-Shopify-Access-Token']).toBe(TOKEN);
    expect(JSON.stringify(f.calls[0]!.variables) + f.calls[0]!.query).not.toContain(TOKEN);
  });
  it('resolves product, collection, page and article by path', async () => {
    const f = fake((c) =>
      c.query.includes('productByIdentifier') ? fx('product-by-handle')
      : c.query.includes('collectionByIdentifier') ? fx('collection-by-handle')
      : c.query.includes('pages(') ? fx('pages-by-handle') : fx('articles-by-handle'));
    const urls = [`${B}/products/brake-pads`, `${B}/collections/brakes`, `${B}/pages/about-us`, `${B}/blogs/news/winter-tips`];
    const m = await mk(f).resolve(urls);
    expect(m.get(urls[0]!)).toEqual({ url: urls[0], kind: 'product', id: 'gid://shopify/Product/1001', h1RenamesRecord: true });
    expect(m.get(urls[1]!)).toMatchObject({ kind: 'collection', id: 'gid://shopify/Collection/2002', h1RenamesRecord: true });
    expect(m.get(urls[2]!)).toMatchObject({ kind: 'page', id: 'gid://shopify/Page/3003', h1RenamesRecord: true });
    expect(m.get(urls[3]!)).toMatchObject({ kind: 'article', id: 'gid://shopify/Article/4004', h1RenamesRecord: true });
  });
  it('strips slash/query, lowercases the handle, keeps the key as passed', async () => {
    const f = fake(() => fx('product-by-handle'));
    const u = `${B}/products/Brake-Pads/?utm=x`;
    const m = await mk(f).resolve([u]);
    expect(f.calls[0]!.variables.handle).toBe('brake-pads');
    expect(m.get(u)?.kind).toBe('product');
  });
  it('returns null for / , unsupported paths and missing records without calling out for them', async () => {
    const f = fake(() => fx('product-not-found'));
    const urls = [`${B}/`, `${B}/cart`, `${B}/blogs/news`, `${B}/products/gone`];
    const m = await mk(f).resolve(urls);
    for (const u of urls) expect(m.get(u)).toBeNull();
    expect(f.calls).toHaveLength(1);
  });
  it('returns null when no page/article handle matches exactly', async () => {
    const f = fake((c) => c.query.includes('pages(') ? fx('pages-by-handle') : fx('articles-by-handle'));
    const a = `${B}/pages/about`, b = `${B}/blogs/missing/winter-tips`;
    const m = await mk(f).resolve([a, b]);
    expect(m.get(a)).toBeNull();
    expect(m.get(b)).toBeNull();
  });
});

describe('shopifyAdapter read', () => {
  it('reads product seo and title', async () => {
    const f = fake(() => fx('node-product'));
    const v = await mk(f).read({ url: 'u', kind: 'product', id: 'gid://shopify/Product/1001', h1RenamesRecord: true });
    expect(v).toEqual({ title: 'Brake Pads | Trailhead', meta: 'Front brake pads.', h1: 'Brake Pad Set' });
  });
  it('reads page title_tag/description_tag metafields', async () => {
    const f = fake(() => fx('node-page'));
    const v = await mk(f).read({ url: 'u', kind: 'page', id: 'gid://shopify/Page/3003', h1RenamesRecord: true });
    expect(v).toEqual({ title: 'About Trailhead', meta: null, h1: 'About Us' });
    expect(f.calls[0]!.query).toContain('global');
  });
});

describe('shopifyAdapter read guards', () => {
  it('throws on an unsupported kind without calling out', async () => {
    const f = fake(() => fx('node-product'));
    await expect(mk(f).read({ url: 'u', kind: 'variant', id: 'gid://shopify/Product/1001', h1RenamesRecord: true })).rejects.toThrow(/unsupported/i);
    expect(f.calls).toHaveLength(0);
  });
  it('throws when the node type does not match the kind', async () => {
    const f = fake(() => fx('node-product'));
    await expect(mk(f).read({ url: 'u', kind: 'collection', id: 'gid://shopify/Product/1001', h1RenamesRecord: true })).rejects.toThrow(/Product/);
  });
});

describe('shopifyAdapter write', () => {
  const prod = { url: 'u', kind: 'product', id: 'gid://shopify/Product/1001', h1RenamesRecord: true };
  it('sends only the seo subfield being changed, plus h1 as title', async () => {
    const f = fake(() => fx('product-update-ok'));
    await mk(f).write(prod, { title: 'New T', h1: 'New H1' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.variables.product).toEqual({ id: prod.id, title: 'New H1', seo: { title: 'New T' } });
  });
  it('never sends null values', async () => {
    const f = fake(() => fx('product-update-ok'));
    await mk(f).write(prod, { title: null, meta: 'M' });
    expect(f.calls[0]!.variables.product).toEqual({ id: prod.id, seo: { description: 'M' } });
    const g = fake(() => fx('product-update-ok'));
    await mk(g).write(prod, { title: null, meta: null, h1: null });
    expect(g.calls).toHaveLength(0);
  });
  it('collections use collectionUpdate', async () => {
    const f = fake(() => '{"data":{"collectionUpdate":{"collection":{"id":"x"},"userErrors":[]}}}');
    await mk(f).write({ ...prod, kind: 'collection', id: 'gid://shopify/Collection/2' }, { meta: 'M' });
    expect(f.calls[0]!.query).toContain('collectionUpdate');
    expect(f.calls[0]!.variables.collection).toEqual({ id: 'gid://shopify/Collection/2', seo: { description: 'M' } });
  });
  const pageRef = { url: 'u', kind: 'page', id: 'gid://shopify/Page/3003', h1RenamesRecord: true };
  const pageFake = (node: string, updates: { meta?: string; page?: string } = {}) => fake((c) =>
    c.query.includes('NodeSeo') ? fx(node)
    : c.query.includes('metafieldsSet') ? (updates.meta ?? fx('metafields-set-ok')) : (updates.page ?? fx('page-update-ok')));
  it('pages: metafieldsSet for seo (documented single_line type by default), pageUpdate for h1', async () => {
    const f = pageFake('node-page');
    await mk(f).write(pageRef, { title: 'T', meta: 'M', h1: 'H' });
    const mf = f.calls.find((c) => c.query.includes('metafieldsSet'))!;
    expect(mf.variables.metafields).toEqual([
      { ownerId: pageRef.id, namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'T' },
      { ownerId: pageRef.id, namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: 'M' },
    ]);
    const pu = f.calls.find((c) => c.query.includes('pageUpdate'))!;
    expect(pu.variables).toEqual({ id: pageRef.id, page: { title: 'H' } });
  });
  it('keeps an existing metafield type (multi_line stays multi_line)', async () => {
    const f = pageFake('node-page-multiline');
    await mk(f).write(pageRef, { title: 'T', meta: 'M' });
    const mf = f.calls.find((c) => c.query.includes('metafieldsSet'))!;
    expect(mf.variables.metafields.map((m: any) => m.type)).toEqual(['multi_line_text_field', 'multi_line_text_field']);
  });
  it('keeps an existing single_line type', async () => {
    const f = pageFake('node-page');
    await mk(f).write(pageRef, { title: 'T' });
    expect(f.calls.find((c) => c.query.includes('metafieldsSet'))!.variables.metafields[0].type).toBe('single_line_text_field');
  });
  it('articles use articleUpdate for h1 only when h1 given', async () => {
    const f = fake((c) => c.query.includes('NodeSeo') ? fx('node-article') : fx('metafields-set-ok'));
    await mk(f).write({ url: 'u', kind: 'article', id: 'gid://shopify/Article/4', h1RenamesRecord: true }, { meta: 'M' });
    expect(f.calls.filter((c) => !c.query.includes('NodeSeo'))).toHaveLength(1);
    expect(f.calls.some((c) => c.query.includes('articleUpdate'))).toBe(false);
    const g = fake(() => '{"data":{"articleUpdate":{"article":{"id":"x"},"userErrors":[]}}}');
    await mk(g).write({ url: 'u', kind: 'article', id: 'gid://shopify/Article/4', h1RenamesRecord: true }, { h1: 'H' });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]!.query).toContain('articleUpdate');
    expect(g.calls[0]!.variables).toEqual({ id: 'gid://shopify/Article/4', article: { title: 'H' } });
  });
  it('throws PartialWriteError naming saved fields when the h1 update fails after the metafields saved', async () => {
    const f = pageFake('node-page', { page: '{"data":{"pageUpdate":{"page":null,"userErrors":[{"field":["page"],"message":"Title taken"}]}}}' });
    const e = await mk(f).write(pageRef, { title: 'T', meta: 'M', h1: 'H' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PartialWriteError);
    expect((e as PartialWriteError).appliedFields).toEqual(['title', 'meta']);
    expect((e as Error).message).toContain('Title taken');
  });
  it('a failed metafieldsSet is a plain error (nothing saved)', async () => {
    const f = pageFake('node-page', { meta: '{"data":{"metafieldsSet":{"metafields":[],"userErrors":[{"message":"bad value"}]}}}' });
    const e = await mk(f).write(pageRef, { title: 'T', h1: 'H' }).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(PartialWriteError);
    expect((e as Error).message).toContain('bad value');
  });
  it('throws when the mutation payload is null with no errors', async () => {
    const f = fake(() => fx('payload-null'));
    await expect(mk(f).write(prod, { title: 'x' })).rejects.toThrow(/no result/i);
  });
  it('never sends empty strings', async () => {
    const f = fake(() => fx('product-update-ok'));
    await mk(f).write(prod, { title: '', meta: 'M', h1: '' });
    expect(f.calls[0]!.variables.product).toEqual({ id: prod.id, seo: { description: 'M' } });
    const g = fake(() => fx('product-update-ok'));
    await mk(g).write(prod, { title: '', meta: '', h1: '' });
    expect(g.calls).toHaveLength(0);
  });
  it('userErrors throw with joined messages', async () => {
    const f = fake(() => fx('user-errors'));
    await expect(mk(f).write(prod, { title: 'x' })).rejects.toThrow("Title is too long; Title can't be blank");
  });
});

describe('shopifyAdapter throttling', () => {
  const prod = { url: 'u', kind: 'product', id: 'gid://shopify/Product/1', h1RenamesRecord: true };
  it('retries 429 using Retry-After, then succeeds', async () => {
    const f = fake((_c, n) => n < 3 ? { status: 429, headers: { 'Retry-After': '5' } } : fx('product-update-ok'));
    await mk(f).write(prod, { title: 'x' });
    expect(f.calls).toHaveLength(3);
    expect(waits).toEqual([5000, 5000]);
  });
  it('retries THROTTLED errors with the 2s default', async () => {
    const f = fake((_c, n) => n < 2 ? fx('throttled') : fx('product-update-ok'));
    await mk(f).write(prod, { title: 'x' });
    expect(waits).toEqual([2000]);
  });
  it('gives up after 3 retries', async () => {
    const f = fake(() => ({ status: 429 }));
    await expect(mk(f).write(prod, { title: 'x' })).rejects.toThrow(/throttl|429/i);
    expect(f.calls).toHaveLength(4);
    expect(waits).toHaveLength(3);
  });
  it('other HTTP errors and GraphQL errors throw without the token', async () => {
    const f = fake(() => ({ status: 401, body: 'nope' }));
    const e = await mk(f).write(prod, { title: 'x' }).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/401/);
    expect((e as Error).message).not.toContain(TOKEN);
    const g = fake(() => '{"errors":[{"message":"Field boom"}]}');
    await expect(mk(g).write(prod, { title: 'x' })).rejects.toThrow('Field boom');
  });
});

describe('shopifyAdapter missing scope for one kind (no-access)', () => {
  const DENIED = JSON.stringify({ data: null, errors: [{ message: 'Access denied for pages field.', extensions: { code: 'ACCESS_DENIED' } }] });
  it('marks page URLs no-access with the scope to add, and still resolves products', async () => {
    const f = fake((c) => (c.query.includes('pages(') ? DENIED : fx('product-by-handle')));
    const a = mk(f);
    const urls = [`${B}/pages/about-us`, `${B}/products/brake-pads`];
    const m = await a.resolve(urls);
    expect(m.get(urls[0]!)).toBeNull();
    expect(m.get(urls[1]!)).toMatchObject({ kind: 'product' });
    expect([...a.noAccess!.keys()]).toEqual([urls[0]]);
    const msg = a.noAccess!.get(urls[0]!)!;
    expect(msg).toMatch(/can't read Shopify pages/);
    expect(msg).toContain('read_online_store_pages');
    expect(msg).toContain('read_content');
    expect(msg).not.toContain(TOKEN);
  });
  it('a read denied for one record throws NoAccessError naming the scope', async () => {
    const { NoAccessError } = await import('../scripts/lib/publish/common.ts');
    const f = fake(() => DENIED);
    const err = await mk(f).read({ url: `${B}/blogs/news/x`, kind: 'article', id: 'gid://shopify/Article/1', h1RenamesRecord: true }).catch((e) => e);
    expect(err).toBeInstanceOf(NoAccessError);
    expect(err.message).toContain('read_online_store_pages');
  });
  it('a 401 for the whole store still fails resolve loudly', async () => {
    const f = fake(() => ({ status: 401, body: '{"errors":"[API] Invalid API key or access token"}' }));
    await expect(mk(f).resolve([`${B}/pages/about-us`, `${B}/products/brake-pads`])).rejects.toThrow(/401/);
  });
});
