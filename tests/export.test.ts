import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GITATTRIBUTES, exportPublic } from '../tools/export_public.ts';

let tmp: string;
let src: string;
let out: string;

function put(base: string, rel: string, body = 'x'): void {
  const f = join(base, rel);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, body, 'utf8');
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pitcrew-export-'));
  src = join(tmp, 'src');
  out = join(tmp, 'out');
  for (const f of [
    'README.md', 'SETUP.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
    '.claude-plugin/plugin.json', 'commands/pitcrew.md', 'skills/write-page/SKILL.md',
    'scripts/pitcrew.ts', 'fixtures/a/x.html', 'assets/logo.svg', 'evals/run.ts', 'evals/benchmarks/b.md', 'evals/benchmarks/b.raw.json',
    'tests/a.test.ts', 'tools/export_public.ts',
    'docs/spec.md', 'sites/s/run.json', 'node_modules/m/i.js', '.check/c.json', 'scripts/node_modules/n.js',
    '.git/HEAD', '.superpowers/sdd/x.md', 'notes.txt',
  ]) put(src, f);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('exportPublic', () => {
  it('writes the plugin at the repo root and leaves out private folders', () => {
    exportPublic(src, out);
    for (const f of ['README.md', 'SETUP.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
      '.claude-plugin/plugin.json', 'commands/pitcrew.md', 'skills/write-page/SKILL.md', 'scripts/pitcrew.ts', 'fixtures/a/x.html', 'assets/logo.svg',
      'evals/run.ts', 'evals/benchmarks/b.md', 'evals/benchmarks/b.raw.json', 'tests/a.test.ts', 'tools/export_public.ts']) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    for (const d of ['docs', 'sites', 'node_modules', '.check', '.git', '.superpowers', 'notes.txt', 'plugins', 'scripts/node_modules']) {
      expect(existsSync(join(out, d)), d).toBe(false);
    }
  });

  it('writes .gitattributes and no marketplace file', () => {
    exportPublic(src, out);
    expect(readFileSync(join(out, '.gitattributes'), 'utf8')).toBe(GITATTRIBUTES);
    expect(GITATTRIBUTES).toMatch(/\* text=auto eol=lf/);
    expect(existsSync(join(out, '.claude-plugin', 'marketplace.json'))).toBe(false);
  });

  it('replaces existing files but keeps .git', () => {
    put(out, '.git/HEAD', 'keep');
    put(out, 'stale.txt', 'stale');
    put(out, 'commands/old.md', 'stale');
    put(out, 'README.md', 'old');
    exportPublic(src, out);
    expect(readFileSync(join(out, '.git', 'HEAD'), 'utf8')).toBe('keep');
    expect(existsSync(join(out, 'stale.txt'))).toBe(false);
    expect(existsSync(join(out, 'commands', 'old.md'))).toBe(false);
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toBe('x');
  });

  it('refuses to export into the source folder or a folder inside it', () => {
    expect(() => exportPublic(src, src)).toThrow(/source/i);
    expect(() => exportPublic(src, join(src, 'out'))).toThrow(/source/i);
  });

  it('refuses when the output folder contains the source, however the path is cased', () => {
    expect(() => exportPublic(src, tmp)).toThrow(/contains it/i);
    if (process.platform === 'win32') expect(() => exportPublic(src, src.toUpperCase())).toThrow(/source/i);
  });
});
