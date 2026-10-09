import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshot, planChanges, applyChanges, verifyLive, rollback, writePlan, renderedFields, publishable, publishDelayMs,
  type Adapter, type RecordRef, type FieldValues,
} from '../scripts/lib/publish/common.ts';
import type { Field, Proposal } from '../scripts/lib/types.ts';

let run: string;
let live: Record<string, FieldValues>;
let calls: string[];
let pageHtml: Record<string, string | Error>;

const ref = (id: string): RecordRef => ({ url: `https://x.test/${id}`, kind: 'product', id, h1RenamesRecord: false });
function fake(opts: { supports?: Field[]; rawIsRendered?: boolean; clear?: boolean } = {}): Adapter {
  const a: Adapter = {
    platform: 'shopify',
    supports: opts.supports,
    rawIsRendered: opts.rawIsRendered,
    async resolve(urls) { return new Map(urls.map((u) => [u, ref(u.split('/').pop()!)])); },
    async read(r) { calls.push('read:' + r.id); return { ...live[r.id]! }; },
    async write(r, values) {
      calls.push('write:' + r.id + ':' + Object.keys(values).sort().join(','));
      live[r.id] = { ...live[r.id]!, ...values };
    },
  };
  if (opts.clear) {
    a.clear = async (r, fields) => {
      calls.push('clear:' + r.id + ':' + [...fields].sort().join(','));
      for (const f of fields) live[r.id] = { ...live[r.id]!, [f]: null };
    };
  }
  return a;
}
const html = (t: string, m: string, h: string) => `<html><head><title>${t}</title><meta name="description" content="${m}"></head><body><h1>${h}</h1></body></html>`;
const render = async (url: string) => {
  const v = pageHtml[url];
  if (v === undefined || v instanceof Error) throw v ?? new Error('404');
  return v;
};
function prop(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    url: `https://x.test/${id}`, type: 'product', tier: 'top',
    current: { title: 'Brake pads – Trailhead', meta: 'Old M', h1: 'Brake pads' },
    proposed: { title: 'New T', meta: 'New M', h1: null },
    reason: '', sources: ['page'], issues: [], status: 'ok', approve: true, ...over,
  };
}
const NOW = () => new Date('2026-10-09T12:00:00.000Z');
const writes = () => calls.filter((c) => c.startsWith('write') || c.startsWith('clear'));

beforeEach(() => {
  run = mkdtempSync(join(tmpdir(), 'pc-safe-'));
  calls = [];
  // Shopify-style: no SEO override on the record, the theme renders "<title> – <shop>".
  live = { a: { title: null, meta: 'Old M', h1: 'Brake pads' } };
  pageHtml = { 'https://x.test/a': html('Brake pads – Trailhead', 'Old M', 'Brake pads') };
});

async function planned(p: Proposal, a = fake()) {
  const bb = await snapshot(a, run, [p], NOW, { render });
  const plan = planChanges(bb, [p], { includeRenamingH1: false });
  writePlan(run, bb.id, plan);
  return { bb, plan, a };
}

describe('publish delay (M2)', () => {
  it('is 250 ms for API platforms and 0 for git', () => {
    for (const p of ['shopify', 'wordpress', 'webflow']) expect(publishDelayMs(p)).toBe(250);
    expect(publishDelayMs('git')).toBe(0);
  });
  it('applyChanges waits between records, not before the first', async () => {
    live.b = { title: null, meta: 'Old M', h1: 'Brake pads' };
    pageHtml['https://x.test/b'] = pageHtml['https://x.test/a']!;
    const a = fake();
    const bb = await snapshot(a, run, [prop('a'), prop('b', { url: 'https://x.test/b' })], NOW, { render });
    const plan = planChanges(bb, [prop('a'), prop('b', { url: 'https://x.test/b' })], { includeRenamingH1: false });
    const t0 = Date.now();
    await applyChanges(a, run, plan, { delayMs: 120 });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(110);
    expect(took).toBeLessThan(240);
  });
});

describe('publishable (R6)', () => {
  it('is approve === true and status ok only', () => {
    expect(publishable(prop('a'))).toBe(true);
    expect(publishable(prop('a', { status: 'needs review' }))).toBe(false);
    expect(publishable(prop('a', { status: 'has [ADD]' }))).toBe(false);
    expect(publishable(prop('a', { approve: null }))).toBe(false);
  });
});

describe('rendered live check (R1)', () => {
  it('renderedFields reads title, meta and the first h1 from HTML', () => {
    expect(renderedFields(html('A &amp; B', 'M', 'H'))).toEqual({ title: 'A & B', meta: 'M', h1: 'H' });
    expect(renderedFields('<html></html>')).toEqual({ title: null, meta: null, h1: null });
  });
  it('a null raw SEO override is not live-changed when the rendered page still shows the crawled value', async () => {
    const { plan, bb } = await planned(prop('a'));
    expect(bb.records[0]!.values.title).toBeNull();
    expect(bb.records[0]!.rendered).toEqual({ title: 'Brake pads – Trailhead', meta: 'Old M', h1: 'Brake pads' });
    expect(plan.skipped).toEqual([]);
    expect(plan.changes.map((c) => [c.field, c.from, c.was, c.to])).toEqual([
      ['title', null, 'Brake pads – Trailhead', 'New T'], ['meta', 'Old M', 'Old M', 'New M'],
    ]);
  });
  it('a rendered value that differs from the workbook current is live-changed', async () => {
    pageHtml['https://x.test/a'] = html('Edited in admin', 'Old M', 'Brake pads');
    const { plan } = await planned(prop('a'));
    expect(plan.changes.map((c) => c.field)).toEqual(['meta']);
    expect(plan.skipped).toEqual([{ url: 'https://x.test/a', field: 'title', reason: 'live-changed' }]);
  });
  it('an unreadable page skips the row as live-unreadable', async () => {
    pageHtml['https://x.test/a'] = new Error('HTTP 500');
    const { plan, bb } = await planned(prop('a'));
    expect(bb.records[0]!.rendered).toBeNull();
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual([{ url: 'https://x.test/a', reason: 'live-unreadable' }]);
  });
  it('an adapter whose raw value is the rendered value (git) is not fetched', async () => {
    live.a = { title: 'Brake pads – Trailhead', meta: 'Old M', h1: 'Brake pads' };
    let fetched = 0;
    const bb = await snapshot(fake({ rawIsRendered: true }), run, [prop('a')], NOW, { render: async () => { fetched++; return ''; } });
    expect(fetched).toBe(0);
    expect(bb.records[0]!.rendered).toEqual(bb.records[0]!.values);
  });
});

describe('unsupported fields (M4)', () => {
  it('skips a field the adapter does not support', async () => {
    const p = prop('a', { proposed: { title: 'New T', meta: null, h1: 'New H' } });
    const { plan } = await planned(p, fake({ supports: ['title', 'meta'] }));
    expect(plan.changes.map((c) => c.field)).toEqual(['title']);
    expect(plan.skipped).toEqual([{ url: p.url, field: 'h1', reason: 'unsupported' }]);
  });
});

describe('verifyLive with theme suffixes (R2)', () => {
  const ch = (field: Field, from: string | null, to: string, was?: string | null) => ({ ref: ref('a'), field, from, to, ...(was !== undefined ? { was } : {}) });
  const one = async (c: ReturnType<typeof ch>, page: string) => (await verifyLive([c], async () => page))[0]!.result;
  it('verified when the live title is the new value plus a separator and the shop name', async () => {
    for (const sep of ['|', '-', '–', '—', ':', '·']) {
      expect(await one(ch('title', null, 'New T'), html(`New T ${sep} Trailhead`, '', '')), sep).toBe('verified');
    }
    expect(await one(ch('title', null, 'New T'), html('New T|Trailhead', '', ''))).toBe('verified');
  });
  it('pending when the live title is still the old rendered value, with or without a suffix', async () => {
    expect(await one(ch('title', null, 'New T', 'Brake pads – Trailhead'), html('Brake pads – Trailhead', '', ''))).toBe('pending');
    expect(await one(ch('title', 'Old T', 'New T'), html('Old T | Trailhead', '', ''))).toBe('pending');
  });
  it('failed when the live value only shares a prefix without a separator', async () => {
    expect(await one(ch('title', 'Old T', 'New T'), html('New Toaster', '', ''))).toBe('failed');
  });
});

describe('compare-and-set on apply (R4)', () => {
  it('re-reads raw values and skips a field changed since the backup, writing the rest', async () => {
    live.a = { title: 'Old raw', meta: 'Old M', h1: 'Brake pads' };
    const { plan } = await planned(prop('a'));
    live.a!.title = 'Edited after the dry run';
    calls = [];
    const log = await applyChanges(fake(), run, plan);
    expect(writes()).toEqual(['write:a:meta']);
    expect(live.a!.title).toBe('Edited after the dry run');
    const t = log.entries.find((e) => e.field === 'title')!;
    expect(t).toMatchObject({ ok: false, reason: 'live-changed' });
    expect(log.entries.find((e) => e.field === 'meta')!.ok).toBe(true);
    const file = JSON.parse(readFileSync(join(run, 'publish-log.json'), 'utf8'));
    expect(file.entries.find((e: any) => e.field === 'title')).toMatchObject({ ok: false, reason: 'live-changed' });
  });
  it('a field that already has the new value is not written again and stays ok', async () => {
    const { plan } = await planned(prop('a'));
    await applyChanges(fake(), run, plan);
    calls = [];
    const again = await applyChanges(fake(), run, plan);
    expect(writes()).toEqual([]);
    expect(again.entries.every((e) => e.ok && e.unchanged === true)).toBe(true);
  });
});

describe('rollback safety (R3, R4)', () => {
  it('leaves a field edited after the publish alone and reports live-changed', async () => {
    live.a = { title: 'Old raw', meta: 'Old M', h1: 'Brake pads' };
    const { plan, bb, a } = await planned(prop('a'));
    await applyChanges(a, run, plan);
    live.a!.title = 'Someone edited it later';
    calls = [];
    const log = await rollback(a, bb, { run });
    expect(writes()).toEqual(['write:a:meta']);
    expect(live.a).toMatchObject({ title: 'Someone edited it later', meta: 'Old M' });
    expect(log.entries.find((e) => e.field === 'title')).toMatchObject({ ok: false, reason: 'live-changed' });
  });
  it('clears an override whose original was empty when the adapter can clear', async () => {
    const a = fake({ clear: true });
    const { plan, bb } = await planned(prop('a'), a);
    await applyChanges(a, run, plan);
    calls = [];
    const log = await rollback(a, bb, { run });
    expect(writes()).toEqual(['write:a:meta', 'clear:a:title']);
    expect(live.a).toMatchObject({ title: null, meta: 'Old M' });
    expect(log.entries.every((e) => e.ok)).toBe(true);
  });
  it('without clear, an empty original is still reported as not restorable', async () => {
    const { plan, bb, a } = await planned(prop('a'));
    await applyChanges(a, run, plan);
    const log = await rollback(a, bb, { run });
    expect(log.entries.find((e) => e.field === 'title')).toMatchObject({ ok: false, error: 'original was empty; not restorable' });
  });
  it('a null-before field whose raw value is the applied value with entities encoded (WordPress sanitising) is cleared', async () => {
    const a = fake({ clear: true });
    const p = prop('a', { proposed: { title: 'Nuts & bolts', meta: 'New M', h1: null } });
    const { plan, bb } = await planned(p, a);
    await applyChanges(a, run, plan);
    live.a!.title = 'Nuts &amp;  bolts ';
    calls = [];
    await rollback(a, bb, { run, render });
    expect(writes()).toContain('clear:a:title');
  });
  it('a null-before field whose raw value reads back null is compared on the rendered page', async () => {
    const a = fake({ clear: true });
    const { plan, bb } = await planned(prop('a'), a);
    await applyChanges(a, run, plan);
    live.a!.title = null;
    pageHtml['https://x.test/a'] = html('New T – Trailhead', 'New M', 'Brake pads');
    calls = [];
    await rollback(a, bb, { run, render });
    expect(writes()).toContain('clear:a:title');
  });
  it('an owner edit that starts with the applied value is not cleared, even though the page shows it', async () => {
    const a = fake({ clear: true });
    const { plan, bb } = await planned(prop('a'), a);
    await applyChanges(a, run, plan);
    live.a!.title = 'New T: owner rewrote this later';
    pageHtml['https://x.test/a'] = html('New T: owner rewrote this later', 'New M', 'Brake pads');
    calls = [];
    const log = await rollback(a, bb, { run, render });
    expect(writes()).not.toContain('clear:a:title');
    expect(live.a!.title).toBe('New T: owner rewrote this later');
    expect(log.entries.find((e) => e.field === 'title')).toMatchObject({ ok: false, reason: 'live-changed' });
  });
  it('a raw edit is not cleared while a stale CDN page still shows the applied value', async () => {
    const a = fake({ clear: true });
    const { plan, bb } = await planned(prop('a'), a);
    await applyChanges(a, run, plan);
    live.a!.title = 'Owner override';
    pageHtml['https://x.test/a'] = html('New T – Trailhead', 'New M', 'Brake pads');
    calls = [];
    const log = await rollback(a, bb, { run, render });
    expect(writes()).not.toContain('clear:a:title');
    expect(log.entries.find((e) => e.field === 'title')).toMatchObject({ ok: false, reason: 'live-changed' });
  });
  it('a null-before field whose raw and rendered values both moved is left alone', async () => {
    const a = fake({ clear: true });
    const { plan, bb } = await planned(prop('a'), a);
    await applyChanges(a, run, plan);
    live.a!.title = 'Owner override';
    pageHtml['https://x.test/a'] = html('Owner override – Trailhead', 'New M', 'Brake pads');
    calls = [];
    const log = await rollback(a, bb, { run, render });
    expect(writes()).not.toContain('clear:a:title');
    expect(log.entries.find((e) => e.field === 'title')).toMatchObject({ ok: false, reason: 'live-changed' });
  });
  it('needs the saved plan when publish-log entries exist', async () => {
    const a = fake();
    const bb = await snapshot(a, run, [prop('a')], NOW, { render });
    await applyChanges(a, run, planChanges(bb, [prop('a')], { includeRenamingH1: false }));
    await expect(rollback(a, bb, { run })).rejects.toThrow(/plan/i);
  });
});

describe('publish log is written per record', () => {
  it('a crash on the third record leaves the first two records logged for rollback', async () => {
    for (const id of ['b', 'c']) {
      live[id] = { title: null, meta: 'Old M', h1: 'Brake pads' };
      pageHtml[`https://x.test/${id}`] = pageHtml['https://x.test/a']!;
    }
    // An error whose message cannot even be read escapes writeOne's catch, like a process crash mid-apply.
    class Fatal extends Error { override get message(): string { throw new Error('unreadable'); } }
    const a = fake();
    const write = a.write.bind(a);
    a.write = async (r, values) => { if (r.id === 'c') throw new Fatal(); return write(r, values); };
    const ps = ['a', 'b', 'c'].map((id) => prop(id, { url: `https://x.test/${id}` }));
    const bb = await snapshot(a, run, ps, NOW, { render });
    const plan = planChanges(bb, ps, { includeRenamingH1: false });
    await expect(applyChanges(a, run, plan)).rejects.toThrow();
    const file = JSON.parse(readFileSync(join(run, 'publish-log.json'), 'utf8'));
    expect(file.entries.map((e: any) => [e.url.split('/').pop(), e.field, e.ok])).toEqual([
      ['a', 'title', true], ['a', 'meta', true], ['b', 'title', true], ['b', 'meta', true],
    ]);
    expect(file.entries.every((e: any) => e.action === 'apply' && e.backupId === bb.id)).toBe(true);
  });
});

describe('no-access records (a missing permission for one kind)', () => {
  it('snapshot and planChanges skip them as no-access with the message, and plan the rest', async () => {
    const { NoAccessError, noAccessWarnings } = await import('../scripts/lib/publish/common.ts');
    live.b = { title: null, meta: 'Old M', h1: 'Brake pads' };
    live.c = { title: null, meta: 'Old M', h1: 'Brake pads' };
    for (const id of ['b', 'c']) pageHtml[`https://x.test/${id}`] = pageHtml['https://x.test/a']!;
    const a = fake();
    const resolve = a.resolve.bind(a);
    a.noAccess = new Map();
    a.resolve = async (urls) => {
      const m = await resolve(urls);
      m.set('https://x.test/b', null);
      a.noAccess!.set('https://x.test/b', "The app can't read Shopify pages.");
      return m;
    };
    const read = a.read.bind(a);
    a.read = async (r) => { if (r.id === 'c') throw new NoAccessError("The app can't read Shopify blog posts."); return read(r); };
    const ps = ['a', 'b', 'c'].map((id) => prop(id, { url: `https://x.test/${id}` }));
    const bb = await snapshot(a, run, ps, NOW, { render });
    expect(bb.records.map((r) => r.ref.id)).toEqual(['a']);
    expect(bb.unresolved).toEqual([]);
    expect(bb.noAccess).toEqual([
      { url: 'https://x.test/b', message: "The app can't read Shopify pages." },
      { url: 'https://x.test/c', message: "The app can't read Shopify blog posts." },
    ]);
    const plan = planChanges(bb, ps, { includeRenamingH1: false });
    expect(plan.changes.map((c) => c.ref.id)).toEqual(['a', 'a']);
    expect(plan.skipped).toEqual([
      { url: 'https://x.test/b', reason: 'no-access', message: "The app can't read Shopify pages." },
      { url: 'https://x.test/c', reason: 'no-access', message: "The app can't read Shopify blog posts." },
    ]);
    expect(noAccessWarnings(bb)).toEqual([
      "1 page skipped: The app can't read Shopify pages.",
      "1 page skipped: The app can't read Shopify blog posts.",
    ]);
  });
  it('any other read error still fails the snapshot', async () => {
    const a = fake();
    a.read = async () => { throw new Error('Shopify request failed with HTTP 401'); };
    await expect(snapshot(a, run, [prop('a')], NOW, { render })).rejects.toThrow(/401/);
  });
});

describe('noAccessBlocker', () => {
  it('stops the plan loudly when every approved page was refused, and not otherwise', async () => {
    const { noAccessBlocker } = await import('../scripts/lib/publish/common.ts');
    const base = { id: 'x', host: 'x.test', createdAt: '', unresolved: [] as string[] };
    const rec = { ref: ref('a'), values: { title: null, meta: null, h1: null } };
    const denied = [{ url: 'https://x.test/b', message: "The app can't read Shopify pages." }];
    expect(noAccessBlocker({ ...base, records: [], noAccess: denied })).toMatch(/^None of the approved pages could be read.*can't read Shopify pages/);
    expect(noAccessBlocker({ ...base, records: [rec], noAccess: denied })).toBeNull();
    expect(noAccessBlocker({ ...base, records: [] })).toBeNull();
  });
});
