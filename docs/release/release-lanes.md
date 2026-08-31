# The four lanes

Which builds exist, who is allowed to install them, which backend they talk to, and what
keeps one lane's work out of another lane's phone.

Everything here is enforced by `eas.json`, `config/backends.cjs`, `app.config.ts` and
`web/deep-links.config.json` rather than by convention. **Where a rule is only a convention,
it says so** — independent review 28 found two places where this document claimed more than
the implementation delivered, and both are corrected below rather than quietly softened.

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
| **In-app diagnostics** | shown | shown | **shown** | hidden |
| **Exists today** | yes | yes | not built | not built |

### Two rows that look like mistakes and are not

**Beta runs `APP_VARIANT=production`.** A bundle identifier cannot change between a
TestFlight build and the App Store release that replaces it, and a package name cannot
change between a Play closed test and the production track — a tester who installed
`app.bingd.beta` would have to delete it and lose their session to move to `app.bingd`.
So Beta *is* the production application. What makes it a beta is the channel it listens
on and the backend it talks to, not its name.

That is also why the in-app diagnostics block is gated on the **lane** rather than the
variant. It was gated on the variant until independent review 28, which meant a Beta build
— production identity, nonproduction database — showed nothing but its version line, and
the people best placed to notice a wrong backend were the only ones who could not see it.
`isRelease` in `src/lib/env.ts` is the gate now, and only a real `production` lane is a
release.

**Beta reads the `preview` EAS environment.** EAS has exactly three environments and they
are not extensible; `beta` is a build profile, not an environment. Pointing it at
`production` would give it the Supabase URL of a project that does not exist, and pointing
it at `preview` gives it bingd-nonprod, which is where the friend beta is meant to run.
`eas.json` states `"environment": "preview"` on that profile explicitly rather than relying
on the name-matching default, so it is a written decision rather than an accident.

---

## Isolation, and what actually enforces it

### The development *channel* cannot reach a Preview or Beta phone

This heading used to read "Development work cannot reach a Preview or Beta phone", and
independent review 28 raised it as a Blocker because it is not true and the difference
matters. Here is what is actually guaranteed and what is not.

**Guaranteed, by configuration, with no human in the loop:**

1. **A different application.** `app.bingd.dev` is a different package and a different
   bundle identifier from either. An update published to any channel is served to builds
   of a matching *runtime*, and a Preview build never asks the development branch for
   anything.
2. **A different channel.** A development build's channel is `development`. `eas update`
   publishes to a branch, a branch maps to a channel, and a build only ever receives its
   own channel's branch.
3. **A development build runs Metro.** `src/lib/updates.ts` disables update checks under
   `__DEV__` entirely, so a dev client has no update mechanism to misdirect.

**Not guaranteed, and nothing in a repository can guarantee it:** somebody running
`eas update --branch beta` or `eas build --profile beta` from a half-finished checkout.
Channels stop the *development channel* crossing over; they have nothing to say about which
*code* is published to the Beta branch. That is the way unfinished work actually reaches a
friend's phone, and it is a decision rather than a leak.

What exists against it is a guard on the documented path:

```
npm run build:beta   -- --platform android
npm run update:beta  -- --message "what changed"
```

`scripts/release.mjs` refuses unless the working tree is clean — **untracked files
included**, because Metro bundles whatever committed code imports whether or not git has
heard of it — HEAD is on `main` or `release/*`, **and the release gate passed for that
exact commit** (`gh run list --commit <sha>`, not "recently", not "on this branch"). Where
it cannot read the gate's result it refuses: an unverifiable gate reported as green is
worse than no gate.

The same script is also **the only supported way to publish an update**, and that half is
not about the gate at all. `eas update` reads `--branch` and `--environment`; it does
**not** read a build profile, so `APP_VARIANT` and `BINGD_LANE` — which live in `eas.json`
under `build.<profile>.env` — are simply absent. A bare `eas update --branch beta`
therefore resolves the config with no variant, **defaults to `development`**, and publishes
a manifest telling every friend tester's device it is a development build: environment
badge on, `isProduction` false, the lane gone. The native side stays correct, which is what
makes it invisible. `scripts/release.mjs` supplies both, read from `eas.json`.

**`eas` remains a command anybody can type.** The guard makes publishing an unreviewed tree
to friend testers a deliberate act — somebody bypassing a check that told them why — rather
than an accident. That is the whole claim, and it is the honest one.

### A build cannot talk to a backend its lane is not allowed

`config/backends.cjs` maps each lane to the Supabase project refs it may use, and throws
during configuration resolution otherwise:

```js
const LANE_BACKENDS = {
  development: ['fjxhcbowoxuzulwirzyr'],  // bingd-staging
  preview:     ['fjxhcbowoxuzulwirzyr'],
  beta:        ['fjxhcbowoxuzulwirzyr'],
  production:  ['abheeqyjzekiowkztfxv'],  // bingd-production, promoted 2026-08-31
};
```

> ### The two projects swapped roles on 2026-08-31, and the reason is the users
>
> `abheeqyjzekiowkztfxv` was the friend-Beta backend. It is now **production**, and the
> empty project created that morning (`fjxhcbowoxuzulwirzyr`) became **staging**.
>
> The alternative was shipping a public release against an empty database and asking the
> real people already using Bingd — fourteen profiles, two hundred and forty-two collection
> rows, two hundred and thirty-nine rankings, one collection of eighty-three titles — to
> register again and re-enter all of it. Promotion copies nothing, so there is no restore
> to get wrong: every Auth UUID, refresh token, follow, notification, award and avatar
> stayed exactly where it was. Verified by a before/after comparison that came back
> **identical on every count**, with the four invite-token environment values as the only
> intended difference.
>
> **What promotion required.** `set_environment_name` deliberately refuses to rename a
> populated database, because invite tokens carry the environment that minted them and a
> bare rename strands every link somebody is holding. `20260905000100` adds
> `p_promote => true`, which moves the stamps in the **same transaction** as the name — the
> guard's reason removed rather than the guard bypassed. The default still refuses.
>
> **Old beta binaries keep working against production, deliberately.** They are the same
> real people, their authorisation is their own JWT under the same RLS, and they move to
> the store build when they install it. No key was rotated and no client-exclusion
> mechanism was added to force them off.
>
> **No beta build may target staging until it reaches 103/103 and passes smoke.** It stands
> at 53/103: `20260817001000` contains `lock table`, which the Management API applies
> outside a transaction. That is the first post-release infrastructure task and it blocks
> beta redistribution, not this release.

This exists because the failure has no symptom. The Supabase URL is an EAS environment
variable — a value in a web dashboard, edited by hand — and a build pointed at the wrong
project does not crash, warn, or look different. It signs in and shows an empty collection,
and every acceptance result taken on it is about a database nobody meant to test.

**Three properties, each of which was a finding before it was a property.** Independent
review 28 raised the first two as a Blocker against a version of this that lived inside
`app.config.ts`:

- **It covers `eas update`, not only `eas build`.** The rule used to be gated on
  `EAS_BUILD=true`. But `eas update` resolves the config on the developer's own machine and
  compiles the URL into the bundle it publishes, so an update could carry any backend to any
  channel. The gate is gone.
- **It is per lane, not one flat set.** A single allowlist meant that the day a production
  ref is added, *every* lane could use it — a Beta build on production, a Production build
  on nonprod, neither failing. `production: []` is also why a `--profile production` build
  refuses today by name rather than quietly succeeding against nonprod.
- **It is testable.** The logic is a CommonJS module because `app.config.ts` cannot be
  imported by a test, and a rule nothing can exercise is a rule nobody can check.
  `npm run test:config` — 18 assertions covering URL parsing (userinfo, path, fragment and
  suffix impostors all rejected), cross-lane swaps, the empty production lane, the escape
  hatch, and agreement with `eas.json`. It runs in the **pull request** gate, because what
  it protects arrives on pull requests.

**There is no escape hatch, and there was one for a round.**
`BINGD_ALLOW_UNLISTED_BACKEND` was refused only when `EAS_BUILD=true` — and **`eas update`
never sets that**, so the one variable meant to close the hatch for shipped artifacts was
absent on the path that ships them (review 28b). It is gone rather than narrowed; anybody
who genuinely needs another project adds its ref to the development lane, which is a line
in a diff somebody reads.

**An undeclared lane gets the development lane's permissions, not the union of every
lane's.** The union is safe only while there is exactly one backend, and it is a trap that
springs later: a bare `eas update` supplies no lane, and the day a production ref exists it
could otherwise compile production credentials and publish them to any channel.

A URL that is not a Supabase URL at all — CI's `https://ci.invalid`, a local stack on
`127.0.0.1` — passes through; `src/lib/env.ts` is what refuses an unusable one at startup.

**When a production Supabase project is created, its ref is added to the `production` lane
and to nothing else,** in the same reviewed change that creates it.

The second half of the same question — *which* backend did this build actually choose — is
answered on the device: Settings shows `backend abheeqyjzekiowkztfxv` on **every lane but
`production`**, Beta included. The URL is in the bundle already and the anon key is public
by construction, so there is no secret in that line.

### Nothing points at a production backend, because there is none

There is no production Supabase project, and a `--profile production` build fails twice
over — the first failure is the earlier one:

1. **At configuration resolution, on the build machine.** `LANE_BACKENDS.production` is
   empty, so any Supabase URL at all is refused by name: *"Permitted: nothing — this lane
   has no backend yet."* The build never gets as far as compiling.
2. **At app startup, if it somehow did.** The `production` EAS environment has no variables,
   and `src/lib/env.ts` parses `extra` with zod and throws on a missing `supabaseUrl`.

Both are loud. An earlier version of this document named only the second, which was true but
described the wrong moment.

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

Every lane except `production` shows, under the version line:

```
preview · preview
runtime 5d60b7b0 · embedded
backend abheeqyjzekiowkztfxv
```

lane, channel, runtime fingerprint, update state, backend ref. **No DSN, no project token,
no anon key, no service key, no user identifier.** None of the five values above reads
anything back from anywhere, which is why they can be on a screen at all — the project ref
is the hostname in the bundle, and the anon key it pairs with is public by construction and
bounded by row level security.

**A Production build shows the version line only.** That is the store rule from PRD §23 —
no identifiers in anything user-facing — and it applies to a public release, not to a beta.

---

## Environment variables, in full

| Name | Where it lives | Reaches the client bundle | Value today |
|---|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | EAS env `development`, `preview` | yes | `https://abheeqyjzekiowkztfxv.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | EAS env `development`, `preview` | yes | publishable key, bounded by RLS |
| `EXPO_PUBLIC_SENTRY_DSN` | EAS env `development`, `preview` | yes | accepts events only |
| `EXPO_PUBLIC_POSTHOG_KEY` | EAS env `development`, `preview` | yes | write-only project token |
| `EXPO_PUBLIC_POSTHOG_HOST` | `eas.json` → `base.env`* | yes | `https://us.i.posthog.com` |
| `APP_VARIANT` | `eas.json` per profile | as `extra.variant` | selects the variant table |
| `BINGD_LANE` | `eas.json` per profile | as `extra.lane` | the profile's own name |
| `SENTRY_DISABLE_AUTO_UPLOAD` | `eas.json` per profile | **no** | `true` — see below |
| `SENTRY_AUTH_TOKEN` | **not configured** | **no** | *founder action* |
| `TMDB_ACCESS_TOKEN` | **Supabase function secret** | **never** | server-side only |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local`, git-ignored | **never** | operator scripts only |

\* **`base.env` reaches builds and not updates.** Anything under `eas.json` →
`build.<profile>.env` — including everything inherited from `base` — is read by `eas build`
and by nothing else; `eas update` takes an *environment*, and an EAS environment holds only
the four `EXPO_PUBLIC_*` variables above it. It happens not to matter for this one, because
`app.config.ts` defaults `posthogHost` to the same value, and it matters a great deal for
`APP_VARIANT` and `BINGD_LANE`, which is why `scripts/release.mjs` supplies those two by
hand. Noted here rather than left to be rediscovered on the next variable somebody adds to
`base.env`. (Review 28c.)

Five things this table is asserting, each of which was checked rather than assumed:

- **The `production` EAS environment is empty.** Verified with `eas env:list --environment production`.
- **No service-role key is reachable from any client path.** `.env.local` is read by
  `supabase/seed/backfill-tmdb.mjs` and nothing else, and `.env.*` is git-ignored.
- **There is no TMDB variable in `.env.example` and adding one would be a bug.** TMDB is
  reached only through the `tmdb-adapter` Edge Function, which holds the token as a
  Supabase secret (AD-8, PRD §19).
- **The client bundle was scanned for secrets** during the security tranche and was clean.
  See `docs/security/beta-security-review.md`.
- **`scripts/release.mjs` passes no credential.** It supplies `BINGD_LANE` and
  `APP_VARIANT` and nothing else; everything above comes from the EAS environment the
  profile names. A secret routed through that script would be a secret in a process listing
  and in a shell history.

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
