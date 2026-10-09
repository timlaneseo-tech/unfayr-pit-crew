import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const runDir = () => join(home, 'sites', SITE, 'runs', DATE);

describe('credentials-save temp file cleanup', () => {
  beforeAll(() => { home = tmp('pc-g0-home-'); config = tmp('pc-g0-cfg-'); });
  it('deletes the temp file even when --platform is bad', () => {
    const f = join(tmp('pc-c2-'), 'cred.json');
    writeFileSync(f, JSON.stringify({ token: 'SECRET456' }));
    const r = cli('credentials-save', '--site', SITE, '--platform', 'carrierpigeon', '--file', f);
    expect(r.code).toBe(1);
    expect(existsSync(f)).toBe(false);
  });
  it('deletes the temp file even when --site is missing', () => {
    const f = join(tmp('pc-c3-'), 'cred.json');
    writeFileSync(f, JSON.stringify({ token: 'SECRET789' }));
    const r = cli('credentials-save', '--platform', 'shopify', '--file', f);
    expect(r.code).toBe(1);
    expect(existsSync(f)).toBe(false);
  });
});

describe('git platform end to end (offline)', () => {
  const pageMap: Record<string, string> = {
    'index.html': 'index', 'water-heater-repair/index.html': 'water-heater-repair', 'drain-cleaning/index.html': 'drain-cleaning',
    'sewer-line-repair/index.html': 'sewer-line-repair', 'leak-detection/index.html': 'leak-detection',
    'emergency-plumbing/index.html': 'emergency-plumbing', 'service-areas/boise/index.html': 'service-areas-boise',
    'service-areas/nampa/index.html': 'service-areas-nampa', 'blog/water-heater-anode-rod/index.html': 'blog-water-heater-anode-rod',
    'blog/frozen-pipes-boise/index.html': 'blog-frozen-pipes-boise', 'blog/sewer-camera-inspection-cost/index.html': 'blog-sewer-camera-inspection-cost',
    'about/index.html': 'about',
  };
  let repo: string;
  let before: Record<string, string>;
  let backupId: string;
  let changes: number;
  const snap = () => Object.fromEntries(Object.keys(pageMap).map((p) => [p, readFileSync(join(repo, p)).toString('base64')]));
  const saveGit = (dir: string) => {
    const cf = join(tmp('pc-gc-'), 'c.json');
    writeFileSync(cf, JSON.stringify({ repoDir: dir, origin: `https://${SITE}` }));
    return cli('credentials-save', '--site', SITE, '--platform', 'git', '--file', cf);
  };

  beforeAll(async () => {
    home = tmp('pc-g-home-'); config = tmp('pc-g-cfg-'); repo = tmp('pc-g-repo-');
    for (const [rel, slug] of Object.entries(pageMap)) {
      const abs = join(repo, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      copyFileSync(join(ROOT, 'fixtures', SITE, 'pages', `${slug}.html`), abs);
    }
    before = snap();
    expect(cli('crawl', '--sample', SITE, '--date', DATE).code).toBe(0);
    expect(cli('interview-save', '--site', SITE, '--file', join(ROOT, 'fixtures', SITE, 'answers.json')).code).toBe(0);
    expect(cli('top', '--site', SITE).code).toBe(0);
    expect(cli('batches', '--site', SITE).code).toBe(0);
    expect(cli('merge', '--site', SITE, '--sample-outs').code).toBe(0);
    const w = cli('workbook', '--site', SITE, '--no-open');
    expect(w.code).toBe(0);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(w.out.workbook);
    const ws = wb.getWorksheet('Pages')!;
    const cols = new Map<string, number>();
    ws.getRow(1).eachCell((c, n) => cols.set(String(c.value), n));
    ws.eachRow((row, n) => { if (n > 1) row.getCell(cols.get('Approve')!).value = 'Y'; });
    await wb.xlsx.writeFile(w.out.workbook);
    expect(cli('approvals', '--site', SITE).code).toBe(0);
    expect(saveGit(repo).code).toBe(0);
  });

  it('publish-plan --kinds product on git exits 1', () => {
    const r = cli('publish-plan', '--site', SITE, '--platform', 'git', '--kinds', 'product');
    expect(r.code).toBe(1);
    expect(r.out.error).toContain('None of the approved pages');
  });

  it('plans without writing, applies, warns on a repeat, and rolls back byte for byte', () => {
    const p = cli('publish-plan', '--site', SITE, '--platform', 'git');
    expect(p.code).toBe(0);
    backupId = p.out.backupId;
    changes = p.out.changes;
    expect(changes).toBeGreaterThan(0);
    expect(p.out.byKind.file).toBe(changes);
    expect(snap()).toEqual(before);

    const a = cli('publish-apply', '--site', SITE, '--backup', backupId);
    expect(a.code).toBe(0);
    // Nampa has no <h1>: the git adapter writes its title and meta and refuses only the heading, saying why (T13).
    expect(a.out.failed).toBe(1);
    expect(a.out.log.filter((e: any) => !e.ok)).toEqual([expect.objectContaining({ field: 'h1', ok: false })]);
    expect(a.out.log.filter((e: any) => !e.ok).every((e: any) => e.url.endsWith('/service-areas/nampa') && /no <h1>/.test(e.error))).toBe(true);
    expect(a.out.applied).toBe(changes - 1);
    expect(a.out.warnings).toEqual([]);
    // Nothing is deployed in this test, so the live check says so in plain words for git (T13).
    expect(a.out.notDeployedYet).toBe(changes - 1);
    expect(a.out.deployNote).toMatch(/not deployed yet/i);
    const after = snap();
    expect(after['drain-cleaning/index.html']).not.toBe(before['drain-cleaning/index.html']);
    expect(Buffer.from(after['drain-cleaning/index.html']!, 'base64').toString()).toContain('Drain cleaning in Boise | Ridgeline Plumbing');
    const onpage = JSON.parse(readFileSync(join(runDir(), 'onpage.json'), 'utf8'));
    expect(onpage.changes.filter((c: any) => c.status === 'published' || c.status === 'verified').length).toBe(changes - 1);
    const log = JSON.parse(readFileSync(join(runDir(), 'publish-log.json'), 'utf8'));
    expect(log.entries.filter((e: any) => e.action === 'apply' && e.ok).length).toBe(changes - 1);

    const again = cli('publish-apply', '--site', SITE, '--backup', backupId);
    expect(again.code).toBe(0);
    expect(again.out.warnings.join(' ')).toMatch(/already/);

    const rb = cli('rollback', '--site', SITE, '--backup', backupId);
    expect(rb.code).toBe(0);
    expect(rb.out.failed).toBe(0);
    expect(snap()).toEqual(before);
    const rolled = JSON.parse(readFileSync(join(runDir(), 'onpage.json'), 'utf8')).changes.filter((c: any) => c.status === 'rolled-back');
    expect(rolled.length).toBe(changes - 1);
    expect(rolled.every((c: any) => typeof c.rolled_back_at === 'string')).toBe(true);
  });

  it('a bad or missing --backup exits 1 with a plain JSON error', () => {
    for (const args of [['--backup', 'nope'], []]) {
      const r = cli('publish-apply', '--site', SITE, '--platform', 'git', ...args);
      expect(r.code).toBe(1);
      expect(typeof r.out.error).toBe('string');
      expect(r.raw).not.toMatch(/ENOENT|\bat .*\.ts:\d+/);
    }
  });

  it('apply and rollback refuse a --platform that differs from the plan', () => {
    const a = cli('publish-apply', '--site', SITE, '--platform', 'shopify', '--backup', backupId);
    expect(a.code).toBe(1);
    expect(a.out.error).toMatch(/git/);
    expect(cli('rollback', '--site', SITE, '--platform', 'shopify', '--backup', backupId).code).toBe(1);
  });

  it('apply refuses when the saved git credential now points at another repo', () => {
    expect(saveGit(tmp('pc-g-other-')).code).toBe(0);
    const r = cli('publish-apply', '--site', SITE, '--backup', backupId);
    expect(r.code).toBe(1);
    expect(r.out.error).toMatch(/different|changed/i);
  });
});
