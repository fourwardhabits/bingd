# The four lanes

Which builds exist, who is allowed to install them, which backend they talk to, and what
keeps one lane's work out of another lane's phone.

Everything here is enforced by `eas.json`, `app.config.ts` and `web/deep-links.config.json`
rather than by convention. Where a rule is only a convention, it says so.

---

## The table

| | Development | Preview | Beta | Production |
|---|---|---|---|---|
| **Who installs it** | the developer | **the founder, alone** | friend testers | the public |
| **How** | `expo start` + dev client | APK / ad hoc IPA from EAS | Play closed test · TestFlight | Play · App Store |
| **App name** | bingd dev | bingd preview | bingd | bingd |
| **Bundle / package** | `app.bingd.dev` | `app.bingd.preview` | `app.bingd` | `app.bingd` |
| **URL scheme** | `bingd-dev` | `bingd-preview` | `bingd` | `bingd` |
| **`APP_VARIANT`** | `development` | `preview` | `production` | `production` |
| **EAS environment** | `development` | `preview` | **`preview`** | `production` |
| **EAS channel** | `development` | `preview` | `beta` | `production` |
| **Backend** | bingd-nonprod | bingd-nonprod | bingd-nonprod | *does not exist* |
| **Android artifact** | APK | APK | AAB | AAB |
| **In-app diagnostics** | shown | shown | hidden | hidden |
| **Exists today** | yes | yes | not built | not built |

### Two rows that look like mistakes and are not

**Beta runs `APP_VARIANT=production`.** A bundle identifier cannot change between a
TestFlight build and the App Store release that replaces it, and a package name cannot
change between a Play closed test and the production track — a tester who installed
`app.bingd.beta` would have to delete it and lose their session to move to `app.bingd`.
So Beta *is* the production application. What makes it a beta is the channel it listens
on and the backend it talks to, not its name.

The visible consequence: **a Beta build hides the diagnostics block in Settings**, because
that block is gated on `env.variant !== 'production'`. Testers get one line —
`Bingd 0.1.0 (7)` — which is what a support conversation starts with. Everything else is
recoverable from that build number in the EAS dashboard.

**Beta reads the `preview` EAS environment.** EAS has exactly three environments and they
are not extensible; `beta` is a build profile, not an environment. Pointing it at
`production` would give it the Supabase URL of a project that does not exist, and pointing
it at `preview` gives it bingd-nonprod, which is where the friend beta is meant to run.
`eas.json` states `"environment": "preview"` on that profile explicitly rather than relying
on the name-matching default, so it is a written decision rather than an accident.

---

## Isolation, and what actually enforces it

### Development work cannot reach a Preview or Beta phone

Three independent reasons, and any one of them is sufficient:

1. **A different application.** `app.bingd.dev` is a different package and a different
   bundle identifier from either. An update published to any channel is served to builds
   of a matching *runtime*, and a Preview build simply never asks the development branch
   for anything.
2. **A different channel.** A development build's channel is `development`. `eas update`
   publishes to a branch, a branch is mapped to a channel, and a build only ever receives
   its own channel's branch.
3. **A development build runs Metro.** `src/lib/updates.ts` disables update checks under
   `__DEV__` entirely, so a dev client does not have an update mechanism to misdirect.

The remaining way for unfinished work to reach a tester is the ordinary one and has
nothing to do with channels: **someone builds Beta from a branch that is not ready.** That
is a git decision, and the gate for it is the release CI job in
[`safe-update-runbook.md`](./safe-update-runbook.md#the-release-gate), not a configuration
key.

### A build cannot talk to an unapproved backend

`app.config.ts` holds a one-entry allowlist of Supabase project refs and **throws during
configuration resolution** on any EAS build whose `EXPO_PUBLIC_SUPABASE_URL` resolves to
something else:

```ts
const ALLOWED_SUPABASE_REFS: Record<string, string> = {
  abheeqyjzekiowkztfxv: 'bingd-nonprod',
};
```

This exists because the failure has no symptom. The Supabase URL is an EAS environment
variable — a value in a web dashboard, edited by hand — and a build pointed at the wrong
project does not crash, warn, or look different. It signs in and shows an empty collection,
and every acceptance result taken on it is about a database nobody meant to test.

The check runs only when `EAS_BUILD=true`, which is exactly the population of artifacts
that reach a phone. Local `expo start`, CI's `expo customize` step (which passes
`https://ci.invalid` on purpose) and a contributor pointing at their own project are all
outside it — a rule that fired there would be a rule people learn to route around.

**When a production Supabase project is created, it is added to that object in the same
change,** which is a visible line in a reviewed diff.

The second half of the same question — *which* backend did this build actually choose —
is answered on the device: Settings shows `backend abheeqyjzekiowkztfxv` on any
non-production build. The URL is in the bundle already and the anon key is public by
construction, so there is no secret in that line.

### Nothing points at a production backend, because there is none

There is no production Supabase project. The `production` EAS environment has **no
variables at all**, which means a `--profile production` build fails at startup: `src/lib/env.ts`
parses `extra` with zod and throws on a missing `supabaseUrl`. That is the intended
behaviour — a loud failure rather than a build that silently talks to nothing.

---

## Version identity

Every candidate has to be nameable in a sentence a founder can say out loud, and traceable
from that sentence back to a commit.

| Field | Where it comes from | Where it is visible |
|---|---|---|
| Marketing version | `app.config.ts` → `version: '0.1.0'` | Settings, both stores |
| Android `versionCode` | EAS remote, auto-incremented per profile | Settings, Play Console |
| iOS `buildNumber` | EAS remote, auto-incremented per profile | Settings, App Store Connect |
| `runtimeVersion` | `fingerprint` policy — a hash of everything native | Settings (first 8 chars), EAS |
| EAS channel | `eas.json` per profile | Settings, every analytics event |
| `build_kind` | derived: `dev_client` \| `embedded` \| `ota` | every analytics event, Sentry tag |
| Update ID | `expo-updates`, null on an embedded launch | Settings, every analytics event |
| Commit | recorded by EAS at build time | EAS build page |

**`autoIncrement` is on for all four profiles.** It used to be on `production` alone, which
meant every build this project has ever produced was `0.1.0 (1)` — two Preview candidates
on one phone were indistinguishable from each other and from a dev client. Counters are per
application identifier, so `app.bingd.dev`, `app.bingd.preview` and `app.bingd` each count
separately, and Beta and Production share one counter because they are one application
(which is also what Play requires: a strictly increasing `versionCode` per package).

**Settings reads the build number out of the installed binary.** `Application.nativeBuildVersion`
is `versionCode` on Android and `CFBundleVersion` on iOS — the same source `src/lib/release.ts`
puts on every analytics event and Sentry report, so what a tester reads aloud matches what
the dashboards say. Before 2026-08-20 it read `expoConfig.android.versionCode`, a key this
project does not set and which is Android's regardless, so every iPhone showed
`Bingd 0.1.0 (—)`.

### What a diagnostics block may and may not show

Development and Preview show, under the version line:

```
preview · preview
runtime 5d60b7b0 · embedded
backend abheeqyjzekiowkztfxv
```

variant, channel, runtime fingerprint, update state, backend ref. **No DSN, no project
token, no anon key, no service key, no user identifier.** None of the five values above
reads anything back from anywhere, which is why they can be on a screen at all. Beta and
Production show the version line only.

---

## Environment variables, in full

| Name | Where it lives | Reaches the client bundle | Value today |
|---|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | EAS env `development`, `preview` | yes | `https://abheeqyjzekiowkztfxv.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | EAS env `development`, `preview` | yes | publishable key, bounded by RLS |
| `EXPO_PUBLIC_SENTRY_DSN` | EAS env `development`, `preview` | yes | accepts events only |
| `EXPO_PUBLIC_POSTHOG_KEY` | EAS env `development`, `preview` | yes | write-only project token |
| `EXPO_PUBLIC_POSTHOG_HOST` | `eas.json` → `base.env` | yes | `https://us.i.posthog.com` |
| `APP_VARIANT` | `eas.json` per profile | as `extra.variant` | selects the variant table |
| `SENTRY_DISABLE_AUTO_UPLOAD` | `eas.json` per profile | **no** | `true` — see below |
| `SENTRY_AUTH_TOKEN` | **not configured** | **no** | *founder action* |
| `TMDB_ACCESS_TOKEN` | **Supabase function secret** | **never** | server-side only |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local`, git-ignored | **never** | operator scripts only |

Four things this table is asserting, each of which was checked rather than assumed:

- **The `production` EAS environment is empty.** Verified with `eas env:list --environment production`.
- **No service-role key is reachable from any client path.** `.env.local` is read by
  `supabase/seed/backfill-tmdb.mjs` and nothing else, and `.env.*` is git-ignored.
- **There is no TMDB variable in `.env.example` and adding one would be a bug.** TMDB is
  reached only through the `tmdb-adapter` Edge Function, which holds the token as a
  Supabase secret (AD-8, PRD §19).
- **The client bundle was scanned for secrets** during the security tranche and was clean.
  See `docs/security/beta-security-review.md`.

### Sentry source maps — the one configured gap

`SENTRY_DISABLE_AUTO_UPLOAD=true` on `development`, `preview` and `beta`. Right for a dev
client, and **wrong for the build a friend beta runs on**: a Preview or Beta crash arrives
in Sentry as minified output rather than a filename and a line number, which is most of the
value of having Sentry at all.

It is set rather than unset because the alternative fails the build. `sentry-xcode.sh`
reports a missing token as `error: sentry-cli ...` and stops the iOS build; `sentry.gradle`
reads the same variable. So the upload cannot be enabled before the token exists.

**Two commands close it, and only the founder can run the first one.** They are written out
in [`safe-update-runbook.md`](./safe-update-runbook.md#turning-sentry-source-maps-on).

---

## What this run deliberately did not do

- **No production Supabase project was created**, and none may be created by this work.
- **No external TestFlight tester was invited**, and no Play tester list was configured.
- **No Play submission and no App Store submission.** The `submit` profiles in `eas.json`
  are prepared — `track: alpha`, `releaseStatus: draft` — and `eas submit` still cannot run
  for Android because no Play service account key exists.
- **No `production` channel and no `beta` channel exist yet.** They are created by the
  first build that names them.
