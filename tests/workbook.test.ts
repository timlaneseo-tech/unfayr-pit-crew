import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWorkbook, readApprovals } from '../scripts/lib/workbook.ts';
import type { Interview, Proposal } from '../scripts/lib/types.ts';
import type { Readout } from '../scripts/lib/readout.ts';

const ro: Readout = { pages: 3, titlesOver60: 1, dupTitles: 0, dupMetas: 0, missingH1: 0, boilerplateMeta: null, separators: {} };
const interview: Interview = { brand: 'Shop', answers: [], convention: { separator: '|', brand: 'Shop', brandPosition: 'end', case: 'title', patterns: { service: '{Service} in {City}' } }, updatedAt: 'x' };
const prop = (n: number, o: Partial<Proposal> = {}): Proposal => ({
  url: `https://shop.example/p${n}`, type: 'service', tier: 'pattern',
  current: { title: `Old title number ${n} for the shop`, meta: `Old meta ${n}`, h1: `Old H1 ${n}` },
  proposed: { title: `Brand new title for page ${n} | Shop`, meta: `New meta description that is long enough to pass the seventy character minimum ${n}`, h1: null },
  reason: 'because', sources: ['page'], issues: [], status: 'ok', approve: null, ...o,
});
let tmp: string; let file: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'pitcrew-wb-')); file = join(tmp, 'a.xlsx'); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
const data = (proposals: Proposal[]) => ({ host: 'shop.example', date: '2026-10-09', readoutBefore: ro, readoutAfter: ro, interview, proposals });
const load = async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file); return wb; };
async function edit(fn: (ws: ExcelJS.Worksheet) => void) { const wb = await load(); fn(wb.getWorksheet('Pages')!); await wb.xlsx.writeFile(file); }

describe('workbook', () => {
  it('has the right tabs, header, styling, validation and credit', async () => {
    await writeWorkbook(file, data([prop(1, { proposed: { title: 'x'.repeat(70), meta: 'short', h1: null } }), prop(2)]));
    const wb = await load();
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Pages', 'Deep fixes', 'Naming style', 'Read me']);
    const ws = wb.getWorksheet('Pages')!;
    const hdr = (ws.getRow(1).values as unknown[]).slice(1);
    expect(hdr).toEqual(['URL', 'Type', 'Current title', 'Chars', 'New title', 'Chars', 'Current meta', 'Chars', 'New meta', 'Chars', 'Current H1', 'New H1', 'Reason', 'Source', 'Issues', 'Status', 'Approve']);
    const h = ws.getCell('A1');
    expect((h.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF1E1BF5');
    expect(h.font.name).toBe('Aptos');
    expect((ws.getCell('E3').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFE2E1FF');
    expect(ws.getCell('E2').font.color?.argb).toBe('FFC2410C');
    expect(ws.getCell('I2').font.color?.argb).toBe('FFC2410C');
    expect(ws.getCell('E3').font.color?.argb).not.toBe('FFC2410C');
    expect(ws.getCell('F3').value).toBe(prop(2).proposed.title!.length);
    expect(ws.getCell('Q2').dataValidation.formulae).toEqual(['"Y,N"']);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    const rm = wb.getWorksheet('Read me')!;
    const texts: string[] = []; rm.eachRow((r) => texts.push(String(r.getCell(1).value)));
    expect(texts).toContain('Built by Unfayr · unfayr.com');
  });

  it('round-trips quotes, ampersands and emoji unchanged, and formula-like text stays text', async () => {
    const t = 'Joe’s Plumbing & Heating 🔧 | Shop';
    const p = prop(1, { proposed: { title: t, meta: '=SUM(A1)', h1: '+Plus' }, approve: true });
    await writeWorkbook(file, data([p]));
    const out = await readApprovals(file, [p]);
    expect(out.proposals[0]!.proposed.title).toBe(t);
    expect(out.proposals[0]!.proposed.meta).toBe('=SUM(A1)');
    expect(out.proposals[0]!.proposed.h1).toBe('+Plus');
    expect(out.proposals[0]!.approve).toBe(true);
  });

  it('maps by URL after reverse sort and a deleted row; parses y/yes/Y/Yes/N/blank', async () => {
    const ps = [1, 2, 3, 4, 5, 6].map((n) => prop(n));
    await writeWorkbook(file, data(ps));
    await edit((ws) => {
      const vals = ['y', 'yes', ' Y', 'Yes', 'N', ''];
      vals.forEach((v, i) => { ws.getRow(i + 2).getCell(17).value = v; });
      const rows: unknown[][] = [];
      for (let i = 0; i < 6; i++) rows.push((ws.getRow(i + 2).values as unknown[]).slice(0));
      rows.reverse().forEach((vs, i) => { const r = ws.getRow(i + 2); vs.forEach((v, c) => { if (c > 0) r.getCell(c).value = (v ?? null) as ExcelJS.CellValue; }); });
      ws.spliceRows(4, 1); // reversed order is p6,p5,p4,p3...: row 4 is p4
    });
    const out = await readApprovals(file, ps);
    const by = Object.fromEntries(out.proposals.map((p) => [p.url.slice(-2), p.approve]));
    expect(by).toMatchObject({ p1: true, p2: true, p3: true, p5: false, p6: null });
    expect(by.p4).toBeNull();
    expect(out.unknownUrls).toEqual([]);
  });

  it('blank New cell is null, edited New meta replaces, unknown URL reported, URL variants match', async () => {
    const ps = [prop(1), prop(2)];
    await writeWorkbook(file, data(ps));
    await edit((ws) => {
      ws.getCell('E2').value = null;
      ws.getCell('I2').value = '  My edited meta  ';
      ws.getCell('A3').value = 'https://SHOP.example/p2/?utm=x';
      ws.getRow(4).getCell(1).value = 'https://other.example/zzz';
    });
    const out = await readApprovals(file, ps);
    expect(out.proposals[0]!.proposed.title).toBeNull();
    expect(out.proposals[0]!.proposed.meta).toBe('My edited meta');
    expect(out.proposals[1]!.proposed.title).toBe(ps[1]!.proposed.title);
    expect(out.unknownUrls).toEqual(['https://other.example/zzz']);
  });

  it('unresolved [ADD:] row is returned approve:false', async () => {
    const p = prop(1, { status: 'has [ADD]', proposed: { title: 'Call us on [ADD: phone] now | Shop', meta: null, h1: null }, approve: true });
    await writeWorkbook(file, data([p]));
    await edit((ws) => { ws.getCell('Q2').value = 'Y'; });
    const out = await readApprovals(file, [p]);
    expect(out.proposals[0]!.approve).toBe(false);
  });

  it('a deleted row comes back approve:null even if it was approved before', async () => {
    const ps = [prop(1, { approve: true }), prop(2, { approve: true })];
    await writeWorkbook(file, data(ps));
    await edit((ws) => { ws.spliceRows(3, 1); });
    const out = await readApprovals(file, ps);
    expect(out.proposals[0]!.approve).toBe(true);
    expect(out.proposals[1]!.approve).toBeNull();
  });

  it('a url on two rows is approve:null and reported', async () => {
    const ps = [prop(1), prop(2)];
    await writeWorkbook(file, data(ps));
    await edit((ws) => { ws.getCell('A3').value = 'https://shop.example/p1/'; ws.getCell('Q2').value = 'Y'; ws.getCell('Q3').value = 'Y'; });
    const out = await readApprovals(file, ps);
    expect(out.duplicateUrls).toEqual(['https://shop.example/p1']);
    expect(out.proposals[0]!.approve).toBeNull();
  });

  it('puts the logo on the Summary sheet when the asset exists', async () => {
    await writeWorkbook(file, data([prop(1)]));
    const wb = await load();
    expect(wb.getWorksheet('Summary')!.getImages()).toHaveLength(1);
  });

  it('Deep fixes tab has a For AI answers column with one fact per line, and the Read me explains it', async () => {
    const deep = { query: 'q', intro: 'i', h2s: ['a'], faq: [], schema: '', altFixes: [], citationFacts: ['From $89', '[ADD: last-updated date shown on the page]'] };
    await writeWorkbook(file, data([prop(1, { tier: 'top', deep })]));
    const wb = await load();
    const dp = wb.getWorksheet('Deep fixes')!;
    const hdr = (dp.getRow(1).values as unknown[]).slice(1);
    expect(hdr).toContain('For AI answers');
    expect(dp.getRow(2).getCell(hdr.indexOf('For AI answers') + 1).value).toBe('From $89\n[ADD: last-updated date shown on the page]');
    const texts: string[] = []; wb.getWorksheet('Read me')!.eachRow((r) => texts.push(String(r.getCell(1).value)));
    expect(texts.some((t) => t.includes('AI answers cite pages that state relevant facts plainly'))).toBe(true);
  });
});

describe('Issues column (I4)', () => {
  it('lists each row\'s lint messages before Status, warnings marked, and a warning-only row reads ok', async () => {
    const warnOnly = prop(1, { status: 'ok', issues: [{ rule: 'title-pixels', field: 'title', severity: 'warn', message: 'The title is about 640 px wide.' }] });
    const blocked = prop(2, { status: 'needs review', issues: [
      { rule: 'unsourced-number', field: 'meta', severity: 'block', message: 'The number 25 is not on the page or in the interview answers.' },
      { rule: 'stale-year', field: 'title', severity: 'warn', message: 'The title mentions 2024.' },
    ] });
    await writeWorkbook(file, data([warnOnly, blocked, prop(3)]));
    const ws = (await load()).getWorksheet('Pages')!;
    const hdr = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    const col = (n: string) => hdr.indexOf(n) + 1;
    expect(col('Issues')).toBe(col('Status') - 1);
    expect(ws.getRow(2).getCell(col('Issues')).value).toBe('Warning: The title is about 640 px wide.');
    expect(ws.getRow(2).getCell(col('Status')).value).toBe('ok');
    expect(ws.getRow(3).getCell(col('Issues')).value).toBe('The number 25 is not on the page or in the interview answers.; Warning: The title mentions 2024.');
    expect(ws.getRow(3).getCell(col('Status')).value).toBe('needs review');
    expect(ws.getRow(4).getCell(col('Issues')).value ?? '').toBe('');
  });
});
