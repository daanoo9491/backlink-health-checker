import { describe, expect, it } from 'vitest';
import { ImportError } from '../../src/client/import/backlink-import';
import { extractValues, importPastedText, PASTED_SHEET, TooManyLinksError } from '../../src/client/import/paste-import';

describe('extractValues', () => {
  it('reads one link per line, skipping blank lines and comments', () => {
    expect(extractValues('https://a.example.com/1\n\n  https://b.example.com/2  \r\n# note\n')).toEqual([
      'https://a.example.com/1',
      'https://b.example.com/2',
    ]);
  });

  it('finds several links on one line, e.g. copied from an email', () => {
    expect(extractValues('See https://a.example.com/x and www.b.example.com/y, thanks')).toEqual([
      'https://a.example.com/x',
      'www.b.example.com/y',
    ]);
  });

  it('drops sentence punctuation stuck to the end of a link, but keeps real brackets', () => {
    expect(extractValues('Live now: https://a.example.com/post.')).toEqual(['https://a.example.com/post']);
    expect(extractValues('(see https://a.example.com/post)')).toEqual(['https://a.example.com/post']);
    expect(extractValues('https://en.example.org/wiki/Foo_(bar)')).toEqual(['https://en.example.org/wiki/Foo_(bar)']);
  });

  it('keeps a line with no link so the preview can say why it was skipped', () => {
    expect(extractValues('not a link\nhttps://a.example.com')).toEqual(['not a link', 'https://a.example.com']);
  });
});

describe('importPastedText', () => {
  it('validates and de-duplicates exactly like an Excel upload', () => {
    const r = importPastedText(
      [
        'https://blog.example.com/post-1',
        'HTTPS://Blog.Example.com/post-1#comments',
        'www.directory.example.org/listing',
        'javascript:alert(1)',
        'http://localhost/admin',
      ].join('\n'),
      'Pasted links',
    );
    expect(r.fileName).toBe('Pasted links');
    expect(r.worksheets).toBe(1);
    expect(r.sheets.map((s) => [s.name, s.status])).toEqual([[PASTED_SHEET, 'used']]);
    expect(r.totals).toMatchObject({ rows: 5, valid: 3, invalid: 2, unique: 2, duplicates: 1, addedScheme: 1 });
    expect(r.rows[0]).toMatchObject({ sheet: PASTED_SHEET, rowNumber: 2, url: 'https://blog.example.com/post-1' });
    expect(r.rows[3]?.invalidReason).toBe('UNSUPPORTED_PROTOCOL');
    expect(r.rows[4]?.invalidReason).toBe('INTERNAL_ADDRESS');
    expect(r.headers).toEqual(['Backlinks']);
  });

  it('a single pasted link is enough', () => {
    const r = importPastedText('https://medium.com/@lanop/post', 'x');
    expect(r.uniqueUrls).toEqual(['https://medium.com/@lanop/post']);
  });

  it('explains when nothing useful was pasted', () => {
    expect(() => importPastedText('   \n\n', 'x')).toThrow(ImportError);
    expect(() => importPastedText('hello\nworld', 'x')).toThrow(ImportError);
  });

  it('refuses more links than one scan can hold', () => {
    const many = Array.from({ length: 20_001 }, (_, i) => `https://s${i}.example.com/`).join('\n');
    expect(() => importPastedText(many, 'x')).toThrow(TooManyLinksError);
  });
});
