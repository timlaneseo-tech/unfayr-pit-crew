import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCredential, setCredential } from '../scripts/lib/credentials.ts';

let dir: string;
const saved = process.env.PITCREW_CONFIG_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pc-cred-')); process.env.PITCREW_CONFIG_DIR = dir; });
afterEach(() => { if (saved === undefined) delete process.env.PITCREW_CONFIG_DIR; else process.env.PITCREW_CONFIG_DIR = saved; });

describe('credentials', () => {
  it('round-trips, keyed by host without www', () => {
    setCredential('https://www.Example.com/x', 'shopify', { token: 'abc' });
    expect(getCredential('example.com', 'shopify')).toEqual({ token: 'abc' });
    expect(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'))).toEqual({ 'example.com': { shopify: { token: 'abc' } } });
  });
  it('keeps other platforms and hosts', () => {
    setCredential('a.com', 'shopify', { t: 1 });
    setCredential('a.com', 'wordpress', { t: 2 });
    setCredential('b.com', 'shopify', { t: 3 });
    expect(getCredential('a.com', 'shopify')).toEqual({ t: 1 });
    expect(getCredential('a.com', 'wordpress')).toEqual({ t: 2 });
    expect(getCredential('www.b.com', 'shopify')).toEqual({ t: 3 });
  });
  it('returns null for unknown host/platform or missing file', () => {
    expect(getCredential('nope.com', 'shopify')).toBeNull();
    setCredential('a.com', 'shopify', { t: 1 });
    expect(getCredential('nope.com', 'shopify')).toBeNull();
    expect(getCredential('a.com', 'webflow')).toBeNull();
  });
  it('writes mode 0600 where supported', () => {
    setCredential('a.com', 'shopify', { t: 1 });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
  });
});

describe('credentials safety', () => {
  it('corrupt file: get and set throw, and the file is not overwritten', () => {
    const f = join(dir, 'credentials.json');
    writeFileSync(f, '{not json');
    expect(() => getCredential('a.com', 'shopify')).toThrow(/credentials\.json is not valid JSON/);
    expect(() => setCredential('a.com', 'shopify', { t: 1 })).toThrow(/credentials\.json/);
    expect(readFileSync(f, 'utf8')).toBe('{not json');
  });
  it('unparseable host throws', () => {
    expect(() => setCredential('http://', 'shopify', { t: 1 })).toThrow(/host/);
    expect(() => getCredential('', 'shopify')).toThrow(/host/);
  });
});

describe('credentials-save temp file handling (M11)', () => {
  const ROOT = join(import.meta.dirname, '..');
  const run = (file: string, env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pitcrew.ts'), 'credentials-save', '--site', 'm11.example', '--platform', 'shopify', '--file', file], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, PITCREW_CONFIG_DIR: dir, PITCREW_HOME: dir, ...env },
    });
    return { code: r.status, out: JSON.parse(r.stdout), raw: r.stdout + r.stderr };
  };
  it('keeps a file that is outside the temp folders (saves, does not delete)', () => {
    const otherTmp = mkdtempSync(join(tmpdir(), 'pc-m11-tmp-'));
    const f = join(mkdtempSync(join(tmpdir(), 'pc-m11-elsewhere-')), 'cred.json');
    writeFileSync(f, JSON.stringify({ shop: 'x.myshopify.com', token: 'shpat_KEEP' }));
    const r = run(f, { TMPDIR: otherTmp, TEMP: otherTmp, TMP: otherTmp });
    expect(r.code).toBe(0);
    expect(existsSync(f)).toBe(true);
    expect(r.out.deleted).toBe(false);
  });
  it('deletes a file inside the config folder\'s tmp folder', () => {
    const otherTmp = mkdtempSync(join(tmpdir(), 'pc-m11-tmp-'));
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    const f = join(dir, 'tmp', 'cred.json');
    writeFileSync(f, JSON.stringify({ shop: 'x.myshopify.com', token: 'shpat_GONE' }));
    const r = run(f, { TMPDIR: otherTmp, TEMP: otherTmp, TMP: otherTmp });
    expect(r.code).toBe(0);
    expect(existsSync(f)).toBe(false);
  });
  it('on bad JSON names the line and character, keeps the file, and never prints the secret', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'pc-m11-bad-')), 'cred.json');
    writeFileSync(f, '{\n  "shop": "x.myshopify.com",\n  "token": "shpat_SECRET999"\n  "extra": 1\n}');
    const r = run(f, {});
    expect(r.code).toBe(1);
    expect(r.out.error).toMatch(/line 4, character 3/);
    expect(r.raw).not.toContain('SECRET999');
    expect(existsSync(f)).toBe(true);
  });
});
