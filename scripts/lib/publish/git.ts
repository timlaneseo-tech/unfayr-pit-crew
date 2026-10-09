import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { PartialWriteError, type Adapter, type FieldValues, type RecordRef } from './common.ts';
import type { Field } from '../types.ts';
import { decodeEntities } from '../text.ts';
import { hostOf } from '../urls.ts';

export interface GitConfig { repoDir: string; origin: string }

/** Blank out comments and script/style bodies (same length) so tag searches never match inside them. */
function mask(html: string): string {
  const blank = (m: string) => m.replace(/[^\r\n]/g, ' ');
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, blank)
    .replace(/(<(script|style)(?=[\s>/])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>|$)/gi, (_m, open: string, _t: string, body: string, close: string) => open + blank(body) + close);
}

interface Span { start: number; end: number }
interface Found { inner: Span }
interface MetaFound { value: Span; quote: string }

/** Quote-aware opening tag: a '>' inside a quoted attribute does not end it; <h1-x> is not <h1>. */
const openTag = (tag: string) => String.raw`<${tag}(?=[\s>/])(?:[^>"']|"[^"]*"|'[^']*')*>`;

function findElement(masked: string, tag: string): Found | null {
  const m = new RegExp(String.raw`(${openTag(tag)})([\s\S]*?)</${tag}\s*>`, 'i').exec(masked);
  if (!m) return null;
  const start = m.index + m[1]!.length;
  return { inner: { start, end: start + (m[2] ?? '').length } };
}

/** Locates content="" of the first <meta {attr}="{want}"> (default name=description); 'no-content' when the tag lacks a quoted content attribute. */
function findMeta(masked: string, attr = 'name', want = 'description'): MetaFound | 'no-content' | null {
  const tagRe = new RegExp(openTag('meta'), 'gi');
  const attrRe = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/dg;
  for (let t = tagRe.exec(masked); t; t = tagRe.exec(masked)) {
    const tag = t[0];
    let isMatch = false;
    let content: MetaFound | null = null;
    attrRe.lastIndex = 5;
    for (let a = attrRe.exec(tag); a; a = attrRe.exec(tag)) {
      const name = (a[1] ?? '').toLowerCase();
      const dq = a.indices?.[2], sq = a.indices?.[3];
      if (name === attr) isMatch = (a[2] ?? a[3] ?? a[4] ?? '').trim().toLowerCase() === want;
      else if (name === 'content' && (dq || sq)) {
        const idx = (dq ?? sq)!;
        content = { value: { start: t.index + idx[0], end: t.index + idx[1] }, quote: dq ? '"' : "'" };
      }
    }
    if (isMatch) return content ?? 'no-content';
  }
  return null;
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string, q: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(q === "'" ? /'/g : /(?!)/g, '&#39;');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? oneLine(v) : null);
/** Inline text formatting an <h1> may hold and still be rewritten as plain text. Anything else (a logo <img>, a link) is left alone. */
const H1_INLINE = new Set(['span', 'em', 'strong', 'b', 'i', 'br']);
function h1Blocker(inner: string): string | null {
  for (const m of inner.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)) {
    const name = m[1]!.toLowerCase();
    if (!H1_INLINE.has(name)) return name;
  }
  return null;
}
const writeAtomic = (abs: string, out: string) => {
  const tmp = `${abs}.pitcrew-${process.pid}.tmp`;
  try { writeFileSync(tmp, out, 'utf8'); renameSync(tmp, abs); } catch (e) { rmSync(tmp, { force: true }); throw e; }
};

export function gitAdapter(cfg: GitConfig): Adapter {
  const root = resolvePath(cfg.repoDir);
  const originHost = hostOf(cfg.origin) || null;
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { realRoot = root; }

  const inside = (abs: string): boolean => {
    const rel = relative(root, abs);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  /** Absolute path for a repo-relative id, refusing anything that leaves the repo. */
  function fileFor(id: string): string {
    const abs = resolvePath(root, id);
    if (typeof id !== 'string' || id.includes('\0') || !inside(abs) || (existsSync(abs) && !realInside(abs))) throw new Error('Refusing to touch a file outside the repository');
    return abs;
  }
  /** True when the real path (symlinks resolved) stays inside the real repo dir. */
  function realInside(abs: string): boolean {
    try {
      const rel = relative(realRoot, realpathSync(abs));
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    } catch { return false; }
  }
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile() && realInside(p);

  function resolveOne(url: string): RecordRef | null {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (originHost !== null && hostOf(url) !== originHost) return null;
    const segs: string[] = [];
    for (const raw of u.pathname.split('/')) {
      let s = raw;
      try { s = decodeURIComponent(raw); } catch { return null; }
      if (s === '') continue;
      if (s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
      segs.push(s);
    }
    const rels = segs.length === 0
      ? ['index.html']
      : [[...segs, 'index.html'].join('/'), segs.join('/') + '.html'];
    for (const rel of rels) {
      const abs = resolvePath(root, rel);
      if (!inside(abs)) return null;
      if (isFile(abs)) return { url, kind: 'file', id: relative(root, abs).split(sep).join('/'), h1RenamesRecord: false };
    }
    return null;
  }

  function load(r: RecordRef): { abs: string; html: string } {
    if (r.kind !== 'file') throw new Error(`Unsupported record kind "${r.kind}"`);
    const abs = fileFor(r.id);
    const buf = readFileSync(abs);
    let html: string;
    try { html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { throw new Error(`${r.id} is not valid UTF-8; refusing to rewrite it`); }
    return { abs, html };
  }

  return {
    platform: 'git',
    supports: ['title', 'meta', 'h1'],
    // The file is the page: what read() returns is what the deployed page renders.
    rawIsRendered: true,
    async resolve(urls) {
      const out = new Map<string, RecordRef | null>();
      for (const u of urls) out.set(u, resolveOne(u));
      return out;
    },

    async read(r): Promise<FieldValues> {
      const { html } = load(r);
      const masked = mask(html);
      const text = (f: Found | null, stripTags: boolean) => {
        if (!f) return null;
        let s = html.slice(f.inner.start, f.inner.end);
        if (stripTags) s = s.replace(/<[^>]*>/g, '');
        s = oneLine(decodeEntities(s));
        return s === '' ? null : s;
      };
      const m = findMeta(masked);
      const meta = m && m !== 'no-content' ? oneLine(decodeEntities(html.slice(m.value.start, m.value.end))) : null;
      return { title: text(findElement(masked, 'title'), false), meta: meta === '' ? null : meta, h1: text(findElement(masked, 'h1'), true) };
    },

    async write(r, values) {
      const title = nonEmpty(values.title), meta = nonEmpty(values.meta), h1 = nonEmpty(values.h1);
      if (title === null && meta === null && h1 === null) return;
      const { abs, html } = load(r);
      const masked = mask(html);
      const edits: { start: number; end: number; text: string }[] = [];
      const titleEl = findElement(masked, 'title');
      if (!titleEl && (title !== null || meta !== null)) {
        throw new Error(`${r.id} has no <title> element; add one to the file before publishing (Pit Crew will not invent a <head>)`);
      }
      /** Open Graph tags that currently repeat the old value follow it to the new one. Tags that differ, or are absent, are left alone. */
      const syncOg = (property: string, oldValue: string | null, next: string) => {
        const og = findMeta(masked, 'property', property);
        if (!og || og === 'no-content' || oldValue === null) return;
        if (oneLine(decodeEntities(html.slice(og.value.start, og.value.end))) === oldValue) edits.push({ ...og.value, text: escAttr(next, og.quote) });
      };
      if (title !== null) {
        const oldTitle = oneLine(decodeEntities(html.slice(titleEl!.inner.start, titleEl!.inner.end)));
        edits.push({ ...titleEl!.inner, text: escText(title) });
        syncOg('og:title', oldTitle === '' ? null : oldTitle, title);
      }
      if (meta !== null) {
        const m = findMeta(masked);
        if (m === 'no-content') throw new Error(`${r.id} has a meta description without a quoted content attribute; fix it by hand first`);
        if (m) {
          edits.push({ ...m.value, text: escAttr(meta, m.quote) });
          const oldMeta = oneLine(decodeEntities(html.slice(m.value.start, m.value.end)));
          syncOg('og:description', oldMeta === '' ? null : oldMeta, meta);
        }
        else {
          const eol = html.includes('\r\n') ? '\r\n' : '\n';
          const openAt = masked.search(/<title\b/i);
          const lineStart = Math.max(html.lastIndexOf('\n', openAt - 1) + 1, 0);
          const indent = /^[ \t]*$/.test(html.slice(lineStart, openAt)) ? html.slice(lineStart, openAt) : '';
          const at = titleEl!.inner.end + masked.slice(titleEl!.inner.end).match(/^<\/title\s*>/i)![0].length;
          edits.push({ start: at, end: at, text: `${eol}${indent}<meta name="description" content="${escAttr(meta, '"')}">` });
        }
      }
      let h1Problem: string | null = null;
      if (h1 !== null) {
        const el = findElement(masked, 'h1');
        const blocker = el ? h1Blocker(masked.slice(el.inner.start, el.inner.end)) : null;
        if (!el) h1Problem = `${r.id} has no <h1> element to rewrite`;
        else if (blocker) h1Problem = `${r.id} has an <h1> that holds a <${blocker}> element (often a logo or a link); Pit Crew will not rewrite it, change that heading by hand`;
        else edits.push({ ...el.inner, text: escText(h1) });
      }
      const applied: Field[] = [];
      if (title !== null) applied.push('title');
      if (meta !== null) applied.push('meta');
      if (h1Problem && !applied.length) throw new Error(h1Problem);
      let out = html;
      for (const e of edits.sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
      writeAtomic(abs, out);
      // The title and meta are saved; only the heading was refused.
      if (h1Problem) throw new PartialWriteError(h1Problem, applied);
    },

    /** Rollback of a meta description that was absent: removes the tag Pit Crew inserted (or empties one it did not). Never removes a <title>. */
    async clear(r, fields) {
      if (fields.includes('title')) throw new Error(`${r.id}: Pit Crew never removes a <title>; not restorable`);
      if (fields.includes('h1')) throw new Error(`${r.id}: Pit Crew does not remove an <h1>; not restorable`);
      if (!fields.includes('meta')) return;
      const { abs, html } = load(r);
      const masked = mask(html);
      const m = findMeta(masked);
      if (!m || m === 'no-content') return;
      const titleEl = findElement(masked, 'title');
      if (titleEl) {
        const after = titleEl.inner.end + (masked.slice(titleEl.inner.end).match(/^<\/title\s*>/i)?.[0].length ?? 0);
        const inserted = /^\r?\n[ \t]*<meta name="description" content="[^"]*">/.exec(html.slice(after));
        if (inserted && after + inserted[0].length === m.value.end + 2) {
          writeAtomic(abs, html.slice(0, after) + html.slice(after + inserted[0].length));
          return;
        }
      }
      writeAtomic(abs, html.slice(0, m.value.start) + html.slice(m.value.end));
    },
  };
}

