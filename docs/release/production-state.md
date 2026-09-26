# Production state

**What is live right now.** One page, updated at every production release.

This exists because the release documentation was all *runbooks* — how a cutover was done
on a particular day — and none of it answered "what is production, today". The 2026-09-25
audit found the newest record was `stopping-point-cutover.md`, two days and four migrations
behind. A runbook ages into history the moment it runs; this does not.

`production-acceptance.md` is how production is proved. `safe-update-runbook.md` is how it
is changed. This is what came out the other side.

---

## The release

| | |
|---|---|
| **main** | `9d9683a` |
| **DB migrations** | **172 applied**, head `20261023000100` |
| **OTA group** | `01a0db04` |
| **iOS runtime** | `61efbf17` — App Store 1.0.1 |
| **Android runtime** | `da3c7f47` — Play vc12 |
| **Store binaries** | unchanged; this release is OTA-only |

Staging runs the same migration head. The preview lane runs **production code against the
staging backend** (see §"The two lanes" below).

---

## The semantics this release fixes in place

### Grouped Unranked ranking (`20261020000100`, `20261023000100`)

A sitting in the Unranked flow posts **one** `ranking_batch` event, not one per title.

- It is written as `ranking_batch_draft` while the sitting runs and **flipped to
  `ranking_batch` only when the sitting ends** — Done, a natural finish, or an explicit
  exit. A post that grew while you ranked would re-sort the feed under the reader.
- The representative title is the **last one placed** (`do update set media_item_id =
  excluded.media_item_id`). A sitting that placed nothing deletes its draft.
- It renders through the ordinary `ActivityRow`: poster, actor avatar over it, and
  `<Name> ranked <Title> and N more`, where *N more* opens the sitting's list.
- **A sitting of exactly one title is an ordinary ranking post**, badge included — it
  borrows the live score, because a batch payload carries none. Above one title there is no
  badge: the representative stands in for a set.
- A force-quit leaves an unfinalised draft, which is invisible to every reader. That is the
  accepted cost of needing no force-kill detection.

**It creates no watch.** No `watch_event`, no watch date set to today, no imported
Letterboxd date replaced, no change to the latest-watch date, no effect on Recently added,
and nothing counted for the monthly leaderboard.

### Review visibility and the remembered default

One model on all three surfaces — Log/Rank, Another watch, Watch History → edit — and the
object is always `user_media.note` with `note_visibility` and `note_has_spoilers`.
`watch_events.note` is a private diary line, owner-only by schema (`20261014000100`), and
nothing writes it.

- A reader's **first-ever** note opens with *Share as a review* **on**.
- After they change it explicitly, that choice is the default for the next **new** note
  (`note-visibility-pref`, per account, device-local).
- **A note that already exists always opens on its stored visibility and spoiler flag.** No
  default and no habit may move it. This is the rule that has survived every reversal of the
  other two.
- Title → **Write a review** opens shared whatever the habit is. That is an act, not a
  default.

### Review count

`title_review_count` and `title_reviews_v2` share one predicate — `note is not null and
note_visibility = 'public'` under `can_view_profile` — so the tab's number and its rows are
the same question. Both are invalidated together in `invalidateAfterCollectionChange`.

Public → private decrements immediately; private → public increments. The count previously
went stale for up to the 60s global `staleTime` because `['title-review-count', id]` is not
a prefix of `['title-reviews', id]`.

### Recently watched

The Collection's `watched` sort axis orders by the **latest real watch date**, with unknown
dates sunk in both directions. Watchlist keeps `added`. Ranking never moves a title in it.

### Watch metadata on a title page (§J.2, founder-locked)

| | |
|---|---|
| 1 watch, dated | `#2 in Movies · Watched Aug 17, 2026 ›` |
| 1 watch, **undated** | `#2 in Movies ›` — **no watch line, by design** |
| 2+ watches | `#2 in Movies · Watched 2 times ›` |

Never `Watched 1 time`. A title ranked without a dated watch shows no date, and none is
inferred: a ranking is not a viewing.

---

## Feature flags

| Flag | Production |
|---|---|
| `ranking.backlog_enabled` | **true** |
| `ranking.refine_enabled` | **false** |
| `goals.count_watch_events` | true |
| `leaderboard.monthly_from_events` | true |
| `push.delivery_enabled` | true |

---

## The two lanes

**Production** is `main` against the production Supabase project.

**Preview** is the *same* `main` code against the **staging** backend, installed beside the
shipped app. Since 2026-09-25 the preview candidate derives explicitly from the production
SHA rather than continuing as an independent branch, so the two lanes cannot drift
operationally — the only difference is the backend and whatever single unreleased fix is
being QA'd. Preview never points at production data.

---

## Updating this page

At every production release, change: the table at the top, any semantics the release moved,
and the flag table. If a release changes none of those, it does not need an entry — this is
a statement of the current state, not a changelog.
