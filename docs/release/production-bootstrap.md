# Production bootstrap

**Written 2026-08-26, against `release/production-bootstrap`.** The order in which a real
Bingd production environment comes into existence, what the repository already does for you,
and what only the founder can do.

Nothing in this document builds a release candidate, submits to a store, or makes
`bingd.app` claim the apps are public. Those are the three things that come after it.

## The state this starts from

| | |
|---|---|
| Production Supabase project | **does not exist** |
| Production EAS environment | exists, **zero variables** |
| `LANE_BACKENDS.production` | `[]` — empty, deliberately |
| `web/distribution.config.json` | `mode: "beta"`, both `storeUrl` null |
| Friend Beta | `bingd-nonprod`, migrations through `20260826000300` |

A `--profile production` build refuses today, by name, at three separate points. That is the
design and not a gap to tidy up: see [§4](#4-why-a-production-build-refuses-today).

---

## 1. The bootstrap trap, and why there is a step for it

`20260817001300` seeds:

```sql
insert into app_config (key, value) values ('env.name', '"nonprod"'::jsonb)
```

and every reader of that key defaults to `'nonprod'` when it is missing. So **a production
project replayed from zero comes up believing it is nonprod.**

That is not cosmetic. `create_invite_link` stamps `env.name` onto every token it mints, and
`redeem_invite` refuses a token from the other environment (PRD §17). A production database
that thinks it is nonprod mints tokens a production client will decline — and satisfies the
rule by being wrong about which environment it is.

**The seed is not edited.** It has already run on `bingd-nonprod`; changing it now would mean
the two databases disagree about what they replayed, and the disagreement would be invisible
until something depended on it. Instead:

```
migration replay  →  scripts/bootstrap-production.mjs  →  environment_name() = 'prod'
```

and three things independently refuse to proceed until that has happened:

- `supabase/tests/remote-smoke.mjs` — first probe, before anything else is asserted
- `supabase/tests/two-user-acceptance.mjs` — before the first account is created
- `set_environment_name` itself — refuses to *rename* a database that already has profiles or
  invite tokens in it, so a live nonprod cannot be relabelled `prod` by an `update`

---

## 2. What the founder must do, in order

Each step names what it needs and what it costs. Steps marked **FOUNDER ONLY** cannot be
automated from this repository — they need an account, a password, or a billing decision.

### 2.1 Create the production Supabase project — FOUNDER ONLY

This is the one genuinely blocking step, and it is blocking because three of its inputs are
irreversible and none of them is established anywhere in this repository.

| Input | What is known | What is not |
|---|---|---|
| Organisation | `Fourward` (`rrrtagzxldpbkhmtekbz`) — the only one | — |
| Region | `bingd-nonprod` is `us-east-2` | Whether production should match it |
| **Plan** | — | **Free or Pro.** This decides backups and PITR ([`backup-and-recovery.md`](./backup-and-recovery.md)) *and* whether email templates can be edited at all ([§2.4](#24-auth--founder-only)) |
| **Database password** | — | Chosen once, at creation, and not recoverable |

`supabase projects create` requires `--db-password` and bills against the organisation. The
CLI session on this machine is authenticated and *could* create it; it is not created here
because a plan and a password are founder decisions with money and recovery attached, and
picking one silently is worse than waiting.

> **The plan is not a detail to defer.** Free tier means no PITR, no custom SMTP-free email
> templates, and a project that pauses on inactivity. A public launch on Free is a decision
> rather than a default. See [`backup-and-recovery.md`](./backup-and-recovery.md) §1.

Then, in **one reviewed change**, add the new ref to three places:

```js
// config/backends.cjs
const LANE_BACKENDS = { …, production: ['<ref>'] };
const REF_NAMES     = { …, '<ref>': 'bingd-production' };

// config/production-lane.cjs
const REF_ENVIRONMENTS = { …, '<ref>': 'prod' };
```

`config/production-lane.test.mjs` asserts the three agree, that exactly one project may claim
`prod`, and that no other lane may name it. It also un-skips its positive case the moment a
ref exists.

> **`config/backends.cjs` is a fingerprint input.** Editing it moves every lane's runtime
> version, beta included, and a beta whose fingerprint moved stops receiving over-the-air
> updates. That is measured, not assumed: the same edit moved beta from `ab794b37…` to
> `08e341d1…`. **Adding the production ref is therefore a beta-stranding change**, and it
> belongs in the same window as the RC build and a beta redistribution — not before.

### 2.2 Replay the migrations from zero

```
supabase link --project-ref <ref>
supabase db push
```

Every migration, in canonical order, on an empty database. **Not** a clone of nonprod, not a
dump restore, not a skipped file. No Beta account, ranking, review or social row is copied —
public production starts empty, by decision.

Verify:

```
supabase migration list          # local count == remote count, nothing pending, nothing remote-only
```

### 2.3 Enable `pg_cron` and `pg_net`, then bootstrap

Dashboard → Database → Extensions. `20260826000300` attempts the install itself and degrades
to a notice if it cannot, so this is only needed where the replay ran before the extensions
were available.

```
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<production service role key> \
  node scripts/bootstrap-production.mjs --target production --apply
```

This sets `env.name = 'prod'`, sets `app_config['functions.base_url']`, and schedules the push
drain. It refuses if the URL's project is not declared `prod`, and it refuses to rename a
database that already has people in it.

Then, in the SQL editor — **the one credential no script installs**:

```sql
select vault.create_secret('<production service role key>', 'service_role_key');
```

See [`push-operations.md`](./push-operations.md) for why this is a Vault secret and why the
scheduler is useless without it.

### 2.4 Auth — FOUNDER ONLY

Production Auth is configured per project and shares nothing with nonprod. Register, on the
**production** project:

- **Redirect allow-list:** `bingd://**` and `https://bingd.app/**`. The development and
  preview schemes (`bingd-dev://`, `bingd-preview://`) belong on nonprod only — a production
  project that accepts them is a production project a development build can complete a
  sign-in against.
- **Apple** and **Google** providers, with **production** client credentials. Do not paste the
  nonprod ones: a shared OAuth client means one revocation takes both environments down.
- **Custom SMTP.** Email one-time codes need it. Supabase refuses template edits entirely on
  the free tier with the default sender, and the built-in template sends
  `{{ .ConfirmationURL }}` — a magic link — while `verifyEmailCode` calls `verifyOtp` and needs
  `{{ .Token }}`. Verified against the project, not inferred: *"Email template modification is
  not available for free tier projects using the default email provider."*
  See [`../architecture/auth.md`](../architecture/auth.md) §SMTP.

### 2.5 Deploy the two Edge Functions

```
supabase functions deploy tmdb-adapter
supabase functions deploy push-sender
supabase secrets set TMDB_ACCESS_TOKEN=<production TMDB token>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform; neither function
needs them set by hand. **`push-sender` needs no APNs or FCM credential** — delivery is through
Expo Push Service, which holds those against the EAS project. `verify_jwt = true` for both
(`supabase/config.toml`), which is what makes `resolveCaller` safe to trust.

### 2.6 Fill the production EAS environment

See [`production-environment.md`](./production-environment.md) for the exact list. A production
build with a missing variable now **fails the build** rather than producing a binary that dies
at startup.

### 2.7 Prove it

```
SUPABASE_URL=… node supabase/tests/remote-smoke.mjs                       # read-only
SUPABASE_URL=… node supabase/tests/two-user-acceptance.mjs --target production
```

[`production-acceptance.md`](./production-acceptance.md) describes what the second one covers
and how its accounts are cleaned up.

---

## 3. What this repository already does

| | |
|---|---|
| `supabase/migrations/20260826000100` | `environment_name()`, `set_environment_name()` |
| `supabase/migrations/20260826000200` | outbox crash recovery — see [`push-operations.md`](./push-operations.md) |
| `supabase/migrations/20260826000300` | `pg_cron` drain, `schedule_push_drain()`, `push_drain_status()` |
| `config/production-lane.cjs` | production fail-closed backend rule, ref → environment map |
| `scripts/bootstrap-production.mjs` | the identity step, guarded on the parsed host |
| `.github/workflows/trending-refresh.yml` | daily Trending refresh, both lanes |
| `supabase/tests/remote-smoke.mjs` | environment identity as its first probe |
| `supabase/tests/two-user-acceptance.mjs` | `--target production`, three-way agreement |

---

## 4. Why a production build refuses today

Three independent refusals, and each one exists because the others are not sufficient:

1. **`config/backends.cjs`** — `LANE_BACKENDS.production` is `[]`, so *any* Supabase project is
   refused for that lane. This is what stops a production build silently using nonprod.
2. **`config/production-lane.cjs`** — refuses a production build with **no** Supabase URL at
   all. `assertBackendIsAllowed` returns early on a URL it cannot parse as a Supabase project
   — correct for `https://ci.invalid` and for a local stack — and an absent variable is not a
   Supabase URL either. With the production EAS environment holding zero variables, that early
   return was the one path a production build could take. It is closed.
3. **`scripts/release.mjs`** — the production lane is guarded like beta: clean tree, `main` or
   `release/*`, and a passing release gate **on this exact commit**.

The release gate asserts all three from the outside, including the negative cases, in
`.github/workflows/release-gate.yml`.

> **There are no `build:production` / `update:production` npm scripts, on purpose.**
> `packageJson:scripts` is a `@expo/fingerprint` input; adding a key moves every lane's hash
> including beta's. Invoke the wrapper directly:
> `node scripts/release.mjs build production --platform ios`.

---

## 5. Still open, and who owns it

| | Owner | Blocks |
|---|---|---|
| Production Supabase project (plan, region, password) | Founder | Everything below |
| Vault `service_role_key` on production | Founder | Push delivery |
| Production Auth providers, redirects, SMTP | Founder | Sign-in |
| Production TMDB token | Founder | Catalogue, Trending |
| Production PostHog project + key | Founder | Telemetry separation |
| Production Sentry project + DSN + `SENTRY_AUTH_TOKEN` | Founder | Symbolicated crashes |
| APNs key, Firebase project, `GOOGLE_SERVICES_JSON` | Founder | **RC build** — see [`production-environment.md`](./production-environment.md) §4 |
| Backups / PITR decision | Founder | [`backup-and-recovery.md`](./backup-and-recovery.md) |
| Vendor retention facts | Founder | [`store-privacy-inventory.md`](./store-privacy-inventory.md) |
