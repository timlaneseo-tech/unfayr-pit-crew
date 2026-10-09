import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'node-html-parser';
import type { Field, FieldValues, Platform, Proposal } from '../types.ts';
import { normaliseUrl, hostOf } from '../urls.ts';
import { decodeEntities } from '../text.ts';

export type { FieldValues };

export interface RecordRef { url: string; kind: string; id: string; h1RenamesRecord: boolean }
export interface Adapter {
  platform: Platform | 'git';
  /** Fields this adapter can write. planChanges skips any other field as 'unsupported'. Omitted means all three. */
  supports?: Field[];
  /** True when read() returns exactly what the page renders (git files), so no page fetch is needed to compare. */
  rawIsRendered?: boolean;
  resolve(urls: string[]): Promise<Map<string, RecordRef | null>>;
  /** The platform's raw stored values. null means "no value / no override" (the theme renders its default). */
  read(ref: RecordRef): Promise<FieldValues>;
  write(ref: RecordRef, values: Partial<FieldValues>): Promise<void>;
  /** Removes the stored value of each field, so the platform falls back to its default (used by rollback when the original was empty). */
  clear?(ref: RecordRef, fields: Field[]): Promise<void>;
  /**
   * URLs resolve() could not look up because the credentials lack a permission for that kind of record, with a plain
   * message naming the fix. resolve() gives these null and records them here; snapshot turns them into 'no-access' skips.
   */
  noAccess?: Map<string, string>;
}
/**
 * Thrown by an adapter when the credentials lack a permission for one kind of record (HTTP 403, Shopify ACCESS_DENIED).
 * It skips those records instead of stopping the run. A failure for the whole site (HTTP 401) is a plain Error and stops it.
 */
export class NoAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAccessError';
  }
}
/** Thrown by an adapter when a multi-call write saved some fields before failing. */
export class PartialWriteError extends Error {
  appliedFields: Field[];
  constructor(message: string, appliedFields: Field[]) {
    super(message);
    this.name = 'PartialWriteError';
    this.appliedFields = appliedFields;
  }
}
export interface BackupRecord {
  ref: RecordRef;
  /** The adapter's RAW values, used for compare-and-set and rollback. */
  values: FieldValues;
  /** `url` is the normalised URL the user approved (may differ from ref.url when two URLs share one record). */
  url?: string;
  /** What the live page rendered at snapshot time (title, meta, first H1). null: the page could not be read. Absent: not checked. */
  rendered?: FieldValues | null;
}
export interface Backup {
  id: string; host: string; createdAt: string;
  records: BackupRecord[];
  /** Approved URLs the adapter could not resolve (normalised); planChanges turns these into 'unresolved' skips. */
  unresolved?: string[];
  /** The adapter's supported fields at snapshot time (M4). */
  supports?: Field[];
  /** Approved URLs the credentials are not allowed to read, with the message naming the fix (normalised URLs). */
  noAccess?: { url: string; message: string }[];
}
/** `from` is the raw stored value before the change (null = no override); `was` is what the page rendered before. */
export interface PlannedChange { ref: RecordRef; field: Field; from: string | null; to: string; was?: string | null }
export type SkipReason = 'unresolved' | 'no-access' | 'live-changed' | 'live-unreadable' | 'unsupported' | 'renames-record' | 'lint' | 'empty-value' | 'duplicate-target';
export interface DryRun {
  backupId: string;
  changes: PlannedChange[];
  skipped: { url: string; field?: Field; reason: SkipReason; message?: string }[];
}
export interface LogEntry {
  url: string; field: Field; ok: boolean; error?: string; at: string; backupId?: string; action?: 'apply' | 'rollback';
  /** Why a field was left alone on purpose (compare-and-set). */
  reason?: 'live-changed';
  /** The live value already was the target, so nothing was written. */
  unchanged?: boolean;
}
export interface PublishLog {
  entries: LogEntry[];
  warnings?: string[];
}
/** Fetches a page's HTML as served (throws when it cannot). */
export type Render = (url: string) => Promise<string>;

/** The one gate for every publish and export route: approved by the user and passed lint (R6). */
export function publishable(p: Proposal): boolean {
  return p.approve === true && p.status === 'ok';
}
/** Approved rows that are held back because they did not pass lint, with their status, for the CLI to list. */
export function heldBack(proposals: Proposal[]): { url: string; status: Proposal['status'] }[] {
  return proposals.filter((p) => p.approve === true && p.status !== 'ok').map((p) => ({ url: p.url, status: p.status }));
}

/** M2: pause between record writes. API platforms get 250 ms so a large publish stays under rate limits; local git files need none. */
export function publishDelayMs(platform: string): number {
  return platform === 'git' ? 0 : 250;
}

const FIELDS: Field[] = ['title', 'meta', 'h1'];
const targetKey = (r: RecordRef) => JSON.stringify([r.kind, r.id]);
const fieldKey = (url: string, f: Field) => JSON.stringify([normaliseUrl(url), f]);
const LIVE_CHANGED = 'live-changed: the live value changed since the backup, so Pit Crew left it alone';

function writeJson(file: string, data: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const SAFE_ID = /^[0-9A-Za-z.-]+$/;
function safeId(id: string): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error(`Unsafe backup id "${String(id)}": only letters, digits, '.' and '-' are allowed.`);
  return id;
}

export function readBackup(run: string, id: string): Backup {
  return JSON.parse(readFileSync(join(run, 'backups', safeId(id) + '.json'), 'utf8')) as Backup;
}
export function writePlan(run: string, id: string, plan: DryRun): void {
  writeJson(join(run, 'plans', safeId(id) + '.json'), plan);
}
export function readPlan(run: string, id: string): DryRun {
  return JSON.parse(readFileSync(join(run, 'plans', safeId(id) + '.json'), 'utf8')) as DryRun;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

const errText = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

export async function snapshot(
  a: Adapter, run: string, approved: Proposal[], now: () => Date = () => new Date(), opts: { render?: Render } = {},
): Promise<Backup> {
  const urls = [...new Set(approved.filter((p) => p.approve === true).map((p) => normaliseUrl(p.url)))];
  const resolved = await a.resolve(urls).catch((e: unknown) => { throw new Error(errText(e)); });
  const byNorm = new Map<string, RecordRef | null>();
  for (const [k, v] of resolved) byNorm.set(normaliseUrl(k), v);
  const denied = new Map<string, string>();
  for (const [k, m] of a.noAccess ?? []) denied.set(normaliseUrl(k), m);
  const records: Backup['records'] = [];
  const unresolved: string[] = [];
  const noAccess: { url: string; message: string }[] = [];
  for (const u of urls) {
    const ref = byNorm.get(u) ?? null;
    if (!ref && denied.has(u)) { noAccess.push({ url: u, message: denied.get(u)! }); continue; }
    if (!ref) { unresolved.push(u); continue; }
    let v: FieldValues;
    try { v = await a.read(ref); } catch (e) {
      if (e instanceof NoAccessError) { noAccess.push({ url: u, message: errText(e) }); continue; }
      throw new Error(errText(e));
    }
    const values = { title: v.title ?? null, meta: v.meta ?? null, h1: v.h1 ?? null };
    const rec: BackupRecord = { ref, url: u, values };
    if (a.rawIsRendered) rec.rendered = { ...values };
    else if (opts.render) rec.rendered = await opts.render(u).then(renderedFields, () => null);
    records.push(rec);
  }
  const d = now();
  const backup: Backup = {
    id: d.toISOString().replace(/:/g, '-'),
    host: urls[0] ? hostOf(urls[0]) : '',
    createdAt: d.toISOString(),
    records, unresolved,
    ...(noAccess.length ? { noAccess } : {}),
    ...(a.supports ? { supports: [...a.supports] } : {}),
  };
  writeJson(join(run, 'backups', backup.id + '.json'), backup);
  return backup;
}

export function planChanges(backup: Backup, approved: Proposal[], opts: { includeRenamingH1: boolean; supports?: Field[] }): DryRun {
  const recs = new Map(backup.records.map((r) => [normaliseUrl(r.url ?? r.ref.url), r]));
  const unresolved = new Set((backup.unresolved ?? []).map(normaliseUrl));
  const denied = new Map((backup.noAccess ?? []).map((n) => [normaliseUrl(n.url), n.message]));
  const supports = opts.supports ?? backup.supports ?? FIELDS;
  const out: DryRun = { backupId: backup.id, changes: [], skipped: [] };
  const seenTargets = new Set<string>();
  for (const p of approved) {
    if (p.approve !== true) continue;
    const key = normaliseUrl(p.url);
    const rec = recs.get(key);
    if (!rec && denied.has(key)) { out.skipped.push({ url: p.url, reason: 'no-access', message: denied.get(key)! }); continue; }
    if (!rec || unresolved.has(key)) { out.skipped.push({ url: p.url, reason: 'unresolved' }); continue; }
    const target = targetKey(rec.ref);
    if (seenTargets.has(target)) { out.skipped.push({ url: p.url, reason: 'duplicate-target' }); continue; }
    seenTargets.add(target);
    if (rec.rendered === null && p.status === 'ok') { out.skipped.push({ url: p.url, reason: 'live-unreadable' }); continue; }
    for (const field of FIELDS) {
      const to = p.proposed[field];
      if (to === null) continue;
      if (p.status !== 'ok') { out.skipped.push({ url: p.url, field, reason: 'lint' }); continue; }
      if (norm(to) === '') { out.skipped.push({ url: p.url, field, reason: 'empty-value' }); continue; }
      if (!supports.includes(field)) { out.skipped.push({ url: p.url, field, reason: 'unsupported' }); continue; }
      const from = rec.values[field] ?? null;
      // R1: compare what the page renders (falls back to the raw value for backups taken without a page check).
      const was = rec.rendered ? rec.rendered[field] ?? null : from;
      if (norm(was) !== norm(p.current[field])) { out.skipped.push({ url: p.url, field, reason: 'live-changed' }); continue; }
      if (field === 'h1' && rec.ref.h1RenamesRecord && !opts.includeRenamingH1) { out.skipped.push({ url: p.url, field, reason: 'renames-record' }); continue; }
      out.changes.push(rec.rendered ? { ref: rec.ref, field, from, to, was } : { ref: rec.ref, field, from, to });
    }
  }
  return out;
}

/** One warning line per distinct no-access message in a backup, with how many approved pages it skipped. */
export function noAccessWarnings(backup: Backup): string[] {
  const counts = new Map<string, number>();
  for (const n of backup.noAccess ?? []) counts.set(n.message, (counts.get(n.message) ?? 0) + 1);
  return [...counts].map(([m, n]) => `${n} page${n === 1 ? '' : 's'} skipped: ${m}`);
}

/** When the credentials could read none of the approved pages, the plain reason (the run stops); otherwise null. */
export function noAccessBlocker(backup: Backup): string | null {
  if (backup.records.length || !backup.noAccess?.length) return null;
  const reasons = [...new Set(backup.noAccess.map((n) => n.message))].join(' ');
  return `None of the approved pages could be read with the saved credentials, so there is nothing to plan. ${reasons}`;
}

function readLogEntries(file: string): { entries: LogEntry[]; corrupt: boolean } {
  if (!existsSync(file)) return { entries: [], corrupt: false };
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(j)) return { entries: j, corrupt: false };
    if (j && typeof j === 'object' && Array.isArray(j.entries)) return { entries: j.entries, corrupt: false };
  } catch { /* fall through to corrupt */ }
  return { entries: [], corrupt: true };
}

/** Appends to publish-log.json; a corrupt or odd-shaped file is moved aside, never overwritten. Returns a warning if so. */
function appendLog(run: string, entries: LogEntry[]): string | undefined {
  const file = join(run, 'publish-log.json');
  const { entries: existing, corrupt } = readLogEntries(file);
  let warning: string | undefined;
  if (corrupt) {
    const aside = join(run, `publish-log.corrupt-${new Date().toISOString().replace(/:/g, '-')}.json`);
    renameSync(file, aside);
    warning = `publish-log.json was corrupt; moved aside to ${aside} and started a fresh log.`;
  }
  writeJson(file, { entries: [...existing, ...entries] });
  return warning;
}

const REDACTIONS: RegExp[] = [
  /access_token=[^\s&"']+/gi,
  /X-Shopify-Access-Token[:=]?\s*[^\s&"',]+/gi,
  /Bearer\s+[^\s&"',]+/gi,
  /Basic\s+[A-Za-z0-9+/=]{8,}/g,
];
/** Strip credential-looking tokens from text that will be logged. */
export function redact(msg: string): string {
  return REDACTIONS.reduce((m, re) => m.replace(re, '[redacted]'), msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Meta = { backupId: string; action: 'apply' | 'rollback' };

/** One write call; every field in `values` is logged ok or failed (a PartialWriteError names the fields that did save). */
async function writeOne(a: Adapter, ref: RecordRef, values: Partial<FieldValues>, meta: Meta): Promise<LogEntry[]> {
  let error: string | undefined;
  let applied: Field[] = [];
  try { await a.write(ref, values); } catch (e) {
    error = errText(e);
    if (e instanceof PartialWriteError) applied = e.appliedFields;
  }
  const at = new Date().toISOString();
  return FIELDS.filter((f) => values[f] !== undefined).map((field) => (error === undefined || applied.includes(field)
    ? { url: ref.url, field, ok: true, at, ...meta }
    : { url: ref.url, field, ok: false, error, at, ...meta }));
}

async function clearOne(a: Adapter, ref: RecordRef, fields: Field[], meta: Meta): Promise<LogEntry[]> {
  let error: string | undefined;
  try { await a.clear!(ref, fields); } catch (e) { error = errText(e); }
  const at = new Date().toISOString();
  return fields.map((field) => (error === undefined ? { url: ref.url, field, ok: true, at, ...meta } : { url: ref.url, field, ok: false, error, at, ...meta }));
}

function finish(run: string, log: PublishLog): PublishLog {
  if (log.entries.length) {
    const w = appendLog(run, log.entries);
    if (w) log.warnings = [w];
  }
  return log;
}

/**
 * Writes the planned changes, grouped per record. R4 compare-and-set: each record's raw values are read again just
 * before writing, and a field whose raw value is no longer the backup's is skipped as live-changed (logged, not written).
 * A field that already holds the new value is logged ok and not written again.
 */
export async function applyChanges(a: Adapter, run: string, plan: DryRun, opts: { delayMs?: number } = {}): Promise<PublishLog> {
  if (!existsSync(join(run, 'backups', safeId(plan.backupId) + '.json'))) {
    throw new Error(`Refusing to publish: no backup found for "${plan.backupId}" in ${join(run, 'backups')}. Take a snapshot first.`);
  }
  const groups = new Map<string, { ref: RecordRef; changes: PlannedChange[] }>();
  for (const c of plan.changes) {
    const k = targetKey(c.ref);
    const g = groups.get(k) ?? { ref: c.ref, changes: [] };
    g.changes.push(c);
    groups.set(k, g);
  }
  const meta: Meta = { backupId: plan.backupId, action: 'apply' };
  const log: PublishLog = { entries: [] };
  let first = true;
  for (const g of groups.values()) {
    if (!first && (opts.delayMs ?? 0) > 0) await sleep(opts.delayMs!);
    first = false;
    const entries: LogEntry[] = [];
    let now: FieldValues | undefined;
    try { now = await a.read(g.ref); } catch (e) {
      const at = new Date().toISOString();
      const error = `could not re-read the live value before writing: ${errText(e)}`;
      for (const c of g.changes) entries.push({ url: g.ref.url, field: c.field, ok: false, error, at, ...meta });
    }
    if (now) {
      const values: Partial<FieldValues> = {};
      const at = new Date().toISOString();
      for (const c of g.changes) {
        const live = norm(now[c.field]);
        if (live === norm(c.to)) entries.push({ url: g.ref.url, field: c.field, ok: true, unchanged: true, at, ...meta });
        else if (live !== norm(c.from)) entries.push({ url: g.ref.url, field: c.field, ok: false, reason: 'live-changed', error: LIVE_CHANGED, at, ...meta });
        else values[c.field] = c.to;
      }
      if (Object.keys(values).length) entries.push(...(await writeOne(a, g.ref, values, meta)));
    }
    // Logged per record, so a crash part-way through still leaves rollback an accurate record of what was written.
    if (entries.length) {
      const w = appendLog(run, entries);
      if (w) log.warnings = [...(log.warnings ?? []), w];
      log.entries.push(...entries);
    }
  }
  return log;
}

function fieldFromHtml(root: ReturnType<typeof parse>, field: Field): string | null {
  let raw: string | undefined;
  if (field === 'title') raw = root.querySelector('title')?.rawText;
  else if (field === 'h1') raw = root.querySelector('h1')?.rawText.replace(/<[^>]*>/g, '');
  else {
    raw = root.querySelectorAll('meta')
      .find((m) => (m.rawAttributes['name'] ?? '').trim().toLowerCase() === 'description')?.rawAttributes['content'];
  }
  if (raw === undefined) return null;
  const v = norm(decodeEntities(raw));
  return v === '' ? null : v;
}

/** The title, meta description and first H1 a page renders, decoded and whitespace-collapsed (null when absent or empty). */
export function renderedFields(html: string): FieldValues {
  const root = parse(html);
  return { title: fieldFromHtml(root, 'title'), meta: fieldFromHtml(root, 'meta'), h1: fieldFromHtml(root, 'h1') };
}

const SUFFIX_SEP = /^\s*[|\-–—:·]\s*\S/;
/** R2: the live value is `want`, or `want` followed by a separator and more text (a theme suffix such as " – Shop name"). */
function showsValue(live: string, want: string): boolean {
  if (want === '') return false;
  if (live === want) return true;
  return live.startsWith(want) && SUFFIX_SEP.test(live.slice(want.length));
}

export async function verifyLive(
  changes: PlannedChange[], fetcher: (url: string) => Promise<string>,
): Promise<{ url: string; field: Field; result: 'verified' | 'pending' | 'failed' }[]> {
  const pages = new Map<string, Promise<FieldValues | null>>();
  const out: { url: string; field: Field; result: 'verified' | 'pending' | 'failed' }[] = [];
  for (const c of changes) {
    let page = pages.get(c.ref.url);
    if (!page) { page = fetcher(c.ref.url).then(renderedFields, () => null); pages.set(c.ref.url, page); }
    const fields = await page;
    let result: 'verified' | 'pending' | 'failed' = 'failed';
    if (fields !== null) {
      const liveVal = norm(fields[c.field]);
      if (showsValue(liveVal, norm(c.to))) result = 'verified';
      else if (showsValue(liveVal, norm(c.was !== undefined ? c.was : c.from))) result = 'pending';
    }
    out.push({ url: c.ref.url, field: c.field, result });
  }
  return out;
}

/**
 * Restores the fields this backup's publish applied (ok 'apply' entries in publish-log.json), using the saved plan
 * (opts.plan, else plans/<id>.json) to know what was applied. R4: each record's raw values are read first and a field is
 * restored only while it still holds the applied value, entity-decoded (for a field that was empty before and whose raw value now reads empty, the rendered page may confirm
 * it instead); otherwise it is reported live-changed and left alone. R3: an empty original is cleared through
 * adapter.clear when the adapter has one, else reported not restorable.
 * Without apply entries it refuses, unless allFields === true (restore every non-null backup field, no checks).
 */
export async function rollback(
  a: Adapter, backup: Backup, opts: { run: string; plan?: DryRun; delayMs?: number; allFields?: boolean; render?: Render },
): Promise<PublishLog> {
  if (!opts?.run) throw new Error('rollback needs the run directory (opts.run) to read publish-log.json.');
  safeId(backup.id);
  const applied = new Set<string>();
  for (const e of readLogEntries(join(opts.run, 'publish-log.json')).entries) {
    if (e.backupId !== backup.id || e.action === 'rollback') continue;
    if (e.ok) applied.add(fieldKey(e.url, e.field));
  }
  const haveEntries = applied.size > 0;
  if (!haveEntries && opts.allFields !== true) {
    throw new Error(`No applied changes recorded for backup ${backup.id}; pass allFields: true to restore every field in the backup`);
  }
  const meta: Meta = { backupId: backup.id, action: 'rollback' };
  const entries: LogEntry[] = [];
  const at = new Date().toISOString();
  const seen = new Set<string>();
  let first = true;
  const pause = async () => { if (!first && (opts.delayMs ?? 0) > 0) await sleep(opts.delayMs!); first = false; };

  if (!haveEntries) {
    for (const r of backup.records) {
      if (seen.has(targetKey(r.ref))) continue;
      seen.add(targetKey(r.ref));
      const values: Partial<FieldValues> = {};
      for (const f of FIELDS) if (r.values[f] !== null && r.values[f] !== undefined) values[f] = r.values[f];
      if (!Object.keys(values).length) continue;
      await pause();
      entries.push(...(await writeOne(a, r.ref, values, meta)));
    }
    return finish(opts.run, { entries });
  }

  const plan = opts.plan ?? (existsSync(join(opts.run, 'plans', backup.id + '.json')) ? readPlan(opts.run, backup.id) : null);
  if (!plan) throw new Error(`No saved plan for backup ${backup.id}, so Pit Crew cannot tell what it applied. Run rollback from the run folder where publish-plan made it.`);
  const appliedTo = new Map(plan.changes.map((c) => [fieldKey(c.ref.url, c.field), c.to]));

  for (const r of backup.records) {
    if (seen.has(targetKey(r.ref))) continue;
    seen.add(targetKey(r.ref));
    const fields = FIELDS.filter((f) => applied.has(fieldKey(r.ref.url, f)));
    if (!fields.length) continue;
    await pause();
    let live: FieldValues;
    try { live = await a.read(r.ref); } catch (e) {
      for (const f of fields) entries.push({ url: r.ref.url, field: f, ok: false, error: `could not read the live value: ${errText(e)}`, at, ...meta });
      continue;
    }
    let page: FieldValues | null | undefined;
    const values: Partial<FieldValues> = {};
    const toClear: Field[] = [];
    for (const f of fields) {
      const orig = r.values[f] ?? null;
      const to = appliedTo.get(fieldKey(r.ref.url, f));
      const liveRaw = live[f] ?? null;
      // The raw value still holds what Pit Crew applied, allowing for entity encoding (WordPress sanitises & to &amp;).
      let still = to !== undefined && liveRaw !== null && norm(decodeEntities(liveRaw)) === norm(decodeEntities(to));
      // Only a raw value that reads back empty may be confirmed on the rendered page; any other raw value is a live
      // edit (even when a cached page still shows the applied text), so it is never written over or cleared.
      if (!still && to !== undefined && liveRaw === null && orig === null && opts.render) {
        if (page === undefined) page = await opts.render(r.url ?? r.ref.url).then(renderedFields, () => null);
        still = page !== null && showsValue(norm(page[f]), norm(to));
      }
      if (!still) { entries.push({ url: r.ref.url, field: f, ok: false, reason: 'live-changed', error: LIVE_CHANGED, at, ...meta }); continue; }
      if (orig !== null) values[f] = orig;
      else if (a.clear) toClear.push(f);
      else entries.push({ url: r.ref.url, field: f, ok: false, error: 'original was empty; not restorable', at, ...meta });
    }
    if (Object.keys(values).length) entries.push(...(await writeOne(a, r.ref, values, meta)));
    if (toClear.length) entries.push(...(await clearOne(a, r.ref, toClear, meta)));
  }
  return finish(opts.run, { entries });
}
