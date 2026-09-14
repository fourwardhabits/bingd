import { cell, parseCsv } from './csv';

/**
 * Every case here is a row shape the founder's real export does **not** contain, which is
 * the reason the file exists: that export has no commas in titles, no quoted fields and no
 * embedded newlines, so a `split(',')` parser would pass every test written against it and
 * corrupt the first real library it met.
 */

describe('quoting', () => {
  it('keeps a comma inside a quoted field', () => {
    // The canonical case. Without quote handling this row has five fields, `Year` becomes
    // ` Hidden Dragon"`, and every later column shifts — silently.
    const doc = parseCsv('Name,Year\n"Crouching Tiger, Hidden Dragon",2000\n');

    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]!.cells.Name).toBe('Crouching Tiger, Hidden Dragon');
    expect(doc.rows[0]!.cells.Year).toBe('2000');
    expect(doc.rows[0]!.ragged).toBe(false);
  });

  it('reads "" as one literal quote', () => {
    const doc = parseCsv('Name\n"The ""Burbs"\n');
    expect(doc.rows[0]!.cells.Name).toBe('The "Burbs');
  });

  it('keeps a newline inside a quoted field', () => {
    const doc = parseCsv('Name,Year\n"Two\nLines",1999\n');
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]!.cells.Name).toBe('Two\nLines');
    expect(doc.rows[0]!.cells.Year).toBe('1999');
  });

  it('reads an empty quoted field as empty', () => {
    const doc = parseCsv('Name,Tags\nShrek,""\n');
    expect(doc.rows[0]!.cells.Tags).toBe('');
  });

  it('treats a quote in the middle of an unquoted field as a literal', () => {
    // A spreadsheet does this, and refusing the row would lose a film over punctuation.
    const doc = parseCsv('Name\n12"" Inches\n');
    expect(doc.rows[0]!.cells.Name).toBe('12"" Inches');
  });
});

describe('line endings and the byte order mark', () => {
  it('reads CRLF', () => {
    const doc = parseCsv('Name,Year\r\nShrek,2001\r\n');
    expect(doc.headers).toEqual(['Name', 'Year']);
    expect(doc.rows[0]!.cells.Year).toBe('2001');
  });

  it('strips a UTF-8 BOM from the first header rather than naming a column "\\uFEFFDate"', () => {
    const doc = parseCsv('﻿Date,Name\n2026-09-11,Shrek\n');
    expect(doc.headers).toEqual(['Date', 'Name']);
    expect(doc.rows[0]!.cells.Name).toBe('Shrek');
  });

  it('reads a final row with no trailing newline', () => {
    const doc = parseCsv('Name,Year\nShrek,2001');
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]!.cells.Year).toBe('2001');
  });

  it('does not invent a row from a trailing newline', () => {
    expect(parseCsv('Name\nShrek\n').rows).toHaveLength(1);
  });

  it('skips blank lines between rows', () => {
    expect(parseCsv('Name\nShrek\n\nBarbie\n').rows).toHaveLength(2);
  });
});

describe('a file with nothing in it', () => {
  it('reads a header-only file as zero rows, not as a failure', () => {
    // Half the files in a real export are header-only — reviews, comments, every likes
    // file, both deleted files. Treating that as an error would refuse valid exports.
    const doc = parseCsv('Date,Name,Year,Letterboxd URI\n');
    expect(doc.headers).toHaveLength(4);
    expect(doc.rows).toEqual([]);
  });

  it('reads an empty string as no headers and no rows', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [], unterminated: false });
  });
});

describe('rows that do not match the header', () => {
  it('flags a short row and leaves the missing column absent', () => {
    const doc = parseCsv('Name,Year,Rating\nShrek,2001\n');
    expect(doc.rows[0]!.ragged).toBe(true);
    expect(doc.rows[0]!.cells.Year).toBe('2001');
    expect(doc.rows[0]!.cells.Rating).toBeUndefined();
  });

  it('flags a long row and does not surface the extra field', () => {
    const doc = parseCsv('Name,Year\nShrek,2001,extra\n');
    expect(doc.rows[0]!.ragged).toBe(true);
    expect(Object.keys(doc.rows[0]!.cells)).toEqual(['Name', 'Year']);
  });

  it('never throws on a ragged file', () => {
    expect(() => parseCsv('Name,Year\n,,,,\nShrek\n"unterminated\n')).not.toThrow();
  });
});

describe('an unterminated quote', () => {
  it('is reported, because the rows it destroyed cannot be counted', () => {
    // One stray `"` absorbs the rest of the file into a single field. Three films become
    // one row, that row looks perfectly well-formed, and without this flag nothing
    // anywhere can tell that anything was lost.
    const doc = parseCsv('Name,Year\n"Shrek,2001\nBarbie,2023\nOdyssey,2026\n');

    expect(doc.unterminated).toBe(true);
    expect(doc.rows).toHaveLength(1);
  });

  it('is false for an ordinary file', () => {
    expect(parseCsv('Name,Year\nShrek,2001\n').unterminated).toBe(false);
  });

  it('is false for a correctly closed quoted field', () => {
    expect(parseCsv('Name,Year\n"Shrek, The",2001\n').unterminated).toBe(false);
  });
});

describe('addressing columns by name', () => {
  it('survives a column being inserted', () => {
    // The whole reason `cells` is a record. A positional read of `Year` would return the
    // new column's value here and nothing would fail.
    const doc = parseCsv('Name,Country,Year\nShrek,US,2001\n');
    expect(doc.rows[0]!.cells.Year).toBe('2001');
  });

  it('ignores a nameless header column', () => {
    const doc = parseCsv('Name,,Year\nShrek,x,2001\n');
    expect(Object.keys(doc.rows[0]!.cells)).toEqual(['Name', 'Year']);
  });
});

describe('cell', () => {
  const row = parseCsv('Name,Tags,Year\n  Shrek  ,   ,2001\n').rows[0]!;

  it('trims', () => expect(cell(row, 'Name')).toBe('Shrek'));
  it('reads a whitespace-only cell as null', () => expect(cell(row, 'Tags')).toBeNull());
  it('reads an absent column as null', () => expect(cell(row, 'Rating')).toBeNull());
});
