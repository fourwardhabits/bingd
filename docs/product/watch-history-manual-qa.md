# Watch History T1–T4 — manual QA

**Written:** 2026-09-20, for `feat/watch-history-t1-t4`.
**Scope:** only what automation cannot establish. About 25 minutes on one seeded account.

This is deliberately short. 2,400 database assertions, five race scenarios and the client
unit tests already cover the semantics — what they cannot cover is **what a person sees
and whether it is legible**, and a QA script that re-walks the covered ground wastes the
one resource it is spending, which is a human being looking at a screen.

So each item below names the thing automation cannot reach, and nothing else.

---

## Before you start

**The flags.** T4's two flags start `false`, so goals and the monthly board behave exactly
as they do today. Items 9 and 10 are the only ones that need them on; do those last, and
turn them back off if anything looks wrong.

```sql
-- the state everything except items 9–10 assumes
select key, value from app_config
 where key in ('goals.count_watch_events', 'leaderboard.monthly_from_events');
```

**The build.** A preview build from this branch, against staging. None of this can be
checked on an OTA: T3b is a client tranche and the migrations are not applied anywhere
yet, so a device on the current beta will simply fail every write with a missing function.

---

## 1. The line, at one watch — the thing a test cannot see

Open a film you have logged once, with a date.

The context line should read exactly as it does today — `#2 in Movies · Watched Aug 17,
2026` — plus a chevron. **It must not say "Watched 1 time".**

*Why a person:* the assertion that the string is absent is automated. What is not is
whether the chevron reads as an affordance or as a stray character, and whether the line
still scans as one sentence with it there. Look at it on the smallest Android device you
have; if the line truncates, that is the finding.

## 2. The line, at two watches

Log another watch on that film (item 4 does this properly; for now any second viewing).

The line becomes `#2 in Movies · Watched 2 times ›`. The date is gone.

*Why a person:* the date leaving is correct — a single date cannot describe two viewings —
but it is a thing the reader will notice, and whether it reads as **a richer fact** or as
**information lost** is a judgement only somebody looking at it can make. This is the one
item most likely to produce a founder correction, so look at it deliberately.

## 3. Ranking an undated imported title shows no date

Find an imported title with no date (Collection ▸ Unranked, or a title whose line shows no
"Watched"). Rank it.

**No date appears anywhere** — not on the title line, not in the log sheet.

*Why a person:* T0b fixed the client and T1 fixed the server, and both are tested. What is
not tested is the whole path through the real sheet on a real device, which is where
§C.3.7 lived undetected for weeks.

## 4. Log another watch → Keep

Title page ▸ ⋯ ▸ *Log another watch*. The When row says Today. Tap **Save watch**.

You should land on *Saved · your Nth watch* with *Did it change your mind?*, and closing
from there should be a complete act — the viewing is recorded and the feed has one
"watched again" row.

*Why a person:* the sheet's central claim is that **closing is a valid answer**. Whether
it actually feels that way, or whether the screen reads as an unfinished form you have
escaped, is the entire design decision and cannot be asserted.

## 5. Log another watch → Re-check, unchanged

Repeat item 4 and tap **Re-check placement**. Answer both comparisons the way you already
feel.

Expect **two comparisons**, then `Still #N`. The feed should still have **one** row for
this viewing, with the score it ended on.

*Why a person:* the comparison count is asserted in the suite. What is not is whether two
comparisons feels like a re-check or like being asked something pointless — the number
this whole tranche was designed around.

## 6. Log another watch → Re-check, a real change

Pick a film you now think much better or worse of. Re-check it and answer honestly.

The result beat should print the exact movement: `Moved from #118 → #72`, with an arrow.

*Why a person:* **check the feed afterwards from a second account.** The activity must
show the verb, the title and the score — and **no ordinal, no arrow, no "spots"**. This is
the privacy rule (§K), it is enforced in the payload, and it is worth seeing with your own
eyes once.

## 7. The Watch History screen, at twenty watches

Seed a title with twenty viewings (`scripts/ops/seed-calibration-fixture.mjs` when it
exists, or twenty taps). Open `Watched 20 times ›`.

Scroll it. Edit a date inline. Remove a watch. Then try to remove the last remaining one.

Expect: an ordinary scroll, the date grid opening **in place on the row**, and the last
watch offering *Remove from collection…* rather than an error.

*Why a person:* §J.2 chose a screen over a sheet on exactly this — whether a twenty-row
history with row actions and an inline date field is comfortable. That is a judgement
about a scroll on a device, and it is the decision most expensive to reverse.

**On the smallest Android device**, specifically: the date column is fixed-width and the
rows are two lines, so a large system font is where this breaks if it breaks.

## 8. Kill the app mid-comparison

During item 5's re-check, kill the app. Reopen and go back to the title.

It should resume on the same comparison, and **the score and position must not have
moved** while the session was open.

*Why a person:* resumability is tested; what is not is whether the app comes back to the
right place from a real cold start on a real device.

---

## The two that need the flags on

Do these last. Run the diff **first** — it tells you what is about to change, per account,
and it is the gate:

```sh
BINGD_DB_URL=... node scripts/ops/watch-history-diff.mjs
```

Then:

```sql
update app_config set value = 'true'::jsonb, updated_at = now()
 where key in ('goals.count_watch_events', 'leaderboard.monthly_from_events');
```

## 9. A goal that was wrong is now right

Find a film watched in a previous year and rewatched this year. Look at **last year's**
goal.

It should now count that film. Before the flag, it did not.

*Why a person:* this is the epic's most visible user-facing correction, and the number
that moves is one somebody may have looked at before. Confirm it moved the way the diff
said it would, for an account you can reason about.

## 10. The monthly board loses what it should

Look at the monthly leaderboard before and after the flip, against the diff's prediction.

Standings **fall** for accounts whose credit came from undated rows and ranked imports.
That is R2's intended effect.

*Why a person:* the direction is predicted and asserted. Whether the resulting board still
looks like a board worth competing on — whether it is now nearly empty, for instance — is
a product judgement the diff cannot make.

---

## What to do with a finding

| Kind | Action |
|---|---|
| Copy, layout, or "this reads wrong" | A note on the PR. Nothing here is load-bearing enough to block. |
| A number that moved the wrong way at the flip | **Flip the flags back** (the same statement with `false`), and bring the diff output. |
| A write that did not land, or landed twice | Block. Capture the title and the sequence; the race suite is the place it gets reproduced. |
| A date appearing where no date was given | **Block.** This is the defect class the whole epic exists to end, and one instance means a path nobody audited. |
