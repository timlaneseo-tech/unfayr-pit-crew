import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitAdapter } from '../scripts/lib/publish/git.ts';

const O = 'https://site.example';
const OG = `<html><head>\n<title>Old title</title>\n<meta name="description" content="Old &amp;  meta">\n<meta property="og:title" content="Old  title">\n<meta property="og:description" content='Old &amp; meta'>\n</head><body><h1>x</h1></body></html>\n`;
const PLAIN = '<html><head><title>Plain</title><meta name="description" content="Plain meta"></head><body><h1>x</h1></body></html>\n';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pitcrew-gitog-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const a = () => gitAdapter({ repoDir: dir, origin: O });
const file = (p: string) => readFileSync(join(dir, p), 'utf8');
const ref = async (u: string) => (await a().resolve([u])).get(u)!;

describe('git adapter: open graph sync', () => {
  it('updates og:title and og:description when they equal the old values (decoded, collapsed)', async () => {
    writeFileSync(join(dir, 'og.html'), OG);
    await a().write(await ref(`${O}/og`), { title: 'New & better', meta: "Fresh 'meta' & more", h1: null });
    const out = file('og.html');
    expect(out).toContain('<title>New &amp; better</title>');
    expect(out).toContain('<meta property="og:title" content="New &amp; better">');
    expect(out).toContain("<meta property=\"og:description\" content='Fresh &#39;meta&#39; &amp; more'>");
    expect(out).toContain('<meta name="description" content="Fresh \'meta\' &amp; more">');
  });
  it('leaves a non-matching og:title alone', async () => {
    writeFileSync(join(dir, 'og.html'), OG.replace('Old  title', 'Something custom'));
    await a().write(await ref(`${O}/og`), { title: 'Newer', meta: null, h1: null });
    const out = file('og.html');
    expect(out).toContain('<meta property="og:title" content="Something custom">');
    expect(out).toContain("content='Old &amp; meta'");
  });
  it('never inserts OG tags that are not there', async () => {
    writeFileSync(join(dir, 'plain.html'), PLAIN);
    await a().write(await ref(`${O}/plain`), { title: 'Brand new title', meta: 'Brand new meta', h1: null });
    expect(file('plain.html')).not.toContain('og:');
  });
  it('does not touch og tags when only the h1 changes', async () => {
    writeFileSync(join(dir, 'og.html'), OG);
    await a().write(await ref(`${O}/og`), { title: null, meta: null, h1: 'Changed' });
    expect(file('og.html')).toBe(OG.replace('<h1>x</h1>', '<h1>Changed</h1>'));
  });
});
