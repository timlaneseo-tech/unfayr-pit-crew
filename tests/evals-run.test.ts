import { describe, expect, it } from 'vitest';
import { renderReport, resolveClaude } from '../evals/run.ts';

describe('renderReport', () => {
  const base = { headline: 'A claim.', sections: ['## Fixture: x', ''], model: 'sonnet', noSlots: true, realSite: false };

  it('ends with the credit line and carries both caveat bullets', () => {
    const md = renderReport(base);
    expect(md).toContain('\nBuilt by Unfayr · unfayr.com\n');
    expect(md).toContain('- Convention match is only counted for page types that have a pattern in the naming convention.');
    expect(md).toContain('- No row in either arm used an [ADD] slot, so this benchmark does not test slot honesty.');
    expect(md).toContain('**A claim.**');
  });

  it('names the write-page skill commit the run used (M13)', () => {
    const md = renderReport({ ...base, skillCommit: 'abc1234' });
    expect(md).toContain('write-page skill at commit `abc1234`');
    expect(renderReport({ ...base, skillCommit: 'abc1234', skillDirty: true })).toContain('plus uncommitted edits');
  });

  it('leaves out the slot caveat when a slot was used and the real-site caveat when a real site ran', () => {
    const md = renderReport({ ...base, noSlots: false, realSite: true });
    expect(md).not.toContain('does not test slot honesty');
    expect(md).not.toContain('No real-site arm');
    expect(md).toContain('Built by Unfayr · unfayr.com');
  });
});

describe('resolveClaude', () => {
  const where = String.raw`C:\Users\a\npm\claude.cmd` + '\r\n';
  it('uses plain claude off Windows', () => {
    expect(resolveClaude('linux', '', () => false)).toBe('claude');
  });
  it('finds the native exe beside the cmd shim on Windows', () => {
    const exe = resolveClaude('win32', where, (f) => f.endsWith('claude.exe'));
    expect(exe).toBe(String.raw`C:\Users\a\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`);
  });
  it('throws on Windows when the exe or the shim is missing, with no shell fallback', () => {
    expect(() => resolveClaude('win32', where, () => false)).toThrow(/claude\.exe/);
    expect(() => resolveClaude('win32', '', () => true)).toThrow(/claude\.exe/);
  });
});
