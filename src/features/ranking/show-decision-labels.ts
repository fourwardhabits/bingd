/**
 * **The parent-show decision's labels** (FU1113-D, founder spec 2026-11-13).
 *
 * Exactly these, on every surface of a season's completion flow — the ranking reveal, the
 * post-details form, and what a screen reader announces — and never with a score: the
 * reader is choosing what happens to the show's ranking, not reading a number. One module
 * so `RankingSheet` and `LogSheet` cannot drift apart.
 */
export const UPDATE_SHOW_RANKING = 'Update Show Ranking';
export const KEEP_SHOW_RANKING = 'Keep Show Ranking';
