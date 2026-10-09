import { describe, it, expect } from 'vitest';
import { decodeEntities, charLen } from '../scripts/lib/text.ts';

describe('text', () => {
  it('counts code points after decoding', () => {
    expect(charLen(decodeEntities('Tom &amp; Jerry’s ✓'))).toBe(15);
  });
  it('charLen counts plain text without decoding', () => {
    expect(charLen('Tom & Jerry')).toBe(11);
    expect(charLen('&amp;')).toBe(5);
    expect(charLen('😀')).toBe(1);
  });
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('a&nbsp;b &#8217; &#x2019; &eacute; &bogus;')).toBe('a b ’ ’ é &bogus;');
    expect(charLen(decodeEntities('&#128512;'))).toBe(1);
  });
  it('decodes the wider entity set and windows-1252 numeric refs', () => {
    expect(decodeEntities('&raquo;')).toBe('»');
    expect(decodeEntities('&laquo; &sect; &szlig; &ecirc; &ensp;&emsp;&thinsp;')).toBe('« § ß ê    ');
    expect(decodeEntities('&#146;')).toBe('’');
    expect(decodeEntities('&#128;')).toBe('€');
    expect(decodeEntities('&Eacute;')).toBe('É');
  });
});
