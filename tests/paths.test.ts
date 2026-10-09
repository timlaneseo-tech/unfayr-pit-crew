import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configDir, homeDir, runDir, siteDir } from '../scripts/lib/paths.ts';

const saved = { h: process.env.PITCREW_HOME, c: process.env.PITCREW_CONFIG_DIR };
afterEach(() => {
  if (saved.h === undefined) delete process.env.PITCREW_HOME; else process.env.PITCREW_HOME = saved.h;
  if (saved.c === undefined) delete process.env.PITCREW_CONFIG_DIR; else process.env.PITCREW_CONFIG_DIR = saved.c;
});

describe('paths', () => {
  it('homeDir honours PITCREW_HOME', () => {
    process.env.PITCREW_HOME = join('x', 'home');
    expect(homeDir()).toBe(join('x', 'home'));
  });
  it('homeDir defaults to Documents/Pit Crew', () => {
    delete process.env.PITCREW_HOME;
    expect(homeDir().endsWith(join('Documents', 'Pit Crew'))).toBe(true);
  });
  it('configDir honours PITCREW_CONFIG_DIR', () => {
    process.env.PITCREW_CONFIG_DIR = join('x', 'cfg');
    expect(configDir()).toBe(join('x', 'cfg'));
  });
  it('siteDir and runDir nest under home', () => {
    process.env.PITCREW_HOME = 'h';
    expect(siteDir('ex.com')).toBe(join('h', 'sites', 'ex.com'));
    expect(runDir('ex.com', '2026-10-09')).toBe(join('h', 'sites', 'ex.com', 'runs', '2026-10-09'));
  });
});
