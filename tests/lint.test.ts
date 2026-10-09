import { describe, it, expect } from 'vitest';
import { lintAll } from '../scripts/lib/lint.ts';
import { numbersIn, CLAIM_WORDS, charLen } from '../scripts/lib/text.ts';
import type { Interview, PageRecord, Proposal } from '../scripts/lib/types.ts';

const URL_ = 'https://x.example/drain';
const page: PageRecord = { url: URL_, slug: 'drain', type: 'service', title: 'Drain Cleaning', meta: null, h1s: ['Drains'], h2s: [], intro: '', text: 'Serving Boise since 1998. 4.9 stars from 312 reviews.', jsonLdTypes: [], altMissing: 0, altTotal: 0, cta: null, inlinks: 0, navLinked: false, ogTitle: null, ogDescription: null };
const pages = new Map([[URL_, page]]);
const interview = (answers: string[] = [], patterns: Interview['convention']['patterns'] = {}): Interview => ({
  brand: 'Ridgeline Plumbing',
  answers: answers.map((a, i) => ({ id: 'q' + i, question: 'q', answer: a })),
  convention: { separator: '|', brand: 'Ridgeline Plumbing', brandPosition: 'end-if-fits', case: 'title', patterns },
  updatedAt: '2026-10-09',
});
const L = (n: number, c = 'a') => c.repeat(n);
const p = (over: Partial<Proposal['proposed']> = {}, extra: Partial<Proposal> = {}): Proposal => ({
  url: URL_, type: 'service', tier: 'top',
  current: { title: 'Drain Cleaning', meta: null, h1: 'Drain cleaning in Boise' },
  proposed: { title: 'Drain Cleaning in Boise since 1998', meta: null, h1: null, ...over },
  reason: '', sources: ['page'], issues: [], status: 'ok', approve: null, ...extra,
});
const rules = (r: Proposal) => r.issues.map((i) => i.rule);
const lint1 = (x: Proposal, iv = interview()) => lintAll([x], pages, iv)[0]!;

describe('lengths', () => {
  it.each([[29, true], [30, false], [60, false], [61, true]])('title %i flagged=%s', (n, bad) => {
    expect(rules(lint1(p({ title: L(n) }))).includes('title-length')).toBe(bad);
  });
  it.each([[69, true], [70, false], [155, false], [156, true]])('meta %i flagged=%s', (n, bad) => {
    expect(rules(lint1(p({ meta: L(n) }))).includes('meta-length')).toBe(bad);
  });
  it('measures plain text in code points (no decoding)', () => {
    const t = 'Tom & Jerry’s Pipe Repair ✓ in Boise';
    expect(charLen(t)).toBe(36);
    expect(rules(lint1(p({ title: t })))).not.toContain('title-length');
  });
  it('an emoji counts as one: 60 passes, 61 fails', () => {
    expect(rules(lint1(p({ title: '\u{1F600}' + L(59) })))).not.toContain('title-length');
    expect(rules(lint1(p({ title: '\u{1F600}' + L(60) })))).toContain('title-length');
  });
  it('skips null fields', () => {
    expect(lint1(p({ title: null })).issues).toEqual([]);
  });
});

describe('h1-count', () => {
  it('flags newline and <h1', () => {
    expect(rules(lint1(p({ h1: 'a\nb' })))).toContain('h1-count');
    expect(rules(lint1(p({ h1: '<h1>a</h1>' })))).toContain('h1-count');
    expect(rules(lint1(p({ h1: 'Fine' })))).not.toContain('h1-count');
  });
});

describe('duplicate', () => {
  it('flags same title case-insensitively after trim', () => {
    const t = 'Drain Cleaning in Boise since 1998';
    const out = lintAll([p({ title: t }), p({ title: '  ' + t.toUpperCase() + ' ' })], pages, interview());
    expect(out.every((o) => rules(o).includes('duplicate'))).toBe(true);
  });
  it('uses current title when proposed is null', () => {
    const a = p({ title: null }, { current: { title: 'Drain Cleaning in Boise since 1998', meta: null, h1: null } });
    const b = p({ title: 'drain cleaning in boise since 1998' });
    const out = lintAll([a, b], pages, interview());
    expect(rules(out[0]!)).toContain('duplicate');
    expect(rules(out[1]!)).toContain('duplicate');
  });
});

describe('convention', () => {
  const iv = interview([], { service: '{Service} in {City}' });
  it('flags service title not matching pattern', () => {
    expect(rules(lint1(p({ title: 'Drains around, whatever you need today' }), iv))).toContain('convention');
    expect(rules(lint1(p({ title: 'Drain Cleaning in Boise | Ridgeline Plumbing' }), iv))).not.toContain('convention');
  });
  it('never flags type other', () => {
    expect(rules(lint1(p({ title: 'Anything at all goes here, really' }, { type: 'other' }), iv))).not.toContain('convention');
  });
});

describe('numbersIn', () => {
  it('normalises', () => {
    expect(numbersIn('25+ years')).toEqual([25]);
    expect(numbersIn('twenty-five years')).toEqual([25]);
    expect(numbersIn('Twenty five')).toEqual([25]);
    expect(numbersIn('$1,200')).toEqual([1200]);
    expect(numbersIn('4.9★ and 312')).toEqual([4.9, 312]);
    expect(numbersIn('three thousand')).toEqual([3000]);
    expect(numbersIn('two hundred')).toEqual([200]);
  });
});

describe('unsourced-number', () => {
  const t = (s: string) => p({ title: s });
  it('passes numbers on the page', () => {
    expect(rules(lint1(t('Drain Cleaning in Boise since 1998')))).not.toContain('unsourced-number');
    expect(rules(lint1(t('Drain Cleaning rated 4.9★ in Boise')))).not.toContain('unsourced-number');
  });
  it('fails unsourced, passes with interview answer', () => {
    expect(rules(lint1(t('25+ years of drain cleaning in Boise')))).toContain('unsourced-number');
    expect(rules(lint1(t('Twenty-five years of drain cleaning')))).toContain('unsourced-number');
    expect(rules(lint1(t('25+ years of drain cleaning in Boise'), interview(['We have 25 years'])))).not.toContain('unsourced-number');
    expect(rules(lint1(t('Twenty-five years of drain cleaning'), interview(['25+ years'])))).not.toContain('unsourced-number');
    expect(rules(lint1(t('Drain cleaning from $1,200 in Boise')))).toContain('unsourced-number');
  });
  it('ignores numbers in the brand on both sides', () => {
    const iv = { ...interview(), brand: 'Route 66 Plumbing' };
    expect(rules(lint1(p({ title: 'Drain Cleaning in Boise | Route 66 Plumbing' }), iv))).not.toContain('unsourced-number');
  });
});

describe('unsourced-claim', () => {
  it('CLAIM_WORDS exact', () => {
    expect(CLAIM_WORDS).toEqual(['award-winning', 'award winning', '#1', 'number one', 'best', 'best-rated', 'top-rated', 'top rated', 'certified', 'licensed', 'guaranteed', 'leading', 'trusted by',
      'free', 'same-day', 'same day', 'insured', 'bonded', 'warranty', 'money-back', 'lowest', 'cheapest', 'fastest', '24/7']);
  });
  it.each(['free', 'same-day', 'same day', 'insured', 'bonded', 'warranty', 'money-back', 'lowest', 'cheapest', 'fastest', '24/7'])('M9: "%s" is a claim: unsourced flagged, sourced passes', (w) => {
    const title = `Drain cleaning in Boise, ${w} service`;
    const r = lint1(p({ title }));
    // "same day" and "same-day" match each other; the message names the first listed spelling.
    expect(r.issues.filter((i) => i.rule === 'unsourced-claim').map((i) => i.message).join(' ')).toContain(`"${w === 'same day' ? 'same-day' : w}"`);
    expect(rules(lint1(p({ title }), interview([`We offer ${w} visits`])))).not.toContain('unsourced-claim');
  });
  it('M9: 24/7 is a claim, not the numbers 24 and 7', () => {
    const r = lint1(p({ title: '24/7 drain cleaning in Boise, Idaho' }));
    expect(rules(r)).toContain('unsourced-claim');
    expect(rules(r)).not.toContain('unsourced-number');
    expect(rules(lint1(p({ title: '24/7 drain cleaning in Boise, Idaho' }), interview(['Open 24 / 7'])))).toEqual([]);
  });
  it('M9: freedom and bondedness are not claims (word boundaries)', () => {
    expect(rules(lint1(p({ title: 'Freedom from clogs in Boise, Idaho' })))).not.toContain('unsourced-claim');
  });
  it('flags award-winning unless award appears', () => {
    const x = p({ title: 'Award-winning plumbers in Boise, Idaho' });
    expect(rules(lint1(x))).toContain('unsourced-claim');
    expect(rules(lint1(x, interview(['We won an Award in 2020'])))).not.toContain('unsourced-claim');
  });
  it('is word-boundary aware and case-insensitive', () => {
    expect(rules(lint1(p({ title: 'Bestow drain care in Boise today' })))).not.toContain('unsourced-claim');
    expect(rules(lint1(p({ title: 'BEST drain cleaning in Boise today' })))).toContain('unsourced-claim');
    expect(rules(lint1(p({ title: '#1 drain cleaning in Boise today ok' })))).toContain('unsourced-claim');
  });
  it('sourced by the same claim word in corpus', () => {
    expect(rules(lint1(p({ title: 'Licensed drain cleaning in Boise, ID' }), interview(['We are licensed and bonded'])))).not.toContain('unsourced-claim');
  });
});

describe('claim compounds', () => {
  const claims = (title: string) => lint1(p({ title })).issues.filter((i) => i.rule === 'unsourced-claim').map((i) => i.message);
  it.each([
    ['Industry-leading drain cleaning in Boise, ID', 'leading'],
    ['Fully-licensed drain cleaning in Boise, ID', 'licensed'],
    ['EPA-certified drain cleaning in Boise, ID', 'certified'],
    ['Board-certified drain cleaning in Boise, ID', 'certified'],
    ['Best-in-class drain cleaning in Boise, ID', 'best'],
    ['Money-back-guaranteed drain cleaning in Boise', 'guaranteed'],
    ['Award‑winning drain cleaning in Boise, ID', 'award-winning'],
    ['Top‑rated drain cleaning in Boise, ID', 'top-rated'],
    ['Top–rated drain cleaning in Boise, ID', 'top-rated'],
  ])('flags %s', (title, w) => {
    expect(claims(title).some((m) => m.includes(`"${w}"`))).toBe(true);
  });
  it('reports only the longer claim', () => {
    expect(claims('Best-rated drain cleaning in Boise, ID')).toHaveLength(1);
    expect(claims('Best-rated drain cleaning in Boise, ID')[0]).toContain('"best-rated"');
  });
  it('does not flag bestseller or Bestow', () => {
    expect(claims('Bestseller drain cleaning in Boise, ID')).toEqual([]);
    expect(claims('Bestow drain cleaning in Boise, ID ok')).toEqual([]);
  });
});

describe('brand boundaries', () => {
  const iv = { ...interview(), brand: 'Ace Plumbing' };
  it('does not flag brand text inside other words', () => {
    expect(rules(lint1(p({ title: 'Faucet Replacement | Ace Plumbing' }), iv))).not.toContain('brand-spelling');
  });
  it('flags wrong case', () => {
    expect(rules(lint1(p({ title: 'Faucet Replacement | ACE plumbing' }), iv))).toContain('brand-spelling');
  });
});

describe('ADD slot text is not checked as copy', () => {
  it('[ADD: one detail] yields only add-slot', () => {
    const r = lint1(p({ title: 'Drain Cleaning in Boise [ADD: one detail]' }));
    expect(rules(r)).toEqual(['add-slot']);
    expect(r.status).toBe('has [ADD]');
  });
});

describe('numbersIn separators and multipliers', () => {
  it('handles thousands separators and multipliers', () => {
    expect(numbersIn('5,10')).toEqual([5, 10]);
    expect(numbersIn('$1,200')).toEqual([1200]);
    expect(numbersIn('1,200,000.5')).toEqual([1200000.5]);
    expect(numbersIn('3 thousand')).toEqual([3000]);
    expect(numbersIn('5 million')).toEqual([5000000]);
    expect(numbersIn('two billion')).toEqual([2e9]);
    expect(numbersIn('twenty-five thousand')).toEqual([25000]);
  });
});

describe('add-slot and status', () => {
  it('ok when clean', () => expect(lint1(p()).status).toBe('ok'));
  it('has [ADD] when only add-slot', () => {
    const r = lint1(p({ title: 'Drain Cleaning in [ADD: city] since 1998' }));
    expect(rules(r)).toEqual(['add-slot']);
    expect(r.status).toBe('has [ADD]');
  });
  it('length checks still run on ADD fields, giving needs review', () => {
    const r = lint1(p({ title: '[ADD: x]' }));
    expect(rules(r)).toEqual(expect.arrayContaining(['add-slot', 'title-length']));
    expect(r.status).toBe('needs review');
  });
});

describe('brand-spelling', () => {
  it('flags wrong casing', () => {
    expect(rules(lint1(p({ title: 'Drain Cleaning in Boise | RidgeLine Plumbing' })))).toContain('brand-spelling');
    expect(rules(lint1(p({ title: 'Drain Cleaning in Boise | Ridgeline Plumbing' })))).not.toContain('brand-spelling');
  });
});

describe('purity', () => {
  it('does not mutate inputs', () => {
    const x = p({ title: 'Award-winning plumbers in Boise, Idaho' });
    const snap = JSON.stringify(x);
    const out = lintAll([x], pages, interview());
    expect(JSON.stringify(x)).toBe(snap);
    expect(out[0]).not.toBe(x);
  });
});

describe('interview answers that apply to some page types (M10)', () => {
  const iv: Interview = {
    ...interview(),
    answers: [{ id: 'price', question: 'Starting price?', answer: 'Drain cleaning from $89', appliesTo: ['product', 'collection', 'service', 'location'] }],
  };
  it('a price answer sources a service page', () => {
    expect(rules(lint1(p({ meta: 'Drain cleaning in Boise from $89. Upfront quotes and plumbers who arrive when they say they will.' }), iv))).not.toContain('unsourced-number');
  });
  it('the same answer does not source an article', () => {
    const art = p({ meta: 'Drain cleaning in Boise from $89. Upfront quotes and plumbers who arrive when they say they will.' }, { type: 'article' });
    const pg = new Map([[URL_, { ...page, type: 'article' as const }]]);
    expect(rules(lintAll([art], pg, iv)[0]!)).toContain('unsourced-number');
  });
  it('an answer without appliesTo sources every page type', () => {
    const all: Interview = { ...iv, answers: [{ id: 'x', question: 'q', answer: 'Drain cleaning from $89' }] };
    const art = p({ meta: 'Drain cleaning in Boise from $89. Upfront quotes and plumbers who arrive when they say they will.' }, { type: 'article' });
    expect(rules(lintAll([art], new Map([[URL_, { ...page, type: 'article' as const }]]), all)[0]!)).not.toContain('unsourced-number');
  });
});
