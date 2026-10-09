import { describe, expect, it } from 'vitest';
import { openCommand } from '../scripts/lib/open.ts';

describe('openCommand', () => {
  const f = 'C:\\Users\\Me\\Documents\\Pit Crew\\Pit Crew - x.com - 2026-01-01.xlsx';
  it('keeps a spaced path as one argument on every platform', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      const { args } = openCommand(f, p);
      expect(args[args.length - 1]).toBe(f);
    }
  });
  it('uses start with an empty title on Windows, without pre-quoted strings', () => {
    expect(openCommand(f, 'win32')).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', f] });
    expect(openCommand(f, 'darwin').cmd).toBe('open');
    expect(openCommand(f, 'linux').cmd).toBe('xdg-open');
  });
});
