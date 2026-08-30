# Production bootstrap runbook — click by click

**Written 2026-08-29 against `54e32fd`; reconciled 2026-08-30 against `95fd4d7`.** The operational companion to
[`production-bootstrap.md`](./production-bootstrap.md), which holds the *reasoning*. This
page holds the *keystrokes*: every dashboard path, every command, in the order they have to
happen, with each step marked as something only the founder can decide or something Claude
can run once authorised.

**Nothing in this document has been executed.** No production project was created, no
secret was read or written, no build was made, nothing was submitted. It is a plan.

---

## 0. The state this starts from — verified, not assumed

Every row below was checked on 2026-08-29 with a read-only command, and the command is
named so it can be re-run before the founder starts.

| | State | How it was checked |
|---|---|---|
| Production Supabase project | **does not exist** | `supabase projects list` returns two projects in org `rrrtagzxldpbkhmtekbz` (Fourward): `bingd-nonprod` (`abheeqyjzekiowkztfxv`, us-east-2) and `fourwardhabits@gmail.com's Project` (`efvbvznkehkeirjstwyk`, us-east-2, created 2026-04-17). **The second is not Bingd** — it is the account's default project, and it must not be mistaken for production. |
| `LANE_BACKENDS.production` | `[]` | `config/backends.cjs` |
| `REF_ENVIRONMENTS` | nonprod only | `config/production-lane.cjs` |
| EAS environment `production` | **zero variables** | `eas env:list production` → *"No variables found for this environment."* |
| EAS channels | `beta`, `preview`, `development` — **there is no `production` channel** | `eas channel:list` |
| Installed betas | iOS build 5, Android build 7, both from `89631bf` (2026-08-27) | `eas build:list` |
| Beta runtime versions | iOS `d3b308f74a08…`, Android `41a907174ba3…` | `eas build:list`, and reproduced locally — see §0.1 |
| Nonprod migrations | 100 local, 100 remote, none pending, none remote-only | `supabase migration list` |
| Nonprod Edge Functions | `tmdb-adapter` v6 ACTIVE, `push-sender` v3 ACTIVE, `verify_jwt: true` on both | `supabase functions list` |
| Nonprod auth | email sign-in on, signups allowed, `mailer_autoconfirm: false`; **templates unverified locally** | `node scripts/check-auth-config.mjs` |
| `bingd.app/privacy`, `/support`, `/terms`, `/account-deletion` | all **HTTP 200**, real documents | `curl` |
| `web/distribution.config.json` | `mode: "beta"`, both `storeUrl` null | the file |
| Apple | Team `98729PG8GD`, ASC app id `6803954532`, bundle `app.bingd`, public TestFlight link live | `eas.json`, `web/distribution.config.json` |

### 0.1 The one measurement that decides "OTA or new binary"

Run in the repository root with `.env` present:

```
BINGD_LANE=beta APP_VARIANT=production npx expo-updates fingerprint:generate --platform ios
```

On 2026-08-29 this returned `d3b308f74a08926ee02303180d171d38c106ca55` — **byte-identical
to the runtime version of the installed iOS beta** — and Android returned
`41a907174ba3b6349b89049fb015406e5e525e7a`, identical to build 7. So `54e32fd` has **no
native delta** against the binaries testers are holding — **and neither does `95fd4d7`,
measured the same way on 2026-08-30: both platforms hash to exactly the same values in a
second checkout with its own `npm ci`** — and the beta lane can still be
served over the air.

Two further measurements, taken the same day, are what make a production binary
unavoidable rather than merely tidy:

- Unsetting `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` moved the beta
  iOS fingerprint from `d3b308f74a08…` to `dd2bfa38810932bc…`. **The backend values are
  fingerprint inputs.** A production build points at a different project, so its runtime
  version cannot equal the beta binary's.
- `BINGD_LANE=preview` and `BINGD_LANE=beta` produce different hashes
  (`19733b83f1ca…` against `d3b308f74a08…`). **The lane is a fingerprint input too.**

> **A caveat about that command, found while measuring.** `expo-updates
> fingerprint:generate` run with `BINGD_LANE=production` **printed a hash instead of
> failing** (`3eda4cd42da51c44…`). That hash is worthless — it comes from a degraded config
> resolution. The ordinary resolution path, which is the one `eas build` uses, refuses
> correctly:
>
> ```
> BINGD_LANE=production APP_VARIANT=production npx expo config --type public
> #  Error reading Expo config … EXPO_PUBLIC_SUPABASE_URL resolves to the Supabase
> #  project abheeqyjzekiowkztfxv (bingd-nonprod), which the "production" lane may not use.
> ```
>
> **Never treat a `fingerprint:generate` output taken under `BINGD_LANE=production` as the
> production runtime version.** Take it from the build itself.

---

## 1. Create the production Supabase project — FOUNDER

**Dashboard path:** <https://supabase.com/dashboard/org/rrrtagzxldpbkhmtekbz> → **New
project**.

| Field | What to enter | Notes |
|---|---|---|
| Organisation | **Fourward** (`rrrtagzxldpbkhmtekbz`) | The only one. Pre-selected. |
| Name | **`bingd-production`** | Recommended. `REF_NAMES` in `config/backends.cjs` will carry this string, and `bingd-nonprod` is the sibling it has to be read against at a glance. |
| Database password | **generate a long one** | **FOUNDER DECISION.** Shown once, at creation, and not recoverable. Store it in the password manager **before** clicking Create. No command in this runbook needs it — the CLI uses an access token — but losing it means no direct `psql`, no dashboard connection string, and no restore rehearsal. |
| Region | **`us-east-2` (East US, Ohio)** recommended | **FOUNDER DECISION.** `bingd-nonprod` is `us-east-2`. Matching it keeps acceptance results and latency comparisons honest. Choose otherwise only for a data-residency reason, and write that reason down. |
| Plan | **FOUNDER DECISION — Free or Pro** | Not deferrable. See below. |

### The plan decision, stated plainly

| | Free | Pro |
|---|---|---|
| Email template editing | **Refused** with the default email provider — verified against the project: *"Email template modification is not available for free tier projects using the default email provider."* | Allowed |
| Point-in-time recovery | No | Yes (add-on) |
| Project pausing on inactivity | Yes | No |

Bingd's entire sign-in path calls `verifyOtp` and needs `{{ .Token }}` in both templates.
**A Free project on the default provider cannot be made to send a code**, so it cannot sign
anybody in. Custom SMTP (§10) is required either way; the plan decides backups and pausing.
See [`backup-and-recovery.md`](./backup-and-recovery.md) §1.

**Claude cannot do this step.** `supabase projects create` requires `--db-password` and
bills the organisation. A password and a plan are not defaults to pick silently.

---

## 2. Recommended project name

`bingd-production`. It has to be the same string in three places:

- the Supabase dashboard project name,
- `REF_NAMES` in `config/backends.cjs`,
- every error message this repository prints about the production lane.

---

## 3. Organisation and region — settled above

Organisation **Fourward** (`rrrtagzxldpbkhmtekbz`); region **recommended `us-east-2`**,
founder's call. Both are irreversible after creation: a project cannot change region or
organisation.

---

## 4. Which settings require a founder selection

| Setting | Reversible? | Why it is founder-only |
|---|---|---|
| Plan | Upgradeable, but Free-tier email breakage is felt immediately | Money |
| Region | **No** | Latency and residency |
| Database password | **No** — regenerate only | A secret |
| PITR add-on | Yes, but only protects forward | Money, and a recovery-objective decision |
| Organisation | **No** | — |

---

## 5. Where the database password goes

**The founder's password manager. Nowhere else.** Not in `.env`, not in `.env.local`, not
in an EAS variable, not in a GitHub secret, not in this repository, not in a commit
message. No command in this runbook consumes it.

---

## 6. Which public values belong in client configuration

Only these two reach the app bundle, and both are safe there — the anon key is bounded by
row-level security:

| Value | Dashboard path | Destination |
|---|---|---|
| Project URL `https://<ref>.supabase.co` | Settings → **API** → Project URL | EAS `production` → `EXPO_PUBLIC_SUPABASE_URL` |
| Publishable / anon key | Settings → **API Keys** → anon / publishable | EAS `production` → `EXPO_PUBLIC_SUPABASE_ANON_KEY` |

Also client-side and also publishable, from their own vendors: `EXPO_PUBLIC_SENTRY_DSN`
(accepts events only) and `EXPO_PUBLIC_POSTHOG_KEY` (write-only). See §19.

### The ref goes in three places, in one reviewed change

```js
// config/backends.cjs
const LANE_BACKENDS = { …, production: ['<ref>'] };
const REF_NAMES     = { …, '<ref>': 'bingd-production' };

// config/production-lane.cjs
const REF_ENVIRONMENTS = { …, '<ref>': 'prod' };
```

`config/production-lane.test.mjs` asserts the three agree, that exactly one project claims
`prod`, and that no other lane may name it.

> **This edit strands the friend beta.** `config/backends.cjs` is a `@expo/fingerprint`
> input; editing it moves **every** lane's runtime version including `beta`, and a beta
> binary whose fingerprint moved silently stops receiving over-the-air updates. Make this
> change in the same window as the RC build and a beta redistribution — **never before**.

---

## 7. Secrets that must stay server-only

| Secret | Where the founder gets it | Where it belongs | Never |
|---|---|---|---|
| **Service-role key** | Settings → API Keys → `service_role` | Supabase **Vault** as `service_role_key` (§17), and GitHub secret `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` | EAS, the bundle, `.env`, git |
| **TMDB read access token** | themoviedb.org → Settings → API | `supabase secrets set TMDB_ACCESS_TOKEN` on the production project | Any `EXPO_PUBLIC_*` variable — `.env.example` says so and means it |
| **`SENTRY_AUTH_TOKEN`** | Sentry → Settings → Auth Tokens, scoped to the **production** project | EAS `production`, `--type sensitive` | The bundle |
| **Database password** | Chosen at §1 | Password manager | Everywhere else |
| **SMTP credential** | The mail provider | Supabase dashboard only | git, EAS |
| **Store-review password** | Chosen by the founder | Supabase dashboard, then App Store Connect and Play Console | This repository, forever |

---

## 8. EAS production environment variables

**Currently zero.** Full rationale in
[`production-environment.md`](./production-environment.md) §2.

```
eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_URL      --value https://<ref>.supabase.co
eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key>
eas env:create --environment production --name EXPO_PUBLIC_SENTRY_DSN        --value <production DSN>
eas env:create --environment production --name EXPO_PUBLIC_POSTHOG_KEY       --value <production key>
eas env:create --environment production --name SENTRY_AUTH_TOKEN             --value <token> --type sensitive
eas env:create --environment production --name SENTRY_PROJECT                --value <production Sentry project slug>
eas env:create --environment production --name GOOGLE_SERVICES_JSON          --type file --value ./google-services.json
```

Verify with `eas env:list production`, which is also how the "zero variables" row in §0 was
established.

**Do not copy the preview values.** They are nonprod's, and a production build carrying
them would sign the public into the friend-beta database. `config/backends.cjs` refuses
that combination, but the refusal is the backstop, not the plan.

`EXPO_PUBLIC_POSTHOG_HOST` is inherited from `eas.json`'s `base` profile and needs no
entry. `SENTRY_ORG` is needed only if the organisation is not `fourward-habits`.

**Claude can run every command in this section** once the founder has the values — but the
values should be pasted into the founder's own shell, because a secret handed to an agent
is a secret in a transcript.

---

## 9. Auth providers — FOUNDER

**Dashboard path:** production project → **Authentication → Sign In / Providers**.

| Provider | Action |
|---|---|
| **Email** | Enabled. The flow is OTP, not a link. |
| **Apple** | Enable with **production** Apple credentials — Services ID, Team ID, Key ID, `.p8`. |
| **Google** | Enable with a **production** OAuth client. |

**Do not paste the nonprod client credentials.** One shared OAuth client means one
revocation takes both environments down at once, and nothing in either console tells them
apart afterwards.

Sign in with Apple is mandatory on iOS because Google sign-in is offered (App Review 4.8).
The entitlement is already in `app.config.ts` (`usesAppleSignIn: true`, iOS only — the
comment there records why Android is deliberately excluded).

---

## 10. Email OTP and production SMTP — FOUNDER, and a hard gate

**Dashboard path:** Authentication → **Emails** → *SMTP Settings*, then *Templates*.

### 10.1 Custom SMTP first

| Setting | Notes |
|---|---|
| Host, port | The provider's endpoint |
| Username | Usually an API key id |
| Password | **Dashboard only. Never committed.** |
| Sender address | On a `bingd.app` domain — **blocked on SUPPORT-1**, see [`founder-input-worksheet.md`](./founder-input-worksheet.md) |
| Sender name | `bingd.` — lowercase, with the period |

No provider is recommended here and no credential belongs in this repository.

### 10.2 Then both templates, together

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<personal access token from supabase.com/dashboard/account/tokens>"
node scripts/check-auth-config.mjs            # read it back first
node scripts/check-auth-config.mjs --apply    # writes supabase/auth-templates/
```

**Confirm signup** and **Magic Link** are applied together. Supabase picks between them by
whether the address already has an account, so fixing one leaves sign-in working for
everybody who has used the app before and broken for everybody arriving — invisible to
whoever is testing, total for whoever is new. A production project starts from Supabase's
defaults, which are magic links, and every verification path in this app calls `verifyOtp`
and needs `{{ .Token }}`.

**Do not reach for `supabase config push`.** It sends a whole `[auth]` block and reverts
every field it does not mention, including the Apple and Google client secrets.

### 10.3 Then prove delivery to a real inbox

A green `check-auth-config.mjs` says the project is configured. It does not say mail is
arriving. Run the seven-case table in
[`production-bootstrap.md`](./production-bootstrap.md) §2.4 against production before RC
acceptance. **Sign-off is seeing the email.**

> **Today, on nonprod, this script reports `templates NOT VERIFIED — no
> SUPABASE_ACCESS_TOKEN`.** That is a missing local credential, not a failing project. The
> founder step is exactly the `$env:SUPABASE_ACCESS_TOKEN` line above.

---

## 11. Site URL and redirect / deep-link URLs — FOUNDER

**Dashboard path:** Authentication → **URL Configuration**.

| Field | Value |
|---|---|
| Site URL | `https://bingd.app` |
| Redirect allow-list | `bingd://**` and `https://bingd.app/**` |

**`bingd-dev://` and `bingd-preview://` belong on nonprod only.** A production project that
accepts them is a production project a development build can complete a sign-in against.

The app-side deep-link surface is already fixed and needs no dashboard entry: iOS
`associatedDomains: ['applinks:bingd.app']`; Android four verified path prefixes — `/u/`,
`/lists/`, `/title/`, `/i/` — held in step with `web/deep-links.config.json` by
`web/router.test.mjs`.

---

## 12. Migrations — replay from zero

```
supabase link --project-ref <ref>
supabase db push
supabase migration list        # local count == remote count, nothing pending, nothing remote-only
```

Every migration, in canonical order, on an empty database. **Not** a clone of nonprod, not
a dump restore, not a skipped file. No beta account, ranking, review or social row is
copied — public production starts empty, by decision.

Today's baseline on nonprod is **100 migrations, `20260813000100` through
`20260901000100`, all matched**. Production must reach the same list.

**Claude can run this** once `supabase link` points at production and the founder has
authorised it.

---

## 13. RLS verification

```
npm run test:db                                              # policy suite, local Postgres
SUPABASE_URL=https://<ref>.supabase.co node supabase/tests/remote-smoke.mjs
```

`remote-smoke.mjs` probes `environment_name()` **first**, before asserting anything else,
so a database that has not been through §14 fails immediately and by name rather than
producing a green run about the wrong project.

Spot-check in the SQL editor that every public table has RLS on:

```sql
select relname from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;
-- expect zero rows
```

---

## 14. The identity step — `bootstrap-production.mjs`

First enable the two extensions if the replay ran before they were available: Database →
**Extensions** → `pg_cron`, `pg_net`. (`20260826000300` attempts this itself and degrades
to a notice.)

```
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<production service role key> \
  node scripts/bootstrap-production.mjs --target production --apply
```

Sets `env.name = 'prod'`, sets `app_config['functions.base_url']`, schedules the push
drain. It refuses if the URL's project is not declared `prod` in
`config/production-lane.cjs`, and it refuses to rename a database that already has profiles
or invite tokens in it.

**Why this exists:** migration `20260817001300` seeds `env.name = "nonprod"`, so a
production project replayed from zero comes up believing it is nonprod — and
`create_invite_link` stamps that onto every token it mints while `redeem_invite` refuses a
token from the other environment. A production database that thinks it is nonprod mints
tokens a production client declines, and satisfies the rule by being wrong.

---

## 15. Edge Functions

```
supabase functions deploy tmdb-adapter
supabase functions deploy push-sender
```

Verify: `supabase functions list` must show both **ACTIVE** with `verify_jwt: true` — the
same shape nonprod reports today (`tmdb-adapter` v6, `push-sender` v3).

Local gates before deploying: `npm run functions:check`, `npm run functions:lint`,
`npm run functions:test`.

---

## 16. Edge Function secrets

```
supabase secrets set TMDB_ACCESS_TOKEN=<production TMDB token>
```

That is the only one. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the
platform. **`push-sender` needs no APNs or FCM credential** — delivery goes through Expo
Push Service, which holds the provider credentials against the EAS project.

---

## 17. Storage buckets, policies, and the Vault secret

**Buckets** are created by the migrations (`avatars`, path shape `avatars/{uuid}/`) with
their policies. Verify in Storage → Policies that anonymous write is refused and that a
user can only write under their own uuid prefix.

**The Vault secret is the one credential no script installs.** In the SQL editor:

```sql
select vault.create_secret('<production service role key>', 'service_role_key');
```

Without it the scheduled push drain runs and delivers nothing. See
[`push-operations.md`](./push-operations.md).

---

## 18. Scheduled jobs and webhooks

| Job | Where | Verify |
|---|---|---|
| Push outbox drain | `pg_cron`, scheduled by `bootstrap-production.mjs` | `select * from push_drain_status();` |
| Trending refresh | `.github/workflows/trending-refresh.yml`, nightly | Needs GitHub secrets `SUPABASE_URL_PRODUCTION` and `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION`, plus the repository **variable** `BINGD_PRODUCTION_TRENDING=true` |

No webhooks are configured and none is required.

---

## 19. Push, PostHog and Sentry — FOUNDER

### 19.1 Push credentials — the RC blocker

**Apple** — <https://developer.apple.com/account/resources>:

- Push Notifications capability on App ID `app.bingd`
- APNs auth key (`.p8`), Key ID, Team ID `98729PG8GD`
- `eas credentials --platform ios` to upload

**Google** — <https://console.firebase.google.com>:

- Firebase project, Android app registered as `app.bingd`
- Download `google-services.json` → EAS `production` file secret `GOOGLE_SERVICES_JSON`
- FCM V1 service-account key via `eas credentials --platform android`

`eas credentials` is interactive and cannot be read non-interactively, so **treat every box
as unticked until the founder confirms in the console.**

> **A correction to carry forward.**
> [`production-environment.md`](./production-environment.md) §1's matrix says beta's
> `aps-environment` is `development`. As of `54e32fd` that row is stale:
> `config/push.cjs` returns `'production'` for **both** `beta` and `production`
> (`apnsEnvironmentFor`), so the installed betas already carry the production entitlement.
> The production binary is still required — for the channel, the backend and the runtime
> version — but not for this reason.

### 19.2 PostHog — <https://us.posthog.com>

New **production** project → Project settings → copy the project API key →
`EXPO_PUBLIC_POSTHOG_KEY`. Host stays `https://us.i.posthog.com`. Separate from beta so the
two do not share funnels.

### 19.3 Sentry — <https://fourward-habits.sentry.io>

New **production** project → Settings → Client Keys (DSN) → `EXPO_PUBLIC_SENTRY_DSN`; the
project slug → `SENTRY_PROJECT`; an auth token scoped to it → `SENTRY_AUTH_TOKEN`.

`SENTRY_DISABLE_AUTO_UPLOAD` is deliberately **absent** from the production profile in
`eas.json` — production is the lane whose stacks have to be readable.

---

## 20. Backup, database log and auth-log retention — FOUNDER

| Setting | Dashboard path | Why it matters here |
|---|---|---|
| Daily backups / PITR | Settings → **Database** → Backups | Follows from the §1 plan. [`backup-and-recovery.md`](./backup-and-recovery.md) |
| Log retention (Postgres, PostgREST, Auth) | **Logs & Analytics** → Settings, or Project Settings → Logs | **This decides the Apple *Search History* answer.** Bingd persists no query text — nothing in `supabase/migrations/` or `src/` writes one — but a search leaves the device as a PostgREST request. If request paths are retained in logs, Search History is collected. Read the number and write it down. |
| PostHog retention | PostHog → Project settings → Data management | Quoted on `bingd.app/privacy`, which today says only "under their own retention settings" |
| Sentry retention | Sentry → Settings → Security & Privacy / Data retention | Same |

---

## 21. The production demo / reviewer account — FOUNDER

Production starts with no users and App Review cannot receive a one-time code. Full runbook
in [`store-review-access.md`](./store-review-access.md); the short form:

1. Authentication → **Users → Add user → Create new user**. Set email and password, and
   **tick Auto Confirm User** — without it `signInWithPassword` refuses a correct password
   and the app's deliberately generic copy makes the cause invisible.
2. Sign in on the **submitted binary** via *More sign-in options → Sign in with password*.
3. Complete onboarding as that user, so the reviewer lands on the feed and not on signup.
4. Seed: about ten ranked titles across two categories; a second account following and
   followed; two or three feed events from it; one recommendation received.
5. Put the credentials **only** in App Store Connect and Play Console.

`supabase.auth.signUp` is never called by the client and `config/auth-templates.test.mjs`
asserts it stays that way. **The dashboard is the only door.**

---

## 22. Release gate and remote smoke

```
gh workflow run release-gate.yml --ref <branch>     # must pass on the exact commit
SUPABASE_URL=https://<ref>.supabase.co node supabase/tests/remote-smoke.mjs
SUPABASE_URL=https://<ref>.supabase.co node supabase/tests/two-user-acceptance.mjs --target production
```

`scripts/release.mjs` guards `beta` and `production` identically: clean tree, branch `main`
or `release/*`, and a release-gate run that **passed on this exact SHA** — not "recently",
not "on this branch". A gate whose result cannot be read is not treated as passed.

[`production-acceptance.md`](./production-acceptance.md) describes what
`two-user-acceptance.mjs` covers and how its accounts are cleaned up.

---

## 23. Rollback

| Situation | Command |
|---|---|
| Bad JavaScript, known-good group exists | `npx eas update:list --branch production`, then `npx eas update:republish --group <GROUP_ID> --message "rollback to <what>"` |
| Unknown-bad JavaScript | `npx eas update:roll-back-to-embedded --branch production --message "back to the shipped bundle"` |
| Native fault | **No OTA can fix it.** New build, new submission, and — for a live App Store release — *Remove from Sale* while the replacement is in review. |
| Bad migration | Restore per [`backup-and-recovery.md`](./backup-and-recovery.md). This is what the §1 plan decision buys. |

Full decision table: [`safe-update-runbook.md`](./safe-update-runbook.md) §4.

---

## 24. The production OTA channel

**It does not exist yet.** `eas channel:list` shows `beta`, `preview`, `development` only.
The first production build creates it, or:

```
eas channel:create production
```

Publishing to it, once a production binary exists:

```
node scripts/release.mjs update production
#   → eas update --branch production --environment production
#     with BINGD_LANE and APP_VARIANT supplied by the wrapper
```

> **There are no `build:production` / `update:production` npm scripts, deliberately.**
> `packageJson:scripts` is a `@expo/fingerprint` input, so adding a key moves every lane's
> hash including beta's. Invoke the wrapper directly.

An update only reaches binaries whose runtime version matches. Check what you are about to
hit first:

```
npx eas update:list --branch production
```

---

## 25. The production iOS build

Preconditions — **all** of them, or the build refuses or ships broken:

- [ ] Production Supabase project exists and `environment_name()` returns `prod` (§14)
- [ ] Ref added to `LANE_BACKENDS.production`, `REF_NAMES` and `REF_ENVIRONMENTS` (§6)
- [ ] `npm run test:config` passes with the new ref — **in CI, not only locally**; see the
      note below
- [ ] EAS `production` holds all seven variables (§8)
- [ ] APNs key uploaded (§19.1)
- [ ] Clean tree, on `main` or `release/*`, release gate green on this exact SHA
- [ ] A beta redistribution is planned for the same window — §6 strands the current betas

> **`npm run test:config` is not hermetic on a founder machine, and it fails there for a
> reason that is not a fault.** Two cases in `config/push.test.mjs` — *"beta refuses to
> resolve at all without Android push configuration"* and the same for production — clear
> `GOOGLE_SERVICES_JSON` and expect the config resolution to refuse by name. But
> `googleServicesFileFor` has a deliberate **local fallback**: if `./google-services.json`
> exists in the project root it is used. That file is present on this machine (git-ignored,
> founder-local), so the resolution gets past push and the two cases fail. Measured
> 2026-08-29 at `54e32fd`: **83 tests, 80 pass, 2 fail, 1 skipped**, with no tracked file
> changed. On CI the file does not exist and the suite is green — the release gate passed on
> `54e32fd` itself. **Read this suite's verdict from the gate, not from a founder laptop**,
> and do not "fix" the two cases by deleting the local credential.

```
node scripts/release.mjs build production --platform ios
```

Then read the build's `runtimeVersion` from `eas build:list`. **That** is the production
runtime version — not anything `fingerprint:generate` printed (§0.1).

Android, when its turn comes:

```
node scripts/release.mjs build production --platform android
```

### Version number — FOUNDER

`app.config.ts` says `version: '0.1.0'` and `eas.json` sets `appVersionSource: "remote"`,
so the build number auto-increments but the marketing version does not. Shipping `0.1.0` to
the App Store is permitted and honest; most first public releases are `1.0.0`. **Changing
it is a one-line edit to `app.config.ts` and it moves the fingerprint**, so it belongs in
the same RC window as §6 — not afterwards.

---

## 26. TestFlight validation before App Review

The production binary goes to TestFlight **first** and is validated there, before any App
Review submission. This is the last chance to find that the build is pointed at the wrong
database, and the symptom of that is an app that signs in and shows an empty collection.

```
npx eas submit --platform ios --profile production
```

`eas.json`'s `submit.production` is `{}` today. It will need `appleTeamId 98729PG8GD`,
`ascAppId 6803954532` and `bundleIdentifier app.bingd`, exactly as `submit.beta` has them.
**That is a repository edit, not a dashboard step**, and it is deliberately not part of
this documentation pass.

On a real device, on the TestFlight build, in this order:

| # | Check | Passes when |
|---|---|---|
| 1 | Settings → scroll to the bottom | Version and build match the build just submitted |
| 2 | Diagnostics sheet | Backend reads **production**, not nonprod. **Stop here if it does not.** |
| 3 | Sign in with a brand-new email address | The code email arrives, has six digits, contains **no link**, and verifies |
| 4 | Sign in with Apple, and with Google | Both complete against production credentials |
| 5 | The review account, via *More sign-in options → Sign in with password* | Signs in and lands on the feed, not onboarding |
| 6 | Rank ten titles | Comparisons resolve; the collection shows them |
| 7 | Enable notifications, trigger one from a second account | It arrives on the lock screen. **This is what proves the production APNs path end to end**, and it is the check nothing before RC can stand in for |
| 8 | Tap a `bingd.app/u/<handle>` link from Messages | Opens the app on the right screen |
| 9 | Tap an invite link `bingd.app/i/<token>` | Redeems against production; a nonprod token must be refused |
| 10 | Report a comment, block an account | Both land; confirm `reports` and `blocks` in SQL |
| 11 | Settings → Account & Data → delete a throwaway account | Completes; the row is gone from `auth.users` |
| 12 | Airplane mode | Own collection still readable |

Only after all twelve does the App Store Connect click list in
[`app-store-submission-pack.md`](./app-store-submission-pack.md) §8 begin.

---

## What Claude can run later, and what it cannot

| Claude, once authorised | Founder only |
|---|---|
| `supabase db push`, `supabase migration list` | Creating the project (§1) |
| `bootstrap-production.mjs --apply` | Plan, region, password (§1, §4, §5) |
| `supabase functions deploy` | Auth providers and their credentials (§9) |
| `eas env:create` from values the founder supplies | SMTP credentials (§10) |
| `remote-smoke.mjs`, `two-user-acceptance.mjs` | `eas credentials` — interactive (§19.1) |
| `release-gate.yml` dispatch, `eas build:list`, `eas channel:list` | Vendor projects and retention settings (§19, §20) |
| Drafting and updating every document referenced here | The reviewer account (§21) |
| | Pressing Build, Submit, Add for Review, Release |
