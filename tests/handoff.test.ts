import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { markHandoff, writeHandoff } from '../scripts/lib/handoff.ts';
import type { Proposal } from '../scripts/lib/types.ts';

function prop(url: string, over: Partial<Proposal> = {}): Proposal {
  return {
    url, type: 'service', tier: 'top',
    current: { title: 'Old title', meta: 'Old meta', h1: 'Old h1' },
    proposed: { title: 'New title', meta: null, h1: 'Old h1' },
    reason: 'r', sources: ['page'], issues: [], status: 'ok', approve: true, ...over,
  };
}
let run: string;
const read = () => JSON.parse(readFileSync(join(run, 'onpage.json'), 'utf8'));
beforeEach(() => { run = mkdtempSync(join(tmpdir(), 'pc-handoff-')); });

describe('handoff', () => {
  it('writes the spec shape with only changed fields', () => {
    writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/x')]);
    const j = read();
    expect(j.tool).toBe('pitcrew');
    expect(j.version).toBe('1.0.0');
    expect(j.site).toBe('example.com');
    expect(j.run_date).toBe('2026-10-09');
    expect(j.changes).toEqual([
      { url: 'https://example.com/x', field: 'title', before: 'Old title', after: 'New title', status: 'approved', published_at: null },
    ]);
  });
  it('status follows approve', () => {
    writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/a', { approve: null }), prop('https://example.com/b', { approve: false })]);
    expect(read().changes.map((c: { status: string }) => c.status)).toEqual(['proposed', 'proposed']);
  });
  it('markHandoff sets published_at; verified keeps it', () => {
    writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/x')]);
    markHandoff(run, 'https://example.com/x', 'title', 'published', '2026-10-10T00:00:00.000Z');
    expect(read().changes[0]).toMatchObject({ status: 'published', published_at: '2026-10-10T00:00:00.000Z' });
    markHandoff(run, 'https://example.com/x', 'title', 'verified');
    expect(read().changes[0]).toMatchObject({ status: 'verified', published_at: '2026-10-10T00:00:00.000Z' });
  });
  it('markHandoff defaults published_at to now', () => {
    writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/x')]);
    markHandoff(run, 'https://example.com/x', 'title', 'published');
    expect(read().changes[0].published_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it('markHandoff throws on unknown url/field', () => {
    writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/x')]);
    expect(() => markHandoff(run, 'https://example.com/x', 'meta', 'published')).toThrow(/meta/);
    expect(() => markHandoff(run, 'https://example.com/nope', 'title', 'published')).toThrow(/nope/);
  });
  it('markHandoff rolled-back stamps rolled_back_at and keeps published_at (M6)', () => {
    writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/x')]);
    markHandoff(run, 'https://example.com/x', 'title', 'published', '2026-10-10T00:00:00.000Z');
    markHandoff(run, 'https://example.com/x', 'title', 'rolled-back', '2026-10-11T00:00:00.000Z');
    expect(read().changes[0]).toMatchObject({ status: 'rolled-back', published_at: '2026-10-10T00:00:00.000Z', rolled_back_at: '2026-10-11T00:00:00.000Z' });
    writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/x')]);
    expect(read().changes[0]).toMatchObject({ status: 'rolled-back', rolled_back_at: '2026-10-11T00:00:00.000Z' });
  });
  it('rewriting preserves published history', () => {
    writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/x')]);
    markHandoff(run, 'https://example.com/x', 'title', 'published', '2026-10-10T00:00:00.000Z');
    writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/x')]);
    expect(read().changes[0]).toMatchObject({ status: 'published', published_at: '2026-10-10T00:00:00.000Z' });
  });
});

describe('handoff corrupt file', () => {
  it('markHandoff and writeHandoff throw and leave the file alone', () => {
    writeFileSync(join(run, 'onpage.json'), '{oops');
    expect(() => markHandoff(run, 'https://example.com/x', 'title', 'published')).toThrow(/onpage\.json is not valid JSON/);
    expect(() => writeHandoff(run, 'example.com', '2026-10-09', [prop('https://example.com/x')])).toThrow(/onpage\.json is not valid JSON/);
    expect(readFileSync(join(run, 'onpage.json'), 'utf8')).toBe('{oops');
  });
});

describe('replaceFile (Windows file locks)', () => {
  it('retries a locked rename, then copies over the target when the lock never clears', async () => {
    const { existsSync } = await import('node:fs');
    const { replaceFile } = await import('../scripts/lib/handoff.ts');
    const d = mkdtempSync(join(tmpdir(), 'pc-rf-'));
    const tmp = join(d, 'a.tmp'), dest = join(d, 'a.json');
    writeFileSync(tmp, 'new'); writeFileSync(dest, 'old');
    let calls = 0;
    replaceFile(tmp, dest, () => { calls++; const e = new Error('locked') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; });
    expect(calls).toBe(5);
    expect(readFileSync(dest, 'utf8')).toBe('new');
    expect(existsSync(tmp)).toBe(false);
    let n = 0;
    writeFileSync(tmp, 'newer');
    replaceFile(tmp, dest, (a, b) => { if (++n < 3) { const e = new Error('busy') as NodeJS.ErrnoException; e.code = 'EBUSY'; throw e; } writeFileSync(b, readFileSync(a, 'utf8')); });
    expect(n).toBe(3);
    expect(readFileSync(dest, 'utf8')).toBe('newer');
    expect(() => replaceFile(join(d, 'missing'), dest, () => { const e = new Error('no') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; })).toThrow('no');
  });
});
