import { describe, it, expect } from 'vitest';
import { parseSections } from '../scripts/lib/args.ts';

describe('parseSections (--include)', () => {
  it('accepts section names with or without slashes, normalised to /<name>/', () => {
    expect(parseSections('collections,pages')).toEqual(['/collections/', '/pages/']);
    expect(parseSections('/collections/,/pages/')).toEqual(['/collections/', '/pages/']);
    expect(parseSections('collections/, /pages')).toEqual(['/collections/', '/pages/']);
    expect(parseSections('/collections/')).toEqual(['/collections/']);
    expect(parseSections('collections/')).toEqual(['/collections/']);
    expect(parseSections('blogs/news')).toEqual(['/blogs/news/']);
  });

  it('recovers the exact string Git Bash (MSYS) hands node for --include /collections/,/pages/', () => {
    expect(parseSections('C:/Program Files/Git/collections/,/pages/')).toEqual(['/collections/', '/pages/']);
    expect(parseSections('C:/Program Files/Git/collections/')).toEqual(['/collections/']);
    expect(parseSections('C:\\Program Files\\Git\\collections\\')).toEqual(['/collections/']);
    expect(parseSections('c:/program files/git/blogs/news/')).toEqual(['/blogs/news/']);
    expect(parseSections('C:/Users/someone/AppData/Local/Programs/Git/collections/')).toEqual(['/collections/']);
    expect(parseSections('D:/Tools/PortableGit/pages/')).toEqual(['/pages/']);
    // A section that is itself called "git" survives.
    expect(parseSections('C:/Program Files/Git/git/')).toEqual(['/git/']);
  });

  it('drops empty entries and duplicates', () => {
    expect(parseSections('collections,,collections/, ')).toEqual(['/collections/']);
  });

  it('throws a clear error naming an unrecoverable Windows path entry and suggesting the slashless form', () => {
    expect(() => parseSections('C:/Users/someone/collections/')).toThrow(/"C:\/Users\/someone\/collections\/".*--include collections,pages/s);
  });

  it('throws when nothing is left to include', () => {
    expect(() => parseSections(' , / ')).toThrow(/--include collections,pages/);
  });
});
