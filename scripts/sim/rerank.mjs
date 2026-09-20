/**
 * The re-rank cost simulator — `watch-history-and-ranking-calibration.md` §O.3.
 *
 * It exists to answer three questions before any of them cost a reader a comparison:
 *
 *   1. **Does the §F.2 policy actually beat bisection where the PRD says it does?**
 *      §F.3 is a hand-derived table. This reproduces it by running the policy, so the
 *      table is checked rather than believed.
 *   2. **What should `G` be?** `ranking.prior_gallop_doublings` is the one tuning knob.
 *      A larger G trims the big-move cost and adds nothing for small moves; the question
 *      is where it stops paying.
 *   3. **Would a star prior help the import queue?** (§I.4, and the answer decides
 *      whether `ranking.import_star_prior` is ever built. Not answered here — T6.)
 *
 * ---------------------------------------------------------------------------
 * THE POLICY LIVES HERE TOO, AND THAT IS THE POINT
 *
 * `nextPivot` and `settleAt` below are a second implementation of `next_pivot` and
 * `_rank_settle_at` in `20261004000100`. Two implementations of one rule is ordinarily a
 * liability; here it is the instrument. `supabase/tests/prior-search.test.mjs` fuzzes
 * this one against the SQL over random `(lo, hi, p, w, n)` and fails on the first
 * disagreement, so the simulator cannot drift into measuring a policy the database does
 * not have — which is the only way a simulator can lie about something that matters.
 *
 *   node scripts/sim/rerank.mjs           # §F.3's table
 *   node scripts/sim/rerank.mjs --tune-g  # cost against G, for the knob
 */

/**
 * The next index to offer, as a pure function of the search state.
 *
 * Items 0..n-1 with the subject excluded; insertion points 0..n; `p` is where the
 * subject already sits; `[a, b] = [p-w, p+w]` is the window that counts as unchanged.
 */
export function nextPivot(lo, hi, p, w, n, g) {
  const t = Math.max(w ?? 0, 0);
  const a = Math.max(p - t, 0);
  const b = Math.min(p + t, n);
  const cap = 1 << Math.max(g ?? 3, 0);
  const mid = Math.floor((lo + hi) / 2);

  if (lo < a && a <= hi) return a - 1; // the item just above the window
  if (lo <= b && b < hi) return b; //     the item just below the window

  if (hi < a) {
    // An answer proved it moved UP. Probe 1, 2, 4, 8 above the window while the top of
    // the range is still open.
    const d = a - hi;
    return lo === 0 && d < cap ? Math.max(0, hi - d) : mid;
  }

  if (lo > b) {
    const e = lo - b;
    return hi === n && e < cap ? Math.min(n - 1, b + 2 * e - 1) : mid;
  }

  return mid;
}

/** Where the search settles when the answers stop. §F.2's finalize table. */
export function settleAt(lo, hi, strategy, p, w) {
  if (lo >= hi) return lo;
  if (strategy !== 'prior' || p === null || p === undefined) return Math.floor((lo + hi) / 2);
  return Math.max(lo, Math.min(p, hi));
}

/**
 * One placement, against an oracle that knows the true answer.
 *
 * `truth` is the insertion point the subject really belongs at. The comparison against
 * item `i` is answered by whether the subject belongs above it, which is `truth <= i`.
 * No noise: this measures the SEARCH, and a noisy oracle would measure the noise.
 */
function place({ n, prior, truth, w = 0, g = 3, strategy = 'prior' }) {
  let lo = 0;
  let hi = n;
  let comparisons = 0;

  for (;;) {
    if (lo >= hi) break;
    if (w > 0 && strategy === 'prior' && prior - w <= lo && hi <= prior + w) break;

    const i =
      strategy === 'prior' ? nextPivot(lo, hi, prior, w, n, g) : Math.floor((lo + hi) / 2);
    comparisons += 1;
    if (comparisons > 256) throw new Error('search did not converge');

    if (truth <= i) hi = i;
    else lo = i + 1;
  }

  const landed = settleAt(lo, hi, strategy, prior, w);
  return { comparisons, landed };
}

/** §F.3's table, reproduced rather than trusted. */
function costTable(g = 3) {
  const bands = [50, 150, 500];
  const cases = [
    ['Unchanged', () => 0],
    ['Moved 1 up', () => -1],
    ['Moved 1 down', () => 1],
    ['Moved 2–3', () => -3],
    ['Moved 4–7', () => -7],
    ['Moved ≥ 8', () => -20],
  ];

  const rows = [];
  for (const [label, delta] of cases) {
    const row = { case: label };
    for (const n of bands) {
      const prior = Math.floor(n / 2);
      const truth = Math.max(0, Math.min(prior + delta(), n));
      row[`band ${n}`] = place({ n, prior, truth, g }).comparisons;
      row[`bisect ${n}`] = place({ n, prior, truth, g, strategy: 'bisect' }).comparisons;
    }
    rows.push(row);
  }
  return rows;
}

/** Mean comparisons over a displacement distribution, for choosing G. */
function meanCost(n, g, displacements) {
  const prior = Math.floor(n / 2);
  let total = 0;
  for (const d of displacements) {
    const truth = Math.max(0, Math.min(prior + d, n));
    total += place({ n, prior, truth, g }).comparisons;
  }
  return total / displacements.length;
}

function tuneG() {
  // A displacement distribution that is mostly "nothing changed", which is what a
  // re-check after a rewatch actually is, with a tail that reaches across the band.
  const displacements = [];
  for (let i = 0; i < 400; i += 1) displacements.push(0);
  for (let d = 1; d <= 8; d += 1) for (let i = 0; i < 40; i += 1) displacements.push(d, -d);
  for (let d = 9; d <= 120; d += 7) displacements.push(d, -d);

  console.log('\nMean comparisons by G (mostly-unchanged distribution)\n');
  const header = ['G', ...[50, 150, 500].map((n) => `band ${n}`)];
  const rows = [];
  for (let g = 0; g <= 6; g += 1) {
    rows.push([g, ...[50, 150, 500].map((n) => meanCost(n, g, displacements).toFixed(2))]);
  }
  console.log(header.join('\t'));
  for (const r of rows) console.log(r.join('\t'));
  console.log(
    '\nG is the one tuning knob (§F.3). A larger G trims the big-move cost and adds\n' +
      'nothing for small moves, so the shipped value is the smallest one at the floor.\n' +
      'Set it in app_config as ranking.prior_gallop_doublings; the default is 3.\n',
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  if (process.argv.includes('--tune-g')) {
    tuneG();
  } else {
    console.log('\n§F.3 — comparisons to re-place a title, prior mid-band, w = 0, G = 3\n');
    console.table(costTable(3));
    console.log(
      'The prior policy pays for itself on the case that actually happens: a re-check\n' +
        'after a rewatch where the reader has not changed their mind. Big moves cost a\n' +
        'few comparisons more than plain bisection, and the break-even distance is about\n' +
        '√n (§F.3).\n',
    );
  }
}

export { place, costTable, meanCost };
