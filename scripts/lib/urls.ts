/**
 * `/page`, `/page/`, `/Page?utm=x` and `/page#top` are one page to the owner. Every stage
 * (crawl, duplicates, workbook read-back, adapter resolve) keys on this form.
 * The host is lowercased; `www.` is kept as served.
 */
export function normaliseUrl(url: string): string {
  try {
    const u = new URL(url); // URL already lowercases the host
    u.hash = '';
    u.search = '';
    // /default.asp, /index.html and friends are the home page wearing a different URL.
    u.pathname = u.pathname.replace(/\/(?:default|index)\.(?:html?|php|aspx?)$/i, '/');
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return url.replace(/[?#].*$/, '').replace(/(.)\/+$/, '$1');
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** File-safe name for a page: `https://x/blog/a-b/` -> `blog-a-b`, root -> `index`. */
export function slugFor(url: string): string {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    path = url;
  }
  const slug = path
    .toLowerCase()
    .replace(/\.(html?|php|aspx?)$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'index').slice(0, 80);
}

/** First path segment with slashes: `/products/`, or `/` for the root. */
export function sectionOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const first = path.split('/').filter(Boolean)[0];
  return first ? `/${first.toLowerCase()}/` : '/';
}
