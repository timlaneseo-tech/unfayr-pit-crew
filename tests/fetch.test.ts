import { describe, expect, it } from 'vitest';
import { fetchHtml, fetchRaw, USER_AGENT } from '../scripts/lib/fetch.ts';

const html = (status: number, body = '<html></html>') =>
  (async () => new Response(body, { status, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;

describe('fetchRaw', () => {
  it('retries a 403 with curl and resolves the curl status', async () => {
    const r = await fetchRaw('https://ex.com/', {
      fetchImpl: html(403, ''),
      curlImpl: async () => ({ status: 200, contentType: 'text/html', body: '<p>ok</p>' }),
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('<p>ok</p>');
  });
  it('stays 403 when curl is unavailable', async () => {
    const r = await fetchRaw('https://ex.com/', { fetchImpl: html(403, ''), curlImpl: async () => null });
    expect(r.status).toBe(403);
  });
  it('reports network errors', async () => {
    const r = await fetchRaw('https://ex.com/', { fetchImpl: (async () => { throw new Error('boom'); }) as unknown as typeof fetch });
    expect(r.status).toBeNull();
    expect(r.error).toBe('boom');
  });
  it('sends the Pit Crew user agent', () => {
    expect(USER_AGENT.startsWith('pitcrew/1.0')).toBe(true);
  });
});

describe('fetchHtml', () => {
  it('returns html on 200', async () => {
    expect((await fetchHtml('https://ex.com/', { fetchImpl: html(200, '<b>x</b>') })).html).toBe('<b>x</b>');
  });
});
