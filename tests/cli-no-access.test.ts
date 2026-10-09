import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// publish-plan against a local fake WordPress (http is allowed only for localhost), so no live site is touched.
const ROOT = join(import.meta.dirname, '..');
const fx = (n: string) => readFileSync(join(ROOT, 'fixtures', 'recorded', 'wordpress', `${n}.json`), 'utf8');
const HOST = '127.0.0.1';
const DATE = '2026-01-01';
let server: Server;
let base: string;
/** Slugs whose post lookup answers 403, as for a user who may not read posts. */
let deniedSlugs: Set<string>;

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: string, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    if (u.pathname === '/wp-json') return send(200, fx('root-yoast'));
    if (u.searchParams.get('context') === 'edit' && u.searchParams.get('per_page') === '1') return send(200, fx('edit-list-yoast'));
    const slug = u.searchParams.get('slug');
    if (u.pathname === '/wp-json/wp/v2/posts' && slug !== null) return deniedSlugs.has(slug) ? send(403, fx('forbidden')) : send(200, '[]');
    if (u.pathname === '/wp-json/wp/v2/pages' && slug !== null) {
      return send(200, slug === 'about-us' ? JSON.stringify([{ id: 11, slug, link: `${base}/about-us/` }]) : '[]');
    }
    if (u.pathname === '/wp-json/wp/v2/pages/11') return send(200, fx('page-yoast'));
    if (u.pathname === '/about-us/') return send(200, '<html><head><title>About Trailhead</title><meta name="description" content=""></head><body><h1>About Us</h1></body></html>', 'text/html');
    return send(404, '{}');
  });
  await new Promise<void>((r) => server.listen(0, HOST, r));
  base = `http://${HOST}:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function cli(env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; out: any }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'pitcrew.ts'), ...args], { cwd: ROOT, env: { ...process.env, ...env, PITCREW_NO_OPEN: '1' } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => { let out: any = null; try { out = JSON.parse(stdout); } catch { /* asserted */ } resolve({ code, out }); });
  });
}

async function setup(): Promise<Record<string, string>> {
  const env = { PITCREW_HOME: mkdtempSync(join(tmpdir(), 'pc-na-home-')), PITCREW_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'pc-na-cfg-')) };
  const run = join(env.PITCREW_HOME, 'sites', HOST, 'runs', DATE);
  mkdirSync(run, { recursive: true });
  const prop = (path: string, current: { title: string | null; meta: string | null; h1: string | null }) => ({
    url: `${base}${path}`, type: 'other', tier: 'top', current, proposed: { title: 'A new title for this page here', meta: null, h1: null },
    reason: '', sources: ['page'], issues: [], status: 'ok', approve: true,
  });
  writeFileSync(join(run, 'proposals.json'), JSON.stringify([
    prop('/about-us/', { title: 'About Trailhead', meta: null, h1: 'About Us' }),
    prop('/2026/winter-tips/', { title: 'Winter tips', meta: null, h1: 'Winter tips' }),
  ]));
  const cred = join(mkdtempSync(join(tmpdir(), 'pc-na-c-')), 'cred.json');
  writeFileSync(cred, JSON.stringify({ base, user: 'editor', appPassword: 'abcd efgh SECRETPW' }));
  expect((await cli(env, 'credentials-save', '--site', HOST, '--platform', 'wordpress', '--file', cred)).code).toBe(0);
  return env;
}

describe('publish-plan --kinds with pages the credentials may not read', () => {
  it('keeps the refused pages as no-access skips with a warning, instead of excludedByKinds', async () => {
    deniedSlugs = new Set(['winter-tips']);
    const env = await setup();
    const r = await cli(env, 'publish-plan', '--site', HOST, '--date', DATE, '--platform', 'wordpress', '--kinds', 'page');
    expect(r.code).toBe(0);
    expect(r.out.excludedByKinds).toEqual([]);
    expect(r.out.skippedByReason['no-access']).toBe(1);
    expect(r.out.skipped.find((s: any) => s.reason === 'no-access').url).toBe(`${base}/2026/winter-tips/`);
    expect(r.out.warnings).toEqual([expect.stringMatching(/^1 page skipped: This WordPress user can't edit WordPress/)]);
  });
  it('when every approved page was refused, the error carries the no-access message', async () => {
    deniedSlugs = new Set(['winter-tips', 'about-us']);
    const env = await setup();
    const r = await cli(env, 'publish-plan', '--site', HOST, '--date', DATE, '--platform', 'wordpress', '--kinds', 'page');
    expect(r.code).toBe(1);
    expect(r.out.error).toMatch(/can't edit WordPress/);
    expect(r.out.error).not.toMatch(/are of kind/);
  });
});
