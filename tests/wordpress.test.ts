import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { wordpressAdapter, wordpressCsv } from '../scripts/lib/publish/wordpress.ts';
import { PartialWriteError } from '../scripts/lib/publish/common.ts';
import type { Proposal } from '../scripts/lib/types.ts';

const fx = (name: string) => readFileSync(new URL(`../fixtures/recorded/wordpress/${name}.json`, import.meta.url), 'utf8');
const PW = 'abcd efgh SECRETPW';
const B = 'https://trailhead.example';

interface Call { url: string; method: string; headers: Record<string, string>; body: any }
type Reply = string | { status: number; body?: string };

function fake(handler: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: any = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = handler(c);
    const o = typeof r === 'string' ? { status: 200, body: r } : r;
    return new Response(o.body ?? '{}', { status: o.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const mk = (f: ReturnType<typeof fake>) => wordpressAdapter({ base: B + '/', user: 'editor', appPassword: PW, fetchImpl: f.fetchImpl });

/** Routes the root and the probe list by URL; `extra` overrides win. */
function site(root: string, list: string, extra: (c: Call) => Reply | undefined = () => undefined) {
  return fake((c) => {
    const x = extra(c);
    if (x !== undefined) return x;
    if (c.url === `${B}/wp-json`) return fx(root);
    if (c.url.includes('context=edit&per_page=1')) return fx(list);
    return '{}';
  });
}
const pageRef = { url: `${B}/about-us/`, kind: 'page', id: '11', h1RenamesRecord: true };

describe('detection and probe', () => {
  it('detects yoast, rankmath and none', async () => {
    expect((await mk(site('root-yoast', 'edit-list-yoast'))).seoPlugin).toBe('yoast');
    expect((await mk(site('root-rankmath', 'edit-list-rankmath'))).seoPlugin).toBe('rankmath');
    const none = await mk(site('root-none', 'empty-list'));
    expect(none.seoPlugin).toBe('none');
    expect(none.metaWritable).toBe(false);
    expect(none.platform).toBe('wordpress');
  });
  it('metaWritable true when the plugin keys are present in meta, and the probe never writes', async () => {
    const f = site('root-yoast', 'edit-list-yoast');
    const a = await mk(f);
    expect(a.metaWritable).toBe(true);
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(f.calls.some((c) => c.url === `${B}/wp-json/wp/v2/pages?context=edit&per_page=1`)).toBe(true);
    expect((await mk(site('root-rankmath', 'edit-list-rankmath'))).metaWritable).toBe(true);
  });
  it('metaWritable false when keys are absent', async () => {
    expect((await mk(site('root-yoast', 'edit-list-nometa'))).metaWritable).toBe(false);
    expect((await mk(site('root-yoast', 'edit-list-rankmath'))).metaWritable).toBe(false);
  });
  it('falls back to posts when there are no pages', async () => {
    const f = fake((c) => c.url.endsWith('/wp-json') ? fx('root-yoast')
      : c.url.includes('/pages?') ? fx('empty-list') : c.url.includes('/posts?') ? fx('edit-list-yoast') : '{}');
    expect((await mk(f)).metaWritable).toBe(true);
    expect(f.calls.some((c) => c.url.includes('/posts?context=edit&per_page=1'))).toBe(true);
  });
  it('metaWritable false when the site has neither pages nor posts', async () => {
    expect((await mk(site('root-yoast', 'empty-list'))).metaWritable).toBe(false);
  });
  it('uses Basic auth and keeps the password out of URLs and bodies', async () => {
    const f = site('root-yoast', 'edit-list-yoast');
    await mk(f);
    const want = 'Basic ' + Buffer.from(`editor:${PW}`).toString('base64');
    for (const c of f.calls) { expect(c.headers['Authorization']).toBe(want); expect(c.url).not.toContain('SECRETPW'); }
  });
  it('401 throws a clean error', async () => {
    const f = fake(() => ({ status: 401, body: 'secret body' }));
    const e = await mk(f).catch((x: Error) => x);
    expect((e as Error).message).toBe('WordPress rejected the application password');
  });
  it('other non-2xx throws the status only', async () => {
    const f = fake(() => ({ status: 500, body: 'secret body' }));
    const e = await mk(f).catch((x: Error) => x);
    expect((e as Error).message).toBe('WordPress API error 500');
  });
});

describe('resolve', () => {
  const resolver = (pages: string, posts: string) => site('root-yoast', 'edit-list-yoast', (c) =>
    c.url.includes('/pages?slug=') ? fx(pages) : c.url.includes('/posts?slug=') ? fx(posts) : undefined);
  it('finds a page by last path segment (lowercased, decoded), h1RenamesRecord true', async () => {
    const f = resolver('one-page', 'empty-list');
    const a = await mk(f);
    const u = `${B}/company/About-Us/?utm=x`;
    const m = await a.resolve([u]);
    expect(m.get(u)).toEqual({ url: u, kind: 'page', id: '11', h1RenamesRecord: true });
    expect(f.calls.some((c) => c.url === `${B}/wp-json/wp/v2/pages?slug=about-us`)).toBe(true);
  });
  it('falls back to posts', async () => {
    const f = resolver('empty-list', 'one-post');
    const u = `${B}/2026/winter-tips/`;
    const m = await (await mk(f)).resolve([u]);
    expect(m.get(u)).toEqual({ url: u, kind: 'post', id: '21', h1RenamesRecord: true });
  });
  it('percent-decodes the slug', async () => {
    const f = resolver('empty-list', 'empty-list');
    await (await mk(f)).resolve([`${B}/caf%C3%A9/`]);
    expect(f.calls.some((c) => c.url.includes('/pages?slug=caf%C3%A9'))).toBe(true);
  });
  it('ambiguous slug resolves to null', async () => {
    const u = `${B}/about-us/`;
    expect((await (await mk(resolver('two-pages', 'one-post'))).resolve([u])).get(u)).toBeNull();
    expect((await (await mk(resolver('empty-list', 'two-pages'))).resolve([u])).get(u)).toBeNull();
  });
  it('/ and misses resolve to null; / makes no lookup', async () => {
    const f = resolver('empty-list', 'empty-list');
    const a = await mk(f);
    const n = f.calls.length;
    const m = await a.resolve([`${B}/`, `${B}/gone/`]);
    expect(m.get(`${B}/`)).toBeNull();
    expect(m.get(`${B}/gone/`)).toBeNull();
    expect(f.calls.slice(n).every((c) => c.url.includes('slug=gone'))).toBe(true);
  });
});

describe('resolve by permalink', () => {
  const rec = (id: number, slug: string, path: string) => `{"id":${id},"slug":"${slug}","link":"${B}${path}"}`;
  const by = (pages: string[], posts: string[]) => site('root-yoast', 'edit-list-yoast', (c) =>
    c.url.includes('/pages?slug=') ? `[${pages.join(',')}]` : c.url.includes('/posts?slug=') ? `[${posts.join(',')}]` : undefined);
  const one = async (f: ReturnType<typeof fake>, u: string) => (await (await mk(f)).resolve([u])).get(u);
  it('same slug on a page and a post picks the one whose link matches', async () => {
    const f = by([rec(5, 'winter-tips', '/winter-tips/')], [rec(6, 'winter-tips', '/blog/winter-tips/')]);
    expect(await one(f, `${B}/blog/winter-tips`)).toMatchObject({ kind: 'post', id: '6' });
    expect(await one(f, `${B}/winter-tips/`)).toMatchObject({ kind: 'page', id: '5' });
  });
  it('nested page under another parent is not confused', async () => {
    const f = by([rec(7, 'drain-cleaning', '/services/drain-cleaning/'), rec(8, 'drain-cleaning', '/drain-cleaning/')], []);
    expect(await one(f, `${B}/services/drain-cleaning`)).toMatchObject({ id: '7' });
    expect(await one(f, `${B}/drain-cleaning/`)).toMatchObject({ id: '8' });
  });
  it('no link match (or no link) resolves to null', async () => {
    expect(await one(by([rec(9, 'x', '/other/x/')], []), `${B}/x/`)).toBeNull();
    expect(await one(by([`{"id":9,"slug":"x"}`], []), `${B}/x/`)).toBeNull();
  });
  it('two records with the same link are ambiguous', async () => {
    expect(await one(by([rec(1, 'x', '/x/')], [rec(2, 'x', '/x/')]), `${B}/x/`)).toBeNull();
  });
});

describe('per-kind writability and echo verification', () => {
  const kinds = (pagesList: string, postsList: string, post: (c: Call) => Reply) => fake((c) =>
    c.method === 'POST' ? post(c) : c.url.endsWith('/wp-json') ? fx('root-yoast')
    : c.url.includes('/pages?') ? fx(pagesList) : c.url.includes('/posts?') ? fx(postsList) : '{}');
  it('probes each collection separately and checks r.kind on write', async () => {
    const f = kinds('edit-list-yoast', 'edit-list-nometa', (c) => JSON.stringify({ meta: c.body.meta ?? {} }));
    const a = await mk(f);
    expect(a.metaWritableByKind).toEqual({ page: true, post: false });
    await a.write(pageRef, { title: 'T' });
    const e = await a.write({ ...pageRef, kind: 'post' }, { title: 'T' }).catch((x: any) => x);
    expect(e.code).toBe('META_NOT_WRITABLE');
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
  it('meta silently dropped by WordPress: MetaNotWritableError when nothing else was sent', async () => {
    const f = kinds('edit-list-yoast', 'edit-list-yoast', () => '{"id":11,"meta":{}}');
    const e = await (await mk(f)).write(pageRef, { title: 'T' }).catch((x: any) => x);
    expect(e.code).toBe('META_NOT_WRITABLE');
  });
  it('dropped meta after h1 saved: PartialWriteError with h1 applied', async () => {
    const f = kinds('edit-list-yoast', 'edit-list-yoast', () => '{"id":11,"meta":{"_yoast_wpseo_metadesc":"x"}}');
    const e = await (await mk(f)).write(pageRef, { title: 'T', h1: 'H' }).catch((x: any) => x);
    expect(e).toBeInstanceOf(PartialWriteError);
    expect(e.appliedFields).toEqual(['h1']);
  });
});

describe('echo check tolerates sanitising', () => {
  const echo = (meta: string) => fake((c) => c.method === 'POST' ? `{"id":11,"meta":${meta}}` : c.url.endsWith('/wp-json') ? fx('root-yoast') : fx('edit-list-yoast'));
  it('whitespace, entity and tag changes are not a dropped write', async () => {
    const f = echo('{"_yoast_wpseo_title":"  Fish &amp; Chips  ","_yoast_wpseo_metadesc":"<b>Good</b>   food"}');
    await (await mk(f)).write(pageRef, { title: 'Fish & Chips', meta: 'Good <b>food</b>!' });
  });
  it('missing key is MetaNotWritableError', async () => {
    const e = await (await mk(echo('{"_yoast_wpseo_metadesc":"M"}'))).write(pageRef, { title: 'T', meta: 'M' }).catch((x: any) => x);
    expect(e.code).toBe('META_NOT_WRITABLE');
  });
  it('empty echoed value is MetaNotWritableError', async () => {
    const e = await (await mk(echo('{"_yoast_wpseo_title":""}'))).write(pageRef, { title: 'T' }).catch((x: any) => x);
    expect(e.code).toBe('META_NOT_WRITABLE');
  });
});

describe('transport', () => {
  it('refuses non-https bases except localhost / 127.0.0.1', async () => {
    const f = site('root-yoast', 'edit-list-yoast');
    await expect(wordpressAdapter({ base: 'http://trailhead.example', user: 'u', appPassword: 'p', fetchImpl: f.fetchImpl })).rejects.toThrow(/https/);
    expect(f.calls).toHaveLength(0);
    await wordpressAdapter({ base: 'http://localhost:8080', user: 'u', appPassword: 'p', fetchImpl: f.fetchImpl });
    await wordpressAdapter({ base: 'http://127.0.0.1', user: 'u', appPassword: 'p', fetchImpl: f.fetchImpl });
  });
  it('sends redirect: manual and rejects 3xx without following', async () => {
    let seen: any;
    const g = (async (_u: string, init: any) => { seen = init; return new Response('', { status: 301, headers: { Location: 'https://x.example' } }); }) as unknown as typeof fetch;
    const e = await wordpressAdapter({ base: B, user: 'u', appPassword: 'p', fetchImpl: g }).catch((x: Error) => x);
    expect(seen.redirect).toBe('manual');
    expect((e as Error).message).toBe('WordPress API redirected (301); use the final https URL as the site address');
  });
  it('non-JSON 2xx throws without echoing the body', async () => {
    const f = fake(() => ({ status: 200, body: '<html>secret page</html>' }));
    const e = await mk(f).catch((x: Error) => x);
    expect((e as Error).message).toBe('WordPress API error: non-JSON response');
  });
});

describe('read', () => {
  it('reads raw title and yoast meta; empty becomes null', async () => {
    const f = site('root-yoast', 'edit-list-yoast', (c) => c.url === `${B}/wp-json/wp/v2/pages/11?context=edit` ? fx('page-yoast') : undefined);
    expect(await (await mk(f)).read(pageRef)).toEqual({ title: 'About Trailhead', meta: null, h1: 'About Us' });
  });
  it('falls back to decoded rendered title; reads rank math keys', async () => {
    const body = fx('page-rendered-only').replace('_yoast_wpseo_title', 'rank_math_title').replace('_yoast_wpseo_metadesc', 'rank_math_description');
    const f = site('root-rankmath', 'edit-list-rankmath', (c) => c.url.includes('/posts/11') ? body : undefined);
    const a = await mk(f);
    expect(await a.read({ ...pageRef, kind: 'post' })).toEqual({ title: null, meta: 'Good food.', h1: 'Fish & Chips – Menu' });
    expect(f.calls.at(-1)!.url).toBe(`${B}/wp-json/wp/v2/posts/11?context=edit`);
  });
  it('title/meta null when the plugin is absent', async () => {
    const f = site('root-none', 'empty-list', (c) => c.url.includes('/pages/11') ? fx('page-yoast') : undefined);
    expect(await (await mk(f)).read(pageRef)).toEqual({ title: null, meta: null, h1: 'About Us' });
  });
});

describe('write', () => {
  const writer = (root = 'root-yoast', list = 'edit-list-yoast') => site(root, list, (c) => c.method === 'POST' ? JSON.stringify({ id: 11, meta: c.body.meta ?? {} }) : undefined);
  const posts = (f: ReturnType<typeof fake>) => f.calls.filter((c) => c.method === 'POST');
  it('sends h1 + yoast meta in ONE POST', async () => {
    const f = writer();
    await (await mk(f)).write(pageRef, { title: 'T', meta: 'M', h1: 'H' });
    expect(posts(f)).toHaveLength(1);
    expect(posts(f)[0]!.url).toBe(`${B}/wp-json/wp/v2/pages/11`);
    expect(posts(f)[0]!.body).toEqual({ title: 'H', meta: { _yoast_wpseo_title: 'T', _yoast_wpseo_metadesc: 'M' } });
  });
  it('uses rank math keys and the posts endpoint', async () => {
    const f = writer('root-rankmath', 'edit-list-rankmath');
    await (await mk(f)).write({ ...pageRef, kind: 'post' }, { title: 'T', meta: 'M' });
    expect(posts(f)[0]!.url).toBe(`${B}/wp-json/wp/v2/posts/11`);
    expect(posts(f)[0]!.body).toEqual({ meta: { rank_math_title: 'T', rank_math_description: 'M' } });
  });
  it('never sends null or empty fields; sends nothing when nothing remains', async () => {
    const f = writer();
    const a = await mk(f);
    await a.write(pageRef, { title: null, meta: 'M', h1: '' });
    expect(posts(f)[0]!.body).toEqual({ meta: { _yoast_wpseo_metadesc: 'M' } });
    await a.write(pageRef, { title: null, meta: '', h1: null });
    expect(posts(f)).toHaveLength(1);
  });
  it('throws META_NOT_WRITABLE for title/meta when meta is not writable, but allows h1', async () => {
    const f = writer('root-yoast', 'edit-list-nometa');
    const a = await mk(f);
    const e = await a.write(pageRef, { title: 'T' }).catch((x: any) => x);
    expect(e.code).toBe('META_NOT_WRITABLE');
    expect(e.message).toContain('META_NOT_WRITABLE');
    expect(posts(f)).toHaveLength(0);
    await a.write(pageRef, { h1: 'H' });
    expect(posts(f)[0]!.body).toEqual({ title: 'H' });
  });
  it('errors do not leak the body or password', async () => {
    const f = site('root-yoast', 'edit-list-yoast', (c) => c.method === 'POST' ? { status: 403, body: fx('forbidden') } : undefined);
    const e = await (await mk(f)).write(pageRef, { h1: 'H' }).catch((x: Error) => x);
    expect((e as Error).message).toBe('WordPress API error 403');
    const g = site('root-yoast', 'edit-list-yoast', (c) => c.method === 'POST' ? { status: 401 } : undefined);
    await expect((await mk(g)).write(pageRef, { h1: 'H' })).rejects.toThrow('WordPress rejected the application password');
  });
});

describe('wordpressCsv', () => {
  const P = (o: Partial<Proposal> & { url: string }): Proposal => ({
    type: 'page', tier: 'top', current: { title: null, meta: null, h1: null },
    proposed: { title: null, meta: null, h1: null }, reason: '', sources: [], issues: [], status: 'ok', approve: true, ...o,
  } as Proposal);
  it('writes the header and approved rows only, with RFC 4180 quoting', () => {
    const csv = wordpressCsv([
      P({ url: `${B}/a`, proposed: { title: 'Hello, "World"', meta: 'line1\nline2', h1: null } }),
      P({ url: `${B}/b`, approve: false, proposed: { title: 'No', meta: 'No', h1: null } }),
      P({ url: `${B}/c`, approve: null, proposed: { title: 'No', meta: 'No', h1: null } }),
      P({ url: `${B}/d`, proposed: { title: null, meta: 'Only meta', h1: null } }),
    ]);
    expect(csv).toBe(`url,seo_title,seo_description\r\n${B}/a,"Hello, ""World""","line1\nline2"\r\n${B}/d,,Only meta`);
  });
  it('blocks CSV formula injection', () => {
    const csv = wordpressCsv([P({ url: `${B}/a`, proposed: { title: '=SUM(A1)', meta: '@x', h1: null } }),
      P({ url: `${B}/b`, proposed: { title: '+1,2', meta: '-3', h1: null } })]);
    expect(csv).toBe(`url,seo_title,seo_description\r\n${B}/a,'=SUM(A1),'@x\r\n${B}/b,"'+1,2",'-3`);
  });
  it('also neutralises a leading tab or CR', () => {
    const csv = wordpressCsv([P({ url: `${B}/a`, proposed: { title: '\tx', meta: '\ry', h1: null } })]);
    expect(csv).toBe(`url,seo_title,seo_description\r\n${B}/a,'\tx,"'\ry"`);
  });
  it('skips approved rows whose status is not ok, so [ADD] text never reaches the CSV (R6)', () => {
    const csv = wordpressCsv([
      P({ url: `${B}/a`, status: 'needs review', proposed: { title: 'Bad row title', meta: 'Bad', h1: null } }),
      P({ url: `${B}/b`, status: 'has [ADD]', proposed: { title: 'Call [ADD: phone]', meta: 'x', h1: null } }),
      P({ url: `${B}/c`, proposed: { title: 'Good', meta: 'Fine', h1: null } }),
    ]);
    expect(csv).toBe(`url,seo_title,seo_description\r\n${B}/c,Good,Fine`);
    expect(csv).not.toContain('[ADD');
  });
  it('header only when nothing is approved', () => {
    expect(wordpressCsv([])).toBe('url,seo_title,seo_description');
  });
});

describe('a permission missing for one kind (no-access)', () => {
  const postRef = { url: `${B}/2026/winter-tips/`, kind: 'post', id: '21', h1RenamesRecord: true };
  it('a 403 on the edit probe for posts does not stop the adapter', async () => {
    const f = site('root-yoast', 'edit-list-yoast', (c) => (c.url.includes('/posts?context=edit&per_page=1') ? { status: 403, body: fx('forbidden') } : undefined));
    const a = await mk(f);
    expect(a.metaWritableByKind).toEqual({ page: true, post: false });
  });
  it('resolve marks a URL no-access when a slug lookup is forbidden, and carries on', async () => {
    const f = site('root-yoast', 'edit-list-yoast', (c) =>
      c.url.includes('/posts?slug=') ? { status: 403, body: fx('forbidden') } : c.url.includes('/pages?slug=') ? fx('one-page') : undefined);
    const a = await mk(f);
    const u = `${B}/company/about-us/`;
    const m = await a.resolve([u]);
    expect(m.get(u)).toBeNull();
    expect(a.noAccess!.get(u)).toMatch(/WordPress/);
    expect(a.noAccess!.get(u)).not.toContain('secret body text');
  });
  it('read of a post the user may not edit throws NoAccessError naming posts', async () => {
    const { NoAccessError } = await import('../scripts/lib/publish/common.ts');
    const f = site('root-yoast', 'edit-list-yoast', (c) => (c.url.includes('/posts/21') ? { status: 403, body: fx('forbidden') } : undefined));
    const e = await (await mk(f)).read(postRef).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NoAccessError);
    expect((e as Error).message).toMatch(/can't edit WordPress posts/);
  });
  it('a 401 still fails resolve loudly', async () => {
    let n = 0;
    const f = site('root-yoast', 'edit-list-yoast', (c) => (c.url.includes('slug=') && ++n ? { status: 401 } : undefined));
    await expect((await mk(f)).resolve([`${B}/company/about-us/`])).rejects.toThrow('WordPress rejected the application password');
  });
});
