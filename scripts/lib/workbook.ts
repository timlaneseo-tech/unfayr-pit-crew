import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Interview, Proposal } from './types.ts';
import type { Readout } from './readout.ts';
import { charLen } from './text.ts';
import { normaliseUrl } from './urls.ts';

const ULTRA = 'FF1E1BF5';
const HAZE = 'FFE2E1FF';
const FAIL = 'FFC2410C';
const FONT = 'Aptos';

const HEADERS = ['URL', 'Type', 'Current title', 'Chars', 'New title', 'Chars', 'Current meta', 'Chars', 'New meta', 'Chars', 'Current H1', 'New H1', 'Reason', 'Source', 'Issues', 'Status', 'Approve'];
const WIDTHS = [44, 12, 36, 7, 36, 7, 44, 7, 44, 7, 28, 28, 40, 16, 48, 14, 10];
const COL_ISSUES = 15, COL_STATUS = 16, COL_APPROVE = 17;

const font = (o: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size: 11, ...o });

/** Set a cell to plain text. A JS string is stored as a string, never a formula, whatever it starts with. */
function setText(cell: ExcelJS.Cell, v: string): void {
  cell.value = v;
  cell.numFmt = '@';
}

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((c) => {
    c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } });
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ULTRA } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; text?: unknown; result?: unknown };
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
  }
  return cell.text ?? '';
}

function logoPath(): string | null {
  const p = join(fileURLToPath(new URL('../../assets/', import.meta.url)), 'pit-crew-lockup-on-light-600.png');
  return existsSync(p) ? p : null;
}

function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  return w > 0 && h > 0 ? { w, h } : { w: 300, h: 90 };
}

export interface WorkbookData {
  host: string; date: string; readoutBefore: Readout; readoutAfter: Readout; interview: Interview; proposals: Proposal[];
  /** Pages whose og:title differs from their title (informational). Omit to leave the line out. */
  ogTitleDiffers?: number;
}

export async function writeWorkbook(file: string, d: WorkbookData): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pit Crew by Unfayr';

  // Summary
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 40 }, { width: 18 }, { width: 18 }];
  let r = 1;
  const logo = logoPath();
  if (logo) {
    const id = wb.addImage({ filename: logo, extension: 'png' });
    const { w, h } = pngSize(logo);
    sum.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 300, height: Math.round((300 * h) / w) } });
    r = 6;
  }
  const put = (a: string, b?: string | number, c?: string | number, bold = false): ExcelJS.Row => {
    const row = sum.getRow(r++);
    [a, b, c].forEach((v, i) => {
      if (v === undefined) return;
      const cell = row.getCell(i + 1);
      if (typeof v === 'number') cell.value = v; else setText(cell, v);
      cell.font = font({ bold });
    });
    return row;
  };
  put(`Titles, metas and H1s for ${d.host}.`, undefined, undefined, true).getCell(1).font = font({ bold: true, size: 16 });
  put(`Run date ${d.date}`);
  r++;
  styleHeader(put('Site readout', 'Before', 'After', true));
  const ro = (label: string, k: 'pages' | 'titlesOver60' | 'dupTitles' | 'dupMetas' | 'missingH1') => put(label, d.readoutBefore[k], d.readoutAfter[k]);
  ro('Pages', 'pages'); ro('Titles over 60 characters', 'titlesOver60'); ro('Pages sharing a title', 'dupTitles');
  ro('Pages sharing a meta description', 'dupMetas'); ro('Pages with no H1', 'missingH1');
  if (d.ogTitleDiffers !== undefined) put('Pages where og:title differs from the title', d.ogTitleDiffers);
  r++;
  const c = d.interview.convention;
  put('Naming style', undefined, undefined, true);
  put('Brand', d.interview.brand);
  put('Separator', c.separator);
  put('Brand position', c.brandPosition);
  put('Case', c.case);
  r++;
  styleHeader(put('Status', 'Pages', undefined, true));
  for (const s of ['ok', 'needs review', 'has [ADD]'] as const) put(s, d.proposals.filter((p) => p.status === s).length);
  r++;
  put('Next steps', undefined, undefined, true);
  put('Mark Approve Y, save, then tell Claude: publish my approved changes.');

  // Pages
  const ws = wb.addWorksheet('Pages', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = WIDTHS.map((width) => ({ width }));
  const hr = ws.getRow(1);
  HEADERS.forEach((t, i) => { hr.getCell(i + 1).value = t; });
  styleHeader(hr);
  d.proposals.forEach((p, i) => {
    const row = ws.getRow(i + 2);
    const str = (col: number, v: string | null) => { if (v !== null) setText(row.getCell(col), v); };
    const num = (col: number, v: string | null) => { if (v !== null) row.getCell(col).value = charLen(v); };
    str(1, p.url); str(2, p.type);
    str(3, p.current.title); num(4, p.current.title);
    str(5, p.proposed.title); num(6, p.proposed.title);
    str(7, p.current.meta); num(8, p.current.meta);
    str(9, p.proposed.meta); num(10, p.proposed.meta);
    str(11, p.current.h1); str(12, p.proposed.h1);
    str(13, p.reason); str(14, p.sources.join(', '));
    // I4: why a row is not ok, in plain words. Warnings (R5) are marked and do not block publishing.
    const issues = p.issues.map((i) => (i.severity === 'warn' ? `Warning: ${i.message}` : i.message)).join('; ');
    if (issues) str(COL_ISSUES, issues);
    str(COL_STATUS, p.status);
    if (p.approve === true) str(COL_APPROVE, 'Y'); else if (p.approve === false) str(COL_APPROVE, 'N');
    for (let k = 1; k <= HEADERS.length; k++) {
      const cell = row.getCell(k);
      cell.font = font();
      cell.alignment = { vertical: 'top', wrapText: true };
    }
    const mark = (col: number, cur: string | null, next: string | null, lim?: readonly [number, number]) => {
      if (next === null) return;
      const cell = row.getCell(col);
      if (next !== cur) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HAZE } };
      const n = charLen(next);
      if (lim && (n < lim[0] || n > lim[1])) cell.font = font({ color: { argb: FAIL } });
    };
    mark(5, p.current.title, p.proposed.title, [30, 60]);
    mark(9, p.current.meta, p.proposed.meta, [70, 155]);
    mark(12, p.current.h1, p.proposed.h1);
    row.getCell(COL_APPROVE).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Y,N"'] };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS.length } };

  // Deep fixes
  const dp = wb.addWorksheet('Deep fixes', { views: [{ state: 'frozen', ySplit: 1 }] });
  const dh = ['URL', 'Query', 'Intro', 'H2s', 'FAQ', 'Schema', 'Image alt fixes', 'For AI answers'];
  dp.columns = [44, 28, 60, 40, 60, 40, 40, 50].map((width) => ({ width }));
  dh.forEach((t, i) => { dp.getRow(1).getCell(i + 1).value = t; });
  styleHeader(dp.getRow(1));
  d.proposals.filter((p) => p.deep).forEach((p, i) => {
    const x = p.deep!;
    const row = dp.getRow(i + 2);
    [p.url, x.query, x.intro, x.h2s.join('\n'), x.faq.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n'), x.schema, x.altFixes.join('\n'), (x.citationFacts ?? []).join('\n')]
      .forEach((v, k) => { const cell = row.getCell(k + 1); setText(cell, v); cell.font = font(); cell.alignment = { vertical: 'top', wrapText: true }; });
  });

  // Naming style
  const ns = wb.addWorksheet('Naming style');
  ns.columns = [{ width: 24 }, { width: 60 }];
  ns.getRow(1).getCell(1).value = 'Setting';
  ns.getRow(1).getCell(2).value = 'Value';
  styleHeader(ns.getRow(1));
  const rows: [string, string][] = [
    ['Brand', d.interview.brand], ['Separator', c.separator], ['Brand position', c.brandPosition], ['Case', c.case],
    ...Object.entries(c.patterns).map(([t, pat]): [string, string] => [`Pattern: ${t}`, String(pat)]),
  ];
  rows.forEach(([k, v], i) => {
    const row = ns.getRow(i + 2);
    setText(row.getCell(1), k); setText(row.getCell(2), v);
    row.eachCell((cell) => { cell.font = font(); });
  });

  // Read me
  const rm = wb.addWorksheet('Read me');
  rm.columns = [{ width: 100 }];
  [
    'How to use this workbook.',
    'Review the New title, New meta and New H1 columns. Changed cells are shaded. Red text means a value is outside the length limit.',
    'You can edit any New cell. Clear a New cell to keep the current value.',
    'Type Y in the Approve column for each row you want published, and N for the rest.',
    'You can sort, filter or delete rows. Rows are matched by URL.',
    'Rows marked has [ADD] contain a slot you need to fill in before they can be approved.',
    'The Issues column says why a row needs review. Lines starting "Warning:" are advice: they do not stop the row from being published.',
    'Google rewrites many titles and cuts them off by width, not by character count (about 600 px), so this tool checks pixel width as well as length.',
    'The title and H1 are kept saying the same thing, because Google and AI answers lean on the main heading.',
    'FAQ suggestions in Deep fixes are content for your page, for readers and AI answers. They are not FAQ rich results, which Google retired.',
    "AI answers cite pages that state relevant facts plainly: prices, dates, definitions, steps. The 'For AI answers' column lists the ones worth adding; Pit Crew never makes them up.",
    'Save the file, then tell Claude: publish my approved changes.',
    'Built by Unfayr · unfayr.com',
  ].forEach((t, i) => { const cell = rm.getRow(i + 1).getCell(1); setText(cell, t); cell.font = font({ bold: i === 0 }); cell.alignment = { wrapText: true }; });

  await wb.xlsx.writeFile(file);
}

const yn = (s: string): boolean | null => {
  const v = s.trim().toLowerCase();
  if (v === 'y' || v === 'yes') return true;
  if (v === 'n' || v === 'no') return false;
  return null;
};

export async function readApprovals(file: string, proposals: Proposal[]): Promise<{ proposals: Proposal[]; unknownUrls: string[]; duplicateUrls: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('Pages');
  if (!ws) throw new Error('The workbook has no "Pages" tab. Use the file Pit Crew created.');
  const cols = new Map<string, number>();
  ws.getRow(1).eachCell((cell, n) => { const t = cellText(cell).trim(); if (!cols.has(t)) cols.set(t, n); });
  for (const need of ['URL', 'New title', 'New meta', 'New H1', 'Approve']) {
    if (!cols.has(need)) throw new Error(`The Pages tab is missing the "${need}" column.`);
  }
  const col = (name: string) => cols.get(name)!;
  const byUrl = new Map(proposals.map((p) => [normaliseUrl(p.url), p]));
  const result = new Map<string, Proposal>();
  const unknownUrls: string[] = [];
  const counts = new Map<string, number>();
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const raw = cellText(row.getCell(col('URL'))).trim();
    if (!raw) return;
    const orig = byUrl.get(normaliseUrl(raw));
    if (!orig) { unknownUrls.push(raw); return; }
    const val = (name: string) => { const t = cellText(row.getCell(col(name))).trim(); return t === '' ? null : t; };
    const proposed = { title: val('New title'), meta: val('New meta'), h1: val('New H1') };
    let approve = yn(cellText(row.getCell(col('Approve'))));
    if (orig.status === 'has [ADD]' && Object.values(proposed).some((v) => v !== null && v.includes('[ADD:'))) approve = false;
    counts.set(orig.url, (counts.get(orig.url) ?? 0) + 1);
    result.set(orig.url, { ...orig, proposed, approve });
  });
  const duplicateUrls = [...counts].filter(([, c]) => c > 1).map(([u]) => u);
  const out = proposals.map((p) => {
    if (!result.has(p.url)) return { ...p, approve: null }; // row deleted
    if ((counts.get(p.url) ?? 0) > 1) return { ...result.get(p.url)!, approve: null };
    return result.get(p.url)!;
  });
  return { proposals: out, unknownUrls, duplicateUrls };
}
