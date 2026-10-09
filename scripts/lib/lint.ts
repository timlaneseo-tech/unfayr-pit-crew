import type { Field, Interview, LintIssue, LintRule, LintSeverity, PageRecord, PageType, Proposal } from './types.ts';
import { CLAIM_WORDS, ROUND_THE_CLOCK, charLen, numbersIn, titlePixels } from './text.ts';
import { patternRegex } from './conventions.ts';

const FIELDS: Field[] = ['title', 'meta', 'h1'];
const LIMITS = { title: [30, 60], meta: [70, 155] } as const;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string) => s.trim().toLowerCase();
const MAX_TITLE_PIXELS = 600;
const NEAR_DUP = 0.8;
/** R5: these rules are advice. They show in the workbook but do not stop a row from being published. */
const WARN_RULES = new Set<LintRule>(['title-pixels', 'near-duplicate', 'title-h1-mismatch', 'stale-year']);
export const severityOf = (rule: LintRule): LintSeverity => (WARN_RULES.has(rule) ? 'warn' : 'block');

/** M10: interview answers that may source copy on a page of this type (an answer with no appliesTo counts everywhere). */
function answersFor(interview: Interview, type: PageType | undefined): string[] {
  return interview.answers
    .filter((a) => !a.appliesTo || (type !== undefined && a.appliesTo.includes(type)))
    .map((a) => a.answer).filter((a): a is string => !!a);
}

/** Numbers in s, with "24/7" left out (it is a claim, not two numbers). */
const numbersOf = (s: string) => numbersIn(s.replace(ROUND_THE_CLOCK, ' '));

const STOPWORDS = new Set('a an and are as at be by for from how in is it of on or our the to we what when where which who why with you your'.split(' '));

/** Light stemmer: strips ing, ers, er, es or s (and then a final e) while the stem stays at least 4 letters, so plumber, plumbers and plumbing meet at "plumb". */
function stem(w: string): string {
  for (const suf of ['ing', 'ers', 'er', 'es', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) { w = w.slice(0, -suf.length); break; }
  }
  return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w;
}

/** Content words: lowercase, punctuation stripped, stopwords, pure numbers and tokens under 3 characters dropped, then stemmed. */
function contentWords(s: string): string[] {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\p{N}+$/u.test(w)).map(stem);
}

/** Word 3-shingles of a string (lowercase, punctuation stripped). Fewer than 3 words gives the one shingle of all of them. */
function shingles(s: string): Set<string> {
  const w = s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (w.length < 3) { if (w.length) out.add(w.join(' ')); return out; }
  for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(' '));
  return out;
}

/** The set of distinct words (lowercase, punctuation stripped). */
function wordSet(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const LB = '(?<![\\p{L}\\p{N}])';
const RB = '(?![\\p{L}\\p{N}])';
const brandRe = (brand: string) => new RegExp(`${LB}${esc(brand)}${RB}`, 'giu');

function stripBrand(s: string, brand: string): string {
  return brand ? s.replace(brandRe(brand), ' ') : s;
}

/** Remove [ADD: ...] slot text so it is not checked as copy. */
const stripSlots = (s: string) => s.replace(/\[ADD:[^\]]*(?:\]|$)/g, ' ');

const normDashes = (s: string) => s.replace(/[‐‑–—]/g, '-');

function claimRe(word: string): RegExp {
  if (word === '#1') return /(?<![\p{L}\p{N}#])#1(?!\d)/gu;
  if (word === '24/7') return new RegExp(ROUND_THE_CLOCK.source, 'gu');
  const body = word.split(/[\s-]+/).map(esc).join('[\\s-]+');
  return new RegExp(`${LB}${body}${RB}`, 'giu');
}

/** Claim words found in s. Unless `all`, a claim inside a longer listed claim (best in best-rated) is not reported. */
function claimsIn(s: string, all = false): string[] {
  const text = normDashes(s);
  const hits: { w: string; a: number; b: number }[] = [];
  for (const w of CLAIM_WORDS) for (const m of text.matchAll(claimRe(w))) hits.push({ w, a: m.index!, b: m.index! + m[0].length });
  const kept = hits.filter((h, i) => all || !hits.some((o, j) => j !== i && o.a <= h.a && o.b >= h.b && (o.b - o.a > h.b - h.a || (o.b - o.a === h.b - h.a && j < i))));
  return [...new Set(kept.map((h) => h.w))];
}

/** Years from the last five (not the current one) that the page does not itself claim as a founding or start year. */
function staleYears(v: string, pageText: string, year: number): number[] {
  const out = new Set<number>();
  for (const m of stripSlots(v).matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)) {
    const y = Number(m[1]);
    if (y < year - 5 || y >= year) continue;
    if (new RegExp(`(?<!\\p{L})(?:since|est\\.?|established in|founded in)\\s+${y}(?!\\d)`, 'iu').test(pageText)) continue;
    out.add(y);
  }
  return [...out];
}

/** True when text has a number or claim word that neither the page nor the interview answers back (an [ADD: ...] slot is ignored). */
export function unsourcedIn(text: string, page: PageRecord | undefined, interview: Interview): boolean {
  const brand = interview.brand;
  const answers = answersFor(interview, page?.type);
  const corpus = [page?.text ?? '', page?.title ?? '', page?.meta ?? '', ...(page?.h1s ?? []), ...(page?.h2s ?? []), ...answers].join('\n');
  const nums = new Set(numbersOf(stripBrand(corpus, brand)));
  const lower = corpus.toLowerCase();
  const claims = new Set(claimsIn(corpus, true));
  const body = stripSlots(text);
  if (numbersOf(stripBrand(body, brand)).some((n) => !nums.has(n))) return true;
  return claimsIn(body).some((w) => !(w === 'award-winning' || w === 'award winning' ? lower.includes('award') : claims.has(w)));
}

/**
 * Code-enforced rules: lengths, duplicates, convention, and never-invent (numbers, claims).
 * Proposals are plain text (not decoded here). Returns copies; inputs are not mutated.
 */
export function lintAll(proposals: Proposal[], pages: Map<string, PageRecord>, interview: Interview, now: Date = new Date()): Proposal[] {
  const year = now.getFullYear();
  const brand = interview.brand;

  const effective = (p: Proposal, f: 'title' | 'meta') => {
    const v = p.proposed[f] ?? p.current[f];
    return v && norm(v) ? norm(v) : null;
  };
  const dupCount = { title: new Map<string, number>(), meta: new Map<string, number>() };
  for (const p of proposals) {
    for (const f of ['title', 'meta'] as const) {
      const k = effective(p, f);
      if (k) dupCount[f].set(k, (dupCount[f].get(k) ?? 0) + 1);
    }
  }

  // Near-duplicates: effective values that are not identical but overlap by 80% or more.
  // Metas compare their word sets (a one-word swap in a short meta must count). Titles are short and share a pattern,
  // so they compare word 3-shingles of the title with the brand removed, which leaves "X in Boise" vs "X in Nampa" alone.
  const nearDup = { title: new Set<number>(), meta: new Set<number>() };
  for (const f of ['title', 'meta'] as const) {
    const items = proposals.map((p, i) => ({ i, k: effective(p, f) })).filter((x): x is { i: number; k: string } => x.k !== null)
      .map((x) => ({ ...x, sh: f === 'meta' ? wordSet(x.k) : shingles(stripBrand(x.k, brand.toLowerCase())) }));
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        const x = items[a]!, y = items[b]!;
        if (x.k === y.k || x.sh.size === 0 || y.sh.size === 0) continue;
        if (Math.min(x.sh.size, y.sh.size) / Math.max(x.sh.size, y.sh.size) < NEAR_DUP) continue;
        if (jaccard(x.sh, y.sh) >= NEAR_DUP) { nearDup[f].add(x.i); nearDup[f].add(y.i); }
      }
    }
  }

  return proposals.map((p, idx) => {
    const page = pages.get(p.url);
    const answers = answersFor(interview, p.type);
    const corpus = [page?.text ?? '', page?.title ?? '', page?.meta ?? '', ...(page?.h1s ?? []), ...(page?.h2s ?? []), ...answers].join('\n');
    const corpusNums = new Set(numbersOf(stripBrand(corpus, brand)));
    const corpusLower = corpus.toLowerCase();
    const pageText = page?.text ?? '';
    const corpusClaims = new Set(claimsIn(corpus, true));

    const issues: LintIssue[] = [];
    const add = (rule: LintRule, field: Field, message: string) => issues.push({ rule, field, message, severity: severityOf(rule) });

    for (const f of FIELDS) {
      const v = p.proposed[f];
      if (v === null) continue;
      if (f === 'h1') {
        if (/[\r\n]/.test(v) || /<h1/i.test(v)) add('h1-count', f, 'The h1 must be a single heading, with no line breaks or <h1> tags.');
      } else {
        const [min, max] = LIMITS[f];
        const n = charLen(v);
        if (n < min || n > max) add(f === 'title' ? 'title-length' : 'meta-length', f, `The ${f} is ${n} characters; keep it between ${min} and ${max}.`);
        if (f === 'title') {
          const px = Math.round(titlePixels(stripSlots(v)));
          if (px > MAX_TITLE_PIXELS) add('title-pixels', f, `The title is about ${px} px wide; Google cuts titles off near ${MAX_TITLE_PIXELS} px, so shorten it or use fewer capitals.`);
        }
        for (const y of staleYears(v, pageText, year)) add('stale-year', f, `The ${f} mentions ${y}, which will look out of date; drop the year unless the page is about it.`);
      }
      if (v.includes('[ADD:')) add('add-slot', f, `The ${f} has an [ADD: ...] slot to fill in.`);
      if (brand) {
        for (const m of v.matchAll(brandRe(brand))) {
          if (m[0] !== brand) { add('brand-spelling', f, `The brand is spelled "${m[0]}"; it should be "${brand}".`); break; }
        }
      }
      const body = stripSlots(v);
      const seen = new Set<number>();
      for (const n of numbersOf(stripBrand(body, brand))) {
        if (!corpusNums.has(n) && !seen.has(n)) {
          seen.add(n);
          add('unsourced-number', f, `The number ${n} is not on the page or in the interview answers.`);
        }
      }
      for (const w of claimsIn(body)) {
        const sourced = w === 'award-winning' || w === 'award winning' ? corpusLower.includes('award') : corpusClaims.has(w);
        if (!sourced) add('unsourced-claim', f, `"${w}" is not backed by the page or the interview answers.`);
      }
    }

    if (p.proposed.title !== null) {
      const re = patternRegex(interview.convention, p.type);
      if (re && !re.test(p.proposed.title)) add('convention', 'title', `The title does not follow the pattern "${interview.convention.patterns[p.type]}".`);
    }
    for (const f of ['title', 'meta'] as const) {
      const k = effective(p, f);
      if (k && (dupCount[f].get(k) ?? 0) > 1) add('duplicate', f, `Another page uses the same ${f}.`);
      else if (nearDup[f].has(idx)) add('near-duplicate', f, `Another page's ${f} is almost the same; say what differs on this page.`);
    }
    const effTitle = p.proposed.title ?? p.current.title;
    const effH1 = p.proposed.h1 ?? p.current.h1;
    if (p.type !== 'home' && p.type !== 'other' && effTitle && effH1) {
      const core = contentWords(stripBrand(stripSlots(effTitle), brand));
      const h1w = new Set(contentWords(stripBrand(stripSlots(effH1), brand)));
      if (core.length && core.filter((w) => h1w.has(w)).length * 2 < core.length) add('title-h1-mismatch', 'title', 'The title and the H1 say different things; Google and AI answers lean on the main heading, so make the H1 say the same thing in plainer words.');
    }

    // R5: warnings never change the status. No blocking issue: ok. Only [ADD] slots block: has [ADD]. Anything else: needs review.
    const blocks = issues.filter((i) => i.severity === 'block');
    const status = blocks.length === 0 ? 'ok' : blocks.every((i) => i.rule === 'add-slot') ? 'has [ADD]' : 'needs review';
    return { ...p, issues, status };
  });
}
