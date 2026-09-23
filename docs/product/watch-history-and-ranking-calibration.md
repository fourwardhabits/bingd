# Watch History, Rewatches and Long-Term Ranking Calibration

**Status (2026-09-23, stopping point): T0–T5 are shipped.** Watch History (T1–T4, with the
#196 founder-QA migrations `20261014000100`–`20261018000100`) merged to `main` in PR #196
(`30833d5`); the unified Backlog + Refine (T5) merged in PR #203 (`ceb4f14`). **Production and
staging are both at 168 migrations, head `20261019000100`.** The production OTA from `a17880d`
carries the client. Production flags: `goals.count_watch_events`,
`leaderboard.monthly_from_events` and `ranking.backlog_enabled` are **true**;
`ranking.refine_enabled` is **false** until the backlog smoke passes (see
[`../release/stopping-point-cutover.md`](../release/stopping-point-cutover.md)).
**T6 as a standalone flow is eliminated** (the unified backlog is it); **T6b** (unmatched-import
repair), **§I.6** (*Add what you've already seen*) and **T7** are **deferred**, and **T6c**
(Letterboxd Lists import) is a separate, deferred post-freeze feature
([`letterboxd-lists-import.md`](./letterboxd-lists-import.md)). The body below is the design as
written; where it differs from what shipped, the notes marked **As shipped** and
[`refine-rankings-t5.md`](./refine-rankings-t5.md) win.
**Written:** 2026-09-19, against `origin/main` at `0468f1c` (PR #170).
**Revision 2 (2026-09-19):** founder decisions R1–R3 applied. Adds the **seen / watch / recording**
separation, entry-context defaults, the metrics matrix and the legacy-data policy (§D.0, §D.6,
§D.7, §L.2, §M.7). Replaces the "placeholder" event with a date *basis*. Adds tranche T0b.
**Revision 3 (2026-09-19):** the founder's decisions after T0. **Movement is private-only in
v1** — the feed carries no ordinal and no "spots" chip, which narrows R1 (§B.2, §E.2, §K). The
interface never shows two persistent collection states (§D.0). Refine is **conditional,
finite, and never overlaps the unranked queue** (§H). Unmatched Letterboxd rows get a
lightweight **Review unmatched titles** repair flow with Skip (§I.7).
**Revision 4 (2026-09-19):** the rewatch surface is **locked** — a prominent `Watched N times ›`
entry opening a dedicated, pushed **Watch History screen**, and **no History tab in v1** (§J).
**No founder decisions remain open in this document.**

**Shipped (all on staging and production, 2026-09-23):**

| Tranche | What | Where |
|---|---|---|
| **T0b** | Ranking an already-seen title no longer stamps today; *Earlier*; the R4 session carry | PR #174, merged `ed644cb`. Client only. |
| **T0** | A correction is not a new ranking: `created_at` preserved, chronology-based watchlist rule, re-rating is not "becoming watched" | PR #180, merged `4a88237`, migration **`20261001000100`** |
| **T1** | `watch_events` with basis, the R3-compliant backfill, the cache and seen triggers, rebuilt legacy writers, `log_title` / `set_watch_date` | migration **`20261003000100`**, in #196 |
| **T2** | `ranking_placements`, the prior-anchored search, clean comparison evidence, `movement` in responses | migration **`20261004000100`**, in #196 |
| **T3** | `log_rewatch` / `edit_watch_event` / `delete_watch_event`; feed `again`, enrichment and deletion | migration **`20261005000100`**, in #196 |
| **T3b** | Log another watch, the **Watch History screen** and its `Watched N times ›` entry, the When row via `log_title` / `set_watch_date`, private movement copy | client, in #196 |
| **T4** | Goals and the monthly board repointed to watch events | migration **`20261006000100`** + client, in #196. Both flags **on in production** (2026-09-23). |
| **#196 QA** | per-watch note and companions (`log_rewatch_with_details`, `set_watch_details`); a watch keeps the score it was posted with; a pure correction follows the latest watch; stars never become buckets | `20261014000100`–`20261018000100`, in #196 |
| **T5** | **Unified Backlog + Refine**: one ranking session with two sources — the unranked backlog (§I, as amended there) and Refine (evidence-driven targets, prior search with tolerance, finite rounds) | migration **`20261019000100`** + client, PR #203. Backlog **on**, Refine **off** in production pending smoke. Built spec: [`refine-rankings-t5.md`](./refine-rankings-t5.md). **T6 (a standalone Rank your imports) is eliminated**: the backlog is that flow. |
| T6b, §I.6, T7 | unmatched-import repair; *Add what you've already seen*; Undo this move, the star prior and the rest of T7 | **deferred**, not built |
| T6c | Letterboxd Lists import | **deferred post-freeze**, separate feature ([`letterboxd-lists-import.md`](./letterboxd-lists-import.md)) |
**Supersedes:** [`deferred-roadmap.md`](./deferred-roadmap.md) §19 (rewatch history) and §22
(per-title watch history). It **resolves** §49 (the historical-unranked exception) for the
historical contexts named here, builds PRD §12's unbuilt import "anchor session", and gives §34
("fast entry") its first concrete shape.
**Reads with:** [`../architecture/ranking.md`](../architecture/ranking.md) (invariants I1–I7),
[`../architecture/data-model.md`](../architecture/data-model.md) §5, [`letterboxd-import.md`](./letterboxd-import.md).

---

## A. Executive recommendation

Separate three facts the schema has always blurred:

| Fact | Question it answers | Where it lives |
|---|---|---|
| **Seen** | Has this person watched this title at some point? | the `user_media` row, as today, made explicit |
| **Watch** | Did they watch it at a known time (or at least once, time unknown)? | `watch_events.watched_on` (nullable) |
| **Recording** | When did they tell bingd? | `watch_events.recorded_at`, `user_media.created_at`, the ranking ledger |

**Recording time is never watch time.** No reader may substitute one for the other.

On that foundation, build three **ledgers** and one **search policy**:

1. **`watch_events`**: one row per viewing the person has told us about. Each row has a nullable
   date and a **basis** saying where the date came from (defaulted Today, chosen by the reader,
   an authoritative diary, unattributed legacy, or none). `user_media.watched_on` stays, now
   defined precisely as a cache of the **latest known date**. Null there means "no known date",
   never "not watched".
2. **`ranking_placements`**: an append-only record of every completed placement, holding the
   ordinal it came from, the ordinal it landed at, and a score snapshot. `rankings.position`
   stays the single current ordinal. History is never averaged or replayed into it.
3. **Clean comparison evidence**: session and placement links, and Undo sets `withdrawn_at`.
4. **A prior-anchored search policy** for re-placing an already-ranked title. It checks both
   neighbours first, gallops outward only if an answer shows a move, then bisects. Unchanged
   costs 2 comparisons instead of 6–9. The existing narrowing rule is untouched.

The user-facing features built on top:
- **Log another watch** records the viewing (defaulting to Today), then offers an optional quick
  re-check of the placement.
- **Watch history** is a dedicated screen, pushed from a prominent `Watched N times ›` entry on
  the title page's existing personal context line. No History tab (§J).
- **Refine your ranking** is a voluntary Collection mode that holds one target per round.
- **Rank what you've watched** is a continuous mode for unranked titles. It includes an
  **Add what you've already seen** entry, so a new user can backfill hundreds of titles as
  *seen* without anyone fabricating a date.

**Entry context decides the date, not a checkbox and not an account-age heuristic** (§D.6).

**Done first, and both are done:**
- **T0** re-implemented the correction fix on current main as `20261001000100`, live on staging
  and production. PR #118 was closed: its version collided with an applied migration.
- **T0b** stopped LogSheet stamping **today** onto titles that are already seen and undated.
  Merged; it carries no migration and is **waiting for its first OTA or binary**, so installed
  clients still have the old behaviour until then (§C.3.7).

**T1 through T4 are built** (2026-09-20), on `feat/watch-history-t1-t4`. **T5 (Refine) and
T6 (Rank what you've watched) are not started**, deliberately: the founder scoped this tranche
to T1–T4.

**The version this document reserved for T1, `20261002000100`, was taken** by the feed-score
fix (PR #189) between the design being written and the work starting. T1 is
`20261003000100` and every tranche after it follows in its own day bucket. That is the
second renumbering this epic has needed, which is why the instruction in
§RECOMMENDED BUILD SEQUENCE is to check the applied head rather than to trust this file.

---

## B. Product behaviour

### B.1 The acts, and what each one writes

| Act (user's words) | Seen | Watch history | Current ordinal | Placement ledger | Feed |
|---|---|---|---|---|---|
| Log a title I just watched (normal log flow) | becomes seen | 1 event, **Today** unless changed | inserted if ranked | `first` | `title_ranked` (unchanged) |
| Log a title, When = **Earlier** | becomes seen | 1 event, no date | inserted if ranked | `first` | `title_ranked` (unchanged) |
| Rank a title that is **already seen** (imported, onboarding, earlier log) | unchanged | **nothing** | inserted | `first` or `import` | first ranking posts; queue mode posts nothing (§I.5) |
| **Log another watch → Keep** | unchanged | +1 event, Today unless changed | untouched | none | one `title_ranked` flagged `again`, if natively dated within 7 days |
| **Log another watch → Re-check** | unchanged | +1 event | prior-anchored search | `rewatch` (linked) | the **same** single event, enriched with movement |
| Update your rating (same band / new band) | unchanged | none | prior search / bisection | `correction` | none (unchanged) |
| Refine your ranking | unchanged | **never** | prior search with tolerance | `refine` | none |
| Rank what you've watched | unchanged | none | bisection (star prior later) | `import` or `first` | **none** |
| Add what you've already seen (bulk) | becomes seen | 1 event, no date | none | none | none |
| Edit a watch date | unchanged | event updated | untouched | none | none |
| Remove one watch | unchanged | event deleted (not the last) | untouched | link set null | that watch's post, if any |
| Remove from collection (`unlog`) | removed | all cascade | removed | all cascade | removes `title_ranked` (unchanged) |

### B.2 Rules that hold everywhere

- **Seen is independent of dates.** A title can be seen, ranked and in the Collection with zero
  known dates. Unknown timing is valid data.
- **`recorded_at` is never `watched_on`.** Product engagement (when someone used bingd) and
  content consumption (when they watched) are different metrics and are never substituted for
  each other (§L.2).
- **No fabricated dates.** Only the reader, in a current-log context, or an authoritative source
  (the Letterboxd diary) puts a date on a viewing. Ranking, refining, importing a title without a
  diary entry, and bulk historical entry never do.
- **One current ordinal per title/season**: `rankings.position`. The newest completed placement
  is authoritative. Placement history is never averaged, weighted, decayed or replayed.
- **Only answers move a title.** When the answers stop, the title is placed at the insertion point
  **nearest its prior** that is consistent with every answer. With no informative answers, that is
  where it already was.
- **Movement is private-only in v1** (founder, 2026-09-19, narrowing R1):
  - On the reader's **own** surfaces — the reveal, Watch History, the Refine result and
    checkpoint — exact ordinals at any depth: `Moved from #118 → #72`.
  - **No movement reaches anybody else.** The feed and share cards carry no ordinal, no
    arrow and no "spots" phrasing. A rewatch activity says what happened and shows the score;
    where the title sits in the reader's list is theirs. This removes R1's public branch
    entirely, and with it the top-50 threshold — nothing public to threshold.
  - `Still #N` only when both neighbours were confirmed. `Kept at #N` when the reader skipped
    out. Both are private too.
  - Public movement can be reconsidered later on its own evidence; v1 does not ship it.
- **One collection state in the interface** (founder, 2026-09-19). The schema distinguishes a
  collection row from its watch events, but the reader never meets two persistent states. There
  is no "Logged" versus "Watched" badge, filter or empty state, and nothing says a title is
  *partly* in the collection. A title is in the Collection or it is not; its dates, and whether
  it has any, are detail inside Watch History (§D.0).
- **No automatic decay and no recency weighting.** Time lowers the app's *interest* in re-asking.
  It never lowers a score.
- **No episode-level anything.** Movies and seasons only.

---

## C. Current-state architecture (origin/main, 0468f1c)

### C.1 Diagram

```
                 WRITERS                                   TABLES                                READERS
 ───────────────────────────────────────  ┌─────────────────────────────────────────┐  ──────────────────────────────────
 LogSheet ── set_bucket ────────────────▶ │ user_media  PK (user, item)  = SEEN     │ ◀─ goals.ts / _maybe_goal_completion
          └─ log_watched(TODAY stamp) ──▶ │  bucket                                 │     (watched_on = the only clock)
 clear_watch_date ──────────────────────▶ │  watched_on DATE  ← ONE date, overwritten│ ◀─ _leaderboard_counts (monthly:
 TasteBucketSheet ── set_bucket (no date)▶│  note (one per title = the review)       │     coalesce(watched_on, created_at)
 _import_apply_batch (native row: date   │  source in_app|imported (ratchet 0917-2) │     ← RECORDING USED AS WATCHING)
   untouched; imported row: max diary) ─▶ │  created_at (= recording; "Recently added")│◀─ profile_title_counts, awards
 unlog ── deletes row + title_ranked ───▶ └───────────────┬─────────────────────────┘ ◀─ title page "Watched <date>"
                                                          │ I3                FK cascade ▼
 rank_start ──────┐                       ┌───────────────┴─────────────┐  ┌──────────────────────────┐
 rank_again(      │   ranking_sessions    │ rankings  PK (user, item)   │  │ imported_titles (stars)  │
   new_watch) ────┼─▶ lo, hi, pivot,      │  category, bucket, position │  │ imported_watches (diary, │
 rank_rebucket ───┘   history[], seen[],  │  created_at ← RESET on every│  │   is_rewatch) NO READER  │
                      skips, provisional, │   replacement (#118 open)   │  └──────────────────────────┘
                      new_watch           └───────────────┬─────────────┘
   rank_answer / rank_skip / rank_back ──▶ comparisons(winner, loser, at)   ◀─ NO READER; Undo does not withdraw
 _rank_finalize (category lock):                          ├──▶ score.ts / score_for: position + band size → 0–10
   [provisional: _rank_unrank_impl = DELETE]              ├──▶ streak.ts, "Recently ranked", people suggestions
   shift → INSERT (created_at = now())                    │     (all read rankings.created_at)
   → user_media upsert → title_ranked if first|new_watch  ├──▶ hero rank "#N in Movies" (top 10 only)
   → fulfil recommendations (first only) → activate invite└──▶ community score, Taste Match (rankings only)
 INSERT triggers: leaves_watchlist ×2, award_on_ranking, take_provenance · DELETE: award_off_ranking (deferred)
 watch_tags (tagger, tagged, item): title-level companions
```

### C.2 Facts the design depends on (each verified against the tree)

| Area | As built | Source |
|---|---|---|
| Seen state | A `user_media` row **is** "watched/logged". Every client reader derives membership from the row, not from `watched_on` (Collection, `use-log-state`, awards, profile counts). | `use-collection.ts`, `use-log-state.ts`, `profile_title_counts` |
| LogSheet date default | The When row shows **Today**. `choose()` stamps `log_watched(effectiveDate = today())` after `set_bucket` whenever the *settled* row has no date, unless "I don't remember" was tapped **in this sheet session**. | `LogSheet.tsx` ~533, ~681–715 |
| Onboarding | `TasteBucketSheet` → `set_bucket` only. **No date**, deliberately ("films seen fifteen years ago do not land in this year's Goals"). | `app/onboarding/taste.tsx` ~153 |
| Other entry paths | Search `+`, the Rank ring, and the title page's "How was it?"/Rank all open the **same** LogSheet; there is no separate ranking path. The companion tick on a never-logged title calls `logWatched(Today)`. `set_season_progress` has no client caller. | `app/(tabs)/log.tsx` ~1173, `app/title/[id].tsx` |
| Rerank entry | `rank_again(item, bucket, op, new_watch)` opens a provisional session starting at the **band midpoint**. | `20260826000500` |
| Narrowing | `rank_answer` narrows correctly for **any** stored pivot. The next pivot is the midpoint, walked by `_rank_offer` past `seen_items`. | `20260922000100`, `20260901000100` |
| Too tough | The skip cap (3) and the dry walk finalize at the **midpoint**, `adjustable`, with no comparison row. | same |
| Undo | Frames hold `(lo, hi, pivot, seen, skips)`. **The undone comparison row stays.** | `20260922000100` |
| Finalize | Provisional path = DELETE + INSERT inside the category lock. The feed posts iff `p_new_watch or not v_replaced`. The payload has **no "again" marker**. | `20260902000100` |
| Log another watch | `rankAgain(newWatch: true)`: a forced full re-rank that records **no watch and no date**. | `app/title/[id].tsx` ~2209 |
| Watch date | `log_watched` upserts `watched_on = coalesce(new, old)`. There is one date; a new one overwrites. | `20260825000200` |
| Import | A native row keeps its date. An imported row gets the **max** diary date. Every diary entry is kept in `imported_watches` (keyed on the diary URI, with `is_rewatch`), which has **no reader**. | `20260917000300` |
| Provenance | Ranking an imported title flips `source` to `in_app`. | `20260917000200` |
| Leaderboard month | The **only** server code that falls back from watching to recording: `coalesce(watched_on, created_at at UTC)` (added deliberately by `20260903000100`, because 5 of 12 accounts had no dates). | `20260917000100` |
| Title page | `#2 in Movies · Watched Aug 17, 2026`; the date segment is absent when null. Tabs: film `Similar · Cast · Reviews · Videos · Details`. | `app/title/[id].tsx` ~846, ~862 |
| Reveal | Never names a *placement* worse than 10th (`TOP_RANK_SHOWN`, 2026-09-05). | `RankingSheet.tsx` ~1495 |
| PRD display rule | No remaining-count or progress-to-everything bar. | PRD §11 |
| PRD import | Specifies an unbuilt **anchor session** of about 20 comparisons. | PRD §12 step 9 |

### C.3 Defects and hazards found during the audit

*Items 1 and 7 are **fixed and live**; they are kept because the rest of the design refers to
them and because the shapes recur.*

1. ~~**Correction still reads as a watch on main.**~~ **FIXED — T0, `20261001000100`, live on
   both projects 2026-09-19.** Every correction re-inserted with `created_at = now()`, so the
   derived streak counted a fabricated week (#120 only hid the celebration), Recently ranked
   jumped, and a re-added watchlist row was cleared. `streak.ts`'s header claimed a fix that had
   never merged — PR #118 could not ship, because its version collided with the applied
   Helpful-reviews migration. #118 is closed as superseded.
2. **A rewatch cannot be recorded without re-ranking**, and the re-ranking ignores the current
   position.
3. **A rewatch in the feed is indistinguishable from a first ranking.**
4. **Comparisons are not evidence yet**: undone answers stay, and there are no session links.
5. **Ranking an imported undated title can inflate the monthly board.** The provenance flip plus
   the `created_at` fallback attribute it to the import month.
6. **Goal year-loss**: a rewatch overwrites last year's date (data-model §5).
7. ~~**LogSheet fabricates a current date on already-seen titles.**~~ **FIXED — T0b, PR #174,
   merged; awaiting its first OTA or binary.** For an existing row with no date the sheet
   *displayed* "Not recorded" while `choose()` still stamped **today**, because it guarded only
   on this session's `dateCleared`. Ranking any undated imported title, onboarding pick or
   earlier "I don't remember" title wrote a false current watch, which then counted toward the
   year's goal and the month's board and flipped the provenance. **Installed clients still do
   this until the fix ships.**
8. **NEW. Backfill through the normal log flow is indistinguishable from current watching.** A
   new user entering 300 old films through Search leaves Today on each one. No stored field
   separates an auto-stamped Today from a deliberate date (`processed_operations` keeps neither
   the arguments nor the intent). **Every in-app date on main is therefore of unknown provenance.**

---

## D. Watch-event model

### D.0 Three concepts, and the one rule between them

- **Seen**: the `user_media` row. It already exists, and it is already the thing every reader uses
  for membership. It becomes explicit: *seen ⇔ a `user_media` row exists*. It needs no new column.
- **Watch**: a `watch_events` row. Invariant: **a seen title has ≥ 1 watch event.** When a title
  becomes seen with no known timing, its one event has no date. That is "watched at some point",
  which is a true statement, not a fabricated one.
- **Recording**: `recorded_at` on each event, `user_media.created_at` for the seen claim, and the
  placement ledger for ranking acts. All three are engagement facts.

**Rule:** time-bound consumption metrics read `watch_events.watched_on` and nothing else.
Engagement metrics read recording times and nothing else (§L.2).

**And one interface rule that follows** (founder, 2026-09-19): *seen* and *watch* are a
**storage** distinction, never a state the reader is shown. The product has one collection
membership. Concretely:

- No "Logged" / "Watched" split anywhere — not as a badge, a filter, a segment, a count or an
  empty state. The Collection's existing segments stay as they are: Watched, Watchlist and
  Unranked, where **Unranked is a ranking state, not a watch state**.
- A title with no known date reads as an ordinary collection title. Its date row says
  *Earlier* (T0b), and nothing calls it incomplete.
- "Watched 6 times" is a **fact on a title**, not a second state. It appears where §J puts it
  and nowhere else.
- Nothing invites the reader to "finish" a title's record. There is no completeness meter, no
  "add a date" nag, and no count of undated titles outside the optional date review (§M.7).

### D.1 Schema

```sql
create type watch_date_basis as enum (
  'today_default',  -- a current-log flow offered Today and the reader kept it
  'reader',         -- the reader chose or edited this date
  'diary',          -- an authoritative imported date (Letterboxd diary "Watched Date")
  'unattributed',   -- an in-app date whose provenance was never recorded (all pre-epic rows,
                    --   and legacy-RPC writes from installed clients during the transition)
  'none'            -- the viewing is known; its timing is not
);

create table watch_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  media_item_id uuid not null,
  watched_on    date,                               -- when it was watched (local date); null = unknown
  basis         watch_date_basis not null,
  import_ref    text,                               -- Letterboxd diary URI; null otherwise
  recorded_at   timestamptz not null default now(), -- when bingd was told. NEVER a watch time.
  updated_at    timestamptz not null default now(),

  constraint watch_events_basis_matches_date
    check ((basis = 'none') = (watched_on is null)),
  constraint watch_events_plausible_date
    check (watched_on between date '1870-01-01' and date '2100-01-01'),
  constraint watch_events_collection_fk
    foreign key (user_id, media_item_id)
    references user_media (user_id, media_item_id) on delete cascade
);

create index watch_events_title
  on watch_events (user_id, media_item_id, watched_on nulls first, recorded_at);
create index watch_events_user_dated
  on watch_events (user_id, watched_on) where watched_on is not null;
create unique index watch_events_import_once
  on watch_events (user_id, import_ref) where import_ref is not null;
```

**Why this is the minimum provenance model.** One enum answers the only three questions any
reader asks:
- *Is there a date?* (`none`)
- *Is it native or imported?* (`diary` vs the rest)
- *How much did a person actually assert it?*

The third question is the one that separates `today_default` from `reader` and `unattributed`. It
is the difference that let the backfill problem (§C.3.8) go undetected, and it is what lets a
future cleanup (§M.7) find it. Nothing else earned a column:
- A separate `source` is subsumed by `basis` plus `import_ref`.
- `declared_rewatch` is replaced by the prior-viewing rule in §D.2.
- `is_placeholder` (Revision 1) is gone: an undated event is simply `basis = 'none'`.
- A `precision` column is rejected (§D.8).

**Derived classes**, used by §L.2:

| Class | Bases | Meaning |
|---|---|---|
| **native-dated** | `today_default`, `reader`, `unattributed` | a date recorded in bingd |
| **diary-dated** | `diary` | a true date from an authoritative import |
| **undated** | `none` | watched, time unknown |

### D.2 Decisions

| Question | Decision |
|---|---|
| Identity / idempotency | Surrogate `id`. Retries are deduplicated by `_claim_operation_result` (the replay returns `watch_event_id`). Imports are deduplicated by `import_ref`. |
| Media relationship | Composite FK to `user_media`, `on delete cascade` (the `imported_watches` precedent). Rankable kinds only; writers refuse a series. |
| Date vs timestamp | A `date`: the local calendar date, accepted up to `current_date + 1`. `recorded_at` orders same-day events. |
| Seen with no timing | One event, `basis = 'none'`, created **at commit** by a deferred constraint trigger on `user_media` insert if the transaction created none. This covers all seven row-creating writers without rebuilding them, and lets an import or `log_title` insert its own events first. |
| An undated event superseded by a diary | When an import adds diary events to a title whose **only** event is `none`, that event is deleted in the same statement. The diary now accounts for the viewing. The exception is the prior-viewing rule below. |
| Prior-viewing rule (authoritative) | If a title's **earliest** diary entry carries Letterboxd `Rewatch = Yes`, the export itself asserts an earlier viewing. The import keeps (or creates) one `none` event, with `import_ref = <diary URI>#prior` for idempotency. This is the only inferred event in the design, and it is inferred from the source's own flag. |
| Rewatch indicator | **Derived**: an event is a rewatch if it is not the first in the order `(watched_on nulls first, recorded_at)`. The UI labels an event "First watch" only when it is first *and* dated. An undated event is shown as "Earlier · date not recorded". |
| Edit | `edit_watch_event(op, id, date, basis)`. It changes the date only (a null date sets `basis = 'none'`) and never creates a viewing. |
| Delete | `delete_watch_event(op, id)` refuses the **last** event (`P0001 last_watch` → the client offers *Remove from collection*). It deletes the linked rewatch post. Placement links are set to null. |
| Same-day duplicates | Allowed. The client confirms "You already logged a watch on Sep 19 — log another?". Operation ids cover retries. |
| Watchlist | A new event clears the title's watchlist row only if `coalesce(watched_on, current_date) >= watchlist.created_at::date`. A backdated entry doesn't consume a fresh "Watch again" intention. |
| Provenance flip | Moves to `watch_events`: inserting a **native-dated** event outside an import flips `source` to `in_app`. `_source_follows_the_watch` ignores `watched_on` changes made under the cache marker (§D.7). |
| Unlog / account deletion | FK cascade (`profiles → user_media → watch_events`). |
| RLS | Owner-only `select`. Writers are `security definer` with `assert_can_write()`. Dates stay private at every visibility level (PRD §22). |
| Lock order | ledger claim → `_lock_media`. Watch writers never take the category lock. |

### D.3 Watched-with: **A. title-level for the MVP**

Re-keying `watch_tags` per event adds a notification and privacy surface for "who was there
*that* time". The door stays open with no rework: an additive `watch_tags.watch_event_id` later.
The rewatch sheet shows no companions, because showing them there would imply per-watch data
that does not exist.

### D.4 Notes: **stay title-level**

One current note per title. A later "note at that watch" can reference `watch_event_id` (§22).

### D.5 RPC surface

New names, and no defaulted parameters (PostgREST overload rule):

| RPC | Signature | Behaviour |
|---|---|---|
| `log_title` | `(p_operation_id, p_media_item_id, p_bucket, p_watched_on, p_basis)` | **The normal log.** Sets the bucket and, **only when this call creates the seen row**, creates its event with the given date and basis. On an existing row it sets the bucket and **ignores the date**. One atomic call replaces LogSheet's two-call bucket + stamp and its acknowledged residual race. |
| `set_watch_date` | `(p_operation_id, p_media_item_id, p_watched_on, p_basis)` | LogSheet's When row on a title with **exactly one** event: dates it, or clears it to `none`. It refuses when there are multiple events, and the sheet then shows `Watched 3 times ›` instead. |
| `log_rewatch` | `(p_operation_id, p_media_item_id, p_watched_on, p_basis)` → `{status, watch_event_id, watch_count, posted}` | Requires a seen row. |
| `edit_watch_event` | `(p_operation_id, p_watch_event_id, p_watched_on, p_basis)` | Edits one event from Watch History. |
| `delete_watch_event` | `(p_operation_id, p_watch_event_id)` | Refuses the last event. |
| `add_seen` | `(p_operation_id, p_media_item_ids uuid[], p_bucket taste_bucket)` | Bulk historical entry (§I.6): creates seen rows with `none` events. It never dates anything and never ranks. |

Reads are plain `select` under owner RLS.

**Legacy writers, rebuilt so installed clients keep working** (from their true latest bodies):

| Old call | New meaning | Basis written |
|---|---|---|
| `log_watched(date)` | Sets the date of the **most recently recorded** event. With one event that is exactly today's overwrite. | `unattributed`. The server cannot know whether the old client defaulted or chose. |
| `clear_watch_date` | Clears the most recently recorded event's date. | `none` |
| `set_bucket` | Unchanged. The seen row gets its `none` event from the deferred trigger. | – |
| `_import_apply_batch` | Adds `diary` events per diary entry (skipping a date that equals an existing native event's date), applies the supersede and prior-viewing rules, and still writes `imported_watches` during the transition. | `diary` / `none` |
| `rank_again(new_watch = true)` from an old client | Creates one **undated** event at finalize (no fabricated date), links it, and posts one `again` event as that client does today. | `none` |

### D.6 Entry paths: what each one means (audited on main)

| # | Path (today's code) | Today | New semantics | Event written |
|---|---|---|---|---|
| 1 | Search `+`, title page "How was it?", watchlist "watched it", recommendation or watched-with CTA, **on a never-seen title** (all go through LogSheet) | stamps Today unless "I don't remember" | **explicit current log.** The When row offers **Today · Earlier · Pick a date**, defaulting to Today. | 1 event: `today_default` / `reader` / `none` |
| 2 | LogSheet, ticking a companion first on a never-seen title | `logWatched(Today)` | same as 1 (uses the When row's value) | same |
| 3 | The Rank ring, or the title page's Rank, **on an already-seen, unranked title** (imported, onboarding, earlier "Earlier") | **stamps Today** (§C.3.7) | **ranking only.** "Ranking now" is not "watched now". The When row shows the stored state ("Date not recorded"); adding a date there is an explicit `set_watch_date(…, 'reader')`. | none |
| 4 | Update your rating | no date | correction | none |
| 5 | **Log another watch** | forced re-rank, no date | watch first, When = Today default, then optional re-check | 1 event |
| 6 | Onboarding pick five (`TasteBucketSheet`) | `set_bucket`, no date | historical seen | 1 event, `none` |
| 7 | Letterboxd diary entry | `imported_watches`; the max date lands on imported rows | the true date preserved | 1 per entry, `diary` |
| 8 | Letterboxd `watched.csv` / rating without a diary entry | seen, no date | seen, no date | 1 event, `none` |
| 9 | Letterboxd earliest diary entry marked Rewatch | ignored | an earlier viewing asserted by the source | +1, `none` (`#prior`) |
| 10 | **Rank what you've watched** (queue) | n/a | historical ranking | none |
| 11 | **Add what you've already seen** (bulk) | n/a | historical seen | 1 each, `none` |
| 12 | **Refine your ranking** | n/a | ranking evidence only | **never** |
| 13 | Watch History: add a past watch, or change a date | n/a | the reader's explicit assertion | `reader` |
| 14 | Old client `log_watched(date)` / `clear_watch_date` | overwrite / clear | see §D.5 | `unattributed` / `none` |
| 15 | Old client `rank_again(new_watch = true)` | re-rank + post | an undated rewatch | 1 event, `none` |
| 16 | `set_season_progress` (no client caller) | creates the row | seen, undated | `none` via trigger |

**No account-wide heuristic** ("first 30 days is historical") and **no per-title
"historical" checkbox**. The When row in path 1 *is* the existing date control, reduced to three
choices. *Earlier* replaces "I don't remember" and is the only new word. For people backfilling a
library through Search, a session-scoped memory of their own last choice is proposed as **R4**.
Path 11 is the purpose-built answer.

### D.7 `user_media.watched_on` compatibility (the critical migration detail)

| Question | Answer |
|---|---|
| New definition | `watched_on = max(watch_events.watched_on)` over the title's events, from **any** basis. It is the latest **known** date. It is maintained by an `AFTER INSERT/UPDATE/DELETE` trigger on `watch_events` under the transaction-local marker `bingd.watch_cache`. It is recomputed, not only advanced, because edits and deletes can lower the maximum. |
| Null means | **No known dated viewing.** It never means "not watched". Seen is the row's existence. |
| Does seen need its own column? | **No.** It already *is* the row. What changes is that the rule becomes explicit and is enforced by a test: **no reader may use `watched_on is null` as "not seen"**, and **no reader may fill a null `watched_on` from a recording time**. |
| Readers that interpret null wrongly today | (1) **LogSheet's stamp** treats null on an existing row as "not yet dated" and writes Today: T0b. (2) **`_leaderboard_counts`** fills null from `created_at`: T4 removes the fallback (R2). No other reader was found. Collection, the title line, awards and posters already treat null as "no date". |
| Old readers during the migration | T1's backfill gives each legacy row an event carrying **the same date** it already had, so the cache value is unchanged for every row except native rows whose Letterboxd diary holds a *later* date. For those, the cache moves to the authoritative later date. That set is enumerated by the T1 diff script before production. |
| Triggers during backfill | The cache recompute fires `_maybe_goal_completion` and the provenance ratchet. The backfill runs under the import's quiet marker (`bingd.import_running`), so no goal completion or award is **announced** by a migration. |
| Installed clients | They still read `watched_on` for the title line and LogSheet, and see the latest known date. |

### D.8 Partial date precision (year known, day unknown): **omit**

"I saw it in 2019" would let annual stats place a historical title. But every time-bound reader
would then need a precision rule, goals and monthly boards would still have to exclude it, and
the only surface it helps (past-year stats) is not built. **Revisit** when a year-in-review for
past years is actually designed. It would be an additive `watched_precision` column then.

---

## E. Placement-history model

### E.1 Schema

```sql
create type placement_kind as enum
  ('first', 'rewatch', 'correction', 'refine', 'import', 'manual', 'backfill');

create table ranking_placements (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  media_item_id  uuid not null,
  category       ranking_category not null,
  kind           placement_kind not null,
  outcome        text not null
                 check (outcome in ('placed', 'moved', 'unchanged', 'kept')),

  bucket         taste_bucket not null,
  position       integer not null check (position > 0),   -- category ordinal (the "#7")
  band_rank      integer not null check (band_rank > 0),
  band_size      integer not null check (band_size >= band_rank),
  category_size  integer not null check (category_size >= position),
  score          numeric(3,1) not null,                   -- the one-decimal score shown then

  from_bucket    taste_bucket,          -- the live state immediately before, inside the lock
  from_position  integer,
  from_score     numeric(3,1),

  strategy       text check (strategy in ('bisect', 'prior')),
  tolerance      smallint not null default 0,
  comparisons    smallint,
  skips          smallint,
  adjustable     boolean not null default false,
  watch_event_id uuid references watch_events (id) on delete set null,
  session_id     uuid,
  operation_id   uuid,
  created_at     timestamptz not null default now(),       -- a recording (engagement) time

  constraint ranking_placements_collection_fk
    foreign key (user_id, media_item_id)
    references user_media (user_id, media_item_id) on delete cascade
);

create index ranking_placements_title
  on ranking_placements (user_id, media_item_id, created_at desc);
create index ranking_placements_category
  on ranking_placements (user_id, category, created_at desc);
```

Owner-only `select`. Written only by `_rank_finalize`, and by `rank_reorder` (granted, no
caller): it must write `manual` rows or be revoked.

Outcomes:
- `placed`: the title had no prior position.
- `moved`: the bucket or position differs.
- `unchanged`: both neighbour checks passed.
- `kept`: resolved at the prior by skips or the dry walk.

### E.2 What "Moved from #18 → #7" means: **C. both are stored; B is what the UI prints**

- **A. the literal ordinal at the prior placement** is on the previous ledger row. It is true about
  *then*, and Watch History shows it that way: "Placed #18 of 34 · Mar 2025".
- **B. the live ordinal immediately before this placement** is `from_position`, read inside the
  category lock just before the old row is dropped.

Movement must be B. After twelve films were ranked above Heat, it sits at #30, not #18. A would
print a movement of 11 that was really 23. Both numbers are category ordinals (`#N in Movies`). A
band change is still one movement.

**Where each form appears — private only, v1 (founder, 2026-09-19):**

| Surface | Audience | Rule |
|---|---|---|
| Reveal, Watch History, Refine result and checkpoint | the reader | exact ordinals at any depth: `Moved from #118 → #72`, `Still #312`, `Kept at #57` |
| Feed, share card | anybody else | **no movement at all** — no ordinal, no arrow, no "spots" |

Movement is a fact about the reader's own list, and v1 keeps it there. The ledger still records
`from_position`, `from_score` and `outcome` for every placement, so making some form of it
public later is a rendering decision and not a schema change — but nothing public is built now,
and the top-50 threshold R1 proposed is moot while nothing public exists.

The reveal's existing rule (no *placement* worse than #10 in its static lines) is unchanged. The
movement line is a separate, private statement about the reader's own history.

### E.3 Finalize changes (one rebuild of `_rank_finalize`)

1. Read `from_*` after the category lock and before `_rank_unrank_impl`.
2. **No-op finalize**: if the resolved point equals the prior and the bucket is unchanged, leave
   `rankings` alone. That means no delete or insert, no trigger churn, and no `created_at` change.
   Write the ledger row, delete the session, return.
3. Otherwise keep today's delete, shift and insert under the generalized marker
   `bingd.rank_replacing = <kind>` (T0). Preserve `created_at` for `correction | refine | manual`;
   stamp `now()` for `rewatch`. The watchlist-leave triggers return early for every replacement,
   because the watch event owns that job.
4. Insert the ledger row. Link the session's non-withdrawn comparisons.
5. Feed and fulfilment follow §K. Fulfilment happens for `first` only, never `import`.
6. Return `placement_id` and `movement`. Old clients ignore both.

`rankings.created_at` is **redefined, not repointed**: it becomes the time of the **latest ranking
act** (first, rewatch or import placement). That is an engagement time (§L.2), and it is correct
for streak and Recently ranked without any code change there.

In-place `UPDATE` instead of delete + insert: **rejected for this epic.** Every insert and delete
trigger, and the deferred award revocation, were audited against delete + insert.

### E.4 Backfill

One `backfill` row per existing ranking: the current snapshot, `created_at = rankings.created_at`,
and `category_size` reconstructed as the count of the category's rankings created at or before it.
That figure is an estimate, and the kind says so.

---

## F. Rerank from the current position

### F.1 The one change

Sessions gain `strategy`, `prior_offset`, `tolerance`, `kind` and `watch_event_id`. Narrowing is
untouched. Only `next_pivot` becomes a pure function of `(lo, hi, p, w, n, G)`, so history frames
still restore the whole state and Undo needs no new field.

### F.2 Policy: neighbour check → capped gallop → bisection

```
Items 0..n-1 (subject excluded). Insertion points 0..n. p = prior. Window [a, b] = [p-w, p+w].
Compare(subject, item i):  WIN ⇒ hi := i   LOSS ⇒ lo := i + 1     (today's rule, unchanged)

next_pivot(lo, hi):
  if lo < a <= hi:            return a - 1              -- test the item just above the window
  if lo <= b < hi:            return b                  -- test the item just below the window
  if hi < a:                                            -- an answer proved it moved UP
     d := a - hi
     if lo = 0 and d < 2^G:   return max(0, hi - d)      -- probes at 1, 2, 4, 8 above the window
     else                     return midpoint(lo, hi)
  if lo > b:                                            -- proved it moved DOWN
     e := lo - b
     if hi = n and e < 2^G:   return min(n-1, b + 2e - 1) -- probes at 0, 1, 3, 7 below the window
     else                     return midpoint(lo, hi)
  return midpoint(lo, hi)

finalize when:
  lo >= hi                         → at lo                          (exact; moved/unchanged)
  a <= lo and hi <= b  (w > 0)     → at p                           (window confirmed; unchanged)
  hi - lo <= w after bisection     → at the point in [lo,hi] nearest p           (moved)
  skip cap or dry walk             → at clamp(p, lo, hi), adjustable (kept, or moved if answers moved it)
```

`G = 3` (`ranking.prior_gallop_doublings`). `_rank_offer`'s walk past `seen_items` still applies.
Both sides of the window are always tested; nothing is assumed.

| Path | Strategy | Tolerance |
|---|---|---|
| First ranking, band change (`rank_rebucket`) | `bisect` | 0 |
| Log another watch → Re-check | `prior` | 0 |
| Update your rating, same band | `prior` | 0 |
| Old-client `rank_again` | `prior`, silently | 0 |
| Refine | `prior` | by rank (§H.5) |
| Rank what you've watched | `bisect` in v1 (§I.4) | 0 |

Kill switch: `ranking.prior_search_enabled = false`.

### F.3 Expected comparisons (hand-derived, w = 0, G = 3; verify with the §O.3 simulator)

| Opinion after rewatch (prior mid-band) | band 50 | band 150 | band 500 |
|---|---|---|---|
| Unchanged | **2** | **2** | **2** |
| Moved 1 place (up / down) | 2 / 3 | 2 / 3 | 2 / 3 |
| Moved 2–3 | 4–5 | 4–5 | 4–5 |
| Moved 4–7 | 5–7 | 5–7 | 5–7 |
| Moved ≥ 8: the gallop cap, then bisection of the rest of that side | 8–10 | 9–12 | 11–14 |
| *Today (plain bisection), any outcome* | *6* | *8* | *9* |

Downward moves cost one more comparison, because the neighbour above is checked first. At a band
edge the unchanged case is 1. Big moves cost 1–5 more than today; the break-even distance is
about √n. `G` is the one tuning knob: a larger G (gallop to about √n) trims the big-move cost and
adds nothing for small moves. Tune it from the simulator, then from real data.

**Alternatives considered:**
- Plain bisection ignores the prior.
- Fixed quartile anchors are poor for small moves.
- A symmetric widening interval costs about 2× for a move.
- An optimal alphabetic tree needs a calibrated displacement prior we don't have. Revisit once the
  ledger holds a few thousand re-placements.

### F.4 Invariants preserved

- **I1/I2/I4**: the finalize arithmetic is unchanged.
- **Undo** restores the frame, the policy recomputes, and the comparison gets `withdrawn_at`.
- **Skip** keeps the 3-cap and the dry walk, with the resolution point changed for prior sessions
  only.
- **Idempotency**: a replay returns the stored answer, with no second ledger row.
- **Resumability**: **a resume must match `(bucket, provisional, kind, strategy)`, or it
  restarts.**
- **Concurrency**: `from_*` is read inside the category lock.
- **Offsets under a sliding band**: the existing, accepted limitation, unchanged.

---

## G. Confidence model

### G.1 What "confidence" means for an ordinal list

The stored order is exactly what the answers implied. The uncertainty is whether it **still
matches the person**:

- **A. Region validity**: would the title land within ±w of where it is if placed today? It is
  threatened by drift, fragile placements, and growth.
- **B. Exact neighbour order**: is the order against its neighbours directly evidenced, or only
  inferred by transitivity through answers given years apart? One wrong early answer in a binary
  insertion misplaces a title by about n/2, and nothing ever revisits it.

There is no probability, no percent and no Bradley–Terry fit. A fit on this data would measure
the insertion design, and it would tempt ranking by the fitted score.

### G.2 Representation: a derived evidence record plus an ordering key

`placement_support(user, category)` is `security definer`, own-account only, and **not
persisted**:

| Field | Meaning | Source | Ships |
|---|---|---|---|
| `last_confirmed_at` | latest placement with outcome `placed/moved/unchanged` | ledger | v1 |
| `age_days` | now − `last_confirmed_at` | ledger | v1 |
| `growth` | `category_size_now / category_size_then` | ledger | v1 |
| `fragile` | last placement `adjustable`, or thin on answers, or `backfill` | ledger | v1 |
| `newer_neighbours` | how many of the ±5 current neighbours were placed after the last confirmation | ledger + rankings | v1 |
| `direct_gap` | distance to the nearest directly compared, order-consistent neighbour above and below | comparisons | v1.1 |
| `anchors_crossed` | anchors from its last session since re-placed across it | comparisons + ledger | v1.1 |
| `reason`, `refine_priority` | explanation enum; ordering key | derived | v1 |

v1.1 waits for 30+ days of PR-2's clean comparisons. Legacy comparisons count only when they are
consistent with the current order.

**Placement support is about ranking evidence, never about watch dates.** A title with no known
date is not "less confident". Dates and confidence are unrelated.

### G.3 Cost and exposure

- **Cost**: one category per call, O(n + comparisons). The target is < 50 ms at 2,500 ranked
  titles.
- **Persisted?** No. It would be stale after every insertion.
- **Exposed?** Never as a number. Only as a one-line reason on a Refine target card.
- **Effect on ranking**: none.

---

## H. Refine your ranking

> **As shipped (T5, [`refine-rankings-t5.md`](./refine-rankings-t5.md)).** The three
> constraints below hold. The entry, the screen and the rhythm changed. There is one Collection
> card, *Fine-tune your rankings*, in the unranked card's slot and drawn only on the server's
> `cta` rule; it has **no overflow row and no timed dismissal**. Not now or Done rests it until
> three new placements and a strong batch again. The screen is `app/rank-session.tsx?start=refine`,
> shared with the backlog. There is **no age term**: selection reads evidence gaps, newer
> contradicting answers, and titles an explicit rerank carried past. There is **no per-title
> result beat**; a round ends on a summary. The comparison controls are **Can't decide** and
> **Skip title (left)**.

### H.1 Name, place, entry

- **Name**: *Refine your ranking* (the session title is *Refine · Movies*). **Home: Collection.**
- **Entry**:
  - A quiet, dismissible Collection card, shown when the category has ≥ 20 ranked titles and a
    candidate clears the threshold. Dismissal lasts 14 days.
  - A permanent overflow-menu row.
- **Start**: a full-screen route, `app/refine.tsx`, hosting the comparison component inline. There
  are no stacked modals; `TitleRecallSheet` is the only sheet.
- **Stop**: ✕ at any time. The current target's session is cancelled (it is provisional, so
  nothing moves).
- **Refine never creates, edits or reads a watch event.**

**Three constraints the founder fixed on 2026-09-19, and they are what keep this feature
from becoming a chore:**

1. **Refine is calibration of what is already ranked.** Its candidate set is `rankings` and
   nothing else. It never offers an unranked title, never "helps you finish", and never
   borrows the unranked queue's copy. The two modes answer different questions — *is this
   still in the right place* against *where does this go* — and a reader must never be unsure
   which one they are in. §I's queue is the only place an unranked title is ever offered.
2. **Refine is conditional.** It exists on the surface only when the app has a real reason:
   ≥ 20 ranked titles in the category **and** at least one candidate over the priority
   threshold. Otherwise the card is absent and the overflow row says nothing is waiting. It is
   never a permanent call to action, and there is no badge or count anywhere.
3. **Refine is finite.** A round is five targets; it ends with a checkpoint that offers Done
   first. When no candidate clears the threshold the session ends with *Nothing else needs a
   look right now*. There is no infinite queue, no streak, no daily goal, and no way for the
   app to imply the reader is behind. Refining is never *required* for a ranking to be valid.

### H.2 Flow A vs B vs C: **recommend C, a hybrid that leans A**

| | A: target held until settled | B: new pair every answer | C: hybrid (recommended) |
|---|---|---|---|
| Cognitive cost | recall the target once | two fresh titles every answer | as A |
| Payoff | visible per target | diffuse | as A, plus a rhythm |
| Engine | one provisional session per target | interleaved sessions; Undo incoherent | as A |

C's rhythm: an unchanged target resolves in two answers and shows a small inline
`Heat · Still #18` as the next pair slides in. A moved target gets a result beat that needs one
tap (*Next*).

### H.3 Screen

```
┌──────────────────────────────────────┐
│ ✕   Refine · Movies          ● ● ○ ○ ○│  ← this round's 5 targets, not the library
│  ▌Heat (1995)                        │  ← target pinned for the whole round
│  ▌#18 in Movies                      │
│  ▌Last placed Mar 2025, when you     │  ← reason line (optional, one line)
│  ▌had 34 movies                      │
│  Which did you like more?            │
│  [   Heat   ]      [ Collateral ]    │
│          Too tough   ·   Undo        │
│  I don't remember Heat well          │
└──────────────────────────────────────┘

Result beat (moved; private → exact at any depth):    Checkpoint (5 targets or 12 answers):
┌──────────────────────────────────────┐ ┌──────────────────────────────────────┐
│  Heat                                │ │  5 titles checked                    │
│  Moved from #118 → #72        ↑      │ │  Heat        #118 → #72        ↑     │
│  7.9                                 │ │  Alien       #4 → #6           ↓     │
│  [ Next ]            Undo this move  │ │  Collateral  Still #33               │
└──────────────────────────────────────┘ │  Thief       Still #241              │
                                         │  Ronin       Kept at #57             │
                                         │  [ Done ]         [ 5 more ]         │
                                         └──────────────────────────────────────┘
```

### H.4 Target selection

1. **Eligible** titles are ranked, in a band of ≥ 3, and not snoozed. Titles first placed in the
   last 14 days, or confirmed in the last 60, are excluded.
2. **Priority** = `rank_weight(r) × (0.35·stale + 0.25·growth + 0.25·fragile + 0.15·newer_neighbours)`,
   each term saturating in [0,1]. `rank_weight` is 1.0 for the top 25, 0.6 for 26–100, and 0.3
   below. The weights live in `app_config`; they are an ordering, not a measurement.
3. **Diversity**: a resolved target's ±3 neighbours are discounted ×0.3 for the session.
4. The first target comes from the top 50 when one qualifies.
5. Unranked imports belong to §I, not here.
6. **Exhausted**: *Nothing else needs a look right now.* No counts. (Refine's card, not its
   screen, may name up to five placements — unified design §5.)

### H.5 Pair selection and settling

Pairs come from the §F policy with tolerance by rank: w = 0 for #1–25, 1 for 26–100, 3 for
101–300, 7 beyond. Outcomes are `unchanged` → `Still #N` (typically 2 answers), `moved` → exact
movement, and `kept` → `Kept at #N` with a 30-day snooze. A detected move is finished, not
budget-capped.

### H.6 Edge controls

- **Too tough**: today's semantics.
- **Undo** within a target is `rank_back`. **Undo this move** is a compensating `correction`
  placement, allowed only while that placement is still the newest in its category (T7).
- **I don't remember Heat well** opens `TitleRecallSheet` first, then snoozes the title for
  180 days. The ranking is unchanged.
- **Checkpoint** after 5 targets or 12 answers.
- **Kill / resume** uses a kind-matched session resume, and the queue is re-derived.

```sql
create table ranking_snoozes (
  user_id uuid not null, media_item_id uuid not null,
  reason text not null check (reason in ('dont_remember', 'too_tough')),
  until  date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, media_item_id),
  foreign key (user_id, media_item_id) references user_media (user_id, media_item_id) on delete cascade
);
```

---

## I. Rank what you've watched (the import and historical mode)

> **Amended by the unified Backlog + Refine design (founder-approved 2026-09-21; built in
> `20261019000100`, see [`refine-rankings-t5.md`](./refine-rankings-t5.md) §0).** Where this
> section and that design differ, the design wins:
>
> - **One screen**, `app/rank-session.tsx?start=backlog|refine`, not a separate
>   `rank-queue`. Entry: Collection ▸ Unranked's persistent **Start ranking** (with the exact
>   count). The Watched view's card says *You have titles left to rank* and **never** a count.
> - **Order (§I.2 is replaced):** incomplete native placements first (an open first-ranking
>   session, then a bucket chosen in bingd), then seen-but-unranked by most recent watch date,
>   then most recently added. **Stars never order anything and never make a bucket** (#196,
>   `20261018000100`); a title with no bingd bucket is asked *How was it?* first.
> - **Progress (§I.3 is replaced):** *7 of 18 ranked*, the total fixed when the sitting began —
>   useful once the reader chose to start the job — plus a **soft checkpoint** every ten placed
>   (*10 titles ranked.* · Keep going · Done). Not a limit; Skip and Done are always there.
> - **Rules (§I.5) hold:** nothing per title in the Feed (a backlog placement uses the silent
>   `import` kind), no recommendation fulfilment. Finishing an abandoned **native** ranking keeps
>   its native behaviour. *I don't remember it well* is not in the backlog v1: **Skip** (this
>   sitting only) covers it, and the title stays in Unranked.
> - **Resume, never duplicate:** a placement left mid-comparison — native or backlog — comes back
>   with its answers from the backlog, from + on a row, or from Rank on the title page.
> - Seasons still being watched stay in Unranked but are not dealt; series are never dealt.
> - **Entries as shipped:** Unranked's *Start ranking*. The import summary's existing **Rank
>   imported movies** (since 2026-09-12) opens Collection ▸ Movies ▸ Unranked, which is where
>   *Start ranking* is, so imports reach this flow without a second product. The
>   import-completion notification and §I.6's *Add what you've already seen* in §I.1 below
>   were **not built** as entries. PR #204 (open, outside the stopping-point release) rewords
>   that button to *Rank imported titles* and shows it only while the backlog has titles.
>   §I.6 and §I.7 are deferred.

### I.1 Shape

One continuous screen, `app/rank-queue.tsx`, shares its components with Refine. It deals the next
unranked seen title, runs the comparisons inline, shows where the title landed, and deals the
next. **It never creates or edits a watch event**: these titles are already seen, and ranking
them now says nothing about when they were watched.

**Entries:**
- the import summary's *Rank imported movies* (repointed here);
- *Rank these* on Collection ▸ Unranked;
- the import-completion notification;
- *Add what you've already seen* (§I.6).

Scope: every unranked seen title in the category, imports first. This is PRD §12's anchor
session.

### I.2 Queue order

1. `loved` → `fine` → `not_for_me` (PRD §11).
2. Within a bucket, most memorable first: star desc, then the most recent diary date, then
   diary count ≥ 2, then dated before undated.
3. Unbucketed titles last, opening with "How was it?".
4. Snoozed titles are skipped. *Skip for now* moves a title to the end of this session.

The first titles become the anchors for everything after, which is another reason to lead with
the best-remembered ones. A user with empty bands builds a spine in 0–2 comparisons per title.

### I.3 Screen and progress

```
┌──────────────────────────────────────┐
│ ✕   Rank what you've watched    3/10 │  ← THIS SESSION's ten, never the library
│  ▌Past Lives (2023)                  │
│  ▌★★★★½ on Letterboxd · I liked it   │
│  ▌Change                             │
│  Which did you like more?            │
│  [ Past Lives ]      [ Aftersun ]    │
│          Too tough   ·   Undo        │
│  Skip for now · I don't remember it well
└──────────────────────────────────────┘
Landed:  Past Lives · 9.3 · #4 in Movies   [ Next ]
```

Per PRD §11, the meter counts this session's ten. The checkpoint says "10 ranked · 4 in your
top 20", never "290 to go".

### I.4 Can Letterboxd data reduce the work?

- **Bucket: yes, already.** It skips the band question and searches one band.
- **Stars: only as a prior.** The saving is at most about 2 comparisons, and the expected saving
  is about 1. Ship bisection. Build the star-stratum prior behind `ranking.import_star_prior`, and
  enable it only if the simulator *and* real `import` placements show a saving.
- **Diary dates: ordering only.**

### I.5 Rules

- **Feed**: nothing per title.
- **Recommendation fulfilment**: none.
- **Streak**: counts. It is an engagement metric for ranking acts (§L.2).
- **Monthly leaderboard**: **no credit** (R2). Ranking writes no watch event, and T4 makes the
  monthly board read native-dated events only. N8 therefore depends on T4.
- **I don't remember it well**: the title stays seen and unranked, snoozed 180 days. §49's
  guardrail holds: this exists only in the historical modes.
- **Resumability**: the queue is derived.

### I.6 Add what you've already seen: the backfill answer

New users spend days entering hundreds of titles they watched years ago. The low-friction path
is a **context**, not a per-title control.

- *Add what you've already seen* (from the queue screen, the Unranked empty state, and the
  onboarding Letterboxd step's *Not now* branch) opens a multi-select poster grid. The sources are
  `starter_movies`, Trending, and search. Tapping a poster marks it seen.
- The screen says once, at the top: *These go in as seen, with no date. Log anything you watched
  recently from Search.*
- *Done* calls `add_seen(...)` in batches. Each title becomes seen with one `none` event, and is
  not ranked or bucketed. The queue then offers "How was it?" and the comparisons.
- Because every title entered here is undated by construction, nothing in the backfill can leak
  into this year's goal, this month's board or a 2026 recap. The person makes no per-title choice,
  and the app makes no guess about their account age.

### I.7 Review unmatched titles — the import repair flow (founder, 2026-09-19)

An import leaves rows it could not place. `letterboxd-import.md` §8 records that the repair
screen was deliberately not built, and `_import_settle` already keeps exactly what one needs:
the **name and year**, redacted of everything else, plus a count the summary reports.

**Scope, and it is deliberately small:**

- Reachable from the import summary (*182 films we couldn't place · Review*) and from
  Settings ▸ Import from Letterboxd. Never a nag: no badge, no push, no card on any other
  surface, and it can be left at any time with progress kept.
- One row at a time: the exported **name and year**, then bingd's best candidates from the
  ordinary search (poster, title, year, director where known).
- Three answers, and **Skip is first-class**: *That's it* (matches the title), *Not in this
  list* (search by hand), *Skip* (leaves the row untouched and moves on). Skipping everything
  is a valid outcome and the screen says so.
- A match writes the collection row and its diary watch events exactly as the importer would
  have — it uses the same apply path, so provenance, `basis = 'diary'` and the dedup rules are
  the importer's, not a second implementation.
- Nothing is inferred. A row nobody resolves stays unresolved for ever, which is the current
  behaviour; the flow only adds a way to answer.
- **Not a ranking surface.** It places titles into the collection; ranking them is §I's queue,
  reached afterwards.

**Depends on** T1 (watch events) for the diary dates to land as events, and on the importer's
retained name/year. It is a T6-or-later item and is not part of T1.

---

## J. Watch History UI

**FOUNDER-LOCKED, 2026-09-19: option A, with a full screen rather than a sheet.** A prominent
personal-context entry — `Watched 11 times ›` — pushes a dedicated **Watch History screen**.
**No History tab is added to the title page in v1.**

### J.1 The decision, and the reasoning that produced it

| | **A. `Watched N times ›` → a pushed Watch History screen** ✅ | **B. A History tab on the title page** ❌ |
|---|---|---|
| Where it lives | The reader's own context line, which already reads `#2 in Movies · Watched Aug 17, 2026` | The tab row: film `Similar · Cast · Reviews · Videos · Details`, season adds `Episodes` |
| Whose fact it is | A watch history is **reader-specific** and private, and it sits with the reader's other personal facts | Every other tab is **the title's public anatomy** and means the same thing to every reader |
| Crowding | Nothing is added to the tab row | A **6th** tab on a film and a **7th** on a season, permanently, including for the many titles with one watch |
| At 10+ watches | A full screen has room for dates, movement and editing, and it scales | A tab inside a scrolling page, competing with the page's own chrome |
| When there is nothing to see | One watch reads exactly as it does today | An empty or near-empty tab, always present |
| Evolving it | A pushed route is easy to change, extend, or later fold into a cross-title Diary (deferred §51) | A tab people have learned is expensive to withdraw — removing it is a visible regression |

**Why a screen and not a sheet.** Revision 2 proposed a bottom sheet. A history can reach ten,
twenty or more entries, each carrying a date, sometimes a movement line, and a ⋯ that edits or
removes it. That is a list with row-level actions and a header summary — a screen's job. A
sheet caps at a fraction of the viewport, competes with the keyboard during an inline date
edit, and on iOS puts row actions inside a presented view that other sheets then cannot stack
on. The route is `app/title/[id]/history.tsx`, pushed, with the ordinary back.

**What would reopen the tab question.** Only a cross-title Diary shipping first, so that
readers arrive at a title *from* their history and a tab becomes the natural landing place.
Absent that, B stays closed.

### J.2 Wireframes — the locked design

The entry is the line that is already there. It gains a count and a chevron, and nothing else
on the page moves:

**The entry, on the title page's personal context line.** The count is the prominent half when
there is one — the same weight as the rank segment beside it, not grey metadata — and it is
never manufactured for a single viewing:

```
Context line on the title page
1 watch, dated       #2 in Movies · Watched Aug 17, 2026 ›   ← today's words, now tappable
1 watch, undated     #2 in Movies                       ›    ← unchanged text; the chevron is the route
2 watches            #2 in Movies · Watched 2 times ›
11 watches           #2 in Movies · Watched 11 times ›
not in the top 10    Watched 11 times ›
```

- **Never `Watched 1 time`.** One viewing keeps the sentence the page already had: the date, or
  nothing when there is no date. The plural count appears from the second watch onward, which
  is also the first moment it says anything.
- **The whole line is the route**, with a chevron whenever there is a history to open — which
  is any seen title, because a single dated watch still has a date to edit and a past watch to
  add. The ⋯ menu also carries *Watch history*, for the undated-single case where the line
  itself is bare.
- The count is the reader's own and appears on nobody else's view of the title.

**The screen** — `app/title/[id]/history.tsx`, pushed, ordinary back:

```
┌──────────────────────────────────────┐
│ ‹ Heat (1995)                        │  ← pushed route; the title is the back context
│ Watched 6 times                      │  ← the summary, in the screen's own voice
│ #72 in Movies · 7.9                  │
│──────────────────────────────────────│
│ 2026                                 │  ← year headers once there is more than one year
│ Sep 19   Rewatch                   ⋯ │
│          Moved from #118 → #72       │  ← private movement: exact, at any depth
│ Feb 2    Rewatch                   ⋯ │
│ 2019                                 │
│ Mar 3    Rewatch · from Letterboxd ⋯ │
│ Jan 12   First watch · Letterboxd  ⋯ │
│ Earlier  Date not recorded         ⋯ │  ← undated: never "first", never inside a year
│──────────────────────────────────────│
│ Placed #18 of 34 · Mar 2025          │  ← placements not tied to a watch
│ Refined · Still #72 · Jul 2026       │
│──────────────────────────────────────│
│ [ + Log another watch ]              │
│   Add a past watch                   │
│ Watched with Ada, Sam                │  ← title-level, as today
└──────────────────────────────────────┘
⋯ on a row → Change date · Remove this watch   (the only watch: "Remove from collection…")
```

**What the screen owns:** the watch events, their known dates, the undated historical viewing
where there is one, the rewatch count, the private movement line, and editing or removing an
individual watch to the extent T1 and T3 allow it. Notes stay **title-level** — there is no
per-watch note here or anywhere.

- Rows are one line plus an optional second line, in a virtualized list: a 60-watch history is
  an ordinary scroll, which is the point of a screen.
- Dates are edited **inline on the row**, never in a presented modal — a screen has the room,
  and it keeps the iOS two-modal rule out of this surface entirely.
- *Add a past watch* opens the same inline date field (`basis = reader`), and *Date not
  recorded* is an allowed answer.

### J.2b The rejected alternative: a History tab

Recorded so nobody re-proposes it without the reasons, and **not an open question**.

A `History` tab would have sat 6th on a film and 7th on a season, permanently, for every
title including the majority with a single watch. It would have been the **only owner-only
tab** in a row whose every other entry — Similar, Cast, Reviews, Videos, Details, Episodes —
describes the title itself and reads identically for every viewer. It would have needed the
tab row tested at 360 dp with seven entries. And it would have been the hardest of the options
to walk back: removing a tab people have learned is a visible regression, where a pushed route
can be changed, extended or folded into a cross-title Diary without anybody losing a landmark.

The only thing that reopens it is a cross-title Diary shipping first (deferred-roadmap §51),
which would make a tab the natural place to land when arriving at a title from that history.

### J.3 Log another watch and the normal log's When row

```
┌──────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ Log another watch                  ✕ │        │ ✓ Saved · your 3rd watch             │
│ Heat (1995)                          │  Save  │ Did it change your mind?             │
│ When?  (●Today) (Earlier) (Pick…)    │ ─────▶ │ Heat is #72 in Movies.               │
│ [ Save watch ]                       │        │ [ Re-check placement ]  usually 2    │
└──────────────────────────────────────┘        │  Keep at #72                         │
                                                └──────────────────────────────────────┘
LogSheet When row (normal log, never-seen title):   When?  (●Today) (Earlier) (Pick a date)
LogSheet When row (already-seen title):             Date not recorded · Add date      ← no stamp
```

---

## K. Feed semantics

| Act | Posts? | Payload | Rendered (new client) |
|---|---|---|---|
| First ranking | yes (unchanged) | `title_ranked {position, bucket, category, score}` | *Ada ranked Heat* · 8.7 |
| Rewatch + keep | **yes, if the event is native-dated within 7 days** (`today_default`/`reader`) | `title_ranked {…, again: true, watch_event_id}` | *Ada watched Heat again* · 8.7 |
| Rewatch + re-check | **the same single event**, its `score` updated to the new one; `from_*` and `outcome` are **not** put in the payload | | *Ada watched Heat again* · 9.1 |
| Rewatch backdated, `diary`, or `none` | no | | |
| Legacy-client rewatch (`none` event) | yes, as today (the act is contemporaneous) | `again: true` | as above |
| Correction, Refine, queue ranking, bulk seen | no | | |
| Remove one watch | deletes that watch's post | | |

**No movement chip (founder, 2026-09-19).** The feed and share cards show the verb, the title
and the score, and nothing about where the title moved. The payload carries no `from_position`
and no `outcome`, so a future client cannot render movement from history it was never sent —
the privacy rule is in the data rather than in the template. The reader still sees their own
movement on the reveal and in Watch History. The watch **date** never appears either.

**Why `title_ranked` + `again`, not a new type.** Installed clients read types through an `IN`
list, so a new type would be invisible until the OTA arrives. Old clients render *ranked Heat*,
which is true.

**Volume**: at most one rewatch post per title per 7 days. The target change in posts per active
user per week is under +5%.

---

## L. Score and metric semantics

### L.1 Five ranking words, five things

| Concept | Definition | Stored? | Read by |
|---|---|---|---|
| **Ordinal** | `rankings.position`; the only ranking truth | yes | everything |
| **Band rank** | 1-based within the band | derived | score |
| **Display score** | `score_for(bucket, band_rank, band_size)`, one decimal | derived live, reflows | Collection, title, profile |
| **Internal projection** | the same formula, unrounded; used only to order mixed movies + seasons | derived | cross-category sorts |
| **Placement snapshot** | `ranking_placements.{position, score, band_*}` | yes, immutable | Watch History, movement |
| **Feed snapshot** | `feed_events.payload.score` / `from_*` | yes, immutable | feed |
| **Placement support** | the §G evidence record | never stored, never a number | Refine only |

No average of snapshots; no snapshot feeds the current score; community score and Taste Match
read `rankings` only.

### L.2 Metrics matrix: consumption vs engagement

**Guiding rule.** Time-independent metrics may include undated seen titles. Time-bound
consumption metrics require a watch date (native-dated or diary-dated) and never fall back to a
recording time.

| Metric | Kind | Unit | Undated seen titles | Diary dates | Native dates (incl. `unattributed`) | Clock |
|---|---|---|---|---|---|---|
| Collection / seen count (profile Movies/TV) | time-independent | distinct seen titles | **yes** | yes | yes | none |
| Unique titles watched (lifetime) | time-independent | distinct seen titles | **yes** | yes | yes | none |
| Total known watch events | time-independent | events | **yes** (an undated event is a known viewing) | yes | yes | none |
| Rewatch count | time-independent | events beyond each title's first | yes | yes | yes | none |
| Lifetime hours | time-independent | Σ runtime × events | yes | yes | yes | none. TV is blocked on season runtimes (`tmdb_upsert_seasons` writes none), so it is movies only until then |
| Lifetime genre/director/decade stats | time-independent | seen titles | yes | yes | yes | none |
| Ranking, taste, Match, community score | time-independent | ranked titles | yes | – | – | none |
| All-time leaderboard (titles/movies/tv) | time-independent | seen titles, `source <> 'imported'` | unchanged from today (native-wins, 2026-09-11) | – | – | none |
| **Yearly movie goal** | time-bound consumption | distinct movies with ≥ 1 event dated in the year | **no** | **yes** (goal contract: genuine diary dates count) | yes | `watched_on` |
| **Yearly TV goal** | time-bound consumption | distinct seasons, same rule | **no** | yes | yes | `watched_on` |
| **Monthly leaderboard** (titles/movies/tv) | time-bound consumption | distinct titles with ≥ 1 **native-dated** event in the month | **no** | **no** (R2) | yes | `watched_on`; **no `created_at` fallback** |
| Monthly reviews board | engagement | first publication | – | – | – | `note_first_published_at` (unchanged) |
| **Weekly streak** | **engagement** ("you ranked this week") | weeks with a ranking act (first, rewatch or import placement) | – | – | – | `rankings.created_at` (latest ranking act); corrections and refines excluded |
| Annual stats ("your 2026") | time-bound consumption | events and titles dated in the year | **no**; shown separately as "+ N seen, date unknown" | yes | yes (see §M.7 on `unattributed`) | `watched_on` |
| Recap (quarter/year) | time-bound consumption | as annual | **no** | yes | yes; the first recap offers the §M.7 review | `watched_on` |
| Watch-over-time chart | time-bound consumption | dated events by period | **no**; one "date unknown" total beside the chart, never spread across periods | yes | yes | `watched_on` |
| Title page "Watched <date>" | display | the latest known date | shows nothing | yes | yes | cache |
| Company: viewing analytics ("what bingd watched this week", trends) | time-bound consumption | native-dated events | no | no (history is not current viewing) | yes | `watched_on` |
| Company: product-engagement analytics (logging volume, rankings, imports, Refine use, activation) | engagement | acts | n/a | n/a | n/a | `recorded_at`, ledger `created_at`, `user_media.created_at`, analytics events. **Never presented as consumption.** |
| Recently added / Recently ranked sorts | engagement | – | – | – | – | `user_media.created_at` / `rankings.created_at` |

**The undated historical movie, checked against the rule:**

| | |
|---|---|
| Counts as seen / all-time Collection | ✔ |
| Participates in ranking, taste and lifetime stats | ✔ |
| Watched in 2026 | ✘ |
| Counts toward the 2026 goal | ✘ |
| September 2026 viewing activity | ✘ |
| In a 2026 recap | ✘ |

---

## M. Migration and compatibility

### M.1 Principles

- Forward-only; applied files are immutable.
- Staging first, through the transactional runner, with parity proven.
- Flags wherever a behaviour can be flagged.
- Every rebuilt function is rebuilt from its **true latest body** and mechanically diffed.

### M.2 Must land together, and can be separate

| Must be one migration | Why |
|---|---|
| `watch_events` + basis enum + backfill + the deferred seen→event trigger + the cache trigger + the provenance change + rebuilt `log_watched` / `clear_watch_date` / `_import_apply_batch` + `log_title` / `set_watch_date` | a gap lets events and the cache drift |
| `ranking_placements` + backfill + session/comparison columns + the rebuilt ranking family (`_rank_finalize`, `_rank_start_impl`, `rank_answer`, `rank_skip`, `rank_back`, `rank_again`, `rank_rebucket`, `rank_reorder`) | shared session semantics; the rebuild trap |
| Goal repoint: client **first**, then the server trigger | the reverse order announces completions the bar doesn't show |

### M.3 Backfill (T1, one transaction, under the quiet marker)

For each `user_media` row of a rankable kind:

1. **Diary**: one `diary` event per `imported_watches` row (`import_ref = diary_uri`,
   `recorded_at = imported_at`).
2. **Prior viewing**: if the title's earliest `imported_watches` row has `is_rewatch = true`, one
   `none` event with `import_ref = diary_uri || '#prior'`.
3. **Native date**: if `source = 'in_app'` and `watched_on` is not null and no diary event shares
   that date, one `unattributed` event on that date (`recorded_at = user_media.created_at`).
4. **Imported row without diary evidence** but with a `watched_on`: one `diary` event on that
   date. That date came from the diary maximum, so it is authoritative.
5. **Otherwise**: one `none` event (`recorded_at = user_media.created_at`).

**R3 (founder): no inferred rewatches.** Every field that could be read as rewatch evidence, and
what it actually encodes:

| Stored field | Encodes a new watch deterministically? | Used? |
|---|---|---|
| `imported_watches` rows (one per Letterboxd diary entry, per-viewing URI) | **yes**: each is a distinct viewing, asserted by the source | ✔ steps 1–2 |
| `imported_watches.is_rewatch` | **yes**: the source's own assertion of an earlier viewing | ✔ step 2 |
| `feed_events` `title_ranked` duplicates | **no**: the payload has no new-watch flag, and an unrank + re-rank also reposts | ✘ |
| `ranking_sessions.new_watch` | **no**: sessions are deleted at finalize; survivors are unfinished | ✘ |
| `processed_operations` (`kind = 'rank_again'`) | **no**: no arguments are stored, and the stored result is the session start, without `new_watch` | ✘ |
| `user_media.watched_on` / `updated_at` | **no**: one overwritten date | ✘ |
| Client analytics (`ranking_completed.mode = 'again'`) | **no**: external, id-free by design, not a data source | ✘ |

**Pre-epic in-app rewatches are therefore not recoverable, and history starts incomplete for
them.** That is the honest outcome.

**Verification queries** (staging, then production, read-only):
- every rankable seen row has ≥ 1 event;
- `basis = 'none'` ⇔ the date is null;
- the cache equals `max(watched_on)` for every row;
- the `imported_watches` count equals the diary events with a plain `import_ref`;
- the placements count equals the rankings count;
- `assert_ranking_valid` passes for all accounts;
- **the diff script lists every row whose cache value changed**, which should be only native
  rows with a later diary date.

### M.4 Compatibility window

- Installed iOS 1.0.1 builds and the Android beta keep every signature and its user-visible
  meaning (§D.5). They silently gain the prior search.
- Old-client date writes are marked `unattributed`, which is honest.
- Sessions open across the deploy default to `legacy` / `bisect`.
- New RPCs have new names.
- No native dependency is expected; prove it with a fingerprint compare before each OTA.

### M.5 Readers, one by one

| Reader | Today | After | Tranche |
|---|---|---|---|
| LogSheet stamp | stamps Today whenever the settled row is dateless | stamps only a row this sheet created (T0b); then replaced by atomic `log_title` (T3b) | T0b / T3b |
| `user_media.watched_on` (title line, LogSheet, award detail) | the one date | the latest known date; null = no known date | T1 |
| Goals (client + trigger) | distinct titles by the cached date | distinct titles with an event dated in the year (native or diary) | T4 |
| Monthly leaderboard | `coalesce(watched_on, created_at)`, excluding imported | **native-dated events only, no fallback** (R2) | T4 |
| All-time leaderboard | seen, excluding imported | unchanged | – |
| Streak, Recently ranked, people suggestions | `rankings.created_at` | unchanged reader; now correct (T0), defined as the latest ranking act | T0/T2 |
| Awards collection tracks, profile counts | seen titles | unchanged | – |
| Feed | `title_ranked` | `again` + enrichment | T3 |

**Expected visible changes at T4** (diffed per account first):
- **Goals** can rise for titles with an earlier native date plus a diary or rewatch date this year.
- **The monthly board** falls for (a) undated in-app rows that were credited by `created_at`, and
  (b) ranked imports that were credited the same way. That is R2's intended effect.

### M.6 Rollback

- **T1**: readers are still cache-based. A forward migration can restore the legacy writer bodies,
  and the events remain as harmless history.
- **T2**: `ranking.prior_search_enabled = false`.
- **T3–T6**: OTA rollback groups plus flags (`feed.rewatch_posts`, `ranking.refine_enabled`,
  `ranking.queue_enabled`, `collection.add_seen_enabled`).
- **T4** changes numbers people saw, hence the diff.
- `imported_watches` is not dropped in this epic.

### M.7 Legacy-data policy

| Data | Policy |
|---|---|
| Every seen row | migrates as seen, unchanged |
| Every in-app `watched_on` (pre-epic) | migrates as one `unattributed` event on **the same date**. **Never moved, nulled or reclassified automatically**: not for being near signup, not for arriving in a burst, not for looking historical. It keeps counting where it counts today (goals; the monthly board of its month), so no user loses progress they have seen. |
| LogSheet auto-stamps and the §C.3.7 defect's dates | indistinguishable from deliberate dates (no stored intent), so they are treated exactly like the row above |
| Letterboxd diary entries | migrate as `diary` events with their true dates (authoritative) |
| Letterboxd earliest-entry Rewatch flag | migrates as one `none` prior-viewing event (authoritative) |
| Native row + a later diary date | the cache moves to the later diary date (authoritative data adding a viewing). The native event is untouched. |
| Pre-epic in-app rewatches | **not backfilled** (R3). History starts incomplete. |
| Feed history, `rankings.created_at` values already written | untouched. T0 only stops *future* resets. |

**Automatic repair is allowed only from authoritative source data**, meaning a Letterboxd diary
row. In practice that repairs nothing in place: it only *adds* dated viewings.

**Optional cleanup: warranted, later (T7), and always user-initiated.** *Review watch dates*,
reachable from Watch History and Settings, lists `unattributed` dates grouped by recording day.
One action, *Mark these as "seen earlier, date unknown"*, converts the selected events to `none`.
Nothing changes without the tap.
- The app may **suggest** it once, as a dismissible card, when an account holds ≥ 20
  `unattributed` dates recorded on a single day. That is a suggestion, never an edit.
- The first annual stats view or recap containing `unattributed` dates offers it before
  rendering.
- `today_default` dates created after T3b are the reader's visible choice and are not offered for
  cleanup by default.

---

## N. PR decomposition

| PR | Content | Server | Client | Depends |
|---|---|---|---|---|
| **N0** | T0: the correction marker **re-implemented from current main** under a new migration version. It is **not** a merge of #118's file, whose `20260911000100` collides with the applied Helpful-reviews migration. `_rank_finalize` is rebuilt from `20260902000100` and the watchlist-leave functions from their latest bodies, with a mechanical diff. `created_at` is preserved for corrections, re-added watchlist rows are kept, and a derived-streak test proves a correction adds no week. `streak.ts`'s false header is fixed. Close #118 with a pointer. | migration | comment | – |
| **N0b** | T0b: LogSheet stamps Today **only when this sheet created the row** (the row was absent when the sheet opened); "I don't remember" is relabelled **Earlier**. Tests: an existing undated row plus a bucket choice writes no date; a new row writes Today. | – | OTA | – |
| **N1** | `watch_events` foundation (§M.2 row 1), backfill, `assert_watch_history_valid()`, the diff script. No UI. | migration | – | N0 |
| **N2** | Placement ledger, prior policy, clean comparisons, movement in responses, flags. | migration | – | N1 |
| **N3** | `log_rewatch` / `edit_watch_event` / `delete_watch_event`; feed `again`, enrichment and deletion. | migration | – | N2 |
| **N4** | Client: Log another watch → Keep / Re-check; the **Watch History screen** (`app/title/[id]/history.tsx`) and its `Watched N times ›` entry; the When row (`log_title` / `set_watch_date`); private movement copy. No History tab. | – | OTA | N3 |
| **N5** | Goals repoint (client, then trigger), monthly board to native-dated events with no fallback, per-account diff. | migration | OTA first | N1 |
| **N6** | `placement_support`, `refine_candidates`, `ranking_snoozes`, `rank_replace(kind = refine)` with tolerance. | migration | – | N2 |
| **N7** | Client: the Refine route, card, checkpoint and summary. | – | OTA | N6 |
| **N8** | Queue v2, queue-context `rank_start` (no post, no fulfilment), `add_seen`, the *Add what you've already seen* grid, the import-summary repoint. | migration | OTA | N2, N5, N6 |
| **N9** (later) | Undo this move; v1.1 support; the star-prior experiment; *Review watch dates*; stop writing `imported_watches`. | | | data |

---

## O. QA plan (no manual account farm)

### O.1 Deterministic fixtures

- **`seedLibrary()`** (PGlite harness) writes seen rows, events of every basis, rankings and ledger
  rows consistently. It runs behind `assert_ranking_valid` and `assert_watch_history_valid`.
- **Sizes** 50 / 500 / 1,000 / 2,500 via `generate_series`. `volume.ts` gains histories of 1, 8,
  20 and 60 events, with `maxRows` / `maxInList` for every new list read.
- **The migration fixture** holds every awkward pre-epic shape:
  - an in-app dated row plus diary entries, on the same date and on later dates;
  - a multi-diary imported row, and an earliest-entry Rewatch flag;
  - `watched.csv`-only rows, and an in-app undated row;
  - an existing-undated row later stamped by the §C.3.7 defect;
  - a ranked import, and a series row;
  - duplicate `title_ranked` posts (which **must not** become events);
  - a session open across the migration;
  - a re-added watchlist row;
  - a burst of 200 rows dated on one signup day (which **must** stay untouched).

### O.2 State-machine and property tests

**Ranking:** the oracle driver (a hidden true order, seeded noise) runs the real RPCs through
random sequences of answer, skip and back. After every step:
- I1–I4 hold;
- one ledger row per finalize, and none per replay;
- `from_position` and `position` are exact;
- **no movement without an answer**;
- `Still` ⇔ both checks passed;
- a noise-free prior search equals plain bisection exactly;
- the comparison count stays under the §F.3 bound;
- a withdrawn comparison is never linked;
- the watch count is unchanged by any ranking or Refine RPC.

**Watch semantics**, asserted per entry path in §D.6 (each path is a test):
- seen ⇔ ≥ 1 event;
- `basis = 'none'` ⇔ null date;
- the cache equals the max after every write;
- ranking an already-seen undated title writes no event and no date;
- `add_seen`, the queue mode and Refine never write a dated event;
- old-client `log_watched` writes `unattributed`.

**Recording ≠ watching:** a repository test fails on any SQL or TypeScript expression that
coalesces `watched_on` with `created_at` or `recorded_at`, or that treats a null `watched_on` as
unwatched. The one existing instance is removed at T4.

**Policy equivalence:** the TypeScript `next_pivot` is fuzzed against the SQL over random
`(lo, hi, p, w, n)`.

**Resume matrix:** kind X resumed as kind Y restarts.

### O.3 Simulator

`scripts/sim/rerank.mjs`: reproduces §F.3, tunes `G`, and decides §I.4.

### O.4 Races and retries (`npm run test:race`)

- `log_rewatch` ∥ `unlog`;
- `log_rewatch` ∥ a rewatch finalize;
- two finalizes in one category;
- `edit_watch_event` ∥ `delete_watch_event`;
- import apply ∥ `log_rewatch` (no `none` event left beside a diary event unless the prior rule
  applies);
- `log_title` ∥ `set_bucket` on a new title (exactly one event);
- replays of every new RPC.

Each gets a mutation check.

### O.5 Importer fixtures

Multi-entry diaries, Rewatch flags, same-day duplicates and no-date rows. Assert:
- events equal the diary entries (plus the prior rule);
- a re-import adds zero events;
- remove + re-import re-attaches;
- a native date and a diary date on the same day yield one event;
- queue order follows §I.2;
- ranking 30 queue titles writes 0 events, 0 feed posts, 0 fulfilments and 0 monthly-board
  change;
- `add_seen` of 300 titles leaves the 2026 goal and the September board unchanged.

### O.6 Hardest failure modes, named

1. **Silent movement.**
2. **Cache drift.**
3. **Double-counted watches**: a `none` event beside a diary event; a native date and a diary date
   of one viewing.
4. **A wrong "from".**
5. **A cross-kind resume.**
6. **The #118 class returning.**
7. **Recording read as watching**: a new reader falling back to `created_at`; the LogSheet stamp
   returning on existing rows.
8. **Fabricated dates** from ranking, Refine, the queue or bulk entry.
9. **Number shifts at the repoint** without a diff.
10. **Feed floods.**
11. **Legacy-client breakage.**
12. **The SQL rebuild trap.**

### O.7 Founder device QA (one seeded account, about 25 minutes)

`scripts/ops/seed-calibration-fixture.mjs` (staging, service key) creates one preview-lane
account: 300 ranked titles over 18 months, 200 imported unranked titles with diaries and stars,
one 20-watch title, and one signup-day burst of 50 `unattributed` dates. The founder checks:

1. Search → log a film with the Today default: "Watched today". Log another with *Earlier*:
   no date, not in the 2026 goal.
2. Rank an undated imported title from its page: **no date appears**.
3. Log another watch → Keep, then Re-check unchanged (2 comparisons, `Still #N`), then a big move
   (the private copy is exact; the feed chip reads "spots" when the move is deeper than #50).
4. Too tough ×3 → `Kept at #N`.
5. The Watch History screen with 20 watches on the smallest Android device: scroll, edit a date
   inline, remove a watch, then try to remove the only remaining one. Check the entry line reads
   `Watched 20 times ›`, and that a one-watch title never reads `Watched 1 time`.
6. Refine: 5 targets, a checkpoint, *I don't remember* → snooze.
7. Rank what you've watched: 10 titles, 0 posts, the board unchanged. *Add what you've already
   seen*: 30 posters, the goal unchanged.
8. Kill the app mid-comparison in each mode → it resumes correctly.

---

## P. Analytics and success metrics

Allowed keys only; no titles, ids, dates or people. `basis` joins `ALLOWED_PROPERTY_KEYS` as a
closed enum.

| Event | Properties |
|---|---|
| `watch_logged` | `kind: first|rewatch|past`, `basis`, `surface` |
| `seen_added` | `count` bucket, `surface` (bulk) |
| `rewatch_decision` | `choice: keep|recheck` |
| `ranking_completed` (existing) | `mode` gains `rewatch|refine|queue`; add `outcome`, `distance`, `comparisons`, `skips` |
| `refine_session_ended` | `targets`, `moved`, `comparisons`, `ended_by` |
| `refine_target_outcome` | `outcome`, `reason` |
| `queue_session_ended` | `placed`, `skipped`, `dont_remember` |
| `watch_history_opened` | `watch_count` bucket |
| `date_review_applied` (T7) | `count` bucket |

**These are engagement events.** Their timestamps are recording times and must never feed a
consumption metric (§L.2).

| Question | Metric | Healthy | Kill/rethink signal |
|---|---|---|---|
| Is the rerank cheaper? | median comparisons, re-check `unchanged` | ≤ 2.2 | > 3 |
| Do people re-check? | `recheck / (keep + recheck)` | 30–70% | < 10% |
| Is Refine worth it? | moved per 10 answers | 1–4 | ~0 or > 6 |
| Refine adoption | % of users with ≥ 50 ranked who finish a round a month | 20%+ | < 5% |
| Imports become rankings | % of imports ranked within 30 days | 20% | – |
| **Is dating honest?** | share of first logs by basis; % with `Earlier`; `today_default` logs per user per day in the first week (a burst means backfill is still going through the normal flow) | `Earlier` or bulk used by backfillers | ≥ 30 `today_default` logs in one day for many new users → promote the bulk entry harder, or adopt R4 |
| Guardrails | posts per active user per week; ranking abandonment; importer W2 retention | ±10%; no rise; no drop | |

---

## Q. Explicit non-goals

- Episode-level tracking.
- Automatic decay, recency weighting, averaging placements or scores, per-watch ratings.
- Any ranking derived from comparisons rather than placement; a visible confidence number.
- **A per-title "historical / previous watch" checkbox; any account-age heuristic.**
- **Automatic date repair or reclassification** of any in-app date; inferring rewatches from
  feed history.
- **Partial date precision** (year-only dates) (§D.8).
- ~~Per-watch companions and notes.~~ **Reversed in #196's founder QA (2026-09-21):** a
  rewatch carries its own note and watched-with (`20261014000100`, `log_rewatch_with_details`,
  `set_watch_details`). Per-watch **ratings** remain a non-goal; what a watch keeps is the score
  it was posted with (`20261015000100`), not a separate rating.
- A Diary tab, past-year stats, recaps: **unblocked**, not built.
- Public watch counts or dates; another user's placement history.
- A drag-to-reorder UI; Refine notifications; Refine, queue or bulk-seen activity in the feed.
- Import re-merge; dropping `imported_watches`; PRD §11's bonus comparison.

---

## R. Founder decisions

**Resolved and applied:**
- **R1 (2026-09-19, narrowed the same day).** Movement is **private-only in v1**: exact ordinals
  at any depth on the reader's own surfaces, nothing public at all (§B.2, §E.2, §K).
- **R2.** The monthly leaderboard credits only **native-dated** watch events in the month: no
  `created_at` fallback, no diary credit, no credit for ranking or importing (§L.2, §M.5).
- **R3.** Legacy rewatch backfill comes only from authoritative stored evidence — the Letterboxd
  diary rows and their Rewatch flag. Nothing is inferred from feed posts (§M.3).
- **R4.** The session-scoped *Earlier* carry is approved and **shipped** in T0b: client memory
  only, 30 minutes of logging activity, reset on restart, never persisted, never inferred.
- **One collection state in the interface** (§D.0): no Logged-versus-Watched split anywhere.
- **Refine is conditional, finite, and never overlaps the unranked queue** (§H.1).
- ~~**Notes stay title-level**; per-watch notes remain deferred (§D.4).~~ **Superseded
  2026-09-21:** the review stays title-level (`user_media.note`), and each watch may carry its
  own private note and companions (`20261014000100`).
- **Yearly goals** move to dated watch events **without adding logging friction**: the normal log
  still defaults to Today in one tap, and the goal simply counts what has a date (§L.2, T4).
- **Unmatched Letterboxd rows** get the lightweight *Review unmatched titles* flow, Skip
  included (§I.7).

- **The rewatch surface (2026-09-19).** Option **A**, with a **full pushed screen** rather than
  a sheet: a prominent `Watched N times ›` entry on the personal context line opens
  `app/title/[id]/history.tsx`. **No History tab in v1** (§J). A single viewing never reads
  "Watched 1 time".

**Still open: none.** T0–T5 are built and shipped (see the status block at the top).

---

## RECOMMENDED BUILD SEQUENCE

| Tranche | Scope | Size | Ships to users | Gate to proceed |
|---|---|---|---|---|
| **T0: Correction hygiene** ✅ **LIVE** | PR #180, merge `4a88237`, migration **`20261001000100`** applied to staging and production 2026-09-19. `created_at` preserved through a correction; the watchlist rule is chronological; a re-rating is not "becoming watched"; #118 closed as superseded | S | streak and Recently ranked stopped lying | done |
| **T0b: Stop fabricating dates** ✅ **SHIPPED** | PR #174, merge `ed644cb`. LogSheet stamps only rows it created; *Earlier*; the R4 carry | XS | ranking a seen title no longer claims "watched today" | done |
| **T1: Watch history foundation** ✅ **SHIPPED** (#196) | N1: `watch_events` with basis, backfill (R3-compliant), cache and seen triggers, rebuilt legacy writers, `log_title` / `set_watch_date` | M | nothing visible | done |
| **T2: Placement ledger + prior-anchored rerank** ✅ **SHIPPED** (#196) | N2 | M–L | corrections get cheaper, silently | done |
| **T3: Rewatch server** ✅ **SHIPPED** (#196) | N3 | S–M | – | done |
| **T3b: Rewatch UX + honest logging** ✅ **SHIPPED** (#196) | N4: Log another watch, the Watch History screen and its entry line (§J, locked), the When row via `log_title`, private movement copy | M | **yes**, the headline feature | done |
| **T4: Readers repoint** ✅ **SHIPPED** (#196) | N5: goals (native + diary), monthly board native-only with no fallback (R2), per-account diff | M | correct cross-year goals, an honest monthly board | done; both flags on in production |
| **T5: Unified Backlog + Refine** ✅ **SHIPPED** (#203) | N6 + N7, plus the unified backlog that replaces T6's queue | L | **yes** | Refine's production flag waits on the backlog smoke |
| ~~**T6: Rank what you've watched + Add what you've seen**~~ | **Eliminated as a standalone flow**: the unified backlog (T5) is the ranking half. *Add what you've already seen* (§I.6) is **deferred** | – | – | – |
| **T7: Follow-ups** — deferred | N9: *Review watch dates*, Undo this move, v1.1 support, the star prior, `imported_watches` retirement | S each | incremental | per item |
| **T6b: Review unmatched titles** (§I.7) — deferred | the import repair flow, Skip included | S–M | **yes**, for importers | T1 (done) |
| **T6c: Letterboxd Lists import** — deferred post-freeze | a separate acquisition/migration feature, not part of this epic's core ([`letterboxd-lists-import.md`](./letterboxd-lists-import.md)) | L | **yes**, for importers | #196 + #200 in production (both met), founder go |

**Critical path:** done through T5. What remains (T6b, §I.6, T7) is deferred, not scheduled.

**Migration numbering from here.** Both projects stand at **`20261019000100`** (168 applied,
2026-09-23). The next free number is **`20261020000100`**. Recheck both projects' applied head
and every open PR before choosing one: this epic was renumbered three times because the
projects and other branches moved underneath it (T1 was drafted as `20261002000100` and
shipped as `20261003000100`; T5 went from `20261013000100` to `20261019000100`).
