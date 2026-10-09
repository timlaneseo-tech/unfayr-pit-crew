import { describe, expect, it } from 'vitest';
import { hostOf, normaliseUrl, sectionOf, slugFor } from '../scripts/lib/urls.ts';

describe('normaliseUrl', () => {
  it('lowercases host, drops query, hash and trailing slash', () => {
    expect(normaliseUrl('https://Ex.com/a/?utm=1#x')).toBe('https://ex.com/a');
  });
  it('collapses index.html to the root', () => {
    expect(normaliseUrl('https://ex.com/index.html')).toBe('https://ex.com/');
  });
  it('treats /page, /page/ and /page?utm=x as one URL', () => {
    const a = normaliseUrl('https://ex.com/page');
    expect(normaliseUrl('https://ex.com/page/')).toBe(a);
    expect(normaliseUrl('https://ex.com/page?utm=x')).toBe(a);
  });
  it('keeps path case, lowercases host, drops query', () => {
    expect(normaliseUrl('https://ex.com/Page?utm=x')).toBe('https://ex.com/Page');
    expect(normaliseUrl('https://EX.com/Page?utm=x')).toBe('https://ex.com/Page');
  });
  it('keeps www as served', () => {
    expect(normaliseUrl('https://WWW.Ex.com/a')).toBe('https://www.ex.com/a');
  });
});

describe('sectionOf', () => {
  it('returns the first path segment with slashes', () => {
    expect(sectionOf('https://ex.com/products/a-b')).toBe('/products/');
  });
  it('returns / for the root', () => {
    expect(sectionOf('https://ex.com/')).toBe('/');
  });
  it('returns the first segment for a single top-level page', () => {
    expect(sectionOf('https://ex.com/about')).toBe('/about/');
  });
});

describe('slugFor and hostOf', () => {
  it('slugs paths', () => {
    expect(slugFor('https://x.com/blog/a-b/')).toBe('blog-a-b');
    expect(slugFor('https://x.com/')).toBe('index');
  });
  it('strips www from host', () => {
    expect(hostOf('https://WWW.Ex.com/a')).toBe('ex.com');
  });
});
