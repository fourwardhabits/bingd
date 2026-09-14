/**
 * A CSV reader for Letterboxd exports, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN `split(',')`
 *
 * The founder's real export contains no title with a comma in it, which is exactly the
 * reason a naive parser would survive every test written against that file and then
 * corrupt a real library on the first import. Letterboxd quotes any field containing a
 * comma, a quote or a newline — *Crouching Tiger, Hidden Dragon* arrives as
 * `"Crouching Tiger, Hidden Dragon"` — and a split on commas turns that one film into two
 * fields, shifts every later column left, and produces a row whose `Year` is
 * ` Hidden Dragon"`. Nothing throws. The row is simply wrong.
 *
 * So this is a real RFC 4180 reader: quoted fields, `""` as an escaped quote, embedded
 * commas and newlines, CRLF or LF, and a UTF-8 BOM on the first header cell.
 *
 * ---------------------------------------------------------------------------
 * COLUMNS ARE ADDRESSED BY NAME, ALWAYS
 *
 * `rows()` returns records keyed by header, not tuples. Letterboxd has changed its export
 * columns before and will again; a positional read is a silent misalignment the day a
 * column is inserted, and every consumer in this feature would have to be re-checked by
 * hand to notice. A missing column is then a `null` at the one call site that wanted it,
 * which is a condition the normaliser can count and report.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER THROWS ON CONTENT
 *
 * A ragged row — more or fewer fields than the header — is a fact about one line, not a
 * reason to abandon somebody's library. Ragged rows are returned with a flag, `normalise`
 * counts them into `malformed`, and the job carries on: it completes and says how many
 * rows it could not read.
 *
 * The one damage it cannot count row by row is an **unterminated quote**, because the rows
 * it destroyed no longer exist to be counted. That is reported per file instead, as
 * `unterminated` — see the field.
 */

/** One parsed record: header name to raw cell value, plus where it came from. */
export type CsvRow = {
  /** Cell values by header name. Absent headers are simply not keys. */
  readonly cells: Readonly<Record<string, string>>;
  /** 1-based line number of the row's first character, for diagnostics only. */
  readonly line: number;
  /** True when the field count did not match the header count. */
  readonly ragged: boolean;
};

export type CsvDocument = {
  /** Header names in file order, trimmed, BOM stripped. Empty for an empty file. */
  readonly headers: readonly string[];
  readonly rows: readonly CsvRow[];
  /**
   * True when the file ended inside an open quote.
   *
   * **This is the quiet catastrophe a CSV reader has to report.** One stray `"` on line 40
   * of a 2,500-row file makes every remaining line part of one enormous field: the reader
   * returns 39 rows, none of them malformed by any per-row test, and the person is told
   * their import succeeded. Nothing else in the pipeline can notice, because there is
   * nothing left to notice — the rows are gone, not broken.
   *
   * So it is surfaced here and counted by `normalise`, which is the only place that knows
   * the file was supposed to have more in it.
   */
  readonly unterminated: boolean;
};

/** U+FEFF, which Letterboxd may or may not emit and which must never become part of a header name. */
const BOM = '﻿';

/**
 * Splits a CSV document into rows of raw fields.
 *
 * Written as an explicit state machine rather than a regex. A regex that handles quoted
 * fields containing newlines is both unreadable and, in every form short enough to be
 * reviewed, wrong on at least one of: a quote at the end of a field, an empty quoted
 * field, or a final row with no trailing newline.
 */
function splitRecords(text: string): {
  records: { fields: string[]; line: number }[];
  unterminated: boolean;
} {
  const records: { fields: string[]; line: number }[] = [];

  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  // A record exists as soon as any character of it has been seen, which is what tells a
  // trailing newline (no final record) apart from a final row with no newline (one).
  let started = false;

  const endField = () => {
    fields.push(field);
    field = '';
  };

  const endRecord = () => {
    endField();
    records.push({ fields, line: recordLine });
    fields = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (!started) {
      recordLine = line;
      started = true;
    }

    if (inQuotes) {
      if (ch === '"') {
        // `""` inside a quoted field is one literal quote. Anything else ends the quoting.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      // Only opens quoting at the start of a field. A quote in the middle of an unquoted
      // field is a literal, which is what a spreadsheet does and what Letterboxd's own
      // reader tolerates.
      if (field.length === 0) inQuotes = true;
      else field += ch;
      continue;
    }

    if (ch === ',') {
      endField();
      continue;
    }

    if (ch === '\r') {
      // CRLF, or a lone CR. Either ends the record; the LF is consumed with it.
      if (text[i + 1] === '\n') i += 1;
      line += 1;
      endRecord();
      continue;
    }

    if (ch === '\n') {
      line += 1;
      endRecord();
      continue;
    }

    field += ch;
  }

  // A final record with no trailing newline. `started` is false after `endRecord`, so a
  // file that ends in a newline does not produce a phantom empty row here.
  if (started || field.length > 0 || fields.length > 0) endRecord();

  // Still quoting when the input ran out: everything after the opening quote was absorbed
  // into one field, and however many rows that was is unknowable from here.
  return { records, unterminated: inQuotes };
}

/** True for a record that carries nothing at all — a blank line between rows. */
const isBlank = (fields: readonly string[]) =>
  fields.length === 0 || (fields.length === 1 && fields[0]!.trim() === '');

/**
 * Parses a whole CSV document.
 *
 * An empty document, or one with only a header, is a document with zero rows — **not an
 * error**. Half the files in a real Letterboxd export are header-only (the founder's
 * `reviews.csv`, `comments.csv`, every `likes/` file and both `deleted/` files all are),
 * and a parser that treated that as a failure would refuse most valid exports.
 */
export function parseCsv(text: string): CsvDocument {
  const { records, unterminated } = splitRecords(text.startsWith(BOM) ? text.slice(1) : text);
  if (records.length === 0) return { headers: [], rows: [], unterminated };

  const headerRecord = records[0]!;
  if (isBlank(headerRecord.fields)) return { headers: [], rows: [], unterminated };

  const headers = headerRecord.fields.map((h) => h.trim());

  const rows: CsvRow[] = [];
  for (let r = 1; r < records.length; r += 1) {
    const record = records[r]!;
    if (isBlank(record.fields)) continue;

    const cells: Record<string, string> = {};
    // Headers drive the read, so a row with extra trailing fields simply does not surface
    // them, and a short row leaves the missing names absent rather than undefined-valued.
    for (let c = 0; c < headers.length; c += 1) {
      const name = headers[c]!;
      if (name === '') continue;
      const value = record.fields[c];
      if (value !== undefined) cells[name] = value;
    }

    rows.push({
      cells,
      line: record.line,
      ragged: record.fields.length !== headers.length,
    });
  }

  return { headers, rows, unterminated };
}

/**
 * One cell, trimmed, or null when the column is absent or empty.
 *
 * Null rather than `''` because every consumer here treats "no value" and "empty string"
 * identically, and collapsing them at the boundary means no call site has to remember to
 * check both.
 */
export function cell(row: CsvRow, header: string): string | null {
  const raw = row.cells[header];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}
