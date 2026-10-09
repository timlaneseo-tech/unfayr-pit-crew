import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitAdapter } from '../scripts/lib/publish/git.ts';

const O = 'https://site.example';
const HOME = `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Old &amp; home</title>\n  <meta name="description" content="Old &quot;desc&quot; &amp; more">\n  <style>h1 { color: red }</style>\n</head>\n<body>\n<!-- <h1>commented</h1> -->\n<h1 class="big">Welcome <span>home</span></h1>\n<h1>Second</h1>\n<script>var t = "<title>x</title>";</script>\n</body>\n</html>\n`;
const SERVICE = `<html><head><title>Drain</title></head><body><h1>Drain</h1></body></html>`;
const ABOUT = `<html>\n<head>\n\t<title>About</title>\n</head>\n<body><h1>About</h1></body>\n</html>\n`;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pitcrew-git-'));
  writeFileSync(join(dir, 'index.html'), HOME);
  mkdirSync(join(dir, 'services', 'drain-cleaning'), { recursive: true });
  writeFileSync(join(dir, 'services', 'drain-cleaning', 'index.html'), SERVICE);
  writeFileSync(join(dir, 'about.html'), ABOUT);
  writeFileSync(join(dir, '..', 'pitcrew-outside.html'), '<title>secret</title>');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(join(dir, '..', 'pitcrew-outside.html'), { force: true }); });

const a = () => gitAdapter({ repoDir: dir, origin: O });
const file = (p: string) => readFileSync(join(dir, p), 'utf8');

describe('resolve', () => {
  it('maps URLs to files; unmatched is null', async () => {
    const urls = [`${O}/`, `${O}`, `${O}/services/drain-cleaning/`, `${O}/about`, `${O}/about/`, `${O}/nothing`];
    const m = await a().resolve(urls);
    expect(m.get(`${O}/`)).toEqual({ url: `${O}/`, kind: 'file', id: 'index.html', h1RenamesRecord: false });
    expect(m.get(O)?.id).toBe('index.html');
    expect(m.get(`${O}/services/drain-cleaning/`)?.id).toBe('services/drain-cleaning/index.html');
    expect(m.get(`${O}/about`)?.id).toBe('about.html');
    expect(m.get(`${O}/about/`)?.id).toBe('about.html');
    expect(m.get(`${O}/nothing`)).toBeNull();
  });
  it('refuses path traversal and foreign hosts', async () => {
    const urls = [`${O}/../pitcrew-outside`, `${O}/%2e%2e/pitcrew-outside`, `${O}/a/..%2f..%2fpitcrew-outside`, `${O}/..%5cpitcrew-outside`, 'https://evil.example/about'];
    const m = await a().resolve(urls);
    for (const u of urls) expect(m.get(u)).toBeNull();
  });
});

describe('read', () => {
  it('decodes entities and strips inner tags from h1', async () => {
    const ref = (await a().resolve([`${O}/`])).get(`${O}/`)!;
    expect(await a().read(ref)).toEqual({ title: 'Old & home', meta: 'Old "desc" & more', h1: 'Welcome home' });
  });
  it('returns null for missing meta', async () => {
    const ref = (await a().resolve([`${O}/about`])).get(`${O}/about`)!;
    expect(await a().read(ref)).toEqual({ title: 'About', meta: null, h1: 'About' });
  });
});

describe('write', () => {
  it('replaces only title, meta content and first real h1; every other byte is unchanged', async () => {
    const ref = (await a().resolve([`${O}/`])).get(`${O}/`)!;
    await a().write(ref, { title: 'New <b> & title', meta: 'He said "hi" & <left>', h1: 'Fresh & heading' });
    const out = file('index.html');
    expect(out).toBe(
      HOME.replace('Old &amp; home', 'New &lt;b&gt; &amp; title')
        .replace('Old &quot;desc&quot; &amp; more', 'He said &quot;hi&quot; &amp; <left>')
        .replace('Welcome <span>home</span>', 'Fresh &amp; heading'),
    );
    expect(out).toContain('<!-- <h1>commented</h1> -->');
    expect(out).toContain('<h1>Second</h1>');
  });
  it('only touches the fields supplied and skips null/empty', async () => {
    const ref = (await a().resolve([`${O}/`])).get(`${O}/`)!;
    await a().write(ref, { title: '', meta: undefined, h1: null as any });
    expect(file('index.html')).toBe(HOME);
    await a().write(ref, { h1: 'Only h1' });
    expect(file('index.html')).toBe(HOME.replace('Welcome <span>home</span>', 'Only h1'));
  });
  it('inserts a missing meta description after the title, matching indent and line endings', async () => {
    const crlf = ABOUT.replace(/\n/g, '\r\n');
    writeFileSync(join(dir, 'about.html'), crlf);
    const ref = (await a().resolve([`${O}/about`])).get(`${O}/about`)!;
    await a().write(ref, { meta: 'About "us"' });
    expect(file('about.html')).toBe(crlf.replace('</title>', '</title>\r\n\t<meta name="description" content="About &quot;us&quot;">'));
  });
  it('preserves CRLF and a BOM', async () => {
    const src = '﻿' + SERVICE.replace('<body>', '<body>\r\n');
    writeFileSync(join(dir, 'services', 'drain-cleaning', 'index.html'), src);
    const ref = (await a().resolve([`${O}/services/drain-cleaning`])).get(`${O}/services/drain-cleaning`)!;
    await a().write(ref, { title: 'Drain é ’ 😀', h1: 'H' });
    const raw = readFileSync(join(dir, 'services', 'drain-cleaning', 'index.html'));
    expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.toString('utf8')).toBe(src.replace('<title>Drain</title>', '<title>Drain é ’ 😀</title>').replace('<h1>Drain</h1>', '<h1>H</h1>'));
  });
  it('throws a clear error when title is missing and leaves the file untouched', async () => {
    const bare = '<html><body><h1>X</h1></body></html>';
    writeFileSync(join(dir, 'about.html'), bare);
    const ref = (await a().resolve([`${O}/about`])).get(`${O}/about`)!;
    await expect(a().write(ref, { meta: 'M' })).rejects.toThrow(/<title>/);
    await expect(a().write(ref, { title: 'T', h1: 'Y' })).rejects.toThrow(/<title>/);
    expect(file('about.html')).toBe(bare);
  });
  it('refuses refs that escape the repo', async () => {
    await expect(a().read({ url: 'u', kind: 'file', id: '../pitcrew-outside.html', h1RenamesRecord: false })).rejects.toThrow();
    await expect(a().write({ url: 'u', kind: 'file', id: '../pitcrew-outside.html', h1RenamesRecord: false }, { title: 'x' })).rejects.toThrow();
  });
});

describe('robustness', () => {
  it('handles > inside quoted attributes of h1, title and meta', async () => {
    const src = `<html><head><title data-x="a > b">T</title><meta content="x > y" name="description"></head><body><h1 x-show="n > 0">Hi</h1><title-bar>no</title-bar></body></html>`;
    writeFileSync(join(dir, 'about.html'), src);
    const ref = (await a().resolve([`${O}/about`])).get(`${O}/about`)!;
    expect(await a().read(ref)).toEqual({ title: 'T', meta: 'x > y', h1: 'Hi' });
    await a().write(ref, { title: 'N', meta: 'M', h1: 'H' });
    expect(file('about.html')).toBe(src.replace('>T<', '>N<').replace('x > y', 'M').replace('>Hi<', '>H<'));
  });
  it('does not match <h1-x> or <title-bar> as real elements', async () => {
    const src = `<html><head><title-bar>no</title-bar></head><body><h1-x>no</h1-x></body></html>`;
    writeFileSync(join(dir, 'about.html'), src);
    const ref = (await a().resolve([`${O}/about`])).get(`${O}/about`)!;
    await expect(a().write(ref, { title: 'T' })).rejects.toThrow(/<title>/);
    await expect(a().write(ref, { h1: 'T' })).rejects.toThrow(/<h1>/);
  });
  it('treats www and bare host as the same origin', async () => {
    const m = await a().resolve(['https://www.site.example/about']);
    expect(m.get('https://www.site.example/about')?.id).toBe('about.html');
  });
  it('refuses symlinks that point outside the repo', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pitcrew-out-'));
    writeFileSync(join(outside, 'index.html'), '<title>secret</title>');
    try { symlinkSync(outside, join(dir, 'linked'), 'junction'); } catch { rmSync(outside, { recursive: true, force: true }); return; }
    try {
      const m = await a().resolve([`${O}/linked`]);
      expect(m.get(`${O}/linked`)).toBeNull();
      await expect(a().read({ url: 'u', kind: 'file', id: 'linked/index.html', h1RenamesRecord: false })).rejects.toThrow();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  it('writes atomically and leaves no temp files', async () => {
    const ref = (await a().resolve([`${O}/about`])).get(`${O}/about`)!;
    await a().write(ref, { title: 'Z' });
    expect(readdirSync(dir).sort()).toEqual(['about.html', 'index.html', 'services']);
  });
});
