# Production acceptance

**Written 2026-08-26.** How Bingd is proved against the real production database before
anybody who is not the founder can install it — with controlled accounts, and with cleanup
that is itself part of the test.

---

## 1. The three layers, and why none of them replaces another

| | Runs as | Covers | Command |
|---|---|---|---|
| Local suite | table owner, PGlite | every migration, every invariant expressible on one connection | `npm test`, `npm run test:db` |
| Concurrency suite | real PostgreSQL, many connections | the ranking, redemption and block-barrier races PGlite cannot express | `npm run test:race` |
| **Remote smoke** | anon key, deployed PostgREST | what an unauthenticated attacker actually reaches | `node supabase/tests/remote-smoke.mjs` |
| **Two-user acceptance** | two real JWTs, deployed PostgREST | what two people do to each other | `node supabase/tests/two-user-acceptance.mjs` |

The bottom two are the production ones. The local suite builds its schema as the table owner,
for whom row security never applies and every grant question is moot — which is exactly how
`follows` and `blocks` once had **no writers at all** for a fortnight while every visibility
test passed.

## 2. Running it against production

```
SUPABASE_URL=https://<production ref>.supabase.co \
EXPO_PUBLIC_SUPABASE_ANON_KEY=<production anon key> \
SUPABASE_SERVICE_ROLE_KEY=<production service role key> \
  node supabase/tests/two-user-acceptance.mjs --target production
```

Ambient environment beats `.env.local` beats `.env`, so production credentials never have to
be written to a file on disk. `.env` is nonprod's and is what every script in this repository
reads by default.

**Three things must agree** before a single row is written, and any two of them is not enough:

1. `--target production` on the command line. Nothing defaults to production.
2. `config/production-lane.cjs` declares the project behind that URL to be `prod`.
3. the database answers `prod` to `environment_name()`.

The third is the one that catches the bootstrap trap: a production project replayed from zero
answers `nonprod` until `scripts/bootstrap-production.mjs` has run, and a run that got past the
first two on a database in that state would be creating accounts where every invite token is
still being stamped `nonprod`.

The refusals name the disagreement:

```
Refusing to run: --target production means the prod database, and abheeqyjzekiowkztfxv
is declared nonprod.
  This script creates and deletes real accounts. It does not guess which database.
```

## 3. What it proves

103 checks against `bingd-nonprod` as of 2026-08-26, in the order a person would do them.

| | |
|---|---|
| **Signup and the age gate** | a profile is created 13+; **an account under 13 is refused**, and `create_profile` deletes the `auth.users` row with it; exactly 13 today is accepted (the control); the date of birth is on **no** public column |
| **Ranking** | insertion sessions converge on both accounts; **Rank Again is one RPC** and leaves the title with a position in the same bucket |
| **TV seasons** | a season is rankable, a whole series is not — *see §5* |
| **Reviews and notes** | an unspecified note defaults to **private server-side** (NR-1) and is unreadable by anyone else; a note can be published as a Review |
| **Comments** | written, edited, deleted by the author, not by anybody else |
| **Reporting** | a Review and a Comment can each be reported by somebody else, and **not** by their own author |
| **Social** | follow, follow-back, request-and-approve on a private account, recommend, watch-tag, invite link |
| **Privacy** | a private account stays findable and unreadable; an approved follower keeps access |
| **Blocking** | both directions severed, activity gone, not announced, comment on an unseeable event refused **with the same error** as one that does not exist |
| **Notifications** | inbox names the actor and the title; preferences gate what is written |
| **Push** | a device registers; a comment on the recipient's activity **lands in `push_outbox`**; the outbox is unreadable by the account it is about; the device can be released |
| **Suspension** | leaves every read surface, cannot write, can still read its own inbox |
| **Deletion** | refuses somebody else's handle; a suspended account can still delete itself; nothing of theirs is readable afterwards; the other person's inbox stops naming them |

`node supabase/tests/award-privacy.mjs` covers the award/privacy boundary separately and is run
alongside.

## 4. The accounts, and cleaning them up

Every account is created inside the run with a run-scoped stamp — `acc_a_<stamp>`,
`acc_b_<stamp>`, plus two more for the age gate — and none of them touches an existing row.
Every title ranked is one the catalogue already had; nothing is inserted into `media_items`.

**Teardown is `delete_account`**, the same path a person's own deletion takes, so the cleanup is
also the test of the deletion path.

Three passes in a `finally`, each step independently caught so one network blip cannot abort
the rest:

1. `delete_account` for A and B;
2. a sweep by **id**, for every account whose creation response was readable — 404 is the
   ordinary outcome, because step 1 already removed it;
3. a sweep by **email**, which catches the account whose creation succeeded and whose response
   was never parseable.

An address is registered for sweeping only **after** the create call succeeds. Registering it
eagerly would make a conflicting address — a reused stamp, a previous run, somebody's real
account — get deleted by this file.

> **If a run is interrupted**, the disposable accounts are the ones whose usernames start
> `acc_` and whose email domain is `example.invalid`. Nothing else this script creates
> outlives it.

## 5. Skips are not passes

The run reports a third outcome:

```
skip          a season can be ranked
              this project holds no tv_season rows…

103/103 passed, 0 failed, 2 skipped
```

`bingd-nonprod` holds **1,027 movies and zero `tv_season` or `tv_series` rows**. `npm run
seed:fetch` fetches series and seasons — the run that filled that project fetched films only.
So M2's season semantics have never been exercised against a deployed database, and neither has
the refusal that keeps a whole series unrankable.

Skips are excluded from the pass count and printed on their own at the end, because reporting
them as passes would be a lie and reporting them as failures would leave the suite permanently
red for a data condition — which is how a number stops being read.

**A production acceptance run is not complete while that list has anything in it.** Seed the
production catalogue with television before running it, or accept in so many words that Bingd
launches with films only.

## 6. Order

1. `node supabase/tests/remote-smoke.mjs` — read-only, 97 probes, environment identity first.
   Nothing is written, so it is safe against production at any time.
2. `node supabase/tests/two-user-acceptance.mjs --target production` — writes, and cleans up.
3. `node supabase/tests/award-privacy.mjs`.
4. `select push_drain_status();` — job present, `older_than_15m` at zero.

Run 2 and 3 **before** the store listing is public, and once more after the RC binary is
installed on a real device — the second run is what catches a client that talks to the right
database with the wrong assumptions.
