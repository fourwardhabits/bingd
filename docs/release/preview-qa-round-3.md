# Preview QA — Round 3 (founder, physical device)

**What this update is:** integration `integration/preview-qa-r3` — physical staging separation,
the Letterboxd importer, comparison memory aids, every Round-2 fix, and Round 3:

- onboarding ends every placement on the **full reveal** (the "landed at" line is gone)
- a dedicated, optional **Already use Letterboxd?** step right after Your First Five
- the import pipeline's **2,500-title scale gate** (`20260917001700`, applied to staging)
- a staging-only **social QA cohort** (`docs/release/staging-qa-cohort.md`)

**Published 2026-09-13** from integration `3ff7da4` to the `preview` branch, on the installed
preview binaries' runtimes (fingerprint-matched; no reinstall):

| Platform | Runtime | Update group | Update id |
|---|---|---|---|
| iOS | `aa3056e7…` | `6ccf1670-856a-4312-ad87-1666c25f79fd` | `01a09d94-5c71-78ce-b468-dbe3d7963fe8` |
| Android | `8e8731a2…` | `4f6cd849-6661-4d91-b1e0-7636805a67a1` | `01a09d94-5c71-710d-83ec-4fc29245cf18` |

It supersedes Round 2's `01a09bf2` (iOS `e5bf46c3…` / Android `5ad3a491…`).

Verify you are on it before judging anything: Settings → About shows the update id prefix,
which must be `01a09d94`.

## The shortest checklist

Use a **brand-new** preview account (six-digit email code).

1. **Film 1** — pick a starter, *I loved it*. The sheet rises straight onto the **big score
   reveal** (no comparison on an empty band). No flash, no empty strip. Tap **Done** quickly —
   the sheet slides away and the picker says **1 of 5**. Screen is fully responsive.
2. **Films 2–4** — answer the comparisons. Each ends on the same reveal (score counts up,
   ordinal / genre ranks). **Done** → next picker. No second sheet appears, nothing overlaps.
3. **Film 5** — reveal, **Done** → **Your First Five** appears once, behind the sliding sheet.
   It no longer has a Letterboxd line.
4. **Continue** → **Already use Letterboxd?** — Import from Letterboxd / Not now.
   - Tap **Not now** on one account → People.
   - On a second account, **Import from Letterboxd** → pick your export ZIP → preview →
     import → **"Your Letterboxd import is on its way"** with **Continue**. Continue through
     People and Notifications **while it runs**.
5. **Close the app completely** mid-import; reopen. The import still finishes; you get
   **one** "import started" and **one** "import completed" notification. Settings → Import from
   Letterboxd shows the result.
6. **Speed** — a ~24-film import should finish in **well under a minute** (staging measured
   ~17 s, it was ~3.5 min in Round 2).
7. **Onboarding award** — if a badge is earned during the five, it is celebrated **once, after
   onboarding finishes** (not on First Five, not on the Letterboxd step).
8. **People / social** — People to follow shows several **QA · …** accounts; follow 3.
   Group Picks returns titles; a title page shows a Following score; Feed has activity.
9. **Round 2 still holds** — imported Unranked posters show without opening each title; TV
   and episodes look right; *Rank imported movies* → Collection Unranked; *Dismiss* wording;
   Invite button label.

Anything that fails: a screenshot plus the About prefix is enough.

## What was measured, so you know what "slow" would mean

Staging, real cron / pg_net / Edge Function / TMDB:

| Titles | Round 2 | Round 3 |
|---|---|---|
| 24 | 215 s | 17 s |
| 250 | — | 14 s |
| 1,000 | — | 33 s |
| 2,500 rows | — | 35 s (109 s with a 40 s worker outage injected mid-job) |

Details: `docs/product/letterboxd-import.md` §6e.
