# Social QA fixture (`social-v1`)

A small social graph you can rebuild exactly on **staging** (`fjxhcbowoxuzulwirzyr`), or on
a local stack, so the Reviews tab, follows, private profiles, recommendations and Helpful
counts can be QA'd against known data. It **never runs against production**, and no flag
changes that.

```
scripts/qa-fixtures/social/
  fixture.mjs        CLI and runner: setup | verify | teardown
  plan.mjs           the data, as a pure value (stable ids, derived operation ids, fixed dates)
  guard.mjs          the target guard, run before any key is read
  client.mjs         the HTTP layer (the only file that calls fetch)
  mutation-log.mjs   the JSONL mutation log
  fake-backend.mjs   in-memory backend for the unit tests
  fixture.test.mjs   node:test suite
  logs/              mutation logs, git-ignored
```

## What it creates

Five accounts, created with the Auth admin API (`email_confirm: true`) and then a profile
through `create_profile` as the account itself:

| key | username | display name | email | profile |
| --- | --- | --- | --- | --- |
| fx1 | `qa_fx_social_1` | QA Fixture 1 | `qa_fx_social_1@example.invalid` | public |
| fx2 | `qa_fx_social_2` | QA Fixture 2 | `qa_fx_social_2@example.invalid` | public |
| fx3 | `qa_fx_social_3` | QA Fixture 3 | `qa_fx_social_3@example.invalid` | public |
| fx4 | `qa_fx_social_4` | QA Fixture 4 | `qa_fx_social_4@example.invalid` | public |
| fx5 | `qa_fx_social_5` | QA Fixture 5 | `qa_fx_social_5@example.invalid` | **private** |

Each auth user carries `app_metadata: { qa_fixture: 'social-v1', qa_fixture_generation: N }`
(and the same marker in `user_metadata`, read only if `app_metadata` came back without the
key). The password is derived at runtime: `HMAC-SHA256(QA_FIXTURE_PASSWORD, "qa-fixture:social-v1:<username>")`,
never written down and never logged. The date of birth is `1990-01-01`.

Titles are looked up by TMDB id and kind (`media_items` where `kind = 'movie'` and
`tmdb_id = …`), never by uuid, and **no catalogue row is ever inserted**. A title the
target does not hold is logged (`result: "missing"`) and every entry that touches it is
skipped.

| title key | TMDB | title |
| --- | --- | --- |
| `tmdb150540` | 150540 | Inside Out (2015) |
| `tmdb361743` | 361743 | Top Gun: Maverick (2022) |
| `tmdb2062` | 2062 | Ratatouille (2007) |

### The scenario

Scores are what `title_reviews_v2` must answer (`score_for` over each author's own bands).
"Unranked" means logged through `log_title` with a bucket but never ranked, so the score
is `null`.

| title | author | how it is in their collection | score | review | Helpful |
| --- | --- | --- | --- | --- | --- |
| Inside Out | fx1 | ranked loved, top of 2 | 10.0 | public | **3** (fx2, fx3, fx4) |
| Inside Out | fx2 | ranked fine, alone | 6.9 | public | **1** (fx1) |
| Inside Out | fx3 | ranked not_for_me, alone | 3.4 | public, **spoilers** | 0 |
| Inside Out | fx4 | ranked loved, bottom of 2 | 7.0 | public | 0 |
| Ratatouille | fx1 | ranked loved, bottom of 2 | 7.0 | public | 0 |
| Ratatouille | fx2 | **watched, unranked** (fine) | null | public | 1 (fx1) |
| Ratatouille | fx3 | ranked fine, alone | 6.9 | public | 0 |
| Ratatouille | fx4 | ranked loved, top of 2 | 10.0 | public | 0 |
| Top Gun: Maverick | fx1 | ranked fine, alone | 6.9 | public | 0 |
| Top Gun: Maverick | fx4 | **watched, unranked** (loved) | null | public | 0 |
| Top Gun: Maverick | fx2 | ranked loved, alone | 10.0 | **private note**: visible to nobody | n/a |
| Top Gun: Maverick | fx5 | ranked loved, alone | 10.0 | public, but fx5 is a **private profile**: visible to fx3 only | 1 (fx3) |

Every ranked and logged title has a fixed watched date (2026-03-07 … 2026-07-04, see
`plan.mjs`). Rankings go through `rank_start` and `rank_answer` as the author, with fixed
answers: "top" wins every comparison and "bottom" loses every one. The watch date is then
set with `set_watch_date` (basis `reader`). Notes go through `save_note` with
`p_base_updated_at` and an operation id.

Follows (`follow`, `respond_follow_request`, `set_profile_visibility`):

| edge | state |
| --- | --- |
| fx1 ↔ fx2 | mutual, approved |
| fx2 ↔ fx3 | mutual, approved |
| fx4 → fx1 | one-way, approved (fx1 does not follow back) |
| fx3 → fx5 | requested, then **approved** by fx5 |
| fx4 → fx5 | **pending**, left pending |

Recommendations (`recommend_title`, at most 3 per sender, far inside the 20 per hour and
50 per day limits):

| sender → recipient | title | state | read state (recipient's view) |
| --- | --- | --- | --- |
| fx1 → fx2 | Ratatouille | delivered | **opened** (`mark_recommendation_opened`) |
| fx3 → fx2 | Inside Out | delivered | **seen** (`mark_recommendations_seen`), not opened |
| fx2 → fx3 | Top Gun: Maverick | delivered | unread |
| fx2 → fx1 | Inside Out | delivered | unread |
| fx4 → fx1 | Top Gun: Maverick | **pending** request (fx1 does not follow fx4) | n/a |
| fx3 → fx5 | Ratatouille | **pending** request (fx5 does not follow fx3) | n/a |

Helpful votes go through `set_review_helpful` and are never self-votes (`plan.mjs`
refuses one). Every entry has a stable id such as `review:fx2:tmdb150540` or
`helpful:fx2>review:fx1:tmdb150540`, and every operation id is a UUID v5 of
`qa-fixture:social-v1:g<generation>:<entry id>:<rpc>`.

## Safety rules

1. **The guard runs first** (`guard.mjs`), on the URL alone, before any key is read. It
   parses the URL with `new URL()`. Production (`abheeqyjzekiowkztfxv`) is refused by name
   over any scheme or port. It then accepts only exactly `https://fjxhcbowoxuzulwirzyr.supabase.co`
   (default port, no userinfo) or `http://127.0.0.1:<port>` / `http://localhost:<port>`, and
   refuses everything else, including look-alikes such as
   `fjxhcbowoxuzulwirzyr.supabase.co.evil.example` and unknown refs.
2. Only then is the anon key read and `environment_name()` asked. `prod` is refused whatever
   the URL said, and anything but `nonprod` is refused. Only after that are
   `SUPABASE_SERVICE_ROLE_KEY` and `QA_FIXTURE_PASSWORD` read. Exit code 2.
3. **The service role is used for four things only:** looking up, creating and (as a
   fallback) deleting fixture auth users, and listing users to prove none remain. Every
   product write is an RPC under the fixture account's own JWT, the same RPCs the app calls.
4. **Ownership:** an account is the fixture's only if its email, its marker and (once signed
   in) its profile username all match the plan. Any mismatch is a hard stop (exit 2)
   **before the run writes anything**: setup and teardown check all five accounts first. A
   marked account that rejects the derived password is a stop too, never a reset.
5. **QA accounts:** the plan refuses any entry that names `@qa_refine_g3`, `@bingdtest2` or
   any non-fixture account, unless it is a `--link-qa-accounts` follow or recommendation
   *from* a fixture account. The fixture never signs in as a QA account, so it cannot edit
   their rankings, watches, reviews or follows. With the flag off (the default) nothing in
   the plan references a QA account at all.
6. Every write appends a JSON line to the mutation log (below). Tokens, keys and passwords
   are never logged: the logger is given every secret value in the run and redacts any line
   that would contain one, and a unit test checks every line of a full run.

## Running it on staging (coordinator)

Put the staging values in the environment for the one command, rather than in a file
(`.env` and `.env.local` are also read, as the sibling scripts do, with the ambient
environment winning):

```sh
export EXPO_PUBLIC_SUPABASE_URL=https://fjxhcbowoxuzulwirzyr.supabase.co
export EXPO_PUBLIC_SUPABASE_ANON_KEY='<staging anon key>'
export SUPABASE_SERVICE_ROLE_KEY='<staging service-role key>'
export QA_FIXTURE_PASSWORD='<at least 16 characters; keep it, every later run needs the same value>'

# 1. See every write it would make. Needs no keys and connects to nothing.
node scripts/qa-fixtures/social/fixture.mjs setup --dry-run

# 2. Create what is missing. Prints each write; log in scripts/qa-fixtures/social/logs/.
node scripts/qa-fixtures/social/fixture.mjs setup

# 3. Check every scenario from the other accounts' points of view. Non-zero on drift.
node scripts/qa-fixtures/social/fixture.mjs verify

# 4. Idempotency: a second setup must report "setup: 0 writes, 0 problems".
node scripts/qa-fixtures/social/fixture.mjs setup

# Optional, only with the QA owners' agreement (see below):
node scripts/qa-fixtures/social/fixture.mjs setup --link-qa-accounts
node scripts/qa-fixtures/social/fixture.mjs verify --link-qa-accounts
```

Deliberately **not** an npm script. `package.json`'s `scripts` block is a fingerprint
source, and editing it moves the runtime version of the published friend-beta binary,
which would stop that binary receiving over-the-air updates (`config/push.cjs`); see
`scripts/check-auth-config.mjs`. Run it with `node` as above. `--log <path>` writes the log
somewhere else. To sign in to a fixture account by hand, derive its password with
`node -e "import('./scripts/qa-fixtures/social/fixture.mjs').then(m => console.log(m.derivePassword(process.env.QA_FIXTURE_PASSWORD, 'qa_fx_social_1')))"`;
do not paste it anywhere shared.

### Tearing it down

```sh
node scripts/qa-fixtures/social/fixture.mjs teardown --dry-run
node scripts/qa-fixtures/social/fixture.mjs teardown
```

Teardown proves ownership of all five accounts first, then deletes each through
`delete_account` **as that account** (the same path a person's own deletion takes). The
admin API delete is used only for a marked auth user that never got a profile. Finally it
checks that none of the five emails resolves and that no auth user marked
`qa_fixture: social-v1` remains anywhere, and exits 1 if one does.

**Usernames are reserved for good once deleted** (`username_history`, `20260813001500`), so
after a teardown `qa_fx_social_1 … 5` can never be created again. Build the next set with
`--generation 2` (`qa_fx_social_1_g2` …, display "QA Fixture 1 (g2)") on every command for
that set. Setup that hits a reserved name removes the auth user it just created and stops.

### The mutation log

One JSON line per write (and per skip, conflict or refusal):

```json
{"time":"…","command":"setup","target":"fjxhcbowoxuzulwirzyr","actor":"qa_fx_social_2","operation":"set_review_helpful","entity":"helpful:fx2>review:fx1:tmdb150540","result":"ok"}
```

`result` is `ok`, `done` (a ranking converged), `already_applied`, `refused:<reason>`,
`error`, `dry_run`, `missing` (a title), `skipped_missing_title`, `skipped_missing_account`,
`problem` or `absent` (teardown found nothing). Default path:
`scripts/qa-fixtures/social/logs/<ISO timestamp>-<command>.jsonl` (git-ignored by this directory's own `.gitignore`; the root `.gitignore` is an `@expo/fingerprint` input and is left alone).

### Idempotency and drift

Setup reads each account's own state first (its profile, `user_media`, `rankings`,
`follow_state_with`, its sent `title_recommendations`, `recommendations_to_me`,
`title_reviews_v2`) and writes only what is missing. It never overwrites: a different
bucket, date or note is reported as a problem (exit 1), not fixed. Operation ids are
deterministic, so a write retried after a lost response is the same operation. The
corollary: if somebody undoes a fixture write by hand (takes a Helpful back, unranks a
title), re-running setup replays the same id and the database answers `already_applied`
without redoing it. `verify` reports that drift. The fix is a teardown and a fresh
`--generation`.

## Exactly what `--link-qa-accounts` writes

Off by default. With it, and only with it, setup adds these rows. Every one is written by a
fixture account, about a QA account:

| entry id | writer | RPC | row it creates |
| --- | --- | --- | --- |
| `link-follow:fx1>@qa_refine_g3` | qa_fx_social_1 | `follow` | `follows` fx1 → qa_refine_g3 (approved, or pending if that account is private) |
| `link-follow:fx1>@bingdtest2` | qa_fx_social_1 | `follow` | `follows` fx1 → bingdtest2 |
| `link-follow:fx2>@qa_refine_g3` | qa_fx_social_2 | `follow` | `follows` fx2 → qa_refine_g3 |
| `link-follow:fx2>@bingdtest2` | qa_fx_social_2 | `follow` | `follows` fx2 → bingdtest2 |
| `link-rec:fx1>@qa_refine_g3:tmdb150540` | qa_fx_social_1 | `recommend_title` | `title_recommendations` fx1 → qa_refine_g3, Inside Out, with a note |
| `link-rec:fx1>@bingdtest2:tmdb150540` | qa_fx_social_1 | `recommend_title` | `title_recommendations` fx1 → bingdtest2, Inside Out, with a note |

The QA ids are found with `search_users` as the fixture account (exact username match). A
handle that is not found is logged and skipped.

What the QA accounts see as a result:

- **Two `follow` notifications each** (`follow_request` if the QA account is private), filed
  by `follow` (`20260912000100`). Both types are push-eligible (`_push_eligible`,
  `20260917001500`), so **a QA account with a registered device will get two pushes**,
  unless its follows notification preference is off.
- **One pending recommendation request** each, in Requests (`recommendation_requests`).
  Pending files no notification and no push: `recommend_title` notifies only when a row
  enters `delivered` (`20260929000100`), which needs the QA account to follow the fixture
  back. If the QA account is private, the follow stays pending and `recommend_title` is
  refused (`not_following`); the fixture logs that and moves on.
- fx1 and fx2 appear in their followers list. The fixture-side `follow_added` Feed story is
  read by fx1's and fx2's followers, who are fixture accounts.
- Nothing else: no ranking, watch, review, follow or block **of theirs** is written or read.
  If a QA tester then follows fx1 or fx2 back, that is their own write: it releases the
  pending recommendation silently (`_release_recommendations`) and can move mutual-follow
  award progress (`_award_touch_follow`, `20260828000100`).

Teardown needs no flag (and refuses one): deleting the fixture accounts cascades their
follows, recommendations and the notifications they caused.

## Notifications and email

With `--link-qa-accounts` off, **QA accounts receive nothing**: no follow, recommendation,
notification, push or email row names them (asserted in `fixture.test.mjs`).

Inside the fixture, these notification rows are created, all with a fixture recipient:
`follow` (fx2 ×2, fx1 ×2, fx3), `follow_request` (fx5 ×2), and `recommendation` for each
delivered recommendation (fx2 ×2, fx3, fx1). Mutual follows can also unlock awards
(`award_earned`). The `notifications_enqueue_push` trigger (`20260825000300` §6) puts each
push-eligible row in `push_outbox`, but **nothing is ever pushed**: `claim_push_batch`
(latest body in `20261113000100`) drops and deletes every job whose recipient has no live
`device_tokens` row, and the fixture never calls `register_device_token` or
`report_device_context` (a unit test asserts neither name appears in the fixture's
source). Proactive notifications likewise need a capable token (`_proactive_capable_token`).

**Email.** Nothing in the fixture sends any:

- The admin create with `email_confirm: true` sends no confirmation mail. The password
  grant sends nothing. No magic link, OTP, invite or recovery is requested.
- `delete_account` deletes the auth user in SQL (`20260817000700`); nothing mails on that.
- **The welcome email** (`20260923000100_a_welcome_note_sent_once.sql`,
  `emails/welcome/automation/`) is the one path that could select a fixture account: it
  takes active profiles with a confirmed email created 48 to 168 hours ago, after
  `welcome.start_after`. Its scheduled run in `.github/workflows/welcome-email.yml` targets
  **production only**. On staging it runs only by manual dispatch with staging's switches
  turned on (`welcome.delivery_enabled = true` and a real `welcome.start_after`, the
  rehearsal the automation README describes). If somebody runs that rehearsal while fixture
  accounts are 2 to 7 days old, they would be claimed. The address is `@example.invalid`, a
  TLD reserved by RFC 2606 / RFC 6761 that never resolves, so nothing can be delivered: the
  row ends as `failed` or `suppressed`, and Resend may count a bounce. Before such a
  rehearsal, add the five addresses to `email_suppressions` (reason `requested`), or tear
  the fixture down. The fixture does not do this itself, because it uses the service role
  for auth users only. A canary run cannot reach them: canaries need the address on
  `welcome.canary_addresses`.
- `supabase/functions/push-sender` sends pushes only, never email.

## Other effects worth knowing

- Fixture rankings never move a staging title's community score: contributors need 10
  rankings in a category (`score.contributor_min_rankings`, `20261119000100`), and a fixture
  account has at most 3.
- Each first ranking posts a `title_ranked` Feed event, readable by that author's fixture
  followers. fx5's rows stay behind its private profile.
- `title_review_count` and `title_reviews_v2` on these three titles include any other
  staging user's reviews, so verify checks "at least N" for counts and finds the fixture's
  own rows by author.

## Local stack and tests

```sh
node --test "scripts/qa-fixtures/social/*.test.mjs"
npx eslint scripts/qa-fixtures
```

Not an npm script either, for the fingerprint reason above.

The suite runs entirely against `fake-backend.mjs`, injected through `main({ makeClient })`.
It covers the guard (production URL, production-answering database, look-alike host,
unknown ref, staging, local), plan determinism and operation-id stability, ownership hard
stops, idempotent re-runs (a second setup makes zero writes), teardown touching only marked
accounts, dry-run making no writes and reading no keys, link on and off, missing titles, and
log lines holding no secret.

A local stack (`http://127.0.0.1:54321`, `supabase start`) is accepted by the guard and
answers `environment_name() = 'nonprod'` by default. It needs the three titles in its
catalogue, or their entries are skipped. When this fixture was written, the Supabase CLI and
a Docker daemon were not available, so it has been exercised against the fake only, not
against a real PostgREST.
