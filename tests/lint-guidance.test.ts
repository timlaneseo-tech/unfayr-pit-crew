import { describe, it, expect } from 'vitest';
import { lintAll } from '../scripts/lib/lint.ts';
import { charLen, titlePixels } from '../scripts/lib/text.ts';
import type { Interview, PageRecord, Proposal } from '../scripts/lib/types.ts';

const interview: Interview = {
  brand: 'Ridgeline Plumbing',
  answers: [],
  convention: { separator: '|', brand: 'Ridgeline Plumbing', brandPosition: 'end-if-fits', case: 'title', patterns: {} },
  updatedAt: '2026-10-09',
};
const NOW = new Date('2026-06-01');
const mk = (path: string, over: Partial<PageRecord> = {}): PageRecord => ({
  url: `https://x.example${path}`, slug: path.slice(1) || 'home', type: 'service', title: 'Old', meta: null, h1s: [], h2s: [], intro: '', text: 'We fix pipes.',
  jsonLdTypes: [], altMissing: 0, altTotal: 0, cta: null, inlinks: 0, navLinked: false, ogTitle: null, ogDescription: null, ...over,
});
const mp = (path: string, proposed: Partial<Proposal['proposed']>, extra: Partial<Proposal> = {}): Proposal => ({
  url: `https://x.example${path}`, type: 'service', tier: 'top',
  current: { title: 'Old', meta: null, h1: null },
  proposed: { title: null, meta: null, h1: null, ...proposed },
  reason: '', sources: ['page'], issues: [], status: 'ok', approve: null, ...extra,
});
const rules = (r: Proposal) => r.issues.map((i) => i.rule);
const run1 = (x: Proposal, pg: PageRecord, now = NOW) => lintAll([x], new Map([[x.url, pg]]), interview, now)[0]!;

describe('titlePixels', () => {
  it('narrow letters are narrower than wide capitals', () => {
    expect(titlePixels('iiiiiiiiii')).toBeLessThan(titlePixels('WWWWWWWWWW'));
  });
  it('copyright and registered signs are plain non-ASCII (11), not emoji', () => {
    expect(titlePixels('©')).toBe(11);
    expect(titlePixels('®')).toBe(11);
    expect(titlePixels('™')).toBe(11);
  });
  it('non-ASCII is 11 and emoji is 20', () => {
    expect(titlePixels('é')).toBe(11);
    expect(titlePixels('\u{1F600}')).toBe(20);
  });
});

describe('title-pixels', () => {
  it('flags a 58-char all-caps title over 600 px', () => {
    const t = 'DRAIN CLEANING AND SEWER LINE REPAIR SERVICES IN BOISE ID.';
    expect(charLen(t)).toBe(58);
    expect(titlePixels(t)).toBeGreaterThan(600);
    const r = run1(mp('/drain', { title: t }), mk('/drain'));
    expect(rules(r)).toContain('title-pixels');
    // R5: title-pixels is a warning, shown in the workbook but not blocking.
    expect(r.status).toBe('ok');
  });
  it('passes a typical 55-char sentence-case title', () => {
    const t = 'Drain cleaning and sewer line repair in Boise, Idaho OK';
    expect(charLen(t)).toBe(55);
    expect(titlePixels(t)).toBeLessThanOrEqual(600);
    expect(rules(run1(mp('/drain', { title: t, h1: 'Drain cleaning and sewer line repair' }), mk('/drain')))).not.toContain('title-pixels');
  });
});

describe('title-h1-mismatch', () => {
  const T = 'Water heater repair in Boise | Ridgeline Plumbing';
  it('ok when the h1 says the same thing', () => {
    const r = run1(mp('/w', { title: T, h1: 'Water heater repair in Boise' }), mk('/w'));
    expect(rules(r)).not.toContain('title-h1-mismatch');
    expect(r.status).toBe('ok');
  });
  it('flags an h1 that says something else', () => {
    const r = run1(mp('/w', { title: T, h1: 'Welcome to our company' }), mk('/w'));
    expect(rules(r)).toContain('title-h1-mismatch');
    // R5: title-h1-mismatch is a warning.
    expect(r.status).toBe('ok');
  });
  it('uses the current h1 when none is proposed, and skips when there is no h1', () => {
    const bad = mp('/w', { title: T }, { current: { title: 'Old', meta: null, h1: 'Welcome to our company' } });
    expect(rules(run1(bad, mk('/w')))).toContain('title-h1-mismatch');
    expect(rules(run1(mp('/w', { title: T }), mk('/w')))).not.toContain('title-h1-mismatch');
  });
  it('light plural stemming: Drains matches drain', () => {
    const x = mp('/d', { title: 'Drain cleaning | Ridgeline Plumbing', h1: 'Drains and cleaning' });
    expect(rules(run1(x, mk('/d')))).not.toContain('title-h1-mismatch');
  });
  it('does not misfire on good rows (plumber/plumbing, brand in the H1, 24/7, type other)', () => {
    const ok = (path: string, title: string, h1: string, type: Proposal['type'] = 'service') =>
      rules(run1(mp(path, { title, h1 }, { type }), mk(path, { type })));
    expect(ok('/service-areas/nampa', 'Plumber in Nampa, ID | Ridgeline Plumbing', 'Plumbing service in Nampa', 'location')).not.toContain('title-h1-mismatch');
    expect(ok('/about', 'About our family plumbers in Boise | Ridgeline Plumbing', 'About Ridgeline Plumbing', 'other')).not.toContain('title-h1-mismatch');
    expect(ok('/emergency-plumbing', '24/7 Emergency plumber in Boise | Ridgeline Plumbing', 'Emergency plumbing, day or night')).not.toContain('title-h1-mismatch');
  });
  it('still flags a real mismatch', () => {
    expect(rules(run1(mp('/s', { title: 'Sewer line repair in Boise | Ridgeline Plumbing', h1: 'Our story and values' }), mk('/s')))).toContain('title-h1-mismatch');
  });
  it('the home page is exempt', () => {
    const x = mp('/', { title: 'Ridgeline Plumbing | Boise plumbers for homes and shops', h1: 'Welcome to our company' }, { type: 'home' });
    expect(rules(run1(x, mk('/', { type: 'home' })))).not.toContain('title-h1-mismatch');
  });
});

describe('near-duplicate', () => {
  const lintTwo = (a: Partial<Proposal['proposed']>, b: Partial<Proposal['proposed']>) => lintAll(
    [mp('/a', { title: 'Drain cleaning in Boise', h1: 'Drain cleaning in Boise', ...a }), mp('/b', { title: 'Sewer repair in Nampa', h1: 'Sewer repair in Nampa', ...b })],
    new Map([['https://x.example/a', mk('/a')], ['https://x.example/b', mk('/b')]]), interview, NOW);
  const M = (town: string) => `Drain cleaning in ${town} with upfront quotes and same-day service from licensed plumbers.`;
  it('flags both metas when only a mid-sentence town differs', () => {
    const out = lintTwo({ meta: M('Boise') }, { meta: M('Nampa') });
    expect(out.map((o) => rules(o).includes('near-duplicate'))).toEqual([true, true]);
    expect(out.every((o) => o.status === 'needs review')).toBe(true);
    expect(out.every((o) => !rules(o).includes('duplicate'))).toBe(true);
  });
  it('identical metas are duplicate only', () => {
    const out = lintTwo({ meta: M('Boise') }, { meta: M('Boise') });
    for (const o of out) { expect(rules(o)).toContain('duplicate'); expect(rules(o)).not.toContain('near-duplicate'); }
  });
  it('two genuinely different metas for related services are not flagged', () => {
    const out = lintTwo(
      { meta: 'Drain cleaning in Boise with upfront quotes and same-day service from licensed plumbers.' },
      { meta: 'Sewer camera inspections in Boise find roots, breaks and belly sections before they flood a basement. Book online.' });
    expect(out.some((o) => rules(o).includes('near-duplicate'))).toBe(false);
  });
  it('convention location titles that differ by town are not flagged', () => {
    const out = lintTwo({ title: 'Water heater repair in Boise | Ridgeline Plumbing', h1: 'Water heater repair in Boise' }, { title: 'Water heater repair in Nampa | Ridgeline Plumbing', h1: 'Water heater repair in Nampa' });
    expect(out.some((o) => rules(o).includes('near-duplicate'))).toBe(false);
  });
});

describe('stale-year', () => {
  it('flags a recent past year in the title', () => {
    const r = run1(mp('/t', { title: 'Best drain cleaning tips 2024' }), mk('/t', { text: 'Tips for drains. Best practice.' }));
    expect(rules(r)).toContain('stale-year');
  });
  it('flags a year in the meta', () => {
    const r = run1(mp('/t', { meta: 'Our 2023 guide to clearing a blocked drain at home, with the tools you need and when to call.' }), mk('/t'));
    expect(rules(r)).toContain('stale-year');
  });
  it('does not flag when the page says since/est./established in/founded in that year', () => {
    for (const phrase of ['since 2022', 'est. 2022', 'established in 2022', 'founded in 2022']) {
      const r = run1(mp('/t', { title: 'Serving Boise since 2022 | Ridgeline Plumbing' }), mk('/t', { text: `We are proud: ${phrase}.` }));
      expect(rules(r)).not.toContain('stale-year');
    }
  });
  it('does not flag old years, the current year or future years', () => {
    for (const y of ['1998', '2020', '2026', '2027']) {
      expect(rules(run1(mp('/t', { title: `Drain cleaning guide ${y}` }), mk('/t', { text: y })))).not.toContain('stale-year');
    }
  });
  it('a letter before since/est does not exempt (latest 2024)', () => {
    const r = run1(mp('/t', { title: 'Drain cleaning tips 2024' }), mk('/t', { text: 'See the latest 2024 notes.' }));
    expect(rules(r)).toContain('stale-year');
  });
  it('does not lint current values the writer did not propose', () => {
    const x = mp('/t', {}, { current: { title: 'Guide 2024', meta: null, h1: null } });
    expect(rules(run1(x, mk('/t')))).not.toContain('stale-year');
  });
  it('does not mutate its input', () => {
    const x = mp('/t', { title: 'Best drain cleaning tips 2024' });
    const copy = JSON.stringify(x);
    run1(x, mk('/t'));
    expect(JSON.stringify(x)).toBe(copy);
  });
});

describe('soft vs hard rules (R5)', () => {
  it('warn rules carry severity warn, everything else block', () => {
    const r = run1(mp('/w', { title: 'DRAIN CLEANING AND SEWER LINE REPAIR SERVICES IN BOISE ID.', h1: 'Welcome to our company', meta: 'x' }), mk('/w'));
    const sev = Object.fromEntries(r.issues.map((i) => [i.rule, i.severity]));
    expect(sev['title-pixels']).toBe('warn');
    expect(sev['title-h1-mismatch']).toBe('warn');
    expect(sev['meta-length']).toBe('block');
  });
  it('a row with only warnings is ok', () => {
    const r = run1(mp('/t', { title: 'Drain cleaning tips for Boise homes 2024', h1: 'Our story and values' }), mk('/t', { text: 'Drain tips, updated 2024.' }));
    expect(rules(r)).toEqual(expect.arrayContaining(['stale-year', 'title-h1-mismatch']));
    expect(r.issues.every((i) => i.severity === 'warn')).toBe(true);
    expect(r.status).toBe('ok');
  });
  it('a block issue still makes it needs review, and an [ADD] slot with only warnings is has [ADD]', () => {
    expect(run1(mp('/t', { title: 'Drain cleaning tips 2024', meta: 'too short' }), mk('/t')).status).toBe('needs review');
    expect(run1(mp('/t', { title: 'Drain cleaning tips 2024 [ADD: city]' }), mk('/t', { text: 'Drain tips, updated 2024.' })).status).toBe('has [ADD]');
  });
  it('near-duplicate metas alone are ok', () => {
    const lintTwo = lintAll(
      [mp('/a', { title: 'Drain cleaning in Boise | Ridgeline Plumbing', h1: 'Drain cleaning in Boise', meta: 'Drain cleaning in Boise with upfront quotes from plumbers who show up when they say they will.' }),
        mp('/b', { title: 'Sewer repair in Nampa | Ridgeline Plumbing', h1: 'Sewer repair in Nampa', meta: 'Drain cleaning in Nampa with upfront quotes from plumbers who show up when they say they will.' })],
      new Map([['https://x.example/a', mk('/a')], ['https://x.example/b', mk('/b')]]), interview, NOW);
    expect(lintTwo.every((o) => rules(o).includes('near-duplicate'))).toBe(true);
    expect(lintTwo.every((o) => o.status === 'ok')).toBe(true);
  });
});
