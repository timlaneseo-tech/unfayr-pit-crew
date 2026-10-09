import { NoAccessError, type Adapter, type FieldValues, type RecordRef } from './common.ts';

/** What to tell the owner when the token lacks a scope (HTTP 403) for one kind of record. */
const NO_ACCESS_PAGES = "The Webflow token can't read pages: make a new site token with the pages:read scope (plus pages:write to publish), then save it again.";
const NO_ACCESS_CMS = "The Webflow token can't read CMS items: make a new site token with the cms:read scope (plus cms:write to publish), then save it again.";
/** Rewords a 403 from api() as the scope fix for this kind of record; anything else is rethrown as is. */
const scoped = (message: string) => (e: unknown): never => { throw e instanceof NoAccessError ? new NoAccessError(message) : e; };

export interface WebflowConfig {
  token: string;
  siteId: string;
  /** Keyed by collection id: which item fields hold the SEO title and meta description. */
  cmsFields?: Record<string, { title: string; meta: string }>;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; used for 429 back-off. */
  sleep?: (ms: number) => Promise<void>;
}

const BASE = 'https://api.webflow.com';
const PAGE_SIZE = 100;
const MAX_RETRIES = 3;
const DEFAULT_RETRY_SECONDS = 2;
const MAX_RETRY_SECONDS = 60;

function decodePath(path: string): string {
  return path.split('/').map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } }).join('/');
}
/** Lowercased, decoded, no trailing slash. The root becomes ''. */
function normPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  return decodePath(p).toLowerCase().replace(/\/+$/, '');
}
function urlPath(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try { return normPath(new URL(url).pathname); } catch { return null; }
}
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const live = (r: any): boolean => !(r?.isDraft === true || r?.isArchived === true);

export function webflowAdapter(cfg: WebflowConfig): Adapter {
  const doFetch = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cmsFields = cfg.cmsFields ?? {};
  // The token lives only in this header: never in a URL, body or error message.
  const auth = `Bearer ${cfg.token}`;

  async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`${BASE}${path}`, {
        method: init.method ?? 'GET',
        redirect: 'manual',
        headers: init.body === undefined
          ? { Authorization: auth, Accept: 'application/json' }
          : { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      if (res.status === 401) throw new Error('Webflow rejected the API token');
      // 403: the token lacks a scope for this kind of record. Skipped per record; 401 above stops the run.
      if (res.status === 403) throw new NoAccessError('Webflow API error 403');
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const secs = Number(res.headers.get('Retry-After'));
        await sleep(Math.min(Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_RETRY_SECONDS, MAX_RETRY_SECONDS) * 1000);
        continue;
      }
      if (res.status >= 300 && res.status < 400) throw new Error(`Webflow API redirected (${res.status}); refusing to follow`);
      if (!res.ok) throw new Error(`Webflow API error ${res.status}`);
      try { return await res.json(); } catch { throw new Error('Webflow API error: non-JSON response'); }
    }
  }

  /** Follows offset/limit pagination until every record has been read. */
  async function listAll(path: string, key: string): Promise<any[]> {
    const out: any[] = [];
    let offset = 0;
    for (;;) {
      const body = await api(`${path}${path.includes('?') ? '&' : '?'}limit=${PAGE_SIZE}&offset=${offset}`);
      const batch: any[] = Array.isArray(body?.[key]) ? body[key] : [];
      out.push(...batch);
      offset += batch.length;
      const total = Number(body?.pagination?.total);
      if (batch.length === 0 || !Number.isFinite(total) || offset >= total) return out;
    }
  }

  const parent = (p: string) => p.slice(0, p.lastIndexOf('/'));
  const last = (p: string) => p.slice(p.lastIndexOf('/') + 1);

  const noAccess = new Map<string, string>();

  async function resolveAll(urls: string[]): Promise<Map<string, RecordRef | null>> {
    const out = new Map<string, RecordRef | null>();
    if (urls.length === 0) return out;
    let pages: any[];
    try { pages = await listAll(`/v2/sites/${encodeURIComponent(cfg.siteId)}/pages`, 'pages'); } catch (e) {
      if (!(e instanceof NoAccessError)) throw e;
      for (const url of urls) { noAccess.set(url, NO_ACCESS_PAGES); out.set(url, null); }
      return out;
    }
    const statics = new Map<string, any[]>();
    const templates: { dir: string; collectionId: string }[] = [];
    for (const p of pages) {
      if (!live(p)) continue;
      const path = normPath(p?.publishedPath ?? '');
      if (path === null) continue;
      if (typeof p?.collectionId === 'string' && p.collectionId) templates.push({ dir: parent(path), collectionId: p.collectionId });
      else statics.set(path, [...(statics.get(path) ?? []), p]);
    }
    const itemCache = new Map<string, Promise<any[]>>();
    for (const url of urls) {
      const want = urlPath(url);
      let ref: RecordRef | null = null;
      if (want !== null) {
        const cands = statics.get(want) ?? [];
        const page = cands.length === 1 ? cands[0] : undefined;
        if (cands.length > 1) {
          ref = null; // two live pages claim this path: never guess
        } else if (page && typeof page.id === 'string') {
          ref = { url, kind: 'page', id: page.id, h1RenamesRecord: false };
        } else if (want !== '') {
          const slug = last(want);
          const tpl = templates.find((t) => t.dir === parent(want) && cmsFields[t.collectionId]);
          if (tpl && slug) {
            let items = itemCache.get(tpl.collectionId);
            if (!items) { items = listAll(`/v2/collections/${encodeURIComponent(tpl.collectionId)}/items`, 'items'); itemCache.set(tpl.collectionId, items); }
            let all: any[];
            try { all = await items; } catch (e) {
              if (!(e instanceof NoAccessError)) throw e;
              noAccess.set(url, NO_ACCESS_CMS);
              out.set(url, null);
              continue;
            }
            const hits = all.filter((i) => live(i) && typeof i?.fieldData?.slug === 'string' && i.fieldData.slug.toLowerCase() === slug);
            const hit = hits.length === 1 ? hits[0] : undefined;
            if (hit && typeof hit.id === 'string') ref = { url, kind: 'cms-item', id: `${tpl.collectionId}:${hit.id}`, h1RenamesRecord: false };
          }
        }
      }
      out.set(url, ref);
    }
    return out;
  }

  function splitCms(r: RecordRef): { collectionId: string; itemId: string; fields: { title: string; meta: string } } {
    const i = r.id.indexOf(':');
    const collectionId = r.id.slice(0, i), itemId = r.id.slice(i + 1);
    const fields = i > 0 ? cmsFields[collectionId] : undefined;
    if (!fields) throw new Error('No CMS field mapping for this collection; ask which fields hold the SEO title and description');
    return { collectionId, itemId, fields };
  }
  function checkKind(r: RecordRef): void {
    if (r.kind !== 'page' && r.kind !== 'cms-item') throw new Error(`Unsupported Webflow record kind "${r.kind}"`);
  }

  return {
    platform: 'webflow',
    supports: ['title', 'meta'],

    resolve: resolveAll,
    noAccess,

    async read(r): Promise<FieldValues> {
      checkKind(r);
      if (r.kind === 'cms-item') {
        const { collectionId, itemId, fields } = splitCms(r);
        const item = await api(`/v2/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`).catch(scoped(NO_ACCESS_CMS));
        const fd = item?.fieldData ?? {};
        return { title: nonEmpty(fd[fields.title]), meta: nonEmpty(fd[fields.meta]), h1: null };
      }
      const page = await api(`/v2/pages/${encodeURIComponent(r.id)}`).catch(scoped(NO_ACCESS_PAGES));
      return { title: nonEmpty(page?.seo?.title), meta: nonEmpty(page?.seo?.description), h1: null };
    },

    async write(r, values) {
      checkKind(r);
      // null, undefined and '' are never sent. H1 is not editable on Webflow static pages and is ignored.
      const title = nonEmpty(values.title), meta = nonEmpty(values.meta);
      if (title === null && meta === null) return;
      if (r.kind === 'cms-item') {
        const { collectionId, itemId, fields } = splitCms(r);
        const fieldData: Record<string, string> = {};
        if (title !== null) fieldData[fields.title] = title;
        if (meta !== null) fieldData[fields.meta] = meta;
        await api(`/v2/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: { fieldData } });
        return;
      }
      // Send the full seo object: the unchanged half comes from a fresh read so it cannot be cleared.
      const fresh = await api(`/v2/pages/${encodeURIComponent(r.id)}`);
      const seo: Record<string, string> = {};
      const t = title ?? nonEmpty(fresh?.seo?.title), d = meta ?? nonEmpty(fresh?.seo?.description);
      if (t !== null) seo['title'] = t;
      if (d !== null) seo['description'] = d;
      // The site publish endpoint is deliberately never called: publishing is a separate yes.
      await api(`/v2/pages/${encodeURIComponent(r.id)}`, { method: 'PUT', body: { seo } });
    },

    /** Rollback of a field that was empty: the SEO field is set back to an empty string. */
    async clear(r, fields) {
      checkKind(r);
      if (fields.includes('h1')) throw new Error('Webflow H1s are not edited by Pit Crew; not restorable');
      if (!fields.length) return;
      if (r.kind === 'cms-item') {
        const { collectionId, itemId, fields: map } = splitCms(r);
        const fieldData: Record<string, string> = {};
        if (fields.includes('title')) fieldData[map.title] = '';
        if (fields.includes('meta')) fieldData[map.meta] = '';
        await api(`/v2/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: { fieldData } });
        return;
      }
      const fresh = await api(`/v2/pages/${encodeURIComponent(r.id)}`);
      const seo: Record<string, string> = {};
      const t = fields.includes('title') ? '' : nonEmpty(fresh?.seo?.title);
      const d = fields.includes('meta') ? '' : nonEmpty(fresh?.seo?.description);
      if (t !== null) seo['title'] = t;
      if (d !== null) seo['description'] = d;
      await api(`/v2/pages/${encodeURIComponent(r.id)}`, { method: 'PUT', body: { seo } });
    },
  };
}
