# QA corrections — ranking summary, Collection navigation, opening poster

Founder brief: "bingd. — Final QA Corrections: Ranking Integrity + Collection + Poster"
(2026-11-06), from phone QA of the UI cohesion Preview. This file records the ranking
diagnosis, what changed, how it was checked, what was published, how to undo it, and what is
left before production.

## Where it comes from

- **Base:** `b868e33` on `refine/ui-cohesion`, the UI cohesion record head. Its code is
  `8e6eef8`, published as `ed8d410` (Android update `01a1b04b-158b-7ac7-8cd8-fe5fec5cd9a1`,
  group `2724ce75-6244-460e-8488-1a1a62a35b84`, runtime `2503ffaa`). None of it is on `main`.
- **Rollback target, recorded before any change:** group `2724ce75`.
- **Branch:** `fix/qa-corrections` in `../worktrees/qa-corrections`. Local only; not pushed,
  not merged. No other session was running.
- **Commits:**
  - `ac6dd49` the ranking summary states the ranking as it stands after the sitting.
  - `f10a1f2` Watched | Watchlist | Unranked as one segmented control; short sort words.
  - `36e9ccd` the "How was it?" poster sized like the comparison.
  - `144ec1b` tests wait for the settled numbers.
  - `e5aa834` large text: tab labels capped at 1.3×, the status wraps under Filter & Sort.
  - `af18f1a` review1 fixes: exact score rounding, one-ranking reads, a key per Refine round.
  - `918f925` review2 fix: every visit to the summary reads the ranking again.
  - This record.

## 1. The ranking summary (diagnosis first)

**What phone QA saw:** a backlog sitting ended on `Pitch Black · #9 in Movies · 8.9` and
`Allied · #9 in Movies · 8.9`.

**Root cause: a stale client snapshot, not a ranking defect.**
- Positions are unique per user and category: `rankings_position_unique`, deferrable
  (`20260813000500_collection.sql`). The server shifts every position at and below an
  insertion inside the placement's transaction. Two titles cannot both hold #9.
- A score is never stored. `score_for(bucket, rank in band, band size)` derives it, so every
  insertion into a band re-scores that whole band.
- Both completion summaries (the backlog sitting and Refine) built each row from the `placed`
  step **that title's own placement returned**, and kept it. Pitch Black landed at #9 (8.9);
  Allied then landed at #9, which moved Pitch Black to #10 and re-scored it; the summary still
  showed Pitch Black's earlier answer.

**Were the two 8.9s legitimate?** Each was true when it was returned. In a band of 22, #9 is
8.857 → 8.9; after Allied the band is 23 and #9 is 8.909 → 8.9. So Allied's 8.9 was right,
and Pitch Black's was stale: in a band of 23, #10 is 8.77 → 8.8. Identical printed scores at
*distinct* positions are also legitimate on their own: in a band of 101, #50 and #52 both print
8.5. The ranking has no ties; rounding can make two neighbours print the same number.

**Do existing records need repair? No.** The server's positions were always correct, and
scores are derived on every read, so there is nothing stored to correct. The batch Feed post
already reads each title's *current* standing server-side
(`20261020000100_a_sitting_is_one_post.sql`). The only wrong surface was the completion
screen, which keeps nothing. (Not verifiable against production data from here; nothing in the
code path could have written a wrong position.)

**The fix (client only, no server contract change):**
- `src/features/ranking/settled-standing.ts`: when a summary opens, it reads the whole category
  afresh (`readRankedCollection`, extracted unchanged from `useRankedCollection`) under a key
  naming the sitting and its placement count (Refine adds the round), and derives each title's
  position and score with the Collection's own `scoreFor`. A read that is not one consistent
  ranking (pages read across another device's move) is read again, up to three times.
- `RankedSummary`: while the read is out, the rows wait behind a small indicator rather than
  showing the snapshots; if it fails, the titles show without numbers and `Try again`.
- **Score rounding now matches the server exactly** (independent review). `scoreFor` rounded a
  floating-point interpolation, so an exact 0.85 printed 0.8 where `score_for` says 0.9. It now
  evaluates the same formula in integer tenths. Running the real `score_for` over all 33,972
  positions in bands up to 150 found six such cases, all *I didn't like it* at 0.85; nothing
  else changes. This applies everywhere `scoreFor` is used (Collection, title page, Search
  badges), which now agree with the Feed and the server at those six positions.

Nothing about placement, comparisons, persistence or what a score means changed.

## 2. Collection

- **Watched | Watchlist | Unranked are one segmented control:** a hairline-outlined track across
  the gutters, split into equal halves (two tabs) or thirds (three); the chosen segment filled
  Parchment with its label in Maroon, the others secondary Ink; Inter Medium throughout; each
  segment a 44pt target. `CompactSwitch`'s grammar at page scale: no separate pills, no heavy
  border, no new colour. Unranked eligibility, switching and Movies | TV behaviour unchanged.
- **Large text:** labels stay on one line, shrinking (down to 0.7) before they would truncate,
  with growth capped at 1.3×, the type scale's display ceiling.
- **Toolbar status:** long sort axes are named by a short word — `Recent ↓`, `Added ↓`,
  `Year ↓` — instead of `Recently watched …`. The sheet and the spoken label keep the full
  names; sort logic is unchanged. At very large text the status wraps under Filter & Sort
  instead of being squeezed out.

## 3. The "How was it?" poster

- It was a fixed 88pt (`poster.md`); the comparison right after draws two posters of up to
  156pt. It now aims for `poster.lg`, **132pt (1.5×)**, limited to 30% of the screen height
  divided by the font scale; never below the old 88pt at ordinary text sizes, and down to
  `poster.sm` (56pt) above 130% text so the choices stay on screen.
- Measured: 128pt on 320×640 (1.45×), 132pt on 360×780 and 412×915. At 200% text, 64pt and
  78pt, with Skip title still on screen.
- Same `Poster` component and 2:3 treatment as the comparison cards; question above, title
  beneath, the three buckets and Skip title below, unchanged. Movies and TV seasons alike. The
  comparison screen is untouched.

## Deviations from the brief

- **`scoreFor` changed app-wide**, not only in the summary: at six midpoint positions it now
  rounds as the server does. The brief rules out changing score calculation semantics; this
  does not change the formula or any score's meaning, only makes the client's copy round like
  the authoritative one. Keeping the old rounding would have made the new summary disagree with
  the number each placement returns.
- **The summary briefly shows a small indicator** where its rows go while the fresh read is out
  (usually well under a second), rather than the previous instant but possibly stale rows.
- **One `supabase/` file changed: a test** (`supabase/tests/score.test.mjs`), pinning the six
  midpoints against the database. No migration or function changed.

## Verification

- **Typecheck:** clean. **Lint:** 0 errors, 81 warnings, the same as the base.
- **Jest:** 282/282 suites, 5,437 passed, 1 skipped (the same env-gated skip; the base ran
  5,401). **SQL score suite** (`node --test supabase/tests/score.test.mjs`, real migrations in
  PGlite): 10/10.
- **New and updated tests:**
  - `settled-standing.test.ts` (new): the QA case, no duplicate positions, equal printed scores
    at distinct positions, an insertion in a band above, a re-ranked title changing band, a title
    no longer ranked, the 0.85 midpoint, torn reads retried and refused.
  - `RankedSummaryStanding.test.tsx` (new): both real screens against a server answering like
    phone QA — the QA case (the read issued after the last placement), three titles one through
    comparisons, equal printed scores, Keep ranking then Done again, the settling state, a failed
    read and Try again, a torn read, TV seasons; Refine with a later move shifting an earlier one.
  - `RefineScreen.test.tsx`: each now declares the ranking; a title the ranking no longer holds
    gets no numbers; the position comes from the ranking when the step named none; two rounds at
    the same count read separately.
  - `RankSessionScreen.test.tsx`: the poster's width at 320/360/412, on short screens and at
    large text, its 2:3 frame and the screen's order; TV seasons.
  - `score.test.ts`: the six SQL midpoints, and agreement with `score_for` at every other position
    up to 150. `CollectionScreen.test.tsx` and `CollectionToolbar.test.tsx`: one control, the
    Parchment fill, halves and thirds, one-line labels, the short words, full names in the sheet
    and spoken label, the status wrap.
- **Mutation checks:** with the snapshot rows put back, 6 of the 7 backlog summary tests fail;
  without the round in Refine's key, or without the one-ranking check, their tests fail.
- **Runtime:** `eas fingerprint:generate --platform android --build-profile preview` in the
  real-`npm ci` checkout gives `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` at `e5aa834` and
  `918f925` — the installed Preview APK's runtime. Only `app/`, `src/` and one SQL test
  changed: no migration, native dependency, config or server change.
- **Real-app renders** (react-native-web against a local mock that places each backlog title at
  #9 and shifts the rest as the server does; Chrome at 320×640, 360×780 and 412×915; 200% text
  through a render-only patch): Collection with three tabs (equal thirds of 94/108/125pt, 44pt
  tall, the Parchment fill following the chosen tab, no overflow), the toolbar reading
  `Recent ↓`, the opening poster at the sizes above, and the summary reading
  `Forrest Gump · #10` and `Ted · #9` at every width. They found the 200% issues fixed in
  `e5aa834`.
- **Not seen on a device:** web ignores `adjustsFontSizeToFit`, so at 200% the tab labels
  truncate in renders where Android shrinks them; checked by measurement (they need a 0.83–0.9
  shrink, inside the 0.7 floor) and on the phone checklist. iOS was not checked.

## Independent review

Codex (`codex-companion adversarial-review`), read-only, three passes. Reports are in
`.agent-workflow/codex-reviews/qa-corrections-review{1,2,3}.md` (gitignored).

1. **`b868e33..e5aa834` — needs attention, three MEDIUM, all fixed in `af18f1a`.** It
   independently confirmed the snapshot diagnosis and that no prohibited area changed.
   - Refine's summary key could repeat across rounds and join a first-round read in flight:
     the round is now in the key.
   - A paged read could be assembled across another device's move into two titles at one
     position: reads are now checked as one ranking, re-read, then refused.
   - `scoreFor`'s floating-point rounding disagreed with `score_for` at an exact 0.85: it now
     rounds exactly, pinned against the database.
2. **Whole branch at `af18f1a` — needs attention, one MEDIUM, fixed in `918f925`:** a summary
   revisited at the same count (Done, Keep ranking, Done again; or a committed placement whose
   reply was lost) reused the first visit's read. Every visit now reads under a new generation.
3. **`af18f1a..918f925` — approve, no material findings,** including StrictMode checks of
   cached and in-flight reads, reopening, failures, retries and empty titles.

No HIGH or CRITICAL finding was raised at any pass. Codex's own Jest run is blocked by its
read-only sandbox, as before; the suite above is the implementer's.

## Android Preview

**Live on 2026-11-06**, published by this session as the one publisher from the real-`npm ci`
checkout `../worktrees/visual2-preview-publish` (left detached at `147b55c`), after a
`BINGD_RELEASE_DRY_RUN=1` dry run. Verified with `eas update:view`; no iOS group was published.

| | |
| --- | --- |
| Channel / branch | `preview` |
| Platform | Android only |
| Update group | `d27b8144-cfad-49d4-ad98-d527cfd6104a` |
| Android update | `01a1b136-1bec-7519-8865-3e6b3d2df030` |
| Runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` (the installed Preview APK's) |
| Source commit | `147b55c` (code `918f925` plus this record) |
| Rollback group | `2724ce75-6244-460e-8488-1a1a62a35b84` (UI cohesion, `ed8d410`), still listed |
| Dashboard | https://expo.dev/accounts/fourward/projects/bingd/updates/d27b8144-cfad-49d4-ad98-d527cfd6104a |

## Rollback

Nothing here needs a data rollback: this pass writes no server state.

1. **The whole pass, on every Preview phone:** republish the UI cohesion group.

   ```sh
   npx eas update:republish --group 2724ce75-6244-460e-8488-1a1a62a35b84 --message "rollback: before the QA corrections"
   ```

   Phones take it at their next launch, back on `ed8d410`. The groups before it (`1f99a23b`,
   `8272a1af`, `4212ffa9`) are still listed too.
2. **One area, keeping the rest:** revert its commits on this branch and publish again — the
   ranking summary is `ac6dd49` + `af18f1a` (`af18f1a` also holds the rounding fix), Collection is
   `f10a1f2` + `e5aa834`, the poster is `36e9ccd`.

**Limits:** an OTA applies at the next launch; republishing works only onto runtime `2503ffaa`;
there is no iOS Preview binary on this runtime.

## Phone QA checklist

Android Preview, after the update has downloaded (relaunch once).

1. **Rank two in a row at the same spot.** Collection → View unranked: rank one title, then rank
   the next so it lands just above the first. The summary must show two different positions,
   and the first title's score may shift by about 0.1. Open the first title's page: the same position
   and score. Tap Done; Keep ranking, rank one more, Done again: every row still matches the
   Collection.
2. **Refine.** Refine a few rankings; if one move passes an earlier one, its row follows it.
3. **Collection tabs.** One control under the header: Watched filled Parchment, Maroon word.
   Tap each; with Unranked showing, thirds; rank the last unranked title, halves. Movies | TV
   keeps the tab.
4. **Toolbar.** Filter & Sort → Recently watched: the toolbar reads `Recent ↓`, the sheet still
   says Recently watched.
5. **"How was it?".** The poster is clearly larger, close to the comparison's; question above,
   title below, three choices and Skip title all on screen. Try a TV season.
6. **Large text** (Settings → Display → Font size, largest): the three tab words fit on one
   line (they may shrink slightly); the toolbar status may drop under Filter & Sort; the opening
   poster gets smaller and Skip title stays on screen.

## Production

Nothing here reaches production. This section is preparation only.

- **Blockers before production:** the founder's phone QA of this Preview, including check 1;
  the whole Preview lineage (`85a8a03` → `0681248` → `ed8d410` → this) is not on `main`;
  production runs Android `ec79e181` / iOS `8ea562b7`, so the merged `main` must pass the cloud
  workflow's fingerprint gate; and the open items carried in `ui-cohesion-pass.md` (trailer
  thumbnails `i.ytimg.com`, the default-date race, the security record's M-5, M-6 and the M-3
  residual).
- **The ranking fix is not a blocker any more** once check 1 passes on the phone: the defect
  was display-only, it is corrected, and no stored data was ever wrong.
- **Out of scope, noticed in renders:** at 200% text the Collection "titles left to rank" card's
  View unranked / Dismiss pair runs past the card's edge on a 320pt phone. Pre-existing, not
  touched here.
- Production release, rollback and the single Cinematic Editorial page are as planned in
  `ui-cohesion-pass.md` → Production.
