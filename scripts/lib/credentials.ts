import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths.ts';
import type { Platform } from './types.ts';
import { hostOf } from './urls.ts';

type Store = Record<string, Record<string, object>>;

const file = () => join(configDir(), 'credentials.json');
function keyOf(hostOrUrl: string): string {
  const k = hostOf(hostOrUrl.includes('://') ? hostOrUrl : `https://${hostOrUrl}`);
  if (!k) throw new Error('Cannot work out a host from the value given for the credential store.');
  return k;
}

function read(): Store {
  if (!existsSync(file())) return {};
  try { return JSON.parse(readFileSync(file(), 'utf8')) as Store; } catch {
    throw new Error(`credentials.json is not valid JSON, so it was left untouched. Fix or remove it: ${file()}`);
  }
}

export function getCredential<T>(host: string, platform: Platform): T | null {
  return (read()[keyOf(host)]?.[platform] as T | undefined) ?? null;
}

/** Stores a publish credential. Never logs values; file is 0600 where the OS supports it. */
export function setCredential(host: string, platform: Platform, value: object): void {
  const store = read();
  const key = keyOf(host);
  store[key] = { ...store[key], [platform]: value };
  mkdirSync(configDir(), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
  renameSync(tmp, file());
}

/**
 * Where a JSON text first goes wrong, as a 1-based line and character, or null when it parses.
 * Hand-rolled so the error never quotes the text: a credentials file holds secrets, and the engine's own messages echo a snippet.
 */
export function jsonErrorAt(text: string): { line: number; char: number } | null {
  let i = 0;
  const ws = () => { while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i++; };
  const bad = (): never => { throw i; };
  const lit = (w: string) => { if (text.startsWith(w, i)) i += w.length; else bad(); };
  const str = () => {
    if (text[i] !== '"') bad();
    i++;
    while (i < text.length && text[i] !== '"') {
      const c = text.charCodeAt(i);
      if (c < 0x20) bad();
      if (text[i] === '\\') {
        i++;
        if (text[i] === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) bad(); i += 5; continue; }
        if (!'"\\/bfnrt'.includes(text[i] ?? 'x')) bad();
      }
      i++;
    }
    if (i >= text.length) bad();
    i++;
  };
  const num = () => { const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i)); if (!m) bad(); i += m![0].length; };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) { ws(); str(); ws(); if (text[i] !== ':') bad(); i++; value(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return; } bad(); }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) { value(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return; } bad(); }
    }
    if (c === '"') return str();
    if (c === 't') return lit('true');
    if (c === 'f') return lit('false');
    if (c === 'n') return lit('null');
    return num();
  };
  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    value(); ws();
    if (i < text.length) bad();
    return null;
  } catch (e) {
    const at = typeof e === 'number' ? Math.min(e, text.length) : 0;
    const before = text.slice(0, at).split('\n');
    return { line: before.length, char: before[before.length - 1]!.length + 1 };
  }
}
