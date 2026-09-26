# Staging QA inventory

**Which existing staging account tests which state**, so a QA pass needs no new fake data.
Read-only survey of staging (`fjxhcbowoxuzulwirzyr`) on **2026-09-26**, at migration head
`20261023000100`. Handles only; credentials are never recorded here.

Staging has 12 accounts, all with public profiles, and 29 follows, all approved.

## Who the accounts are

| Kind | Accounts |
|---|---|
| **QA cohort, seeded** (`qa_cohort=v1`, generation 2, 2026-09-14). The cohort reset deletes and recreates these | `qa_blockbuster_fan_g2`, `qa_scifi_fan_g2`, `qa_horror_fan_g2`, `qa_classic_fan_g2`, `qa_indie_fan_g2`, `qa_drama_fan_g2`, `qa_comedy_fan_g2`, `qa_tv_fan_g2`. Each has 30–38 ranked titles, and every watch is undated |
| **QA, made by hand** (2026-09-23). No cohort flag, so a cohort reset keeps it | `qa_refine_g3` |
| **Founder's own staging accounts** | `bingdsocial2`, `bingdtest2`, `whatever` |

## State → account

| State | Use | Evidence (2026-09-26) |
|---|---|---|
| Light / normal account | `whatever`, `bingdtest2` | `whatever`: 11 titles, all ranked, 17 watches, 7 on the Watchlist, 2 lists |
| Import-style account | `bingdsocial2`, `bingdtest2` | 36 and 26 titles; 22 imported from Letterboxd each; import jobs `done` |
| Ranked titles | `qa_refine_g3`; any cohort account | `qa_refine_g3`: 34 movies and 3 seasons; `qa_tv_fan_g2`: 25 seasons |
| Unranked (backlog) | `bingdtest2`, `bingdsocial2` | 20 and 11 backlog movies, mostly imported with no bucket |
| One-title ranking batch | `qa_refine_g3` | `ranking_batch` of 1, 2026-09-25 |
| Multi-title ranking batch | `qa_refine_g3` | batches of 3 and 2, 2026-09-25. No other account has one |
| Dated single watch | `whatever`, `qa_refine_g3` | 11 and 12 dated watch events |
| Undated single watch | any cohort account, e.g. `qa_classic_fan_g2` | 30 of 30 watches undated |
| Multiple watches of one title | `whatever`, `bingdsocial2`, `qa_refine_g3` | `whatever`: one title watched 5 times, dated and undated mixed |
| Imported historical date | `bingdsocial2`, `bingdtest2` | one `diary`-dated watch each (Free Solo, 2026-09-10) |
| Public review | `qa_refine_g3` | 2 public notes, the only account with notes |
| Private note | `qa_refine_g3` | 2 private notes |
| Public ↔ private toggle | `qa_refine_g3` | one private note already published once, so it has been toggled |
| Follower / following | `whatever` ↔ `bingdsocial2` (mutual); cohort | `qa_drama_fan_g2` and `qa_indie_fan_g2` have 5 followers each |
| Account following nobody | `qa_refine_g3` | 0 following, 0 followers |
| Watchlist | `qa_tv_fan_g2`, `whatever` | 10 and 7 items; every cohort account has 4–10 |
| Lists | `qa_blockbuster_fan_g2`, `whatever`, `bingdsocial2` | public, private and link-only lists, including ranked lists |
| Refine eligible by count (staging `refine_enabled` is true) | `bingdsocial2`, `qa_refine_g3`, cohort movies | 20+ ranked in a category |

## Verdict: sufficient for a regression pass, with four known gaps

The existing accounts cover 14 of the 17 states. Don't create data for these unless a test
genuinely depends on them:

1. **Heavy library.** No account has more than 38 titles or 22 imported titles. Production has
   libraries in the hundreds.
2. **Multi-year imported diary.** One diary-dated watch per import account, nothing older.
3. **Refine call-to-action visible.** No account currently returns `cta.show = true`.
   `bingdsocial2` has an 11-title backlog (the CTA waits for an empty backlog) and only 2
   candidates. `qa_refine_g3` is in its 30-day cooldown until about 2026-10-23.
4. **Minor.** No watch with a reader-picked date (`reader` basis), no private profile, no
   pending follow request, and every ranking batch is on `qa_refine_g3`.
