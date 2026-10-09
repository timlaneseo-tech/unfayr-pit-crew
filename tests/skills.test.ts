import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SKILLS = join(ROOT, 'skills');
const skillNames = ['pitcrew-run', 'interview', 'research', 'write-page', 'publish'];
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const SUBCOMMANDS = [
  'crawl', 'conventions', 'top', 'batches', 'merge', 'workbook', 'approvals', 'publish-plan', 'publish-apply',
  'rollback', 'wp-csv', 'interview-save', 'credentials-save', 'mark', 'status',
];
const PAGE_TYPES = ['home', 'service', 'location', 'product', 'collection', 'article'];

function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function allMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) out.push(...allMarkdown(f));
    else if (n.endsWith('.md')) out.push(f);
  }
  return out;
}

describe('skills and command files', () => {
  it('every SKILL.md has name and description matching its folder', () => {
    for (const n of skillNames) {
      const f = join(SKILLS, n, 'SKILL.md');
      expect(existsSync(f), f).toBe(true);
      const fm = frontmatter(readFileSync(f, 'utf8'));
      expect(fm.name, n).toBe(n);
      expect((fm.description ?? '').length, n).toBeGreaterThan(40);
    }
  });

  it('the command has a description and an argument hint', () => {
    const fm = frontmatter(read('commands', 'pitcrew.md'));
    expect(fm.description).toBeTruthy();
    expect(fm['argument-hint']).toBeTruthy();
  });

  it('every pitcrew.ts <sub> mentioned is a real subcommand, and the skills mention the main ones', () => {
    const files = [...allMarkdown(SKILLS), join(ROOT, 'commands', 'pitcrew.md')];
    const seen = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/pitcrew\.ts"?\s+([A-Za-z][\w-]*)/g)) {
        seen.add(m[1]!);
        expect(SUBCOMMANDS, `${f}: ${m[1]}`).toContain(m[1]);
      }
    }
    for (const s of SUBCOMMANDS) expect(seen.has(s), `no skill mentions pitcrew.ts ${s}`).toBe(true);
  });

  it('skills call the CLI through the plugin root', () => {
    for (const f of allMarkdown(SKILLS)) {
      const text = readFileSync(f, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (/pitcrew\.ts"?\s+[a-z]/.test(line)) expect(line, f).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts');
      }
    }
  });

  it('pitcrew-run lists the 10 run steps in spec order', () => {
    const text = read('skills', 'pitcrew-run', 'SKILL.md');
    const names = ['Crawl', 'Extract', 'Platform', 'Site readout', 'Interview', 'Research', 'Write', 'Lint', 'Workbook', 'Offer to publish'];
    let last = -1;
    names.forEach((n, i) => {
      const at = text.search(new RegExp(`^## Step ${i + 1}\\. ${n}`, 'm'));
      expect(at, `Step ${i + 1} ${n}`).toBeGreaterThan(last);
      last = at;
    });
  });

  it('publish carries the safety phrases', () => {
    const text = read('skills', 'publish', 'SKILL.md');
    expect(text).toContain('explicit yes');
    expect(text.toLowerCase()).toContain('never publish');
    expect(text).toContain('--include-renaming-h1');
    expect(text).toContain('--kinds');
  });

  it('assist mode requires approvals and an explicit yes per batch', () => {
    const text = read('skills', 'publish', 'SKILL.md');
    const assist = text.slice(text.indexOf('### Any other platform: assist mode'), text.indexOf('## Step 3.'));
    expect(assist).toContain('explicit yes');
    expect(assist).toContain('approvals');
    expect(assist).toContain('best effort');
  });

  it('sample row names interview-save and answers.json, and git is narrowed', () => {
    const cmd = read('commands', 'pitcrew.md');
    const row = cmd.split(/\r?\n/).find((l) => l.includes('--sample <fixture>'))!;
    expect(row).toContain('interview-save');
    expect(row).toContain('answers.json');
    const tools = frontmatter(cmd)['allowed-tools']!;
    expect(tools).not.toContain('Bash(git *)');
    expect(tools).toContain('diff');
  });

  it('question-bank has a section for every page type except other, and for All sites', () => {
    const text = read('skills', 'interview', 'references', 'question-bank.md');
    expect(text).toMatch(/^## All sites/m);
    for (const t of PAGE_TYPES) expect(text, t).toMatch(new RegExp(`^## ${t}\\b`, 'mi'));
    expect(text).not.toMatch(/^## other\b/mi);
  });

  it('user-facing copy has no exclamation marks and carries the credit line', () => {
    for (const f of allMarkdown(SKILLS).concat(join(ROOT, 'commands', 'pitcrew.md'))) {
      const text = readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '');
      expect(text, f).not.toMatch(/!(?=\s|$)/m);
    }
    expect(read('skills', 'pitcrew-run', 'SKILL.md')).toContain('Built by Unfayr · unfayr.com');
  });

  it('write-page carries the AI-citation rules and leaves formatting tricks out', () => {
    const text = read('skills', 'write-page', 'SKILL.md');
    expect(text.toLowerCase()).toContain('price');
    expect(text).toContain('citationFacts');
    expect(text.toLowerCase()).toContain('formatting');
    expect(read('skills', 'research', 'SKILL.md').toLowerCase()).toContain('never copy competitor facts');
  });

  it('interview saves the price answer with appliesTo product, collection, service and location (M10)', () => {
    const text = read('skills', 'interview', 'SKILL.md');
    expect(text).toContain('"appliesTo": ["product", "collection", "service", "location"]');
    expect(text).toContain('appliesTo');
  });

  it('write-page and README say warnings show in the workbook but do not block publishing (R5), and list the claim words (M9)', () => {
    const wp = read('skills', 'write-page', 'SKILL.md');
    expect(wp).toMatch(/[Ww]arnings? .*workbook.*(do not|don't|never) block/);
    for (const w of ['free', 'same-day', 'insured', 'bonded', 'warranty', 'money-back', 'lowest', 'cheapest', 'fastest', '24/7']) expect(wp, w).toContain(`\`${w}\``);
    const readme = read('README.md');
    expect(readme).toMatch(/[Ww]arnings? .*workbook.*(do not|don't|never) block/);
    expect(readme).toContain('24/7');
  });

  it('the run skill resumes from status and handles a truncated include crawl (I5, I6, M15)', () => {
    const text = read('skills', 'pitcrew-run', 'SKILL.md');
    const resume = text.slice(text.indexOf('## Resume'));
    expect(resume).toContain('pitcrew.ts" status');
    expect(resume.toLowerCase()).toContain('instead of crawling again');
    expect(text).toContain('truncatedTo');
    expect(text).toContain('only if a newer run exists');
  });

  it('docs: install omits dev deps, sample mode says its rewrites are pre-written, assist mode names no backup file, git says not deployed yet (M12, M14, T14, T13)', () => {
    expect(read('commands', 'pitcrew.md')).toContain('npm install --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"');
    const readme = read('README.md');
    expect(readme).toMatch(/three runtime dependencies \(exceljs, he and node-html-parser\)/);
    const tryIt = readme.slice(readme.indexOf('## Try it'), readme.indexOf('## Install'));
    expect(tryIt.toLowerCase()).toContain('pre-written');
    const pub = read('skills', 'publish', 'SKILL.md');
    const assist = pub.slice(pub.indexOf('### Any other platform: assist mode'), pub.indexOf('## Step 3.'));
    expect(assist.toLowerCase()).not.toContain('backup');
    expect(assist).toContain("workbook's current columns");
    const rb = pub.slice(pub.indexOf('## Rollback'));
    expect(rb.slice(rb.indexOf('Assist-mode')).toLowerCase()).not.toContain('backup file');
    expect(pub).toContain('not deployed yet');
    for (const r of ['live-unreadable', 'unsupported', 'excluded']) expect(pub, r).toContain(r);
  });

  it('question-bank has the optional price question', () => {
    const text = read('skills', 'interview', 'references', 'question-bank.md');
    expect(text).toContain("Is there a starting price or typical price range you're happy to show?");
    for (const sec of ['Service', 'Product']) {
      const body = text.split(/^## /m).find((b) => b.startsWith(sec))!;
      expect(body, sec).toContain('starting price or typical price range');
    }
  });
});

describe('Git Bash slash rewriting in the docs', () => {
  it('sections are passed slashless and page addresses in full, with the reason', () => {
    const run = read('skills', 'pitcrew-run', 'SKILL.md');
    expect(run).toContain('--include collections,pages');
    expect(run).toMatch(/Git Bash/);
    const cmd = read('commands', 'pitcrew.md');
    expect(cmd).toMatch(/Git Bash/);
    expect(cmd).toContain('collections,pages');
    for (const s of ['publish', 'research']) expect(read('skills', s, 'SKILL.md'), s).toMatch(/Git Bash/);
    expect(read('skills', 'publish', 'SKILL.md')).toContain('--url <full page address');
  });
});

describe('publish skill explains no-access skips', () => {
  it('names the reason, the warnings line and the Shopify scope fix', () => {
    const text = read('skills', 'publish', 'SKILL.md');
    expect(text).toContain('`no-access`');
    expect(text).toContain('`warnings`');
    expect(text).toContain('read_online_store_pages');
    const setup = read('SETUP.md');
    for (const s of ['read_online_store_pages', 'read_content', 'read_products']) expect(setup).toContain(s);
  });
});

describe('run skill relays crawl warnings', () => {
  it('mentions warnings in step 1', () => {
    const text = read('skills', 'pitcrew-run', 'SKILL.md');
    const step1 = text.slice(text.indexOf('## Step 1'), text.indexOf('## Step 2'));
    expect(step1).toContain('`warnings`');
  });
});
