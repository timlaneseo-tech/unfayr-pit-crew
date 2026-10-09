// Build the standalone public repo tree for Pit Crew (github.com/timlaneseo-tech/unfayr-pit-crew).
// Usage: node tools/export_public.ts OUT_DIR
// OUT_DIR becomes the repo root: the plugin root is the repo root, with .claude-plugin/plugin.json in it.
// Existing files in OUT_DIR are replaced, except .git/. The "unfayr" marketplace lives in the unfayr-ref repo
// and points at this repo, so no marketplace file is written here.
// The export never pushes, tags or releases anything.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
/** Top-level entries that make up the public repo. Everything else (docs/, .superpowers/, sites/, ...) stays private. */
export const INCLUDE = [
  '.claude-plugin', 'commands', 'skills', 'scripts', 'assets', 'fixtures', 'tests', 'evals', 'tools',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
  'LICENSE', 'README.md', 'SETUP.md', 'CHANGELOG.md', '.gitignore',
];
/** Folders left out wherever they appear inside an included entry. */
const SKIP_NESTED = new Set(['node_modules', '.check', '.git', 'sites']);
export const GITATTRIBUTES = '* text=auto eol=lf\n*.png binary\n*.ico binary\n*.xlsx binary\n';

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const sep_ = (p: string) => (p.endsWith(sep) ? p : p + sep);

export function exportPublic(srcDir: string, outDir: string): void {
  const src = resolve(srcDir);
  const out = resolve(outDir);
  const s = sep_(norm(src));
  const o = sep_(norm(out));
  if (o.startsWith(s) || s.startsWith(o)) {
    throw new Error('The output folder must not be the source folder, inside it, or a folder that contains it.');
  }

  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(out)) {
    if (name === '.git') continue;
    rmSync(join(out, name), { recursive: true, force: true });
  }

  for (const name of INCLUDE) {
    const from = join(src, name);
    if (!existsSync(from)) continue;
    cpSync(from, join(out, name), {
      recursive: true,
      filter: (p) => !relative(src, p).split(sep).some((part) => SKIP_NESTED.has(part)),
    });
  }
  writeFileSync(join(out, '.gitattributes'), GITATTRIBUTES, 'utf8');
}

if (process.argv[1] && basename(process.argv[1]) === 'export_public.ts') {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('Usage: node tools/export_public.ts OUT_DIR');
    process.exit(2);
  }
  exportPublic(fileURLToPath(new URL('..', import.meta.url)), outDir);
  console.log(`Exported Pit Crew ${VERSION} to ${outDir}`);
}
