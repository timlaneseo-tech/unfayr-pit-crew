import { describe, it, expect } from 'vitest';
import { extractPage } from '../scripts/lib/extract.ts';

describe('extract: open graph', () => {
  const g = { inlinks: new Map<string, number>(), nav: new Set<string>() };
  it('captures og:title and og:description, decoded', () => {
    const html = '<html><head><title>T</title><meta property="og:title" content="Tom &amp; Jerry&#39;s  Pipes"><meta property="og:description" content="Fast &amp; clean"></head><body><h1>x</h1></body></html>';
    const r = extractPage('https://x.example/a', html, g);
    expect(r.ogTitle).toBe("Tom & Jerry's Pipes");
    expect(r.ogDescription).toBe('Fast & clean');
  });
  it('is null when absent or empty', () => {
    const r = extractPage('https://x.example/a', '<html><head><title>T</title><meta property="og:title" content=" "></head><body></body></html>', g);
    expect(r.ogTitle).toBeNull();
    expect(r.ogDescription).toBeNull();
  });
});
