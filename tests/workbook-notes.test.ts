import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWorkbook } from '../scripts/lib/workbook.ts';
import type { Interview, Proposal } from '../scripts/lib/types.ts';
import type { Readout } from '../scripts/lib/readout.ts';

const ro: Readout = { pages: 3, titlesOver60: 1, dupTitles: 0, dupMetas: 0, missingH1: 0, boilerplateMeta: null, separators: {} };
const interview: Interview = { brand: 'Shop', answers: [], convention: { separator: '|', brand: 'Shop', brandPosition: 'end', case: 'title', patterns: {} }, updatedAt: 'x' };
const prop: Proposal = {
  url: 'https://shop.example/p1', type: 'service', tier: 'pattern',
  current: { title: 'Old title for the shop', meta: 'Old meta', h1: 'Old H1' },
  proposed: { title: 'Brand new title for page | Shop', meta: null, h1: null },
  reason: 'because', sources: ['page'], issues: [], status: 'ok', approve: null,
};
const base = { host: 'shop.example', date: '2026-10-09', readoutBefore: ro, readoutAfter: ro, interview, proposals: [prop] };

async function sheetText(extra: object, sheet: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'pitcrew-wbn-'));
  try {
    const file = join(tmp, 'a.xlsx');
    await writeWorkbook(file, { ...base, ...extra });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const out: string[] = [];
    wb.getWorksheet(sheet)!.eachRow((r) => out.push([r.getCell(1).value, r.getCell(2).value].filter((v) => v !== null && v !== undefined).join('|')));
    return out.join('\n');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

describe('workbook: best-practice notes', () => {
  it('Read me explains pixel width, title and H1, and the FAQ retirement', async () => {
    const t = await sheetText({}, 'Read me');
    expect(t).toMatch(/600 px/);
    expect(t).toMatch(/title and H1/);
    expect(t).toMatch(/Google retired/);
  });
  it('Summary shows how many pages have an og:title that differs from the title', async () => {
    expect(await sheetText({ ogTitleDiffers: 4 }, 'Summary')).toContain('Pages where og:title differs from the title|4');
  });
  it('Summary omits the og line when the count is not given', async () => {
    expect(await sheetText({}, 'Summary')).not.toContain('og:title');
  });
});
