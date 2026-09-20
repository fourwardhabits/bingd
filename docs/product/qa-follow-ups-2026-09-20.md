# Founder device QA on Android vc12 — follow-ups, specified and not built

**Build:** 1.0.1 (12), EAS `d96ade7e`, from `6d2f8455458afabc42d1cfd0a0bd68f5bd2ae343`.
**Date:** 2026-09-20. Core functionality passed; these are the residue.

Nothing in this document is implemented. Each item records the founder's decision or
observation, what the code does today, and what it would take — so that the next tranche
starts from a settled question rather than a re-investigation. Two release blockers were
raised alongside these and are answered in `docs/release/vc12-qa-triage.md`; neither
required a client change.

---

## 1. The second confirmation after *Update your rating*

**Founder decision.** The confirmation that follows *Update your rating* — "Rank
*[title]* again?" — is redundant. The preferred flow is:

> *Update your rating* → bucket → comparisons

with nothing committed until the comparisons finish.

**Why it is safe to remove.** Since `20260826000500` opening a ranking session is
non-destructive: `rank_again` and `rank_rebucket` open a session over the position the
title already holds and replace it only at the placement, so arriving on the sheet and
leaving writes one `ranking_sessions` row and nothing else. The second confirmation is
guarding a destruction that no longer happens. `RankingSheet.tsx`'s own header says as
much ("There is no longer such a thing as opening destructively").

**Shape.** Remove the confirmation step between the row and the bucket picker; keep the
bucket picker, which is a real choice. One decision to re-check: the row is the only
place that currently names the title, so the bucket sheet must.

---

## 2. Sent to you — read state and ordering

**Founder decision, in full:**

- Sort by **recommendation recency, newest first**.
- Unread state must **not** affect ordering.
- Reading an item must **not** move it.
- Opening *Sent to you* marks the recommendations **actually loaded and displayed** as
  read. Opening each title is not required.
- New recommendations arrive at the top by timestamp.
- Resend/update may move an item by recency, under the existing resend semantics.

**What happens today.** `recommendations_to_me` orders **unopened first, then newest
within that** — `use-sent-to-you.ts` documents the ordering as the database's and builds
`unopenedIsAtLeast` on top of the guarantee that unopened rows are a prefix. So today an
item *does* move when it is read, which is exactly what the founder is rejecting. Read
state is per-row `opened_at`, set by `mark_recommendation_opened` when the reader taps
through to the title — not on list display.

**What it touches.** The RPC's `order by`; `unopenedCount` / `unopenedIsAtLeast` and the
tab's dot, which currently lean on the unopened-first prefix; and a new "mark the
displayed page read" call, which is a different trigger from the current per-title one and
needs its own idempotence (the `reportedOpens` module set is per-title today).

Not a bug — a deliberate ordering the founder has now changed their mind about.

**Can it be done server-side alone, without retesting vc12? No — and it should not be.**
The `order by` lives in `recommendations_to_me`, so the *ordering* half is one RPC change.
But two things stop it being a free backend correction:

- it would silently change vc12's behaviour in the field, which is a change to a shipped
  build without the build being retested — the thing this release process exists to avoid;
- `unopenedIsAtLeast` derives the "200+" chip from the guarantee that unopened rows are a
  **prefix** of the page. Reorder underneath a client that still believes that and the
  chip becomes wrong (only past 200 recommendations, so not reachable today — but it
  would be a latent wrong answer shipped deliberately).

And the second half — *marking the displayed page read* — is unavoidably a client change:
nothing server-side knows what was displayed.

**Recommendation: one post-launch client tranche**, changing the RPC ordering, the chip's
derivation and the mark-on-display call together, tested as a unit.

---

## 2b. Dismiss a recommendation you do not want

**Founder decision.** *Sent to you* needs an X / Dismiss that removes the recommendation
from the recipient's queue and takes its note off the title page for that reader — and
does nothing else: no dislike, no Taste Match effect, no watchlist change, no notification
to the sender, no block or mute, no feed activity. Bookmark stays as the "save it"
affordance.

**Verdict: this is almost entirely already built.** `dismiss_recommendation(uuid)` exists
(`20260826000400`), is granted to `authenticated`, and its semantics are the founder's
list verbatim — the row becomes a **tombstone** rather than a deletion, and its own
comment records that "the sender is not notified, not unfollowed and not blocked".

It is scoped to requests:

```sql
   where r.id = p_recommendation_id
     and r.recipient_id = auth.uid()
     and r.state = 'pending';        -- <- the only thing in the way
```

**The smallest implementation is one predicate:** widen that to
`and r.state in ('pending', 'delivered')`.

Everything the founder asked for then follows without touching a read path, because the
recipient's row-level policy is

```sql
using (recipient_id = auth.uid() and state = 'delivered')
```

and **both** read RPCs (`recommendations_to_me`, `title_recommendations_for_me`) are
`security invoker` precisely so that this policy is the only visibility rule. The moment
the row is `dismissed` it stops being admitted, so it disappears from *Sent to you* and
from the title-page card and its note together, with no change to either function.
`_rank_finalize` fulfils only `state = 'delivered'` rows, so a dismissed recommendation
correctly stops being fulfillable.

**The one decision to make first.** The pair is unique on
`(sender_id, recipient_id, media_item_id)`, so a sender re-sending a dismissed title hits
the existing upsert. Today's pending-dismiss comment says the sender "may send the same
title again". Either that stays true for a dismissed delivered row — in which case
`recommend_title` must move `dismissed` back to `delivered` deliberately — or dismissal is
final for that pair. **Founder decision required**; everything else is mechanical.

**Tests required:** dismiss a delivered recommendation → gone from both read paths for the
recipient, still visible to the sender (the sender policy is unconditional), no
notification filed, no feed event, watchlist and rankings untouched; dismissing somebody
else's row is a no-op; a dismissed row is not fulfilled by a later ranking; and whichever
resend rule is chosen, asserted in both directions.

---

## 3. Director discovery

**Future bounded feature.** The director's name on a title page should be tappable and
lead to a person/filmography surface.

To evaluate together, not piecemeal:

- person/director results in Search;
- whether Cast becomes **Cast & Crew**, which is probably the cleanest IA;
- what a person surface shows for somebody with one credit in the catalogue.

Explicitly **not before the Android launch.**

---

## 4. Offline

Airplane mode reaches *"We couldn't load your account."* Offline is **not a v1
requirement** and no offline caching is to be built.

The only thing worth checking is that the failure is recoverable, which it is:
`refetchOnReconnect` is on for queries and the app is expected to open offline and render
from cache rather than blank (`lib/query.ts`). Flag only if a future report shows the
state corrupting or signing the reader out — neither was observed.

---

## 5. TMDB synopsis

Title overview copy is **TMDB's**, carried through the catalogue, not authored or
generated by bingd. It must not be rewritten, humanised or em-dash-corrected: the
project's prose rules govern bingd-authored copy, and third-party catalogue metadata is
quoted, not written. No action.

---

## 6. Taste Match on a five-title account

Expected behaviour, not a defect. `taste.min_common` is 5, so an account with five titles
is at the floor: the evidence is sparse, the percentile bands are coarse, and the number
moves a long way on one more shared title. The algorithm is not to change in this tranche.

**Future UX idea, recorded only:** show the shared-title evidence count beside the match
("84% · 7 titles in common"), so a volatile number carries its own confidence. This is a
display change and needs no algorithm work.

---

## 7. Series-level recommendation

**Founder observation.** A series page can be watchlisted but not recommended; the reader
has to open a season first. Desired: recommend the **series object itself**, recipient
lands on the **series page**, *Sent to you* renders a sensible series row, notes behave as
they do elsewhere, and **no personal score is manufactured** for a series. Series stay
non-rankable; seasons stay rankable.

**Verdict: B — a small full-stack change.** Not trivial client enablement, because the
server refuses it; not structurally unsupported, because nothing in the schema objects.

What is actually in the way, in one line each:

| Layer | Today |
|---|---|
| `title_recommendations` | `media_item_id` references `media_items` with **no kind constraint** — a series row is storable as-is |
| `recommend_title` | Refuses via `if v_kind is null or rankable_category(v_kind) is null` (`20260929000100` line 167). **This is the whole blocker**, and it conflates *rankable* with *recommendable* |
| Read RPCs | `recommendations_to_me` and `title_recommendations_for_me` already project `media_kind` and `series_title`, so the read side can render a series row without schema work |
| Client | The Feed hides the control on `kind === 'series'`; the title page does the same. Routing already has a series page to land on |
| Score | A series has no ranking, so `public_scores` returns no row and the badge is simply absent — the "do not manufacture a score" requirement is satisfied by construction |

**Work required:** replace the `rankable_category` gate with an explicit *recommendable
kind* predicate (movie, season, series); drop the client guards on the series page and
the Feed; confirm the *Sent to you* row and the title-page card read well with no season
number; tests for each of send / resend / open / fulfil against a series, plus a
regression that a series recommendation manufactures no score and does not make the
series rankable.

---

## 8. Series watchlist — clearing on first evidence

**Founder preference.** A series on the watchlist means *"I intend to start this show."*
Watching or ranking **any** season should satisfy that intent and clear the series entry.

**What happens today.** `_leave_series_watchlist` removes the parent series only when
**every currently released normal season** (`season_number > 0`, released) is watched or
ranked — `20260906000100`, amended by `20261001000100`. So ranking season 1 of a
five-season show leaves the series on the watchlist.

That is documented intent rather than a regression, so it is **not** changed here. The gap
is precisely: *complete-the-series* versus the founder's *first-evidence* rule.

| Case | Today | Founder's rule |
|---|---|---|
| Rank season 1 of many | series **stays** | series clears |
| Rank the last released season | series clears | series clears |
| Log an already-seen season | same rule, via the `user_media` trigger | clears |
| Imported historical season | same rule | clears |
| **Correction / rerank of a ranked season** | **does not touch a re-added series entry** | must not touch it |

**The correction half already behaves as the founder wants, and is tested.**
`20261001000100` gave the rankings triggers a chronology clause — a correction keeps the
`created_at` the ranking already had, so it can only remove a watchlist entry older than
itself. Cited: `supabase/tests/correction-is-not-a-ranking.test.mjs`, §"a deliberately
re-added watchlist entry survives a correction" → *"for a series the reader re-added after
finishing it"*, plus *"but Log another watch satisfies it, as it always did"*.

So the change, if the founder wants it, is bounded to the *first-evidence* rule: the
completion count in `_leave_series_watchlist` becomes "any released normal season has a
watch signal". The vacuous-truth guard (a series whose seasons are not in the catalogue is
never removed) should survive unchanged, and the advisory lock is unaffected.

---

## 9. Release awareness from implicit interest — hypothesis only

**Recorded, not decided and not implemented.** A reader who rates a series in, say, the
top ~10% of their TV rankings might have enough implicit interest to qualify for new-season
awareness without a watchlist entry.

The current explicit/caught-up rules in
[`release-awareness.md`](./release-awareness.md) remain authoritative and are unchanged.

Before this could be specified it needs separate decisions on: implicit versus explicit
interest as a basis for a proactive notification at all; threshold stability on a small TV
library, where "top 10%" can be two seasons; notification volume against the cap; whether
caught-up status is still required; and where it sits in the hierarchy in
[`notifications.md`](./notifications.md) §11.

No testing and no release work attaches to this.
