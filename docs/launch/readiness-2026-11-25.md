# Launch readiness, 2026-11-25: auth, Sentry, store 1.2.0, alerting

The overnight sprint of 2026-11-24/25 produced this record. Each section gives what was checked, what is done, and the smallest action left for the founder. Every reading was read-only. No production configuration, secret or migration was changed.

## 1. Authentication: email quota and CAPTCHA

### Configuration as read on 2026-11-25 (Management API, non-secret fields only)

| Setting | Production | Staging |
|---|---|---|
| Email provider | Resend SMTP (`smtp.resend.com:465`, sender "bingd.") | Supabase built-in mailer |
| `rate_limit_email_sent` (all emails, project-wide, per hour) | **30** | 2 |
| `smtp_max_frequency` (per address) | 60 s | 60 s |
| `rate_limit_otp` / `rate_limit_verify` | 30 / 30 | 30 / 30 |
| `security_captcha_enabled` | **false** (provider field says hcaptcha; no secret set) | false |
| Email sign-in | one-time code (`signInWithOtp`, 6 digits, 10 min) | same |
| Password sign-in / reset | not offered | not offered |
| Apple / Google | on | off |
| Accounts | 66 total, 37 email, 5 new in 30 days | n/a |

### What happens when the quota runs out
`over_email_send_rate_limit` covers both the per-address cooldown and the project-wide quota. The client already tells them apart (`src/features/auth/methods.ts`, `rateLimitMessage`):
- **Cooldown:** "You just asked for a code. Try again in N seconds."
- **Quota:** "We cannot send codes right now. Try again in a few minutes, or continue with Apple or Google."

Nobody is locked out of Apple or Google sign-in. The risk is a marketing burst of more than 30 email sign-ins in an hour. Every later email user would then hit the quota message until the hour rolls over, and so would the Welcome emails, which share the same Resend account.

### Recommendation (founder, dashboard)
1. **Check the Resend plan.** Resend is the real ceiling: the free tier is 100 emails a day and 3,000 a month. Welcome emails count against the same allowance.
2. **Set `rate_limit_email_sent`** to what the plan can sustain:
   - on a paid Resend plan, **150 per hour** is reasonable for the push;
   - on the free plan, leave it at 30, because the daily cap (100) is the binding limit, and upgrade Resend before the push.
3. **Make the same change in `supabase/auth-templates/templates.json` → `limits`**, in one reviewed PR. `scripts/check-auth-config.mjs` fails when the dashboard and that file disagree, and it deliberately never writes limits.
4. **Leave `smtp_max_frequency` at 60 s.** The client's cooldown copy is built against it.

**Rollback:** set the dashboard value back. The client needs no change either way.

### CAPTCHA: not tonight, and why
- Supabase CAPTCHA (hCaptcha or Cloudflare Turnstile) needs the client to send a `captchaToken` with `signInWithOtp`. On React Native that token comes from a WebView widget.
- `react-native-webview` is not installed, so this is a **native dependency and a new store binary**.
- Turning CAPTCHA on in the dashboard before the client sends tokens **would break every email sign-in.**

**Plan for the next binary after 1.2.0:**
1. Add `react-native-webview` and a Turnstile (invisible) or hCaptcha widget.
2. Pass `options.captchaToken` in `sendEmailCode`, with focused tests.
3. Ship and confirm the binary is adopted.
4. Then set the provider and secret in the dashboard and enable it.

**Kill switch:** `security_captcha_enabled = false`.

Until then, abuse is bounded by `smtp_max_frequency` (60 s per address), `rate_limit_otp`/`verify` (per IP), and the project quota itself.

## 2. Sentry crash reporting
- **Store binaries:** these already upload source maps. The production build logs for 1.1.0 (15) and 1.2.0 (16) show the Gradle `createBundleReleaseJsAndAssets_SentryUpload_*` step ("Uploaded files to Sentry", org `fourward-habits`, project `bingd-react-native`, release `app.bingd@1.x+N`) and Xcode "Upload Debug Symbols to Sentry". So the production EAS environment's `SENTRY_AUTH_TOKEN` exists and works for that project.
- **OTAs had never uploaded source maps** (`upload_sentry_sourcemaps: false`), and every production user runs an OTA, so production stacks were minified.
- **The fix is PR #380, merged as `a66dfb98`:**
  - `metro.config.js` adds Sentry's serializer. Without it a bundle has a map but no runtime Debug ID registration; with it, it has both.
  - `upload_sentry_sourcemaps: true` is set on the production OTA workflow only. Preview has no token.
  - The native fingerprint is unchanged.
- **One project, as now.** Production and Preview are separated by the `environment` tag (the lane). No second project is needed at this traffic.
- **Founder check (2 minutes):** in Sentry, open an issue from a production device after the next OTA and confirm the stack shows file names and line numbers. If the upload ever fails the publish job, the update is already live. Check `release-manifest live production`, and set the flag back to false to disable the upload.

## 3. Store 1.2.0
- **#330** (`release/2026-11-20-store-1.2.0`): version 1.2.0 and the EAS `store-build.yml` workflow. On 2026-11-20 this produced 1.2.0 (16) for both platforms from `e76d8730`. That JS predates everything shipped since, including the Leaderboard, Comments and performance work.
- **Refresh: draft #382** (`release/2026-11-25-store-1.2.0`) is current main (`32790c48`, with #378, #380 and #381) plus #330's change, so the embedded bundle is current. It supersedes #330. Build it with `store-build.yml`, which runs on EAS where `GOOGLE_SERVICES_JSON` lives and submits nothing.
- **After both binaries are live (doc §11 on #326):**
  1. Merge the bump.
  2. Set `config/live-runtimes.json` to the new runtimes.
  3. From then on, production OTAs target 1.2.0. 1.1.0 users keep their last OTA until the store updates them.
- **#326 (listing):** card 03 still needs the founder's `Screenshot_20261119_160109_bingd.jpg`. Once it is there, the swap is one command.
- **Founder steps:**
  1. **iOS:** `eas submit -p ios --id <build>`, or upload in App Store Connect, then Submit for Review.
  2. **Android:** there is no Play service account, so upload the `.aab` by hand in Play Console.

## 4. Operational alerting
- **#343 is the design, and complete:**
  - a Healthchecks.io dead-man's switch plus an alerts check, fed by `bingd-ops-alert`;
  - gated to production;
  - silent without the Vault key;
  - 23 PGlite tests, Codex clean;
  - staging-applied.
- **Before production:**
  1. **Renumber its migration.** `20261130000700` is now older than production's head (`20261130001300`), so it must become the next free version, with the staging history row updated in the same change.
  2. **Founder setup:**
     - a Healthchecks.io account (free) and a `bingd production` project;
     - checks `bingd-heartbeat` (10 min period / 20 min grace) and `bingd-alerts` (10 min / 1 day);
     - the project ping key stored in production Vault as `ops_alert_ping_key`.
  3. **Approval** to apply the renumbered migration to production.
- **No competing system was built.**
