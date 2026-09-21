# Watch History + Lists — the one founder QA pass

**Written:** 2026-09-20, for the combined candidate (`integration/watch-history-lists`).
**Backend:** staging, at `20261012000100`, with `leaderboard.monthly_from_events` **on** and
`goals.count_watch_events` **off** until item 21.
**Time:** about 45 minutes on one account, plus a second account for four items.

This replaces `watch-history-manual-qa.md` and the Lists PRD §N device list for this
release. It is **one pass over both features**, because they ship together and the
interesting failures are at their seam — a watch that moves a list, a list that logs a film.

**Everything provable without a person has been left out.** The candidate carries 2,411
database tests, 150 concurrency tests, 4,820 client tests and 27 grant probes against
staging itself (release gate run 35554338112); re-walking that ground here would spend the only resource
this document spends, which is you looking at a screen. So each item below says **why a
person** — and if an item ever stops having an answer to that, delete it.

Items marked **(2nd account)** need a second signed-in device or a sign-out.

---

## Before you start

**Which build.** A **preview** build (`app.bingd.preview`, the plum icon, installs beside
the shipped app) against staging. Not the beta and not the production app: the beta talks to
production, where none of these migrations exist, and every write would fail with a missing
function. If the preview build on your device predates 2026-09-11, it cannot take this
code — see the release note in the integration report.

**What the account needs**, and it is worth five minutes to arrange:

- a film logged **once, with a date**;
- a film logged **once, undated** (an import, or *Earlier*);
- a film with **three or more** viewings;
- around 20 ranked films, so movement has somewhere to go;
- one **series** with a season logged and a season not;
- a film on the **Watchlist**;
- a 2025 watch **and** a 2026 rewatch of the same film (for item 21).

**Stop and write it down rather than working around it.** An item that needs a workaround is
the finding.

---

# Watch History

## 1. The line at one watch, and at two

Open the film logged once with a date. The personal line reads as it always has, plus a
chevron: `#2 in Movies · Watched Aug 17, 2026 ›`. It must **never** say "Watched 1 time".

Now log a second watch (item 3) and come back. It reads `#2 in Movies · Watched 2 times ›`
and **the date is gone**.

*Why a person:* the strings are asserted; what is not is whether the chevron reads as an
affordance rather than a stray character, and whether losing the date reads as **a richer
fact** or as **information taken away**. That second judgement is the most likely correction
in this release. Look at it on the smallest device you have — if the line truncates, that is
the finding.

## 2. Today, and Earlier

Log a film you watched **today**: one tap on the bucket, no date question in the way.

Log another you saw **years ago**: choose *Earlier*. The row then reads `Earlier`, and
nothing anywhere invents a date for it.

*Why a person:* "Today is one tap" is a claim about how the flow feels, not about what it
writes. And *Earlier* is the only new word in the vocabulary — whether it reads as an answer
or as a shrug is a judgement.

## 3. Log another watch → Keep

Title ▸ ⋯ ▸ *Log another watch*. The When row offers Today. **Save watch**.

You land on *Saved · your Nth watch* with *Did it change your mind?*. Close it from there.
The viewing is recorded, and the feed has exactly **one** "watched again" row.

*Why a person:* the sheet's whole claim is that **closing is a complete answer**. Whether it
feels that way, or reads as a form you escaped, is the design decision.

## 4. Log another watch → Re-check, nothing changed

Repeat item 3 and tap **Re-check placement**. Answer as you already feel.

Expect about **two comparisons**, then `Still #N`, and still **one** feed row for the
viewing, carrying the score it ended on.

*Why a person:* the comparison count is asserted against the real RPCs. Whether two
comparisons feels like a re-check or like being asked something pointless is the number this
tranche was designed around.

## 5. Re-check with a real change, and what the sheet hands over to

Pick a film you now feel very differently about. Re-check and answer honestly. The result
prints the exact movement: `Moved from #118 → #72`.

**Watch the hand-over itself.** The rewatch sheet must close and the comparison sheet must
appear — no flash of a dead screen, no tap that does nothing, and the page must still accept
touches afterwards.

*Why a person:* this is the one hand-over in the release that is new, and the failure it can
have looks like nothing at all: the screen renders perfectly and stops responding. A test
models the refusal, but only a device proves the animation.

## 6. Watched N times → the History screen

Open `Watched N times ›` on the film with three or more viewings. Scroll it. **Edit** a
date in place. **Remove** a watch. Then try to remove the last one standing.

Expect an ordinary scroll, the date grid opening **on the row**, and the last watch offering
*Remove from collection…* rather than an error.

*Why a person:* §J.2 chose a pushed screen over a sheet on exactly this comfort question,
and it is the decision most expensive to reverse. **On the smallest Android device with a
large system font**, specifically: the rows are two lines and the date column is fixed
width, so that is where it breaks if it breaks.

## 7. Rerank versus rewatch — the distinction, in your own words

From ⋯, use *Update your rating* on one film and *Log another watch* on another.

Afterwards: the corrected film's **watch count has not moved** and its history shows no new
viewing. The rewatched film's has.

*Why a person:* the invariant is asserted in the database. What is not is whether the two
rows in the menu tell a reader which one they want **before** they tap — the confusion this
distinction exists to remove.

## 8. Movement is yours alone **(2nd account)**

After item 5, look at that activity from the second account.

It shows the verb, the title and the score — and **no ordinal, no arrow, no "spots"**.

*Why a person:* enforced in the payload and tested. Worth seeing once with your own eyes,
because it is the privacy promise of the whole epic.

## 9. Kill the app mid-comparison

During a re-check, kill the app. Reopen, return to the title.

It resumes on the same comparison, and the score and position have **not moved** while the
session was open.

*Why a person:* resumability is tested; a real cold start on a real device is not.

## 10. An undated import stays undated

Rank an imported title that has no date. **No date appears anywhere** — not on the line, not
in the sheet.

*Why a person:* the fabricated-date defect lived undetected for weeks precisely because the
whole path through the real sheet on a real device was never walked.

---

# Lists

## 11. Getting there at all

Collection ▸ the trailing half of the `Movies ▾` title row ▸ **`My lists ›`**. Then
Profile ▸ **LISTS** ▸ `Manage ›`.

Both reach the same screen. Check the entry is present on **both mediums and every
segment**, and that Collection rows and posters still have **no long-press and no overflow**.

*Why a person:* the entry is a text action sharing a row with the screen's title, and
whether it is **findable** is the one thing the whole IA reversal rests on. If you would not
have found it without this instruction, say so — that is the finding, and it is what the
`my_lists_opened` measurement exists to confirm later.

## 12. Make one, fill it, name it

Create a list. Add a **movie**, a **season**, and a **whole series** — from
`Title ⋯ → Add to list…` and from the list's own **Add titles**.

Then, from a title page, tap ⋯ ▸ *Add to list…* and **watch that the sheet actually
opens**, every time, including the first time after a fresh launch.

*Why a person:* the same hand-over as item 5, from the other end — and this one was **broken
until 2026-09-20**: the menu closed and nothing opened at all. It is fixed and tested, and
it is worth ten taps of your own to trust it.

## 13. The zero-lists path

On an account (or after deleting them all) with no lists, use `Title ⋯ → Add to list…`.

It opens **New list** with the title already chosen.

*Why a person:* one act or two acts, which is a feel judgement.

## 14. Edit, reorder, remove, delete

Rename a list, change its description, toggle **Numbered**, reorder items with the move
controls, remove an item, and delete the list.

Expect: toggling Numbered **never reorders anything**; removing an item leaves the numbers
reading 1..N with no hole; the delete confirmation is plain.

*Why a person:* ordinals and positions are asserted. The **move controls on a device** are
not — whether they are reachable, whether the list scrolls under them, and whether a
reorder on a 20-item list is pleasant or a fight.

## 15. Private, link-only, public **(2nd account)**

Take one list through all three. Read the consent copy on private → link.

From the second account: the **public** list is visible on the profile; the **link-only** one
is reachable **only** by its URL and appears on no shelf; the **private** one is nowhere.

Then make your profile private and look again: public lists become follower-only, and the
link-only list still opens by URL.

*Why a person:* the matrix is asserted at every reader. What is not is whether the copy makes
the reader understand **what they are about to share** before they share it.

## 16. The profile shelf shows what a visitor sees

With one public list and one private, look at **your own** profile.

Only the public list is drawn. With no public lists you get the "Nothing public yet" line —
and `Manage ›` is still there.

*Why a person:* this is deliberate and surprising. Whether an owner reads it as a bug is
exactly the question, and only a person can answer it.

## 17. Viewer progress **(2nd account)**

Put four titles on a public list, two of which the second account has seen.

That account sees `You've seen 2 of 4` as **plain text, never a bar**. On an empty list the
line is absent, not zero.

*Why a person:* the arithmetic is tested, including that a rewatch does not double-count.
Whether the sentence reads as encouragement or as judgement is a voice call.

## 18. Add to my Watchlist, from someone else's list **(2nd account)**

On a list from the other account, tap the bulk action. It says **"my Watchlist"**.

Titles already seen or already saved are skipped, and your feed gains **nothing** — twenty
rows from one tap is the failure this is designed to avoid. Then watch one of those titles:
it leaves the Watchlist and **stays on the list**.

*Why a person:* all three are asserted. What is not is whether the toast tells you what
happened well enough that you do not tap it again.

## 19. Sharing, and the public page

Share a public list. Open the link **on a phone with the app installed**, and again in a
browser where it is not.

Expect: the app opens the list; the web page shows the title, the posters and the owner's
handle, with install buttons. A **link-only** list's page works the same. A **private** list
gives the generic page.

*Why a person:* the page is rendered by a Cloudflare Function with its own fallbacks, and
the only way to know the whole chain works is to open it on a phone.

---

# Regression — the things this release touched indirectly

## 20. The old core flows, once each

- **Rank a new film** end to end, including the reveal.
- **Collection**: filters, segments, both mediums, an unranked title.
- **Title page**: Scores, Similar, Cast, Episodes on a series.
- **Feed**: scroll two pages, react, comment.
- **Recommend** a title to somebody, and accept one.
- **Watchlist**: add, then watch it, and see it leave.
- **Search** for a film and a person.

*Why a person:* the feed's page-two read and the Collection read were both **re-planned** in
this release (`20261012000100`), and the ranking write path was rebuilt in T1–T3. All are
covered by tests; none of that tells you the app still feels like itself.

## 21. The goal, once the flag is on — do this last

Run the diff, read it, then flip the goal flag:

```sh
node scripts/ops/watch-history-cutover.mjs --target staging --report
node scripts/ops/watch-history-cutover.mjs --target staging --only-flags --flags goals --apply
```

On the account with a 2025 watch and a 2026 rewatch of one film: the goal now counts that
film in **both** years, and the bar and the number agree.

Rollback is the same command with `--off`.

*Why a person:* the arithmetic is asserted and the per-account change is enumerated before
you flip it. What needs your eyes is the **bar and the number agreeing** on a real screen —
the failure §M.2 names is a completion announced that the bar does not show.

## 22. The monthly board, already on

Leaderboard ▸ this month.

Accounts whose titles carried no real watch date have **fallen**, by design (R2): the board
counts native-dated viewings and nothing else. Yours should reflect what you actually
watched this month.

*Why a person:* eleven accounts on staging move, and the list was printed before the flip.
Whether the board now reads as **true** rather than as broken is the judgement, and it is
the last thing to settle before production.

---

## What to do with a finding

Write the item number, the device, and what you saw. Anything in items 5, 12 or 20 is a
**release blocker** by default — they are the seams this integration created. Everything
else is a judgement call the founder makes.
