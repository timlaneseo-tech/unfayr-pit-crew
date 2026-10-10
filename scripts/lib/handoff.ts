import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Field, Proposal } from './types.ts';

export type ChangeStatus = 'proposed' | 'approved' | 'published' | 'verified' | 'rolled-back';

interface Change {
  url: string; field: Field; before: string; after: string;
  status: ChangeStatus; published_at: string | null;
  /** Set when a rollback put the old value back. */
  rolled_back_at?: string | null;
}
interface Handoff {
  tool: 'pitcrew'; version: '1.0.0'; site: string; run_date: string; changes: Change[];
}

const FIELDS: Field[] = ['title', 'meta', 'h1'];
const file = (run: string) => join(run, 'onpage.json');

/**
 * Moves tmp over dest. On Windows a virus scanner or the search indexer can hold the file for a moment, so an
 * EPERM, EACCES or EBUSY rename is tried again a few times and then falls back to copying over dest.
 */
export function replaceFile(tmp: string, dest: string, rename: (a: string, b: string) => void = renameSync): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rename(tmp, dest); return; } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      const until = Date.now() + 50 * (attempt + 1);
      while (Date.now() < until) { /* short wait for the lock to clear */ }
    }
  }
  copyFileSync(tmp, dest);
  unlinkSync(tmp);
}

function save(run: string, data: Handoff): void {
  const tmp = `${file(run)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  replaceFile(tmp, file(run));
}

function load(run: string): Handoff | null {
  if (!existsSync(file(run))) return null;
  try { return JSON.parse(readFileSync(file(run), 'utf8')) as Handoff; } catch {
    throw new Error(`onpage.json is not valid JSON: ${file(run)}`);
  }
}

/** Writes onpage.json: one change per field that is proposed, non-null and different from current. */
export function writeHandoff(run: string, host: string, date: string, proposals: Proposal[]): void {
  const prior = new Map<string, Change>();
  for (const c of load(run)?.changes ?? []) prior.set(`${c.url}\n${c.field}`, c);
  const changes: Change[] = [];
  for (const p of proposals) {
    for (const field of FIELDS) {
      const after = p.proposed[field];
      const before = p.current[field];
      if (after === null || after === before) continue;
      const old = prior.get(`${p.url}\n${field}`);
      const keep = old && (old.status === 'published' || old.status === 'verified' || old.status === 'rolled-back');
      changes.push({
        url: p.url, field, before: before ?? '', after,
        status: keep ? old.status : p.approve === true ? 'approved' : 'proposed',
        published_at: keep ? old.published_at : null,
        ...(keep && old.rolled_back_at ? { rolled_back_at: old.rolled_back_at } : {}),
      });
    }
  }
  save(run, { tool: 'pitcrew', version: '1.0.0', site: host, run_date: date, changes });
}

/** Moves one change to a new status. 'published' stamps published_at; 'verified' keeps it; 'rolled-back' stamps rolled_back_at. */
export function markHandoff(run: string, url: string, field: Field, status: ChangeStatus, at?: string): void {
  const data = load(run);
  if (!data) throw new Error(`No onpage.json in ${run}. Generate the workbook first.`);
  const change = data.changes.find((c) => c.url === url && c.field === field);
  if (!change) throw new Error(`No ${field} change recorded for ${url} in onpage.json.`);
  change.status = status;
  if (status === 'published') change.published_at = at ?? new Date().toISOString();
  if (status === 'rolled-back') change.rolled_back_at = at ?? new Date().toISOString();
  save(run, data);
}
