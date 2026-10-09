import he from 'he';

// Windows-1252 meanings for the C1 range, which browsers apply to numeric refs &#128;-&#159;.
const CP1252: Record<number, string> = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡',
  136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž',
  145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—',
  152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
};

/** Decode HTML entities (full HTML named set via `he`, numeric, and Windows-1252 numeric refs). */
export function decodeEntities(s: string): string {
  const pre = s.replace(/&#(?:(\d+)|[xX]([0-9a-fA-F]+));/g, (m, dec, hex) => {
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return CP1252[cp] ?? m;
  });
  return he.decode(pre);
}

/** Length in code points of plain text. Does not decode: pass plain text (decode raw HTML first). */
export function charLen(s: string): number {
  return [...s].length;
}

export const CLAIM_WORDS: string[] = ['award-winning', 'award winning', '#1', 'number one', 'best', 'best-rated', 'top-rated', 'top rated', 'certified', 'licensed', 'guaranteed', 'leading', 'trusted by',
  'free', 'same-day', 'same day', 'insured', 'bonded', 'warranty', 'money-back', 'lowest', 'cheapest', 'fastest', '24/7'];

/** "24/7" (and "24 / 7") is a claim, not the numbers 24 and 7. */
export const ROUND_THE_CLOCK = /(?<![\p{L}\p{N}])24\s*\/\s*7(?![\p{N}])/gu;

const ONES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD_NUM = `(?:(${Object.keys(TENS).join('|')})(?:[-\\s](${Object.keys(ONES).join('|')}))?|(${Object.keys(TEENS).join('|')})|(${Object.keys(ONES).join('|')}))`;
const MULT: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
const DIGITS = '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
const NUM_RE = new RegExp(`(${DIGITS})(?:\\s+(thousand|million|billion)\\b)?|\\b(?:${WORD_NUM}(?:\\s+(hundred|thousand|million|billion))?|(hundred|thousand|million|billion))\\b`, 'gi');

/** Numeric values in a string, normalised: "25+" is 25, "$1,200" is 1200, "4.9★" is 4.9, "twenty-five" is 25, "3 thousand" is 3000. */
export function numbersIn(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(NUM_RE)) {
    if (m[1] !== undefined) {
      let n = Number(m[1].replace(/,/g, ''));
      if (m[2]) n *= MULT[m[2].toLowerCase()]!;
      if (!Number.isNaN(n)) out.push(n);
      continue;
    }
    const [, , , tens, ones, teen, one, mult, bare] = m;
    let n = 0;
    if (tens) n = TENS[tens.toLowerCase()]! + (ones ? ONES[ones.toLowerCase()]! : 0);
    else if (teen) n = TEENS[teen.toLowerCase()]!;
    else if (one) n = ONES[one.toLowerCase()]!;
    const word = (mult ?? bare)?.toLowerCase();
    if (word) n = (n || 1) * MULT[word]!;
    out.push(n);
  }
  return out;
}

/*
 * Estimated rendered width of a Google desktop title (Arial 20px), in pixels.
 * Source: Arial's standard advance widths in 1/1000 em (Helvetica/Arial AFM metrics) scaled to 20px,
 * so 'a' = 556 -> 11.12px, 'i' = 222 -> 4.44px, 'W' = 944 -> 18.88px, space = 278 -> 5.56px.
 * It is an approximation: Google truncates by pixel width (about 580-600px on desktop) and the
 * exact font and kerning vary. Any non-ASCII code point counts as 11px and an emoji as 20px.
 */
const ARIAL_1000: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
};
// Emoji by default presentation, or any symbol followed by U+FE0F. Plain symbols such as (c), (R) and TM stay ordinary non-ASCII.
const EMOJI = /\p{Emoji_Presentation}/u;

export function titlePixels(s: string): number {
  let total = 0;
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '\u200d' || ch === '\ufe0f') continue; // zero-width joiner and variation selector add no width
    const w = ARIAL_1000[ch];
    if (w !== undefined) total += (w * 20) / 1000;
    else if (ch.charCodeAt(0) < 128) total += 11; // control characters and anything unlisted
    else total += EMOJI.test(ch) || chars[i + 1] === '\ufe0f' ? 20 : 11;
  }
  return Math.round(total * 100) / 100;
}
