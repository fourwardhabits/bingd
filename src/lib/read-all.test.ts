import { MAX_PAGES, PAGE_ROWS, after, readAllByKey, type Cursor } from './read-all';

/**
 * **The bug these tests are about cannot be found by reading the helper.**
 *
 * Independent review 21b: paging a read with `.range(from, to)` is not concurrency-safe.
 * Every page is its own PostgREST request and therefore its own `READ COMMITTED`
 * transaction, so a total sort order only protects a row set that nobody is writing to.
 * One row inserted before the boundary and page two's offset has shifted underneath it:
 * the boundary row arrives twice, one row is never seen, **and the total still looks
 * right**. That is the whole danger — 999 films assemble to 1,000 and Movie Muncher Gold
 * unlocks on an account that has not earned it, with no error and nothing on screen to
 * suggest anything happened.
 *
 * So asserting that the shipped helper calls `.gt()` would prove nothing about any of
 * that. What these tests do instead is stand up a small PostgREST — rows in a table, a
 * filter, an order, a limit, one request at a time — **and write to it between pages**,
 * exactly as another device would. Then they run *both* strategies against it: the
 * offset reader below is the code as it shipped in `23a237f`, kept here as the control
 * that proves the scenario is real rather than theoretical. Every concurrency case
 * asserts the old one fails and the new one does not.
 */

type Row = { id: string; label: string };

/**
 * PostgREST in miniature: one table, one order, and one request at a time.
 *
 * Ids are zero-padded so that string ordering is numeric ordering — which is also true
 * of the real thing, since a canonical UUID is fixed-width lowercase hex and Postgres
 * compares `uuid` as bytes. The gaps are deliberate: they leave room to insert a row
 * *between* two existing ones, which is the only way to land a write before a page
 * boundary.
 */
class Table {
  rows: Row[];
  /** How many requests have been served, which is what "between pages" is measured in. */
  requests = 0;
  /** Runs after each request is served, so a write can land between two pages. */
  between: (requestsSoFar: number, table: Table) => void = () => {};

  constructor(rows: Row[]) {
    this.rows = [...rows];
  }

  private sorted() {
    return [...this.rows].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** `select … order(id) gt(id, after) limit(n)` — what the shipped read issues. */
  keyset = (cursor: Cursor | null, limit: number) => {
    const value = cursor?.[0];
    const rows = this.sorted().filter((row) => value === undefined || row.id > value);
    return this.serve(rows.slice(0, limit));
  };

  /** `select … order(id) range(from, to)` — what it used to issue. */
  offset = (from: number, to: number) => this.serve(this.sorted().slice(from, to + 1));

  private serve(data: Row[]) {
    this.requests += 1;
    const served = { data, error: null as unknown };
    this.between(this.requests, this);
    return Promise.resolve(served);
  }

  insert(id: string) {
    this.rows.push({ id, label: `inserted ${id}` });
  }

  remove(id: string) {
    this.rows = this.rows.filter((row) => row.id !== id);
  }
}

/** `n` rows, spaced a thousand apart so anything can be inserted between two of them. */
const table = (n: number, start = 1) =>
  new Table(
    Array.from({ length: n }, (_, i) => {
      const at = (start + i) * 1000;
      return { id: String(at).padStart(12, '0'), label: `row ${at}` };
    }),
  );

/**
 * The offset reader, as `23a237f` shipped it.
 *
 * Kept verbatim rather than described, because a control that has been paraphrased is a
 * control that can quietly stop being the thing it is controlling for.
 */
async function readAllByOffset(page: (from: number, to: number) => PromiseLike<{ data: unknown }>) {
  const rows: Row[] = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const from = index * PAGE_ROWS;
    const result = await page(from, from + PAGE_ROWS - 1);
    const batch = (result.data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE_ROWS) return rows;
  }
  return rows;
}

const ids = (rows: Row[] | null) => (rows ?? []).map((row) => row.id);

/** Ids that arrived more than once. A read to exhaustion must produce none. */
const duplicates = (rows: Row[] | null) => {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const id of ids(rows)) (seen.has(id) ? twice : seen).add(id);
  return [...twice];
};

/**
 * Rows that were in the table before the read and still in it afterwards, yet never
 * arrived.
 *
 * This is the assertion that matters and it is deliberately not "the count is right". A
 * count can be right while the set is wrong — that is the defect — and a row written or
 * deleted *during* the read may legitimately be in or out. What may never happen is a
 * row that was present throughout going unseen.
 */
const omitted = (before: Row[], afterwards: Row[], got: Row[] | null) => {
  const stable = new Set(afterwards.map((row) => row.id));
  const arrived = new Set(ids(got));
  return before
    .map((row) => row.id)
    .filter((id) => stable.has(id) && !arrived.has(id));
};

const keysetRead = (source: Table) =>
  readAllByKey<Row>((cursor, limit) => source.keyset(cursor, limit), (row) => [row.id]);

describe('reading to exhaustion, with nobody else writing', () => {
  it('makes one request when the first page is short', async () => {
    const source = table(30);
    const result = await keysetRead(source);

    expect(ids(result.data)).toHaveLength(30);
    expect(source.requests).toBe(1);
  });

  it('asks once more when the total lands exactly on a page boundary', async () => {
    const source = table(PAGE_ROWS);
    const result = await keysetRead(source);

    // A full page cannot be known to be the last one, so the empty page is the price of
    // not guessing — and 1,000 is precisely the total a gold Movie Muncher has.
    expect(ids(result.data)).toHaveLength(PAGE_ROWS);
    expect(source.requests).toBe(2);
    expect(duplicates(result.data)).toEqual([]);
  });

  it('crosses one page boundary', async () => {
    const source = table(PAGE_ROWS + 1);
    const result = await keysetRead(source);

    expect(ids(result.data)).toHaveLength(PAGE_ROWS + 1);
    expect(source.requests).toBe(2);
  });

  it('crosses two, in order and without repeating itself', async () => {
    const source = table(PAGE_ROWS * 2 + 37);
    const result = await keysetRead(source);

    expect(ids(result.data)).toHaveLength(PAGE_ROWS * 2 + 37);
    expect(source.requests).toBe(3);
    expect(duplicates(result.data)).toEqual([]);
    expect(ids(result.data)).toEqual([...ids(result.data)].sort());
  });

  it('returns nothing at all for an empty table, in one request', async () => {
    const source = table(0);
    const result = await keysetRead(source);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
    expect(source.requests).toBe(1);
  });
});

/**
 * The four writes that can land mid-read, each run against both strategies.
 *
 * Every one of these is a real sequence on a two-device account: the phone opens Awards
 * while the tablet logs a film.
 */
describe('a write lands between two pages', () => {
  /** A row that sorts before page one's last row — the dangerous position. */
  const BEFORE_BOUNDARY = '000000000500';

  it('an insert before the boundary makes offset paging repeat one row and lose another', async () => {
    const source = table(PAGE_ROWS + 500);
    const before = [...source.rows];
    source.between = (requests, t) => {
      if (requests === 1) t.insert(BEFORE_BOUNDARY);
    };

    const rows = await readAllByOffset(source.offset);
    const afterwards = [...source.rows];

    // The count is *plausible*, which is what makes this defect invisible: 1,501 rows
    // arrived and the table does hold 1,501. Codex's version of this sequence is 999
    // films assembling to 1,000 and unlocking Movie Muncher Gold.
    expect(rows).toHaveLength(PAGE_ROWS + 501);
    expect(source.rows).toHaveLength(PAGE_ROWS + 501);
    // And it is wrong in both directions at once.
    expect(duplicates(rows)).toHaveLength(1);
    expect(omitted(before, afterwards, rows)).toEqual([]);
    expect(ids(rows)).not.toContain(BEFORE_BOUNDARY);
  });

  it('and keyset paging does neither', async () => {
    const source = table(PAGE_ROWS + 500);
    const before = [...source.rows];
    source.between = (requests, t) => {
      if (requests === 1) t.insert(BEFORE_BOUNDARY);
    };

    const result = await keysetRead(source);
    const afterwards = [...source.rows];

    expect(result.error).toBeNull();
    expect(duplicates(result.data)).toEqual([]);
    expect(omitted(before, afterwards, result.data)).toEqual([]);
    // The inserted row sorts behind the cursor, so it is simply outside this traversal —
    // which is a row the read began before, not a row it lost. The count is one short of
    // the table's *final* size and exactly right for the set it actually saw.
    expect(ids(result.data)).toHaveLength(PAGE_ROWS + 500);
  });

  it('a delete before the boundary makes offset paging skip a row it never saw', async () => {
    const source = table(PAGE_ROWS + 500);
    const before = [...source.rows];
    const firstId = before[0]!.id;
    source.between = (requests, t) => {
      if (requests === 1) t.remove(firstId);
    };

    const rows = await readAllByOffset(source.offset);
    const afterwards = [...source.rows];

    // One row that existed before the read, still exists after it, and never arrived.
    expect(omitted(before, afterwards, rows)).toHaveLength(1);
    expect(rows).toHaveLength(PAGE_ROWS + 499);
  });

  it('and keyset paging loses nothing that stayed put', async () => {
    const source = table(PAGE_ROWS + 500);
    const before = [...source.rows];
    const firstId = before[0]!.id;
    source.between = (requests, t) => {
      if (requests === 1) t.remove(firstId);
    };

    const result = await keysetRead(source);
    const afterwards = [...source.rows];

    expect(omitted(before, afterwards, result.data)).toEqual([]);
    expect(duplicates(result.data)).toEqual([]);
    // The deleted row was read before it was deleted, so it is in hand. That is a fact
    // about *when* the read happened, not a miscount.
    expect(ids(result.data)).toHaveLength(PAGE_ROWS + 500);
  });

  it('an insert after the boundary is picked up, once', async () => {
    const source = table(PAGE_ROWS + 500);
    const before = [...source.rows];
    // Between the last row of page one and the first row of page two.
    const id = String(PAGE_ROWS * 1000 + 500).padStart(12, '0');
    source.between = (requests, t) => {
      if (requests === 1) t.insert(id);
    };

    const result = await keysetRead(source);

    expect(duplicates(result.data)).toEqual([]);
    expect(ids(result.data)).toContain(id);
    expect(omitted(before, [...source.rows], result.data)).toEqual([]);
    expect(ids(result.data)).toHaveLength(PAGE_ROWS + 501);
  });

  it('survives a write between every single page', async () => {
    const source = table(PAGE_ROWS * 3);
    const before = [...source.rows];
    source.between = (requests, t) => {
      t.insert(String(requests).padStart(12, '0'));
      t.remove(before[requests * 7]!.id);
    };

    const result = await keysetRead(source);

    expect(result.error).toBeNull();
    expect(duplicates(result.data)).toEqual([]);
    expect(omitted(before, [...source.rows], result.data)).toEqual([]);
  });
});

/**
 * The ceiling, which exists so that "too many to read" can never arrive as a number.
 *
 * A truncated array is the defect this whole module is about, wearing a different hat:
 * it is a count that is confidently wrong. So the read refuses, and the caller turns
 * that into "could not load this one" and a dash.
 */
describe('past the ceiling', () => {
  it('refuses rather than returning the rows it managed to collect', async () => {
    const source = table(PAGE_ROWS * MAX_PAGES + 1);
    const result = await keysetRead(source);

    expect(result.data).toBeNull();
    expect((result.error as { code: string }).code).toBe('BINGD_TOO_MANY_ROWS');
    expect(source.requests).toBe(MAX_PAGES);
  });

  it('refuses at exactly twelve thousand too, and says "at least"', async () => {
    // Review 21b's nit. Twelve full pages is exactly 12,000 rows and no thirteenth
    // request has been made, so this read cannot tell that total apart from a larger
    // one — which is precisely why the message must not claim to.
    const source = table(PAGE_ROWS * MAX_PAGES);
    const result = await keysetRead(source);

    expect(result.data).toBeNull();
    expect((result.error as { message: string }).message).toMatch(/^At least 12000 rows/);
  });

  it('stops at the ceiling rather than paging forever', async () => {
    const source = table(PAGE_ROWS * MAX_PAGES * 2);
    await keysetRead(source);
    expect(source.requests).toBe(MAX_PAGES);
  });
});

describe('when the traversal itself is unsound', () => {
  it('refuses a repeated row rather than quietly dropping it', async () => {
    // What a non-unique cursor column would produce. Discarding the duplicate would
    // leave a shorter array and no sign — the plausible-total failure again, one level
    // down.
    let request = 0;
    const rows = Array.from({ length: PAGE_ROWS }, (_, i) => ({
      id: String(i).padStart(6, '0'),
      label: 'x',
    }));
    const result = await readAllByKey<Row>(
      () => {
        request += 1;
        return Promise.resolve({ data: request === 1 ? rows : [rows[0]], error: null });
      },
      (row) => [row.id],
    );

    expect(result.data).toBeNull();
    expect((result.error as { code: string }).code).toBe('BINGD_DUPLICATE_ROW');
  });

  it('refuses a cursor that stops moving, rather than looping to the ceiling', async () => {
    const rows = Array.from({ length: PAGE_ROWS }, (_, i) => ({
      id: String(i).padStart(6, '0'),
      label: 'x',
    }));
    // A page that walks backwards: every id is new, so it is not the duplicate check
    // that catches it, but a last row no further on than the previous page's.
    let request = 0;
    const result = await readAllByKey<Row>(
      () => {
        request += 1;
        return Promise.resolve({
          data: request === 1 ? rows : rows.map((row) => ({ ...row, id: `!${row.id}` })),
          error: null,
        });
      },
      (row) => [row.id],
    );

    expect((result.error as { code: string }).code).toBe('BINGD_CURSOR_STALLED');
    expect(request).toBe(2);
  });

  it('passes a failed request straight through, with no rows attached', async () => {
    const result = await readAllByKey<Row>(
      () => Promise.resolve({ data: null, error: { message: 'nope' } }),
      (row) => [row.id],
    );

    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: 'nope' });
  });
});

/**
 * The composite cursor, which exists for exactly one read.
 *
 * `reactions` is keyed by `(feed_event_id, user_id)` and the awards read pins neither, so
 * a cursor on either column alone would skip every other reaction on the boundary event.
 * Everything else on that screen pins one half of its key and pages on the other.
 */
describe('a cursor of two columns', () => {
  type Pair = { event: string; user: string };
  const pairs = (events: number, per: number) =>
    Array.from({ length: events }, (_, e) =>
      Array.from({ length: per }, (_, u) => ({
        event: String(e).padStart(6, '0'),
        user: String(u).padStart(6, '0'),
      })),
    ).flat();

  /** The tuple comparison the PostgREST predicate spells out. */
  const greater = (row: Pair, cursor: Cursor | null) =>
    cursor === null ||
    row.event > cursor[0]! ||
    (row.event === cursor[0]! && row.user > cursor[1]!);

  it('walks every row of every group, without repeating a boundary group', async () => {
    // 1,004 events × 3 reactions is 3,012 rows, so both page boundaries fall in the
    // middle of a group — the case a single-column cursor gets wrong.
    const rows = pairs(1004, 3);
    let requests = 0;
    const result = await readAllByKey<Pair>(
      (cursor, limit) => {
        requests += 1;
        return Promise.resolve({
          data: rows.filter((row) => greater(row, cursor)).slice(0, limit),
          error: null,
        });
      },
      (row) => [row.event, row.user],
    );

    expect(requests).toBe(4);
    expect(result.data).toHaveLength(3012);
    expect(new Set((result.data ?? []).map((row) => `${row.event}/${row.user}`)).size).toBe(3012);
  });

  it('would have lost the boundary group had the cursor been the event alone', async () => {
    // The control. Paging on `feed_event_id` only, `.gt()` skips every remaining reaction
    // on the event that straddled the boundary — a silent undercount of Heart Magnet.
    const rows = pairs(1004, 3);
    const result = await readAllByKey<Pair>(
      (cursor, limit) =>
        Promise.resolve({
          data: rows
            .filter((row) => cursor === null || row.event > cursor[0]!)
            .slice(0, limit),
          error: null,
        }),
      (row) => [row.event],
    );

    // It does not even survive to a wrong number: two rows of the boundary group share
    // an event id, so the duplicate check fires. That refusal is the point.
    expect((result.error as { code: string }).code).toBe('BINGD_DUPLICATE_ROW');
  });
});

describe('the after() helper', () => {
  const builder = () => {
    const calls: [string, string][] = [];
    const self = {
      calls,
      gt(column: string, value: string) {
        calls.push([column, value]);
        return self;
      },
    };
    return self;
  };

  it('adds nothing to the first request', () => {
    expect(after(builder(), 'id', null).calls).toEqual([]);
  });

  it('is strictly greater, never greater-or-equal — which would repeat the boundary', () => {
    expect(after(builder(), 'id', ['abc']).calls).toEqual([['id', 'abc']]);
  });

  it('reads the element of the cursor it was asked for', () => {
    expect(after(builder(), 'user_id', ['event', 'user'], 1).calls).toEqual([
      ['user_id', 'user'],
    ]);
  });
});

/**
 * **How many pages carried rows**, which is not how many requests were made.
 *
 * A caller that intersects rather than counts needs to know whether every row it holds
 * came from one snapshot: two pages can hold `me → A` from the first and `A → me` from the
 * second when the pair never coexisted, and an intersection then invents a member.
 *
 * The distinction between rows and requests is independent review 21e's first finding, and
 * it lands at exactly the total most likely to occur: a full page is always followed by an
 * exhaustion probe, so an account with precisely 1,000 edges makes two requests and the
 * second returns nothing. Counting requests turned that into "could not load this one" on
 * a perfectly readable account.
 */
describe('how many pages carried rows', () => {
  const pagesFor = async (n: number) => (await keysetRead(table(n))).pages;

  it('is none for an empty read', async () => {
    expect(await pagesFor(0)).toBe(0);
  });

  it('is one for a short page', async () => {
    expect(await pagesFor(30)).toBe(1);
  });

  it('is one at exactly the page size, though that takes two requests', async () => {
    const source = table(PAGE_ROWS);
    const result = await keysetRead(source);

    expect(source.requests).toBe(2);
    expect(result.pages).toBe(1);
  });

  it('is two the moment a row lands on a second page', async () => {
    expect(await pagesFor(PAGE_ROWS + 1)).toBe(2);
  });

  it('is three across two boundaries', async () => {
    expect(await pagesFor(PAGE_ROWS * 2 + 5)).toBe(3);
  });
});
