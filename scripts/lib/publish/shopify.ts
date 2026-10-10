import { NoAccessError, PartialWriteError, type Adapter, type FieldValues, type RecordRef } from './common.ts';
import type { Field } from '../types.ts';

/** Latest stable Admin API version, confirmed with the Shopify toolkit's GraphQL validator on 2026-10-09. */
export const SHOPIFY_API_VERSION = '2026-07';

export interface ShopifyConfig {
  shop: string;
  token: string;
  fetchImpl?: typeof fetch;
  apiVersion?: string;
  /** Injectable so tests never really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRIES = 3;
const DEFAULT_RETRY_SECONDS = 2;

const SEO_FIELDS = `titleTag: metafield(namespace: "global", key: "title_tag") { value type } descriptionTag: metafield(namespace: "global", key: "description_tag") { value type }`;

const Q_PRODUCT = `query ProductByHandle($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { id title seo { title description } } }`;
const Q_COLLECTION = `query CollectionByHandle($handle: String!) { collectionByIdentifier(identifier: { handle: $handle }) { id title seo { title description } } }`;
const Q_PAGES = `query PageByHandle($query: String!) { pages(first: 25, query: $query) { nodes { id handle title ${SEO_FIELDS} } } }`;
const Q_ARTICLES = `query ArticleByHandle($query: String!) { articles(first: 25, query: $query) { nodes { id handle title blog { handle } ${SEO_FIELDS} } } }`;
const Q_NODE = `query NodeSeo($id: ID!) { node(id: $id) { __typename id ... on Product { title seo { title description } } ... on Collection { title seo { title description } } ... on Page { title ${SEO_FIELDS} } ... on Article { title ${SEO_FIELDS} } } }`;

const M_PRODUCT = `mutation ProductUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`;
const M_COLLECTION = `mutation CollectionUpdate($collection: CollectionUpdateInput!) { collectionUpdate(collection: $collection) { collection { id } userErrors { field message } } }`;
const M_METAFIELDS = `mutation SetMeta($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } } }`;
const M_PAGE = `mutation PageUpdate($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } } }`;
const M_ARTICLE = `mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { id } userErrors { field message } } }`;
const M_METAFIELDS_DELETE = `mutation DeleteMeta($metafields: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $metafields) { deletedMetafields { key namespace ownerId } userErrors { field message } } }`;

interface GqlError { message?: string; extensions?: { code?: string } }
interface UserError { message: string }

/** Shopify's docs: the global title_tag / description_tag metafields are single_line_text_field.
 *  https://shopify.dev/docs/apps/build/marketing/optimize-storefront-seo */
const DEFAULT_SEO_TYPE = 'single_line_text_field';
const TYPENAME: Record<string, string> = { product: 'Product', collection: 'Collection', page: 'Page', article: 'Article' };

/** What to tell the owner when the custom app may not read a kind of record (a missing Admin API scope). */
const PAGES_SCOPE = 'add the read_online_store_pages scope (read_content on older apps) to the custom app, plus write_online_store_pages (write_content) to publish them, then reinstall it';
const NO_ACCESS: Record<string, string> = {
  product: "The app can't read Shopify products: add the read_products scope to the custom app, plus write_products to publish them, then reinstall it.",
  collection: "The app can't read Shopify collections: add the read_products scope to the custom app, plus write_products to publish them, then reinstall it.",
  page: `The app can't read Shopify pages: ${PAGES_SCOPE}.`,
  article: `The app can't read Shopify blog posts: ${PAGES_SCOPE}.`,
};
const KIND_OF_HEAD: Record<string, string> = { products: 'product', collections: 'collection', pages: 'page', blogs: 'article' };

function decodeSegment(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** `/products/Foo/?x=1` -> ['products','foo']; null when the URL is unusable. */
function segmentsOf(url: string): string[] | null {
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  const segs = path.split('/').filter(Boolean).map((s) => decodeSegment(s).toLowerCase());
  return segs.length ? segs : null;
}

export function shopifyAdapter(cfg: ShopifyConfig): Adapter {
  const doFetch = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shop = cfg.shop.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const endpoint = `https://${shop}/admin/api/${cfg.apiVersion ?? SHOPIFY_API_VERSION}/graphql.json`;

  async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      // The token goes only in this header, never into a URL, body or error message.
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': cfg.token },
        body: JSON.stringify({ query, variables }),
      });
      // 429 and transient gateway errors (502/503/504) are retried; SEO field writes are idempotent, so a retry is safe.
      let throttled = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      let json: any;
      if (!throttled) {
        // 403 or ACCESS_DENIED: the app lacks a scope for this kind of record. 401 (bad token) stays a plain error.
        if (res.status === 403) throw new NoAccessError('Shopify denied access (HTTP 403)');
        if (!res.ok) throw new Error(`Shopify request failed with HTTP ${res.status}`);
        json = await res.json();
        const errs: GqlError[] = Array.isArray(json?.errors) ? json.errors : [];
        if (errs.some((e) => e.extensions?.code === 'THROTTLED')) throttled = true;
        else if (errs.some((e) => e.extensions?.code === 'ACCESS_DENIED')) throw new NoAccessError(errs.map((e) => e.message ?? 'Access denied').join('; '));
        else if (errs.length) throw new Error(errs.map((e) => e.message ?? 'Unknown GraphQL error').join('; '));
      }
      if (!throttled) return json.data;
      if (attempt >= MAX_RETRIES) throw new Error(`Shopify kept throttling the request (gave up after ${MAX_RETRIES} retries)`);
      const secs = Number(res.headers.get('Retry-After'));
      await sleep((Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_RETRY_SECONDS) * 1000);
    }
  }

  function check(payload: { userErrors?: UserError[] } | null | undefined): void {
    if (!payload) throw new Error('Shopify returned no result for the update');
    const errs = payload?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  }

  function ref(url: string, kind: string, id: string): RecordRef {
    return { url, kind, id, h1RenamesRecord: true };
  }

  async function resolveOne(url: string): Promise<RecordRef | null> {
    const segs = segmentsOf(url);
    if (!segs) return null;
    const [head, a, b] = segs;
    if (head === 'products' && segs.length === 2) {
      const n = (await gql(Q_PRODUCT, { handle: a }))?.productByIdentifier;
      return n ? ref(url, 'product', n.id) : null;
    }
    if (head === 'collections' && segs.length === 2) {
      const n = (await gql(Q_COLLECTION, { handle: a }))?.collectionByIdentifier;
      return n ? ref(url, 'collection', n.id) : null;
    }
    if (head === 'pages' && segs.length === 2) {
      const nodes: { id: string; handle: string }[] = (await gql(Q_PAGES, { query: `handle:${a}` }))?.pages?.nodes ?? [];
      const n = nodes.find((x) => x.handle.toLowerCase() === a);
      return n ? ref(url, 'page', n.id) : null;
    }
    if (head === 'blogs' && segs.length === 3) {
      const nodes: { id: string; handle: string; blog?: { handle: string } }[] =
        (await gql(Q_ARTICLES, { query: `handle:${b}` }))?.articles?.nodes ?? [];
      const n = nodes.find((x) => x.handle.toLowerCase() === b && x.blog?.handle.toLowerCase() === a);
      return n ? ref(url, 'article', n.id) : null;
    }
    return null;
  }

  const tag = (m: { value: string } | null | undefined): string | null => m?.value ?? null;

  /** A NoAccessError from gql, reworded to name the scope for this kind of record. */
  const scoped = (kind: string | undefined) => (e: unknown): never => {
    if (e instanceof NoAccessError && kind && NO_ACCESS[kind]) throw new NoAccessError(NO_ACCESS[kind]);
    throw e;
  };

  async function readNode(r: RecordRef): Promise<any> {
    const want = TYPENAME[r.kind];
    if (!want) throw new Error(`Unsupported Shopify record kind "${r.kind}"`);
    const node = (await gql(Q_NODE, { id: r.id }).catch(scoped(r.kind)))?.node;
    if (!node) throw new Error(`Shopify record ${r.id} was not found`);
    if (node.__typename !== want) throw new Error(`Shopify record ${r.id} is a ${node.__typename}, expected ${want}`);
    return node;
  }

  const noAccess = new Map<string, string>();

  return {
    platform: 'shopify',
    supports: ['title', 'meta', 'h1'],

    noAccess,

    async resolve(urls) {
      const out = new Map<string, RecordRef | null>();
      for (const u of urls) {
        try { out.set(u, await resolveOne(u)); } catch (e) {
          if (!(e instanceof NoAccessError)) throw e;
          // One kind the app may not read is skipped with the scope to add; the other kinds carry on.
          const kind = KIND_OF_HEAD[segmentsOf(u)?.[0] ?? ''];
          noAccess.set(u, (kind && NO_ACCESS[kind]) || `The app can't read this Shopify record: ${e.message}. Check the custom app's Admin API scopes.`);
          out.set(u, null);
        }
      }
      return out;
    },

    async read(r): Promise<FieldValues> {
      const node = await readNode(r);
      if (r.kind === 'product' || r.kind === 'collection') {
        return { title: node.seo?.title ?? null, meta: node.seo?.description ?? null, h1: node.title ?? null };
      }
      return { title: tag(node.titleTag), meta: tag(node.descriptionTag), h1: node.title ?? null };
    },

    async write(r, values) {
      // '' is treated like null: an empty string is never sent.
      const str = (v: string | null | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
      const title = str(values.title), meta = str(values.meta), h1 = str(values.h1);
      // A field that is absent or null is never sent (no clearing).
      if (r.kind === 'product' || r.kind === 'collection') {
        // SEOInput has two optional fields, so only the subfield(s) being changed go out and the other is left alone.
        const seo: { title?: string; description?: string } = {};
        if (title !== undefined) seo.title = title;
        if (meta !== undefined) seo.description = meta;
        const input: Record<string, unknown> = { id: r.id };
        if (h1 !== undefined) input['title'] = h1;
        if (Object.keys(seo).length) input['seo'] = seo;
        if (Object.keys(input).length === 1) return;
        if (r.kind === 'product') {
          check((await gql(M_PRODUCT, { product: input }))?.productUpdate);
        } else {
          check((await gql(M_COLLECTION, { collection: input }))?.collectionUpdate);
        }
        return;
      }
      if (r.kind !== 'page' && r.kind !== 'article') throw new Error(`Unsupported Shopify record kind "${r.kind}"`);
      if (title === undefined && meta === undefined && h1 === undefined) return;
      const applied: Field[] = [];
      if (title !== undefined || meta !== undefined) {
        // Reuse the type of any existing metafield; never change it. Absent ones get the documented default.
        const node = await readNode(r);
        const typeOf = (m: { type?: string } | null | undefined) => m?.type ?? DEFAULT_SEO_TYPE;
        const metafields: Record<string, string>[] = [];
        if (title !== undefined) { metafields.push({ ownerId: r.id, namespace: 'global', key: 'title_tag', type: typeOf(node.titleTag), value: title }); applied.push('title'); }
        if (meta !== undefined) { metafields.push({ ownerId: r.id, namespace: 'global', key: 'description_tag', type: typeOf(node.descriptionTag), value: meta }); applied.push('meta'); }
        check((await gql(M_METAFIELDS, { metafields }))?.metafieldsSet);
      }
      if (h1 !== undefined) {
        try {
          if (r.kind === 'page') check((await gql(M_PAGE, { id: r.id, page: { title: h1 } }))?.pageUpdate);
          else check((await gql(M_ARTICLE, { id: r.id, article: { title: h1 } }))?.articleUpdate);
        } catch (e) {
          if (applied.length) throw new PartialWriteError(e instanceof Error ? e.message : String(e), applied);
          throw e;
        }
      }
    },

    /** Rollback of a field that had no override: products and collections get an empty SEO field, pages and articles lose the metafield. */
    async clear(r, fields) {
      if (fields.includes('h1')) throw new Error('Pit Crew cannot clear an H1 (the record title) on Shopify; not restorable');
      if (!fields.length) return;
      if (r.kind === 'product' || r.kind === 'collection') {
        const seo: { title?: string; description?: string } = {};
        if (fields.includes('title')) seo.title = '';
        if (fields.includes('meta')) seo.description = '';
        if (r.kind === 'product') check((await gql(M_PRODUCT, { product: { id: r.id, seo } }))?.productUpdate);
        else check((await gql(M_COLLECTION, { collection: { id: r.id, seo } }))?.collectionUpdate);
        return;
      }
      if (r.kind !== 'page' && r.kind !== 'article') throw new Error(`Unsupported Shopify record kind "${r.kind}"`);
      const metafields = fields.map((f) => ({ ownerId: r.id, namespace: 'global', key: f === 'title' ? 'title_tag' : 'description_tag' }));
      check((await gql(M_METAFIELDS_DELETE, { metafields }))?.metafieldsDelete);
    },
  };
}
