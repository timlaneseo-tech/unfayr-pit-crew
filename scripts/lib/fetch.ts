import { execFile } from 'node:child_process';

export const USER_AGENT = 'pitcrew/1.0 (+https://github.com/timlaneseo-tech/unfayr-pit-crew; reads your pages to suggest titles)';

export interface CurlResult {
  status: number;
  contentType: string;
  body: string;
}

/** Fetches a URL with curl; resolves null when curl is not installed or cannot run. */
export type CurlImpl = (url: string, userAgent: string, timeoutMs: number) => Promise<CurlResult | null>;

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  curlImpl?: CurlImpl;
  /** Keep the body whatever the content type (robots.txt is sometimes served as application/octet-stream). */
  anyType?: boolean;
}

export interface RawResponse {
  status: number | null;
  type: string;
  body: string;
  error?: string;
  /** URL after redirects, when the transport reported it. */
  finalUrl?: string;
  /** Response headers, lowercased names. */
  headers?: Record<string, string>;
}

const CURL_MARK = '\n__pitcrew_curl__';

export const curlFetch: CurlImpl = (url, userAgent, timeoutMs) =>
  new Promise((done) => {
    const args = ['-sL', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-A', userAgent, '-H', 'accept: text/html,application/xhtml+xml', '-w', `${CURL_MARK}%{http_code} %{content_type}`, url];
    execFile('curl', args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const i = stdout ? stdout.lastIndexOf(CURL_MARK) : -1;
      if (i < 0) return done(null);
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return done(null);
      const [code, ...type] = stdout.slice(i + CURL_MARK.length).trim().split(' ');
      const status = Number(code);
      done(status ? { status, contentType: type.join(' '), body: stdout.slice(0, i) } : null);
    });
  });

/**
 * Some CDNs refuse Node's fetch with a 403 by its TLS fingerprint while serving curl the
 * same page, user agent unchanged. A 403 is therefore retried once with curl; every other
 * status is taken as the site's answer.
 */
export async function fetchRaw(url: string, opts: FetchOptions = {}): Promise<RawResponse> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const userAgent = opts.userAgent ?? USER_AGENT;
  const f = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml' },
    });
    if (res.status === 403) {
      clearTimeout(timer);
      const c = await (opts.curlImpl ?? curlFetch)(url, userAgent, timeoutMs);
      if (c && c.status !== 403) return { status: c.status, type: c.contentType, body: c.body };
      return { status: 403, type: '', body: '' };
    }
    const type = res.headers.get('content-type') ?? '';
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, type, body: res.ok && (opts.anyType || /html|xml|text\/plain/i.test(type)) ? await res.text() : '', finalUrl: res.url || url, headers };
  } catch (e) {
    const error = e instanceof Error ? (e.name === 'AbortError' ? `Timed out after ${timeoutMs / 1000}s` : e.message) : String(e);
    return { status: null, type: '', body: '', error };
  } finally {
    clearTimeout(timer);
  }
}

/** The page's HTML as served. */
export async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<{ status: number | null; html: string; error?: string }> {
  const r = await fetchRaw(url, opts);
  if (r.status === null) return { status: null, html: '', error: r.error };
  if (r.status < 200 || r.status > 299) return { status: r.status, html: '', error: `HTTP ${r.status}` };
  return { status: r.status, html: r.body };
}
