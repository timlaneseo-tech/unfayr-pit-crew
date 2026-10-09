import { describe, it, expect } from 'vitest';
import { detectPlatform } from '../scripts/lib/platform.ts';

describe('detectPlatform', () => {
  it.each([
    ['<link href="https://cdn.shopify.com/s/x.css">', 'shopify'],
    ['<img src="/wp-content/uploads/a.png">', 'wordpress'],
    ['<html data-wf-site="abc">', 'webflow'],
    ['<img src="https://static.wixstatic.com/a.png">', 'wix'],
    ['<img src="https://static1.squarespace.com/a.png">', 'squarespace'],
    ['<html></html>', 'unknown'],
  ])('%s -> %s', (html, want) => {
    expect(detectPlatform(html)).toBe(want);
  });
});
