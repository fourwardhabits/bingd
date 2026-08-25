# Production environment and secrets

**Written 2026-08-26.** Every value a production build, a production function or a production
job needs; where it lives; and what happens when it is missing.

The rule the whole page is arranged around: **a missing production value fails closed.** It
does not fall back to nonprod, and it does not produce a binary that discovers the problem on
somebody's phone.

---

## 1. The environment matrix

| | development | preview | beta | production |
|---|---|---|---|---|
| `APP_VARIANT` | development | preview | **production** | production |
| `BINGD_LANE` | development | preview | beta | production |
| EAS environment | development | preview | **preview** | production |
| Channel | development | preview | beta | production |
| Supabase project | `bingd-nonprod` | `bingd-nonprod` | `bingd-nonprod` | **none yet** |
| `environment_name()` | nonprod | nonprod | nonprod | **prod** |
| Sentry `environment` | development | preview | **beta** | **production** |
| Bundle id | `app.bingd.dev` | `app.bingd.preview` | `app.bingd` | `app.bingd` |
| `aps-environment` | development | development | development | **production** |
| Backend required at build time | no | no | no | **yes** |

Two rows are the ones that catch people out.

**Beta builds the production variant.** The bundle identifier cannot change between a
TestFlight build and the App Store release that replaces it, so `variant === 'production'` is
true of a friend beta. Anything asking "is somebody testing this" must ask the **lane**.
`src/lib/env.ts` exports `isRelease` for exactly that, and `Sentry`'s `environment` is the lane
rather than the variant — otherwise a beta crash against nonprod and a public crash against
production arrive in the same bucket.

**Beta and production share an EAS environment.** Beta builds resolve the `preview`
environment, so beta credentials are nonprod credentials. Production is the only lane pointed
at the `production` EAS environment, and that environment is empty today.

---

## 2. EAS environment `production`

Currently: **zero variables.** `eas env:list production` confirms it.

| Variable | Value | Missing ⇒ |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `https://<production ref>.supabase.co` | **build refuses** (`config/production-lane.cjs`) |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | production publishable key | app throws at startup (`src/lib/env.ts`) |
| `EXPO_PUBLIC_SENTRY_DSN` | **production** Sentry project DSN | crash reporting silently off |
| `EXPO_PUBLIC_POSTHOG_KEY` | **production** PostHog project key | analytics silently off |
| `EXPO_PUBLIC_POSTHOG_HOST` | inherited from `eas.json` `base` | — |
| `SENTRY_AUTH_TOKEN` | secret; source-map upload | production stacks stay minified |
| `SENTRY_PROJECT` | the **production** Sentry project slug | maps upload into the Beta project, or the upload fails and production events arrive unsymbolicated |
| `SENTRY_ORG` | only if the organisation differs from `fourward-habits` | — |
| `GOOGLE_SERVICES_JSON` | **file** secret | Android build **fails** — `config/push.cjs` demands it for the production lane |

```
eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_URL --value https://<ref>.supabase.co
eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <key>
eas env:create --environment production --name EXPO_PUBLIC_SENTRY_DSN --value <production dsn>
eas env:create --environment production --name EXPO_PUBLIC_POSTHOG_KEY --value <production key>
eas env:create --environment production --name SENTRY_AUTH_TOKEN --value <token> --type sensitive
eas env:create --environment production --name SENTRY_PROJECT --value <production sentry project slug>
eas env:create --environment production --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json
```

> **Do not copy the preview values.** The preview environment holds nonprod's Supabase URL and
> anon key, and a production build carrying them would sign strangers into the friend-Beta
> database. `config/backends.cjs` refuses that combination outright — but the refusal is the
> backstop, not the plan.

---

## 3. Secrets that never touch EAS or git

| Secret | Where it lives | Used by |
|---|---|---|
| Production **service-role key** | Supabase Vault, secret name `service_role_key` | `_drain_push_outbox()` |
| | GitHub secret `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` | Trending refresh workflow |
| | `.env.local` on the founder's machine, transiently | `bootstrap-production.mjs`, acceptance |
| Production **TMDB access token** | `supabase secrets set TMDB_ACCESS_TOKEN=…` | `tmdb-adapter` |
| Production **database password** | founder's password manager | `psql`, restores |
| **APNs `.p8`** | EAS credentials | Expo Push Service |
| **FCM V1 service account** | EAS credentials | Expo Push Service |

`.env` and `.env.local` are git-ignored. **Production credentials do not belong in `.env`** —
that file is nonprod's and is read by every script in the repository by default.

---

## 4. Push credentials — the RC blocker

`push-sender` needs none of these. Delivery goes through **Expo Push Service**, which holds the
provider credentials against the EAS project; the Edge Function only ever talks to Expo.

**Apple**

- [ ] Push Notifications capability enabled on App ID `app.bingd`
- [ ] APNs auth key (`.p8`), Key ID, Team ID (`98729PG8GD`)
- [ ] Uploaded to EAS: `eas credentials --platform ios`
- [ ] The production binary carries `aps-environment: production` — `config/push.cjs` writes
      it for the production lane only. **Every binary before this one carried
      `development`**, which is the APNs *sandbox*, and is why an RC is required rather than
      an over-the-air update.

**Google**

- [ ] Firebase project, Android app registered as `app.bingd`
- [ ] `google-services.json` downloaded
- [ ] `GOOGLE_SERVICES_JSON` file secret in the **production** EAS environment — *currently
      absent; `eas env:list production` shows nothing*
- [ ] FCM V1 service-account key uploaded: `eas credentials --platform android`

Both lists are **unverified** as of 2026-08-26: `eas credentials` is interactive and cannot be
read non-interactively, and `eas env:list production` returns nothing. Treat every box as
unticked until the founder confirms otherwise.

---

## 5. GitHub repository secrets and variables

| Name | Kind | For |
|---|---|---|
| `SUPABASE_URL_NONPROD` | secret | Trending refresh |
| `SUPABASE_SERVICE_ROLE_KEY_NONPROD` | secret | Trending refresh |
| `SUPABASE_URL_PRODUCTION` | secret | Trending refresh |
| `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` | secret | Trending refresh |
| `BINGD_PRODUCTION_TRENDING` | **variable**, `true` | Enables the nightly production run |

The variable exists so the nightly job does not fail every night until production exists. A
workflow that is red by default is a workflow nobody reads. See
[`trending-operations.md`](./trending-operations.md).

---

## 6. Telemetry separation

**PostHog.** A separate production project, and a separate key. Sharing one project means
beta and public events land in the same funnels with nothing but a property to tell them
apart. The event schema itself needs no change: `src/lib/analytics.ts` is a closed vocabulary
with a `FORBIDDEN_PROPERTY_KEYS` denylist that already covers `dob`, `date_of_birth`, `note`,
`review`, `comment`, `token` and `access_token`, autocapture is off, and non-scalar property
values are refused outright.

**Sentry.** A separate production project and DSN. `environment` is now the lane, so a beta
crash reports `beta` and a public crash reports `production` even if the same DSN were used —
but alert rules, quotas and release health are per project, and a public launch sharing a
project with a friend beta cannot be alerted on sensibly.

Source maps upload at build time via the Sentry Expo plugin. The plugin's `organization` and
`project` used to be hard-coded to `fourward-habits` / `bingd-react-native` — the friend beta's
project — so a production build would either have uploaded its maps there or failed the upload
because a production-scoped token has no access to it. Either way production events would have
arrived unsymbolicated, which is most of a crash reporter's value gone and is invisible until
somebody needs a stack trace. They read `SENTRY_ORG` and `SENTRY_PROJECT` now, defaulting to
the current values so no other lane's resolved config moves. `SENTRY_AUTH_TOKEN` comes from the
production EAS environment alongside them. `SENTRY_DISABLE_AUTO_UPLOAD` is set for development, preview and
beta and is **deliberately absent from the production profile** in `eas.json` — production is
the lane whose stacks have to be readable.

Neither vendor receives a raw date of birth, a Private Note, or a push token. The token rule
is enforced twice: `src/features/notifications/push.ts` rebuilds every error through
`redactTokens` before it reaches Sentry, and `push-sender` redacts Expo's own error messages
before they are written to `push_outbox.last_error`.
