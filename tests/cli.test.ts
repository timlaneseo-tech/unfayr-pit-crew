import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

const ROOT = join(import.meta.dirname, '..');
const SITE = 'ridgeline-plumbing.example';
const DATE = '2026-01-01';
let home: string;
let config: string;

function cli(...args: string[]): { code: number | null; out: any; raw: string } {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pitcrew.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PITCREW_HOME: home, PITCREW_CONFIG_DIR: config, PITCREW_NO_OPEN: '1' },
  });
  let out: any = null;
  try { out = JSON.parse(r.stdout); } catch { /* asserted by callers */ }
  return { code: r.status, out, raw: r.stdout + r.stderr };
}

const run = () => join(home, 'sites', SITE, 'runs', DATE);

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'pc-cli-home-'));
  config = mkdtempSync(join(tmpdir(), 'pc-cli-cfg-'));
});

describe('pitcrew CLI sample flow', () => {
  it('crawl --sample reads the 12 kept pages', () => {
    const r = cli('crawl', '--sample', SITE, '--date', DATE);
    expect(r.code).toBe(0);
    expect(r.out.readout.pages).toBe(12);
    expect(r.out.capped).toBe(false);
    expect(existsSync(join(run(), 'pages.json'))).toBe(true);
    expect(existsSync(join(run(), 'crawl.json'))).toBe(true);
  });

  it('conventions prints the analysis and 3 candidates', () => {
    const r = cli('conventions', '--site', SITE, '--brand', 'Ridgeline Plumbing');
    expect(r.code).toBe(0);
    expect(r.out.candidates).toHaveLength(3);
    expect(r.out.analysis.brandLast).toBeGreaterThan(0);
  });

  it('interview-save rejects a bad file and saves a good one', () => {
    const bad = join(mkdtempSync(join(tmpdir(), 'pc-cli-f-')), 'bad.json');
    writeFileSync(bad, JSON.stringify({ brand: '', answers: [] }));
    const b = cli('interview-save', '--site', SITE, '--file', bad);
    expect(b.code).toBe(1);
    expect(b.out.error).toMatch(/brand/);
    const g = cli('interview-save', '--site', SITE, '--file', join(ROOT, 'fixtures', SITE, 'answers.json'));
    expect(g.code).toBe(0);
    expect(g.out.answers).toBe(5);
    expect(existsSync(join(home, 'sites', SITE, 'interview.json'))).toBe(true);
  });

  it('interview-save keeps appliesTo on an answer and rejects an unknown page type (M10)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-cli-m10-'));
    const base = JSON.parse(readFileSync(join(ROOT, 'fixtures', SITE, 'answers.json'), 'utf8'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ ...base, answers: [...base.answers, { id: 'price', question: 'Price?', answer: 'From $89', appliesTo: ['service', 'blog'] }] }));
    const b = cli('interview-save', '--site', 'm10.example', '--file', bad);
    expect(b.code).toBe(1);
    expect(b.out.error).toMatch(/appliesTo/);
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ ...base, answers: [...base.answers, { id: 'price', question: 'Price?', answer: 'From $89', appliesTo: ['product', 'collection', 'service', 'location'] }] }));
    expect(cli('interview-save', '--site', 'm10.example', '--file', good).code).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, 'sites', 'm10.example', 'interview.json'), 'utf8'));
    expect(saved.answers.find((a: any) => a.id === 'price').appliesTo).toEqual(['product', 'collection', 'service', 'location']);
    expect(saved.answers.find((a: any) => a.id === 'history').appliesTo).toBeUndefined();
  });

  it('top writes top.json and batches puts the top tier first', () => {
    const t = cli('top', '--site', SITE);
    expect(t.code).toBe(0);
    expect(t.out.top[0]).toBe(`https://${SITE}/`);
    expect(JSON.parse(readFileSync(join(run(), 'top.json'), 'utf8'))).toEqual(t.out.top);
    const b = cli('batches', '--site', SITE);
    expect(b.code).toBe(0);
    expect(b.out.pending.map((p: any) => p.id)).toEqual(['01']);
    expect(b.out.skipped).toEqual([]);
  });

  it('merge --sample-outs reports has [ADD] and needs review', () => {
    const m = cli('merge', '--site', SITE, '--sample-outs');
    expect(m.code).toBe(0);
    expect(m.out.counts['has [ADD]']).toBeGreaterThanOrEqual(1);
    expect(m.out.counts['needs review']).toBeGreaterThanOrEqual(1);
    expect(m.out.proposals).toBe(12);
    expect(m.out.retry).toContain(`https://${SITE}/sewer-line-repair`);
    expect(m.out.missingBatches).toEqual([]);
  });

  it('workbook writes the xlsx and onpage.json without opening it', () => {
    const w = cli('workbook', '--site', SITE, '--no-open');
    expect(w.code).toBe(0);
    expect(w.out.opened).toBe(false);
    expect(existsSync(w.out.workbook)).toBe(true);
    expect(w.out.workbook).toContain(`Pit Crew - ${SITE} - ${DATE}.xlsx`);
    expect(existsSync(join(run(), 'onpage.json'))).toBe(true);
  });

  it('approvals reads Approve cells back and reports unknown urls', async () => {
    const file = join(run(), `Pit Crew - ${SITE} - ${DATE}.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.getWorksheet('Pages')!;
    const cols = new Map<string, number>();
    ws.getRow(1).eachCell((c, n) => cols.set(String(c.value), n));
    ws.eachRow((row, n) => {
      if (n > 1) row.getCell(cols.get('Approve')!).value = 'y';
    });
    const extra = ws.addRow([]);
    extra.getCell(cols.get('URL')!).value = 'https://elsewhere.example/nope';
    await wb.xlsx.writeFile(file);
    const a = cli('approvals', '--site', SITE);
    expect(a.code).toBe(0);
    expect(a.out.approved).toBe(11);
    expect(a.out.rejected).toBe(1);
    expect(a.out.approvedNeedingReview).toHaveLength(1);
    expect(a.out.unknownUrls).toEqual(['https://elsewhere.example/nope']);
    expect(a.out.duplicateUrls).toEqual([]);
  });

  it('mark updates onpage.json and rejects a bad status', () => {
    const url = `https://${SITE}/about`;
    const m = cli('mark', '--site', SITE, '--url', url, '--field', 'title', '--status', 'published');
    expect(m.code).toBe(0);
    const j = JSON.parse(readFileSync(join(run(), 'onpage.json'), 'utf8'));
    expect(j.changes.find((c: any) => c.url === url && c.field === 'title').status).toBe('published');
    const bad = cli('mark', '--site', SITE, '--url', url, '--field', 'title', '--status', 'done');
    expect(bad.code).toBe(1);
    expect(bad.out.error).toMatch(/status/);
  });

  it('wp-csv writes the import file for approved ok rows only and lists the excluded ones (R6)', () => {
    const r = cli('wp-csv', '--site', SITE);
    expect(r.code).toBe(0);
    expect(existsSync(r.out.csv)).toBe(true);
    expect(r.out.rows).toBe(10);
    const csv = readFileSync(r.out.csv, 'utf8');
    expect(csv).not.toContain('/sewer-line-repair');
    expect(csv).not.toContain('[ADD');
    expect(r.out.excluded).toEqual([{ url: `https://${SITE}/sewer-line-repair`, status: 'needs review' }]);
  });
});

describe('pitcrew CLI failures', () => {
  it('crawl on a site that yields nothing exits 1 with a plain message', () => {
    const r = cli('crawl', '--sample', 'empty-site.example', '--date', DATE);
    expect(r.code).toBe(1);
    expect(r.out.error).toContain('found no pages Pit Crew can read');
    expect(r.raw).not.toMatch(/\bat .*\.ts:\d+/);
  });

  it('publish-plan without credentials names the platform and says credentials', () => {
    const r = cli('publish-plan', '--site', SITE, '--platform', 'shopify');
    expect(r.code).toBe(1);
    expect(r.out.error).toMatch(/shopify/);
    expect(r.out.error).toMatch(/credentials/);
  });

  it('unknown command and missing run exit 1 with JSON errors', () => {
    expect(cli('frobnicate').code).toBe(1);
    const r = cli('batches', '--site', 'nowhere.example');
    expect(r.code).toBe(1);
    expect(r.out.error).toMatch(/crawl/);
  });

  it('credentials-save stores the secret, deletes the temp file and never prints it', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'pc-cli-c-')), 'cred.json');
    writeFileSync(f, JSON.stringify({ shop: 'x.myshopify.com', token: 'shpat_SECRET123' }));
    const r = cli('credentials-save', '--site', SITE, '--platform', 'shopify', '--file', f);
    expect(r.code).toBe(0);
    expect(r.raw).not.toContain('SECRET123');
    expect(existsSync(f)).toBe(false);
    expect(readFileSync(join(config, 'credentials.json'), 'utf8')).toContain('SECRET123');
  });
});

describe('resuming a run (I5)', () => {
  const S2 = 'ridgeline-plumbing.example';
  const run2 = () => join(home, 'sites', S2, 'runs', '2026-02-02');
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'pc-cli-resume-'));
    config = mkdtempSync(join(tmpdir(), 'pc-cli-resume-cfg-'));
  });
  it('status reports how far the run got, step by step', () => {
    const st = () => cli('status', '--site', S2, '--date', '2026-02-02').out;
    expect(cli('status', '--site', S2).out.stage).toBe('none');
    expect(cli('crawl', '--sample', S2, '--date', '2026-02-02').code).toBe(0);
    expect(st().stage).toBe('crawled');
    expect(cli('interview-save', '--site', S2, '--file', join(ROOT, 'fixtures', S2, 'answers.json')).code).toBe(0);
    expect(st().stage).toBe('interviewed');
    expect(cli('top', '--site', S2).code).toBe(0);
    expect(st().stage).toBe('top');
    expect(cli('batches', '--site', S2).code).toBe(0);
    const b = st();
    expect(b.stage).toBe('batches pending 1');
    expect(b.batches).toEqual({ total: 1, done: 0, pending: ['01'] });
    expect(cli('merge', '--site', S2, '--sample-outs').code).toBe(0);
    expect(st().stage).toBe('merged');
    expect(cli('workbook', '--site', S2, '--no-open').code).toBe(0);
    const w = st();
    expect(w.stage).toBe('workbook');
    expect(typeof w.next).toBe('string');
  }, 30_000); // spawns about ten CLI processes; 5 s is too tight on a busy Windows machine
  it('a same-day re-crawl that finds different pages clears top.json, batches and proposals', () => {
    expect(cli('crawl', '--sample', S2, '--date', '2026-02-02').code).toBe(0);
    expect(existsSync(join(run2(), 'top.json'))).toBe(true);
    expect(existsSync(join(run2(), 'proposals.json'))).toBe(true);
    const pf = join(run2(), 'pages.json');
    const pages = JSON.parse(readFileSync(pf, 'utf8'));
    pages[1].title = 'Changed since the last crawl';
    writeFileSync(pf, JSON.stringify(pages));
    const r = cli('crawl', '--sample', S2, '--date', '2026-02-02');
    expect(r.code).toBe(0);
    expect(r.out.cleared).toEqual(['top.json', 'batches', 'proposals.json']);
    expect(existsSync(join(run2(), 'top.json'))).toBe(false);
    expect(existsSync(join(run2(), 'batches'))).toBe(false);
    expect(existsSync(join(run2(), 'proposals.json'))).toBe(false);
    expect(cli('status', '--site', S2, '--date', '2026-02-02').out.stage).toBe('interviewed');
  });
});

describe('crawl --include over the cap (I6)', () => {
  it('returns truncatedTo and a plain message instead of asking for sections again', () => {
    home = mkdtempSync(join(tmpdir(), 'pc-cli-i6-'));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pitcrew.ts'), 'crawl', '--sample', 'trailhead-parts.example', '--date', DATE, '--include', 'products'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, PITCREW_HOME: home, PITCREW_NO_OPEN: '1', PITCREW_CAP: '3' },
    });
    const out = JSON.parse(r.stdout);
    expect(r.status).toBe(0);
    expect(out.truncatedTo).toBe(3);
    expect(out.message).toMatch(/^Kept the first 3 of \d+ pages in \/products\/\.$/);
    expect(out.readout.pages).toBe(3);
  });
});

describe('crawl --include section forms (Windows Git Bash mangling)', () => {
  // Spawned with an args array (no shell), so the value reaches node exactly as written here.
  const crawlWith = (include: string) => {
    home = mkdtempSync(join(tmpdir(), 'pc-cli-inc-'));
    return cli('crawl', '--sample', 'trailhead-parts.example', '--date', DATE, '--include', include);
  };
  it('takes slashless section names', () => {
    const r = crawlWith('collections,pages');
    expect(r.code).toBe(0);
    expect(r.out.readout.pages).toBeGreaterThan(0);
    const pages = JSON.parse(readFileSync(join(home, 'sites', 'trailhead-parts.example', 'runs', DATE, 'pages.json'), 'utf8'));
    expect(pages.every((p: any) => /\/(collections|pages)\//.test(p.url))).toBe(true);
  });
  it('recovers the value Git Bash passes for --include /collections/,/pages/', () => {
    const plain = crawlWith('collections,pages').out.readout.pages;
    const r = crawlWith('C:/Program Files/Git/collections/,/pages/');
    expect(r.code).toBe(0);
    expect(r.out.readout.pages).toBe(plain);
  });
  it('fails with the entry named when a Windows path cannot be recovered', () => {
    const r = crawlWith('C:/Users/tim/collections/');
    expect(r.code).toBe(1);
    expect(r.out.error).toContain('C:/Users/tim/collections/');
    expect(r.out.error).toContain('--include collections,pages');
  });
});

describe('mark --url needs a full address', () => {
  it('rejects a path (Git Bash turns /x into C:/Program Files/Git/x)', () => {
    home = mkdtempSync(join(tmpdir(), 'pc-cli-mark-'));
    expect(cli('crawl', '--sample', SITE, '--date', DATE).code).toBe(0);
    const r = cli('mark', '--site', SITE, '--date', DATE, '--url', 'C:/Program Files/Git/services/drain-cleaning', '--field', 'title', '--status', 'published');
    expect(r.code).toBe(1);
    expect(r.out.error).toMatch(/full address/);
  });
});

describe('crawl --include warns about a section that matched nothing', () => {
  it('names it (catches a Git root such as Scoop recovering to the wrong path)', () => {
    home = mkdtempSync(join(tmpdir(), 'pc-cli-empty-'));
    const r = cli('crawl', '--sample', 'trailhead-parts.example', '--date', DATE, '--include', 'C:/Users/tim/scoop/apps/git/current/collections/,/pages/');
    expect(r.code).toBe(0);
    expect(r.out.warnings).toEqual([expect.stringContaining('/current/collections/')]);
    expect(r.out.warnings[0]).toContain('--include collections,pages');
  });
  it('fails naming the sections when none matched', () => {
    home = mkdtempSync(join(tmpdir(), 'pc-cli-empty2-'));
    const r = cli('crawl', '--sample', 'trailhead-parts.example', '--date', DATE, '--include', 'nope');
    expect(r.code).toBe(1);
    expect(r.out.error).toContain('/nope/');
  });
});
