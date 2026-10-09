import type { Platform } from './types.ts';

export function detectPlatform(html: string, headers: Record<string, string> = {}): Platform {
  const h = Object.entries(headers).map(([k, v]) => `${k.toLowerCase()}: ${v}`).join('\n').toLowerCase();
  if (html.includes('cdn.shopify.com') || /x-shopify|x-shardid/.test(h)) return 'shopify';
  if (html.includes('/wp-content/') || html.includes('/wp-includes/') || /x-pingback|wp-json/.test(h)) return 'wordpress';
  if (html.includes('data-wf-site')) return 'webflow';
  if (html.includes('static.wixstatic.com')) return 'wix';
  if (html.includes('static1.squarespace.com')) return 'squarespace';
  return 'unknown';
}
