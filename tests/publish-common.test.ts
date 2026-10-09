import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshot, planChanges, applyChanges, verifyLive, rollback, readBackup, readPlan, writePlan, PartialWriteError,
  type Adapter, type RecordRef, type FieldValues, type Backup,
} from '../scripts/lib/publish/common.ts';
import type { Proposal } from '../scripts/lib/types.ts';

const calls: string[] = [];
let run: string;
let live: Record<string, FieldValues>;
let failOn: Set<string>;

function fake(refs: Record<string, RecordRef | null>): Adapter {
  return {
    platform: 'shopify',
    async resolve(urls) { calls.push('resolve'); return new Map(urls.map((u) => [u, refs[u] ?? null])); },
    async read(r) { calls.push('read:' + r.id); return { ...live[r.id]! }; },
    async write(r, values) {
      calls.push('write:' + r.id + ':' + Object.keys(values).sort().join(','));
      if (failOn.has(r.id)) throw new Error('boom ' + r.id);
      live[r.id] = { ...live[r.id]!, ...values };
    },
  };
}
const ref = (id: string, renames = false): RecordRef => ({ url: `https://x.test/${id}`, kind: 'product', id, h1RenamesRecord: renames });
function prop(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    url: `https://x.test/${id}`, type: 'product', tier: 'top',
    current: { title: 'Old T', meta: 'Old M', h1: 'Old H' },
    proposed: { title: 'New T', meta: 'New M', h1: null },
    reason: '', sources: ['page'], issues: [], status: 'ok', approve: true, ...over,
  };
}
const NOW = () => new Date('2026-10-09T12:34:56.789Z');
/** Write calls only: since R4, apply and rollback also read each record first. */
const writeCalls = () => calls.filter((c) => c.startsWith('write'));

beforeEach(() => {
  calls.length = 0; failOn = new Set();
  run = mkdtempSync(join(tmpdir(), 'pc-pub-'));
  live = { a: { title: 'Old T', meta: 'Old M', h1: 'Old H' }, b: { title: 'Old T', meta: 'Old M', h1: null } };
});

describe('snapshot', () => {
  it('writes the backup file before any write call and never writes', async () => {
    const a = fake({ 'https://x.test/a': ref('a') });
    const b = await snapshot(a, run, [prop('a')], NOW);
    expect(b.id).toBe('2026-10-09T12-34-56.789Z');
    expect(existsSync(join(run, 'backups', b.id + '.json'))).toBe(true);
    expect(calls.some((c) => c.startsWith('write'))).toBe(false);
    expect(readBackup(run, b.id).records[0]!.values.title).toBe('Old T');
  });
  it('covers approved proposals only and records unresolved', async () => {
    const a = fake({ 'https://x.test/a': ref('a') });
    const b = await snapshot(a, run, [prop('a'), prop('b', { approve: false }), prop('zzz')], NOW);
    expect(b.records).toHaveLength(1);
    expect(b.unresolved).toEqual(['https://x.test/zzz']);
  });
});

describe('planChanges', () => {
  async function bk(props: Proposal[], refs = { 'https://x.test/a': ref('a') } as Record<string, RecordRef | null>): Promise<Backup> {
    return snapshot(fake(refs), run, props, NOW);
  }
  it('plans one change per non-null proposed field with from = live', async () => {
    const p = prop('a');
    const plan = planChanges(await bk([p]), [p], { includeRenamingH1: false });
    expect(plan.changes.map((c) => [c.field, c.from, c.to])).toEqual([['title', 'Old T', 'New T'], ['meta', 'Old M', 'New M']]);
  });
  it('skips live-changed fields only (Review Focus 4)', async () => {
    live.a!.title = 'Edited in CMS';
    const p = prop('a');
    const plan = planChanges(await bk([p]), [p], { includeRenamingH1: false });
    expect(plan.changes.map((c) => c.field)).toEqual(['meta']);
    expect(plan.skipped).toEqual([{ url: p.url, field: 'title', reason: 'live-changed' }]);
  });
  it('ignores whitespace differences and null h1 equality', async () => {
    live.b!.title = '  Old   T ';
    const p = prop('b', { current: { title: 'Old T', meta: 'Old M', h1: null }, proposed: { title: 'N', meta: null, h1: 'New H' } });
    const bb = await bk([p], { 'https://x.test/b': ref('b') });
    expect(planChanges(bb, [p], { includeRenamingH1: false }).changes).toHaveLength(2);
  });
  it('h1RenamesRecord skipped unless flag on', async () => {
    const p = prop('a', { proposed: { title: null, meta: null, h1: 'New H' } });
    const bb = await bk([p], { 'https://x.test/a': ref('a', true) });
    const off = planChanges(bb, [p], { includeRenamingH1: false });
    expect(off.changes).toHaveLength(0);
    expect(off.skipped).toEqual([{ url: p.url, field: 'h1', reason: 'renames-record' }]);
    expect(planChanges(bb, [p], { includeRenamingH1: true }).changes).toHaveLength(1);
  });
  it('unresolved is skipped', async () => {
    const p = prop('zzz');
    const plan = planChanges(await bk([p], {}), [p], { includeRenamingH1: false });
    expect(plan.skipped).toEqual([{ url: p.url, reason: 'unresolved' }]);
  });
  it('lint status other than ok is skipped', async () => {
    const p = prop('a', { status: 'needs review' });
    const plan = planChanges(await bk([p]), [p], { includeRenamingH1: false });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped.every((s) => s.reason === 'lint')).toBe(true);
  });
  it('precedence: lint beats live-changed beats renames-record', async () => {
    live.a!.h1 = 'Edited';
    const p = prop('a', { proposed: { title: null, meta: null, h1: 'New H' } });
    const bb = await bk([p], { 'https://x.test/a': ref('a', true) });
    expect(planChanges(bb, [p], { includeRenamingH1: false }).skipped[0]!.reason).toBe('live-changed');
    const l = { ...p, status: 'has [ADD]' as const };
    expect(planChanges(bb, [l], { includeRenamingH1: false }).skipped[0]!.reason).toBe('lint');
  });
  it('keys on normalised url', async () => {
    const p = prop('a', { url: 'https://x.test/a/' });
    const bb = await bk([prop('a')]);
    expect(planChanges(bb, [p], { includeRenamingH1: false }).changes).toHaveLength(2);
  });
  it('plan persists', () => {
    writePlan(run, 'p1', { backupId: 'b1', changes: [], skipped: [] });
    expect(readPlan(run, 'p1')).toEqual({ backupId: 'b1', changes: [], skipped: [] });
  });
  it('empty or whitespace-only value is skipped (empty-value)', async () => {
    const p = prop('a', { proposed: { title: '   ', meta: '', h1: null } });
    const plan = planChanges(await bk([p]), [p], { includeRenamingH1: false });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped.map((x) => [x.field, x.reason])).toEqual([['title', 'empty-value'], ['meta', 'empty-value']]);
  });
  it('plan carries backupId', async () => {
    const p = prop('a');
    const bb = await bk([p]);
    expect(planChanges(bb, [p], { includeRenamingH1: false }).backupId).toBe(bb.id);
  });
  it('two urls resolving to the same record: later skipped duplicate-target', async () => {
    const p1 = prop('a');
    const p2 = prop('a2');
    const bb = await bk([p1, p2], { 'https://x.test/a': ref('a'), 'https://x.test/a2': ref('a') });
    const plan = planChanges(bb, [p1, p2], { includeRenamingH1: false });
    expect(plan.changes).toHaveLength(2);
    expect(plan.changes.every((c) => c.ref.id === 'a')).toBe(true);
    expect(plan.skipped).toEqual([{ url: p2.url, reason: 'duplicate-target' }]);
  });
});

describe('applyChanges', () => {
  it('groups per record, continues past failures, logs errors', async () => {
    const refs = { 'https://x.test/a': ref('a'), 'https://x.test/b': ref('b') };
    const a = fake(refs);
    const ps = [prop('a'), prop('b', { current: { title: 'Old T', meta: 'Old M', h1: null } })];
    const bb = await snapshot(a, run, ps, NOW);
    const plan = planChanges(bb, ps, { includeRenamingH1: false });
    failOn.add('a');
    calls.length = 0;
    const log = await applyChanges(a, run, plan, { delayMs: 0 });
    expect(writeCalls()).toEqual(['write:a:meta,title', 'write:b:meta,title']);
    expect(log.entries.filter((e) => !e.ok).map((e) => e.error)).toEqual(['boom a', 'boom a']);
    expect(log.entries.filter((e) => e.ok)).toHaveLength(2);
    const file = JSON.parse(readFileSync(join(run, 'publish-log.json'), 'utf8'));
    expect(file.entries).toHaveLength(4);
    const again = await applyChanges(a, run, plan);
    expect(JSON.parse(readFileSync(join(run, 'publish-log.json'), 'utf8')).entries).toHaveLength(8);
    expect(again.entries).toHaveLength(4);
  });
});

describe('verifyLive', () => {
  const ch = (field: 'title' | 'meta' | 'h1', from: string, to: string) => ({ ref: ref('a'), field, from, to });
  const html = (t: string, m: string, h: string) => `<html><head><title>${t}</title><meta name="description" content="${m}"></head><body><h1>${h}</h1><h1>other</h1></body></html>`;
  it('verified / pending / failed', async () => {
    const changes = [ch('title', 'Old T', 'New T'), ch('meta', 'Old M', 'New M'), ch('h1', 'Old H', 'New H')];
    const r = await verifyLive(changes, async () => html('New T', 'Old M', 'Weird'));
    expect(r.map((x) => x.result)).toEqual(['verified', 'pending', 'failed']);
  });
  it('decodes entities', async () => {
    const r = await verifyLive([ch('title', 'a', 'Tom & Jerry’s'), ch('meta', 'a', 'café'), ch('h1', 'a', 'A <b> B')], async () =>
      html('Tom &amp; Jerry&#8217;s', 'caf&eacute;', 'A &lt;b&gt; B'));
    expect(r.map((x) => x.result)).toEqual(['verified', 'verified', 'verified']);
  });
  it('fetcher errors fail', async () => {
    const r = await verifyLive([ch('title', 'a', 'b')], async () => { throw new Error('net'); });
    expect(r[0]!.result).toBe('failed');
  });
});

describe('rollback', () => {
  it('writes backup values to every record', async () => {
    const refs = { 'https://x.test/a': ref('a'), 'https://x.test/b': ref('b') };
    const a = fake(refs);
    const bb = await snapshot(a, run, [prop('a'), prop('b')], NOW);
    calls.length = 0;
    const log = await rollback(a, bb, { run, allFields: true });
    expect(calls).toEqual(['write:a:h1,meta,title', 'write:b:meta,title']);
    expect(log.entries.every((e) => e.ok)).toBe(true);
    expect(existsSync(join(run, 'publish-log.json'))).toBe(true);
  });
});

describe('fix round 1', () => {
  const refs = () => ({ 'https://x.test/a': ref('a'), 'https://x.test/b': ref('b') });
  // Since R4 rollback reads the saved plan, so the helper saves it as publish-plan does.
  const plan1 = (bb: Backup, ps: Proposal[]) => { const p = planChanges(bb, ps, { includeRenamingH1: false }); writePlan(run, bb.id, p); return p; };
  it('applyChanges refuses when the backup file is missing', async () => {
    const a = fake(refs());
    await expect(applyChanges(a, run, { backupId: 'nope', changes: [], skipped: [] })).rejects.toThrow(/backup/i);
    expect(calls.some((c) => c.startsWith('write'))).toBe(false);
  });
  it('corrupt publish-log is moved aside, not overwritten', async () => {
    const a = fake(refs());
    const ps = [prop('a')];
    const bb = await snapshot(a, run, ps, NOW);
    writeFileSync(join(run, 'publish-log.json'), '{not json', 'utf8');
    const log = await applyChanges(a, run, plan1(bb, ps));
    const aside = readdirSync(run).filter((f) => f.startsWith('publish-log.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(run, aside[0]!), 'utf8')).toBe('{not json');
    expect(log.warnings?.[0]).toMatch(/corrupt/i);
    expect(JSON.parse(readFileSync(join(run, 'publish-log.json'), 'utf8')).entries).toHaveLength(2);
  });
  it('odd-shaped publish-log is moved aside too', async () => {
    const a = fake(refs());
    const ps = [prop('a')];
    const bb = await snapshot(a, run, ps, NOW);
    writeFileSync(join(run, 'publish-log.json'), '{"foo":1}', 'utf8');
    await applyChanges(a, run, plan1(bb, ps));
    expect(readdirSync(run).some((f) => f.startsWith('publish-log.corrupt-'))).toBe(true);
  });
  it('redacts credentials from logged errors', async () => {
    const a = fake(refs());
    a.write = async () => { throw new Error('401 at ?access_token=shpat_abc123&x=1 Bearer abc.def-ghi X-Shopify-Access-Token: shpat_zzz Basic dXNlcjpwYXNzd29yZA=='); };
    const ps = [prop('a')];
    const bb = await snapshot(a, run, ps, NOW);
    const log = await applyChanges(a, run, plan1(bb, ps));
    const err = log.entries[0]!.error!;
    expect(err).not.toMatch(/shpat|abc\.def|dXNlcjpw/);
    expect(err).toContain('[redacted]');
    expect(readFileSync(join(run, 'publish-log.json'), 'utf8')).not.toMatch(/shpat/);
  });
  it('log entries carry backupId', async () => {
    const a = fake(refs());
    const ps = [prop('a')];
    const bb = await snapshot(a, run, ps, NOW);
    const log = await applyChanges(a, run, plan1(bb, ps));
    expect(log.entries.every((e) => e.backupId === bb.id)).toBe(true);
  });
  it('rollback does not touch a live-changed (skipped) field', async () => {
    const a = fake(refs());
    const ps = [prop('a')];
    live.a!.title = 'Edited in CMS';
    const bb = await snapshot(a, run, ps, NOW);
    await applyChanges(a, run, plan1(bb, ps));
    calls.length = 0;
    await rollback(a, bb, { run });
    expect(writeCalls()).toEqual(['write:a:meta']);
    expect(live.a!.title).toBe('Edited in CMS');
  });
  it('rollback does not touch a renames-record H1 that was skipped', async () => {
    const a = fake({ 'https://x.test/a': ref('a', true) });
    const ps = [prop('a', { proposed: { title: 'New T', meta: null, h1: 'New H' } })];
    const bb = await snapshot(a, run, ps, NOW);
    await applyChanges(a, run, plan1(bb, ps));
    calls.length = 0;
    await rollback(a, bb, { run });
    expect(writeCalls()).toEqual(['write:a:title']);
  });
  it('rollback does not restore fields whose write failed', async () => {
    const a = fake(refs());
    const ps = [prop('a')];
    const bb = await snapshot(a, run, ps, NOW);
    failOn.add('a');
    await applyChanges(a, run, plan1(bb, ps));
    failOn.clear(); calls.length = 0;
    await expect(rollback(a, bb, { run })).rejects.toThrow(/No applied changes/);
    expect(calls).toEqual([]);
  });
  it('rollback reports a null original as not restorable and does not write it', async () => {
    const a = fake({ 'https://x.test/b': ref('b') });
    const ps = [prop('b', { current: { title: 'Old T', meta: 'Old M', h1: null }, proposed: { title: null, meta: null, h1: 'New H' } })];
    const bb = await snapshot(a, run, ps, NOW);
    await applyChanges(a, run, plan1(bb, ps));
    calls.length = 0;
    const log = await rollback(a, bb, { run });
    expect(writeCalls()).toEqual([]);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ field: 'h1', ok: false, error: 'original was empty; not restorable' });
  });
  it('rollback without run throws', async () => {
    const a = fake(refs());
    const bb = await snapshot(a, run, [prop('a')], NOW);
    await expect(rollback(a, bb, {} as never)).rejects.toThrow(/run/i);
    expect(calls.some((c) => c.startsWith('write'))).toBe(false);
  });
  it('rollback with missing, empty or corrupt log throws unless allFields', async () => {
    const a = fake(refs());
    const bb = await snapshot(a, run, [prop('a')], NOW);
    await expect(rollback(a, bb, { run })).rejects.toThrow(/No applied changes recorded for backup/);
    writeFileSync(join(run, 'publish-log.json'), '{nope', 'utf8');
    await expect(rollback(a, bb, { run })).rejects.toThrow(/allFields: true/);
    writeFileSync(join(run, 'publish-log.json'), '{"entries":[]}', 'utf8');
    await expect(rollback(a, bb, { run })).rejects.toThrow(/No applied changes/);
    expect(calls.some((c) => c.startsWith('write'))).toBe(false);
    await rollback(a, bb, { run, allFields: true });
    expect(calls).toEqual(expect.arrayContaining(['write:a:h1,meta,title']));
  });
  it('unsafe backup ids are rejected', async () => {
    const a = fake(refs());
    expect(() => readBackup(run, '../x')).toThrow(/backup id/i);
    expect(() => readPlan(run, '..\\x')).toThrow(/backup id/i);
    expect(() => writePlan(run, 'a/b', { backupId: 'a/b', changes: [], skipped: [] })).toThrow(/backup id/i);
    await expect(applyChanges(a, run, { backupId: '../x', changes: [], skipped: [] })).rejects.toThrow(/backup id/i);
  });
  it('errors from resolve and read are redacted', async () => {
    const a = fake(refs());
    a.resolve = async () => { throw new Error('boom Bearer sekret123'); };
    await expect(snapshot(a, run, [prop('a')], NOW)).rejects.toThrow(/\[redacted\]/);
    const b = fake(refs());
    b.read = async () => { throw new Error('x access_token=sekret123'); };
    await expect(snapshot(b, run, [prop('a')], NOW)).rejects.not.toThrow(/sekret/);
  });
  it('verifyLive meta name is case-insensitive', async () => {
    const r = await verifyLive([{ ref: ref('a'), field: 'meta', from: 'o', to: 'New M' }], async () =>
      '<html><head><meta name="Description" content="New M"></head></html>');
    expect(r[0]!.result).toBe('verified');
  });
  it('snapshot normalises undefined values to null', async () => {
    const a = fake({ 'https://x.test/a': ref('a') });
    live.a = { title: 'T' } as FieldValues;
    const bb = await snapshot(a, run, [prop('a')], NOW);
    expect(bb.records[0]!.values).toEqual({ title: 'T', meta: null, h1: null });
  });
});

describe('PartialWriteError', () => {
  it('logs applied fields ok:true with backupId (so rollback restores them) and the rest ok:false, redacted', async () => {
    const a = fake({ 'https://x.test/a': ref('a', true) });
    const p = prop('a', { proposed: { title: 'New T', meta: null, h1: 'New H' } });
    const bb = await snapshot(a, run, [p], NOW);
    const plan = planChanges(bb, [p], { includeRenamingH1: true });
    writePlan(run, bb.id, plan);
    const partial: Adapter = {
      ...a,
      // The title call saved (R4: rollback restores only what is still live), then the rename failed.
      async write(r, values) { live[r.id] = { ...live[r.id]!, title: values.title ?? live[r.id]!.title }; throw new PartialWriteError('page rename failed Bearer abc123secret', ['title']); },
    };
    const log = await applyChanges(partial, run, plan);
    const t = log.entries.find((e) => e.field === 'title')!;
    const h = log.entries.find((e) => e.field === 'h1')!;
    expect(t).toMatchObject({ ok: true, backupId: bb.id, action: 'apply' });
    expect(t.error).toBeUndefined();
    expect(h.ok).toBe(false);
    expect(h.error).toContain('[redacted]');
    expect(h.error).not.toContain('abc123secret');
    calls.length = 0;
    await rollback(a, bb, { run });
    expect(writeCalls()).toEqual(['write:a:title']);
  });
});
