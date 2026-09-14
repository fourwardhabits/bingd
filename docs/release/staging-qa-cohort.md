# Staging QA cohort

**Scripts:** `scripts/staging/qa-cohort.mjs` (runner) · `scripts/staging/qa-cohort-plan.mjs` (fixture)
**Test:** `supabase/tests/staging-qa-cohort.test.mjs` (pure `node:test`, no network)
**Target:** STAGING only, `fjxhcbowoxuzulwirzyr`. First seeded 2026-09-13.

## What it is

A brand-new preview account on staging used to see empty social surfaces. Nobody to
suggest, no Group Picks, no Following score, no Match, and a Top Rated wall with nothing
on it. Staging had two real founder test accounts and 15 rankings between them.

The cohort is eight synthetic, public accounts with deliberately overlapping and
diverging taste. They rank through the same RPCs the app uses, save watchlists, follow
each other and send recommendations. A tester who signs up on a preview build and
finishes onboarding lands in a populated social graph.

| Account | Movies | Seasons | Watchlist | Follows |
| --- | --: | --: | --: | --- |
| `qa_blockbuster_fan` | 28 | 4 | 6 | scifi, horror, comedy, tv |
| `qa_scifi_fan` | 29 | 4 | 6 | blockbuster, horror, tv |
| `qa_horror_fan` | 30 | 3 | 5 | scifi, indie |
| `qa_classic_fan` | 30 | 0 | 4 | drama |
| `qa_indie_fan` | 30 | 3 | 5 | drama, classic |
| `qa_drama_fan` | 27 | 6 | 6 | indie, classic, tv |
| `qa_comedy_fan` | 30 | 5 | 6 | blockbuster, tv, drama |
| `qa_tv_fan` | 13 | 25 | 8 | drama, comedy, scifi, indie |

The totals are 267 rankings, 46 watchlist rows, 22 follows (mutual and one-way) and 8
delivered recommendations.

**Generations.** Deleting a profile reserves its username permanently
(`reserve_username_on_profile_delete`, 20260813001500), so a cohort that has been reset
cannot come back under the same names. Each seed after a reset is therefore a new
generation:

- generation 1 is `qa_<name>`; generation *n* is `qa_<name>_g<n>`, with the email
  `qa-cohort+<name>_g<n>@example.com`;
- the fixture is otherwise identical, and the display names ("QA · Horror fan") do not
  change;
- `seed` and `verify` use the live generation. If none is live, `seed` takes the first
  generation whose eight emails and usernames are all unused and unreserved.

As of 2026-09-13, staging holds **generation 2** (`qa_blockbuster_fan_g2` and so on).
Generation 1 was seeded, verified and reset to prove reset works.

- **Shared core.** 15 widely seen films. 12 are ranked by all eight accounts and 3 by
  seven. Everyone gives them different buckets, so the pairs disagree in useful ways.
- **Designed Match spread.** The server's `taste_match` agrees exactly with the plan's
  pure mirror of it: blockbuster~scifi **80**, indie~drama **72**, comedy~classic
  **43**, blockbuster~classic **36**.
- **Groups.** Group Picks has a movies group (`qa_blockbuster_fan` plus scifi, horror,
  comedy and tv) and a TV group (`qa_tv_fan` plus drama, comedy, scifi and indie).
  Their watchlists intersect: *Whiplash* is saved by four members, *Ted Lasso* and
  *The Last of Us* by three.
- **Recommendations.** Every one goes between mutual followers, so it is delivered to
  Sent to you, and the recipient has not ranked the title.

## Safety guarantees

These are enforced in code and asserted by the unit test.

1. **One project, hard-coded.** `STAGING_REF = 'fjxhcbowoxuzulwirzyr'` is a constant.
   The script reads no `process.env`, no `.env` and no `.env.local`, and the only flag it
   accepts is `--dry-run`. Every request goes through a single `stagingFetch`, which
   parses the URL and refuses anything other than `https://fjxhcbowoxuzulwirzyr.supabase.co`,
   including look-alike hosts, userinfo, ports and any URL that names the production ref.
2. **Four agreements before any write.** The script refuses to run unless all four hold:
   - the target host is exactly staging;
   - both keys' JWT `ref` claim is staging, with the expected `role`;
   - `config/backends.cjs` `LANE_BACKENDS.preview[0]` is staging and
     `config/production-lane.cjs` calls it `nonprod`;
   - `environment_name()` on the database itself answers `nonprod`.
3. **Keys stay in memory.** They are read at run time from
   `npx supabase@latest projects api-keys --project-ref fjxhcbowoxuzulwirzyr -o json`
   using the logged-in CLI (the legacy `anon` and `service_role` entries). They are never
   printed, logged or written to disk. The only hosts contacted are staging and, through
   the CLI, `api.supabase.com`.
4. **Real accounts are never touched.** Every follow and recommendation target is checked
   against the set of cohort ids created in the same run. The verify probe follows only
   accounts whose username and id match a cohort account. Reset deletes an account only
   when **all** of these hold:
   - `app_metadata.qa_cohort` is `v1` (or `probe`). `app_metadata` is admin-only;
     `user_metadata` does not count;
   - the email matches `qa-cohort+<name>@example.com`;
   - a profile on the same id has the username `qa_<name>`.
   Any other account is reported as refused and left alone.
5. **No email, no push, no analytics.**
   - Accounts are created with the Admin API (`email_confirm: true`), which sends nothing,
     on the reserved `example.com` domain. No signup, magic link, OTP, recover or invite
     endpoint is ever called.
   - No `device_tokens` are inserted, so the push drain marks the cohort's notifications
     dead.
   - Analytics is client-side PostHog, and the script never loads the client.
6. **Product paths only.** Rankings go through `rank_start` / `rank_answer`. Watchlists,
   follows and recommendations go through `set_watchlist`, `follow` and `recommend_title`.
   There are no direct inserts, no migrations and no `app_config` changes.
7. **Idempotent twice over.** Every write uses a deterministic operation id: a
   v5-shaped SHA-1 of a fixed namespace plus
   `v1:<username>:<action>:<title or target>`. Each run also re-reads the current state
   and skips what already exists, because `processed_operations` is pruned after 30
   days. Rerunning `seed` changes no counts. Seed also checks every ranking's final bucket
   and **exact position** against the plan and reports any drift.

## Commands

Run from the repo root on a machine where `npx supabase login` has been done.

```sh
# What seed would do, without writing (reads staging to resolve titles and existing state)
node scripts/staging/qa-cohort.mjs seed --dry-run

# SEED: create or top up the cohort. Safe to rerun.
node scripts/staging/qa-cohort.mjs seed

# VERIFY: PASS/FAIL table; creates and then deletes a throwaway probe account
node scripts/staging/qa-cohort.mjs verify

# RESET: delete every selector-approved cohort and probe account (cascades their data).
# The usernames stay reserved; the next seed creates the next generation.
node scripts/staging/qa-cohort.mjs reset

# The fixture and guard tests
node --test supabase/tests/staging-qa-cohort.test.mjs
```

On every run, `seed` sets a fresh random password on each cohort account through the
Admin API and signs in with it. `verify` does the same for the accounts it signs in as.
Passwords are never stored. Nobody is meant to sign in to a cohort account by hand. To
look at one in the app, use the Admin API or the dashboard to set a password yourself.
The next seed will replace it.

## What verify proves

As cohort members:
- the accounts, rankings (bucket and exact position), watchlists, follow graph and
  delivered recommendations all match the plan;
- `group_picks` returns at least 3 group-derived movies and at least 1 group-derived
  series;
- `following_score` and `following_ratings` have values;
- the similar pairs' `taste_match` beats the dissimilar pairs';
- `top_rated_titles('movies')` contains the core, and `community_score` has 5 or more
  ratings;
- `leaderboard` shows the cohort (all-time is required; month is reported);
- followees' `feed_events` are readable;
- `recommendations_to_me` shows cohort senders, and `people_mutuals` answers.

As a **probe**, a brand-new account named `qa_probe_<hex>` with marker `probe`:
- it ranks the first five `starter_movies` rows through `rank_start` / `rank_answer`;
- `people_starter_suggestions` then returns cohort accounts;
- it follows three of them, after which Group Picks, Following score and Match all
  answer;
- it is then deleted through `delete_account`, called as the probe itself. That function's
  only side effect beyond the auth-user delete, which cascades everything, is a storage
  count, so it matches the Admin API delete. Verify confirms with an Admin API 404.
  Leftover probes from an interrupted verify are removed at the start of the next one.

## What a new preview account should see

These assume a new account on a preview build that completes onboarding.

- **Onboarding, First Five grid (`starter_movies`).** The top of the grid is the
  cohort's community tier: *Pulp Fiction*, *The Dark Knight*, *Parasite*, *The Shawshank
  Redemption*, *Inception* and the other titles all eight accounts ranked. The support
  floor is the 90th percentile of rating counts, currently 8. Picking any five of them
  shares five rankings with every cohort account.
- **People step (`people_starter_suggestions`).** All eight `QA ·` accounts, each with
  "5 shared", ahead of the non-cohort accounts.
- **Match.** A number against every cohort account, because `taste.min_common` is 5.
  The probe scored 55–59.
- **Following score / ratings on a title page.** Populated for any core title once the
  account follows a cohort member.
- **Group Picks.** Titles such as *Dune: Part Two*, *Whiplash* and *Arrival* (saved by
  members) with any three followed cohort accounts. For TV (for example with
  `qa_tv_fan`'s group), *Ted Lasso*, *The Last of Us* and *House of the Dragon*.
- **Top Rated, movies.** The 12 titles every cohort account ranked. Staging runs the
  shared support floor (`20260916000200`), so only titles at the 90th-percentile count
  qualify.
- **Leaderboard.** All eight cohort accounts, for all time and for the calendar month
  they were seeded in.
- **Mutuals, feed and Sent to you.** These show only once the account follows cohort
  members, and Sent to you only once a cohort account follows it back. A new account
  receives no recommendations of its own.

## Known limits

These are recorded rather than forced. No product logic was changed to hide them.

- **Group Picks' `similar` family does not fire.** It reads
  `media_cache facet='similar'`, which only the For You adapter writes. Staging has 8
  such rows and none for the core, and this script never calls the adapter. Group Picks
  is still useful through the `saved` and `loved` families.
- **Top Rated TV is thin.** The cohort's widest season, *Stranger Things* S1, has 4
  raters. It appears only while the TV floor stays at 3.
- **Monthly leaderboard ages out.** The `month` board counts rankings dated in the
  current month. After the month changes, the cohort leaves that board until it is reset
  and reseeded. The all-time board is unaffected.
- **Cohort accounts get notifications.** Follows and recommendations create them. With
  no device tokens they are never delivered.
- **A profile-less orphan exists, and reset will not remove it.** The auth user is
  `qa-cohort+blockbuster_fan@example.com` (marker `v1`). On 2026-09-13, before
  generations existed, a reseed created it and then failed on the reserved username.
  - Reset refuses it by design: with no profile there is no `qa_` username to confirm.
  - It is inert. It has no profile, so it appears on no surface, and nobody knows its
    password.
  - It can be deleted by hand in the dashboard.
  - It should not recur: seed now confirms a username is free before it creates the
    auth user.

## Extending it

1. Add the title to `MOVIES`, `SEASONS` or `SERIES` in `qa-cohort-plan.mjs`, using TMDB
   ids. First confirm it exists on staging with a poster (`seed --dry-run` fails loudly
   naming any missing id and never calls the adapter).
2. Put it in a user's `loved` / `fine` / `not_for_me` list (best first) or `watchlist`.
   You can also add a user, follow edge or recommendation to the arrays beside them.
3. Run `node --test supabase/tests/staging-qa-cohort.test.mjs`. It catches:
   - a watchlist title the same user ranks (which a ranking trigger would silently
     remove);
   - a follow outside the cohort;
   - a recommendation that is not between mutual followers;
   - a similar pair that stops out-matching a dissimilar one.
4. Run `seed` then `verify`.

Adding a title to an **existing** account appends it through `rank_start`, which places
it by comparisons. Changing an existing ranking's bucket or order is **not** applied by
reseeding. Seed reports it as drift instead, and `reset` then `seed` is the way to apply
it. If a change needs a new marker, run `reset` with the old code first. Reset only
recognises the markers the current code knows about, so bumping `COHORT_MARKER` before
resetting would leave the v1 accounts unresettable.
