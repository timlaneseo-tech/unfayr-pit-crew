/**
 * Minimal flag parser so the scripts need no CLI dependency.
 * `--site example.com --sample --date 2026-10-07 extra` gives
 * flags { site: 'example.com', sample: true, date: '2026-10-07' } and positional ['extra'].
 * A flag followed by another flag, or by nothing, is boolean true.
 */
export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

const SECTIONS_HINT = 'Pass section names without slashes, for example --include collections,pages.';
/**
 * Git Bash (MSYS) rewrites a slash-leading argument into a Windows path under its install folder, so
 * `--include /collections/,/pages/` reaches node as `C:/Program Files/Git/collections/,/pages/`. This is the part
 * after that install folder (a folder named Git, PortableGit or msys64), or null when the path is something else.
 */
const MSYS_ROOT = /^[A-Za-z]:[\\/](?:[^,]*?[\\/])?(?:[^\\/]*git|msys(?:32|64)?)[\\/](.*)$/i;

/**
 * Parses `--include` into path sections such as `/collections/`. Each entry may be written `collections`,
 * `collections/`, `/collections/` or as the MSYS-mangled Windows path; an entry that is a Windows path Pit Crew
 * cannot map back throws, naming it.
 */
export function parseSections(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    let s = piece.trim();
    if (/^[A-Za-z]:[\\/]/.test(s)) {
      const m = MSYS_ROOT.exec(s);
      if (!m) throw new Error(`"${s}" in --include is a Windows path, not a site section (Git Bash turns a leading / into one). ${SECTIONS_HINT}`);
      s = m[1]! || '/';
    }
    const slashed = s.replace(/\\/g, '/');
    s = slashed.replace(/^\/+|\/+$/g, '');
    if (!s && !/^\/+$/.test(slashed)) continue;
    // home, root and a lone / all mean the site root.
    const section = !s || /^(home|root)$/i.test(s) ? '/' : `/${s}/`;
    if (!out.includes(section)) out.push(section);
  }
  if (!out.length) throw new Error(`--include names no sections. ${SECTIONS_HINT}`);
  return out;
}
