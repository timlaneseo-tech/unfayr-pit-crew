import { NoAccessError, PartialWriteError, publishable, type Adapter, type FieldValues, type RecordRef } from './common.ts';
import type { Proposal } from '../types.ts';
import { decodeEntities } from '../text.ts';

export type SeoPlugin = 'yoast' | 'rankmath' | 'none';

export interface WordPressConfig {
  base: string;
  user: string;
  appPassword: string;
  fetchImpl?: typeof fetch;
  /** Injectable so tests never really wait (429 back-off). */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRIES = 3;
const DEFAULT_RETRY_SECONDS = 2;
const MAX_RETRY_SECONDS = 60;

const META_KEYS = {
  yoast: { title: '_yoast_wpseo_title', meta: '_yoast_wpseo_metadesc' },
  rankmath: { title: 'rank_math_title', meta: 'rank_math_description' },
} as const;

type Kind = 'page' | 'post';
const COLLECTION: Record<Kind, string> = { page: 'pages', post: 'posts' };

/** Error carrying a machine-readable code so the publish skill can offer the CSV fallback. */
export class MetaNotWritableError extends Error {
  code = 'META_NOT_WRITABLE';
  constructor() {
    super('META_NOT_WRITABLE: this site does not expose the SEO plugin title/description fields over the REST API; use the CSV export instead');
    this.name = 'MetaNotWritableError';
  }
}

function decodePath(path: string): string {
  return path.split('/').map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } }).join('/');
}

/** Lowercased, percent-decoded pathname without a trailing slash; null when unusable. */
function normPath(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  return decodePath(path).toLowerCase().replace(/\/+$/, '');
}

function lastSlug(path: string): string | null {
  return path.split('/').filter(Boolean).pop() ?? null;
}

function assertSecureBase(base: string): void {
  let u: URL;
  try { u = new URL(base); } catch { throw new Error('WordPress site address is not a valid URL'); }
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !local) {
    throw new Error('WordPress site address must use https (http is allowed only for localhost)');
  }
}

function detect(namespaces: unknown): SeoPlugin {
  const ns = Array.isArray(namespaces) ? namespaces.map(String) : [];
  if (ns.includes('yoast/v1')) return 'yoast';
  if (ns.some((n) => n === 'rankmath/v1' || n.startsWith('rank-math') || n.startsWith('rankmath'))) return 'rankmath';
  return 'none';
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export async function wordpressAdapter(
  cfg: WordPressConfig,
): Promise<Adapter & { seoPlugin: SeoPlugin; metaWritable: boolean; metaWritableByKind: Record<'page' | 'post', boolean> }> {
  assertSecureBase(cfg.base);
  const doFetch = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = cfg.base.replace(/\/+$/, '');
  // The application password lives only in this header: never in a URL, body or error message.
  const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString('base64');

  async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        redirect: 'manual',
        headers: init.body === undefined
          ? { Authorization: auth, Accept: 'application/json' }
          : { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      if (res.status !== 429) break;
      if (attempt >= MAX_RETRIES) throw new Error(`WordPress kept answering 429 Too Many Requests (gave up after ${MAX_RETRIES} retries)`);
      const secs = Number(res.headers.get('Retry-After'));
      await sleep(Math.min(Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_RETRY_SECONDS, MAX_RETRY_SECONDS) * 1000);
    }
    if (res.status === 401) throw new Error('WordPress rejected the application password');
    // 403: this user may not do that to this kind of record. Skipped per record; 401 above stops the run.
    if (res.status === 403) throw new NoAccessError('WordPress API error 403');
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`WordPress API redirected (${res.status}); use the final https URL as the site address`);
    }
    if (!res.ok) throw new Error(`WordPress API error ${res.status}`);
    try { return await res.json(); } catch { throw new Error('WordPress API error: non-JSON response'); }
  }

  const root = await api('/wp-json');
  const seoPlugin = detect(root?.namespaces);
  const keys = seoPlugin === 'none' ? null : META_KEYS[seoPlugin];

  // Read-only probe per collection: the plugin's keys only appear in a record's `meta` when registered for REST.
  const writableByKind: Record<Kind, boolean> = { page: false, post: false };
  if (keys) {
    for (const kind of ['page', 'post'] as Kind[]) {
      let list: unknown;
      try { list = await api(`/wp-json/wp/v2/${COLLECTION[kind]}?context=edit&per_page=1`); } catch (e) {
        if (e instanceof NoAccessError) continue; // this user cannot edit that kind; its records are skipped as no-access
        throw e;
      }
      if (!Array.isArray(list) || list.length === 0) continue;
      const meta = list[0]?.meta;
      writableByKind[kind] = !!meta && typeof meta === 'object' && !Array.isArray(meta) && keys.title in meta && keys.meta in meta;
    }
  }
  const metaWritable = writableByKind.page || writableByKind.post;

  async function resolveOne(url: string): Promise<RecordRef | null> {
    const want = normPath(url);
    const slug = want === null ? null : lastSlug(want);
    if (want === null || !slug) return null;
    // A page and a post can share a slug, so both are queried and matched on their permalink path.
    const hits: RecordRef[] = [];
    for (const kind of ['page', 'post'] as Kind[]) {
      const list = await api(`/wp-json/wp/v2/${COLLECTION[kind]}?slug=${encodeURIComponent(slug)}`);
      if (!Array.isArray(list)) continue;
      for (const rec of list) {
        if (normPath(rec?.link) === want) hits.push({ url, kind, id: String(rec.id), h1RenamesRecord: true });
      }
    }
    return hits.length === 1 ? hits[0]! : null;
  }

  const noAccessFor = (what: string) =>
    `This WordPress user can't edit WordPress ${what}: give the user behind the application password the Editor role (or one that can edit ${what}), then run the plan again.`;
  const noAccess = new Map<string, string>();

  function collectionOf(r: RecordRef): string {
    if (r.kind !== 'page' && r.kind !== 'post') throw new Error(`Unsupported WordPress record kind "${r.kind}"`);
    return COLLECTION[r.kind];
  }

  return {
    platform: 'wordpress',
    supports: ['title', 'meta', 'h1'],
    seoPlugin,
    metaWritable,
    metaWritableByKind: writableByKind,
    noAccess,

    async resolve(urls) {
      const out = new Map<string, RecordRef | null>();
      for (const u of urls) {
        try { out.set(u, await resolveOne(u)); } catch (e) {
          if (!(e instanceof NoAccessError)) throw e;
          noAccess.set(u, noAccessFor('pages and posts'));
          out.set(u, null);
        }
      }
      return out;
    },

    async read(r): Promise<FieldValues> {
      const col = collectionOf(r);
      const rec = await api(`/wp-json/wp/v2/${col}/${encodeURIComponent(r.id)}?context=edit`).catch((e: unknown) => {
        throw e instanceof NoAccessError ? new NoAccessError(noAccessFor(col)) : e;
      });
      const raw = nonEmpty(rec?.title?.raw);
      const rendered = nonEmpty(rec?.title?.rendered);
      const meta = rec?.meta && typeof rec.meta === 'object' && !Array.isArray(rec.meta) ? rec.meta : {};
      return {
        title: keys ? nonEmpty(meta[keys.title]) : null,
        meta: keys ? nonEmpty(meta[keys.meta]) : null,
        h1: raw ?? (rendered ? decodeEntities(rendered) : null),
      };
    },

    async write(r, values) {
      const col = collectionOf(r);
      // null, undefined and '' are never sent.
      const title = nonEmpty(values.title), meta = nonEmpty(values.meta), h1 = nonEmpty(values.h1);
      if (title === null && meta === null && h1 === null) return;
      const body: Record<string, unknown> = {};
      if (h1 !== null) body['title'] = h1;
      if (title !== null || meta !== null) {
        if (!keys || !writableByKind[r.kind as Kind]) throw new MetaNotWritableError();
        const m: Record<string, string> = {};
        if (title !== null) m[keys.title] = title;
        if (meta !== null) m[keys.meta] = meta;
        body['meta'] = m;
      }
      const resp = await api(`/wp-json/wp/v2/${col}/${encodeURIComponent(r.id)}`, { method: 'POST', body });
      const sent = body['meta'] as Record<string, string> | undefined;
      if (sent) {
        const got = resp?.meta && typeof resp.meta === 'object' && !Array.isArray(resp.meta) ? resp.meta : {};
        if (Object.keys(sent).some((k) => typeof got[k] !== 'string' || got[k].trim() === '')) {
          // WordPress ignores unregistered meta keys silently; the title (if sent) did save. Only a missing or empty key counts as dropped: sanitising (tags, entities, whitespace) changes the stored value legitimately and verifyLive reports the live text.
          if (h1 !== null) throw new PartialWriteError('META_NOT_WRITABLE: the heading saved but WordPress did not store the SEO title/description', ['h1']);
          throw new MetaNotWritableError();
        }
      }
    },

    /** Rollback of a field that had no SEO plugin value: the plugin key is set back to an empty string. */
    async clear(r, fields) {
      if (fields.includes('h1')) throw new Error('Pit Crew cannot clear an H1 (the post or page title) on WordPress; not restorable');
      if (!fields.length) return;
      const col = collectionOf(r);
      if (!keys || !writableByKind[r.kind as Kind]) throw new MetaNotWritableError();
      const m: Record<string, string> = {};
      if (fields.includes('title')) m[keys.title] = '';
      if (fields.includes('meta')) m[keys.meta] = '';
      await api(`/wp-json/wp/v2/${col}/${encodeURIComponent(r.id)}`, { method: 'POST', body: { meta: m } });
    },
  };
}

function cell(v: string | null): string {
  if (v === null || v === '') return '';
  // Neutralise spreadsheet formulas, then apply RFC 4180 quoting.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV for the manual import fallback: approved rows that passed lint (status ok) only, so [ADD] text never reaches it. */
export function wordpressCsv(rows: Proposal[]): string {
  const lines = ['url,seo_title,seo_description'];
  for (const p of rows) {
    if (!publishable(p)) continue;
    lines.push([cell(p.url), cell(p.proposed.title), cell(p.proposed.meta)].join(','));
  }
  return lines.join('\r\n');
}
