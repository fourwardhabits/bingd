# Disaster recovery: a new laptop

**Drafted 2026-09-23 from a read-only audit of the founder machine. Re-verified 2026-09-26 at
the product freeze (frozen source `9d9683a`, store binaries 1.1.0 from `63694c3`).**

What is live is [`../release/production-state.md`](../release/production-state.md). What is
left to do, including the backup actions below, is
[`../product/founder-todo.md`](../product/founder-todo.md).

The question this page answers: *the laptop is gone; how do I get back to a machine that can
develop and deploy bingd?* It is a checklist, not an explanation. The detail for each system
lives in the docs it links to.

> **No credential value belongs in this file.** It names where each secret lives and which
> variable holds it. If you find yourself pasting a key here, stop.

Items marked **VERIFY** are assumptions that nobody has read back from the vendor. Confirm
each one once, then change the mark to the date you checked.

---

## 0. What the laptop never held (nothing to recover)

These run in vendor clouds and keep running without any machine:

| System | Keeps running because |
|---|---|
| Production app (iOS App Store, Google Play) | store-hosted binaries plus OTA bundles on EAS |
| Supabase production `abheeqyjzekiowkztfxv` and staging `fjxhcbowoxuzulwirzyr` | Supabase-hosted; `pg_cron` drains run inside the database |
| bingd.app | Cloudflare Pages builds `main` from GitHub, with no local deploy step ([web-deployment.md](../architecture/web-deployment.md)) |
| Nightly Trending refresh, hourly welcome email | GitHub Actions (`trending-refresh.yml`, `welcome-email.yml`), with secrets held in GitHub |
| Auth email | Supabase custom SMTP → Resend (`auth.bingd.app`) |
| Support mailbox | Cloudflare Email Routing on `bingd.app` |

A dead laptop stops **new** work. It does not take anything down.

---

## 1. Services: what each is for, where its configuration lives, and what cannot be rebuilt

Sign in on the new machine in this order: GitHub unlocks the code, and the others unlock
deploys. If a 2FA method or its recovery codes were stored only on the laptop, fix that before
anything else. **VERIFY** means nobody has confirmed it from the vendor side.

| Service | Purpose | Configuration lives in | Access needed | Irreplaceable state outside Git and DB backups |
|---|---|---|---|---|
| **GitHub** `fourwardhabits/bingd` | code, PRs, Actions (CI, release gate, trending, welcome email) | the repo; Actions secrets (§8) | org owner; 2FA (**VERIFY** recovery codes off-laptop) | none. Secrets can't be read back, only regenerated at the vendor |
| **Supabase production** `abheeqyjzekiowkztfxv` | the database, auth, Edge Functions, Storage, `pg_cron` | migrations in Git; `app_config` rows, Vault `service_role_key`, function secrets, auth providers and SMTP, OTP templates in the dashboard | org `Fourward` owner | **all user data** (8 daily backups, PITR off, §10); 3 avatar files in Storage (95 kB, not in DB backups) |
| **Supabase staging** `fjxhcbowoxuzulwirzyr` | QA backend for the preview lane | same shape as production | same org | QA accounts only ([`staging-qa-inventory.md`](../release/staging-qa-inventory.md)); rebuildable |
| **Expo / EAS** project `@fourward/bingd` (`d10f76cc…`) | builds, OTA updates, env vars, signing, submission | `eas.json` in Git; env vars `production` / `preview`; credentials on EAS servers | account `fourward`; 2FA **VERIFY** | build and update history; the iOS distribution cert and profile (valid to 2027-04-22), the Android upload keystore, the ASC API key `7L8FQ94SZX`. All EAS-held; **VERIFY** a keystore backup exists outside EAS |
| **Apple** App Store Connect, team `98729PG8GD`, app `6803954532` | iOS distribution, review, TestFlight | the ASC dashboard; `eas.json` `submit` | Apple ID + trusted device | the listing, screenshots, review history (Apple-held) |
| **Google Play Console** `app.bingd` | Android distribution | the Play Console | the Google account; **VERIFY** Play App Signing is on | the listing and release history (Google-held). **There is no Play service account, so every AAB is uploaded by hand** |
| **Firebase** `bingd-f1ad4` | FCM for Android push | `google-services.json` (ignored locally, EAS file secret `GOOGLE_SERVICES_JSON`) | Google account | none; re-downloadable, keys regenerable |
| **Cloudflare** | registrar + DNS for `bingd.app`, Pages (bingd.app), Email Routing (support mail) | the dashboard; the Pages project is git-connected to `main` | account owner | the DNS zone. Record it once (export) so it can be re-created |
| **Resend** | auth email over SMTP (`auth.bingd.app`), the welcome email | the Resend dashboard; key `Supabase` in Supabase SMTP; `RESEND_API_KEY_WELCOME` in GitHub | account owner | domain verification (re-doable via DNS) |
| **TMDB** | catalogue, credits, trending | token in Supabase function secrets (`TMDB_ACCESS_TOKEN` / `TMDB_API_KEY`) | TMDB account | none; the catalogue in Postgres is a cache |
| **PostHog** (US cloud) | product analytics | `EXPO_PUBLIC_POSTHOG_KEY` / `_HOST` in EAS env | account owner | event history (vendor-held) |
| **Sentry** org `fourward-habits` | crash reporting | `EXPO_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` in EAS env | account owner | issue history (vendor-held) |
| **DNS / domain** `bingd.app` | web, deep links (AASA, `assetlinks.json` from `web/`), email | Cloudflare; the link files are built from `web/` in Git | Cloudflare owner | renewal. **VERIFY** auto-renew and the renewal card |

---

## 2. Tooling

| Tool | Version | Notes |
|---|---|---|
| Git | current | set `core.autocrlf` to match the old machine; CRLF drift has broken fingerprints before |
| Node | **22.16.0** | pinned in `eas.json` `build.base.node`; use the same version locally |
| npm | ships with Node | the repo uses `package-lock.json` |
| eas-cli | `>= 21.7.1` (`eas.json` `cli.version`) | `npm i -g eas-cli`, then `eas login` |
| Supabase CLI | via `npx supabase` | not a dependency; `npx supabase login` |
| Deno | devDependency (`^2.9.5`) | installed by `npm ci`; used by `functions:check`/`lint` |
| gh | current | `gh auth login` |
| Android Studio / Xcode | only for local native debugging | release builds run on EAS |

---

## 3. Code

```
git clone https://github.com/fourwardhabits/bingd.git
cd bingd
npm ci
```

The workspace layout is in `Bingd-Workspace/02_Development/WORKSPACE_POLICY.md` (not in
Git, and it goes with the laptop). The short version: one canonical clone, temporary
worktrees under `02_Development/Worktrees/`, release clones pinned to a SHA under
`02_Development/Builds/`.

**Restore local-only Git work** from the latest `git bundle` in cloud storage, if one
exists:

```
git fetch <path-to>/bingd-YYYY-MM-DD.bundle 'refs/heads/*:refs/remotes/bundle/*'
git branch -r | grep bundle/     # then check out what you need
```

**Re-create the local ignore rules.** Some entries live in `.git/info/exclude`, which is
not in the repo, so a fresh clone does not have them:

```
/02 JSO/
store-assets/google-play/
**/.claude/worktrees/   (and the other **/.claude/* state entries)
```

Until these are re-added, a `git add -A` in a fresh clone **will stage the FCM
service-account key** if `02 JSO/` is restored into the working tree. Don't "fix" this by
adding lines to `.gitignore` casually: `.gitignore` is a fingerprint source, so every lane's
runtime would move and installed binaries would stop receiving updates from `main`.

**Backup branches.** Every commit that ever existed only on the laptop is on GitHub as
`backup/*` (10 branches, 2026-09-25) or `backup/stash/*` (3 stashes, 2026-09-26). None is
merged, and none is production truth.

---

## 4. Local configuration files

None of these are in Git. None should be.

| File | Holds (names only) | Restore from |
|---|---|---|
| `.env` | `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_HOST`, `APP_VARIANT` | EAS `production` environment (`eas env:list --environment production`, **filter to `EXPO_PUBLIC_*`**, because that command prints secrets in plain text) |
| `.env.local` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → project → API keys, or `npx supabase projects api-keys --project-ref <REF>` |
| `google-services.json` (repo root) | Firebase Android config | Firebase console → project `bingd-f1ad4` → Android app `app.bingd`. **It must be byte-identical to the EAS `GOOGLE_SERVICES_JSON` file secret**, or the local fingerprint and the Android build disagree. If unsure, download it fresh and re-upload it to EAS |
| `02 JSO/` | FCM V1 service-account key; a copy of `google-services.json` | password manager / encrypted cloud copy. The FCM key can also be regenerated in Firebase → Service accounts; then re-upload with `eas credentials --platform android` |
| `BINGD_STAGING_DB_URL` (env, when used) | direct Postgres URL for staging | Supabase dashboard → staging → Connect |

`.env` holds **production** values today. The staging suites take staging keys from the CLI
into the child process only; see the header of `supabase/tests/remote-smoke.mjs` and
[production-environment.md](../release/production-environment.md).

---

## 5. Supabase

| | Ref | Name |
|---|---|---|
| **Production** | `abheeqyjzekiowkztfxv` | `bingd-production` |
| **Staging** | `fjxhcbowoxuzulwirzyr` | `bingd-staging` |

`config/backends.cjs` is the source of truth. The ref is the identity; names have swapped
before.

```
npx supabase login
npx supabase migration list --project-ref fjxhcbowoxuzulwirzyr
npx supabase migration list --project-ref abheeqyjzekiowkztfxv
npx supabase functions list --project-ref abheeqyjzekiowkztfxv
```

**Always pass `--project-ref`.** The CLI link is machine state, and a new machine has none.

Secrets that live **inside** Supabase survive the laptop, and none of them need
restoring:

- Edge Function secrets: `TMDB_ACCESS_TOKEN` / `TMDB_API_KEY` (`tmdb-adapter`);
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.
- Vault secret `service_role_key`, read by the push drain.
- Auth: Apple and Google provider credentials, custom SMTP (Resend key named `Supabase`),
  OTP templates. **Never `supabase config push` the `[auth]` block.** It reverts fields it
  does not mention, including provider secrets ([auth.md](../architecture/auth.md)).

Deploy paths: [production-bootstrap.md](../release/production-bootstrap.md) and
[supabase/functions/README.md](../../supabase/functions/README.md). Nothing in the release
path deploys Edge Functions, so compare `git log -1 -- supabase/functions/` with
`functions list` before every release.

---

## 6. EAS: builds, OTA, signing

```
eas login
eas whoami
eas env:list --environment production     # names; do not paste the output anywhere
eas credentials                           # interactive; confirm iOS + Android are present
```

- **Signing credentials are EAS-managed** (no `credentials.json` in the repo). iOS
  distribution certificate, provisioning profile, APNs key, Android upload keystore and FCM V1
  key live on EAS. **VERIFY** once through `eas credentials`, and download a backup of the
  Android keystore into the password manager.
- **Build numbers are remote** (`appVersionSource: remote`), so nothing local is lost.
- **Build and OTA history** live on expo.dev. Nothing is stored locally.
- Lanes, channels and runtime rules: [release-lanes.md](../release/release-lanes.md),
  [safe-update-runbook.md](../release/safe-update-runbook.md). Commands:
  `npm run build:beta`, `npm run update:beta`, and so on (`scripts/release.mjs`).
- **Release from a clean clone, not from a checkout with `.env`.** Copy
  `google-services.json` in, and pass the four `EXPO_PUBLIC_*` values inline from EAS. A
  copied `.env` breaks `eas update`, and a missing `google-services.json` breaks the
  production config.
- `eas env:list` has to resolve the Expo config before it will list anything, and the config
  refuses to resolve without those same values. Run it once from a checkout that has a
  `.env`, redirect the output to a file outside the repo, and keep only the `EXPO_PUBLIC_`
  lines. It prints secret values in plain text.
- **Prove the environment before building:** in the clean clone at the commit the live binary
  was built from, `npx expo-updates fingerprint:generate --platform <p>` must equal that
  build's runtime on EAS (iOS 170 sources, Android 173). Only then does a changed hash mean a
  changed binary.
- `eas.json`, the marketing `version`, and `.gitignore` are all fingerprint inputs. Changing
  any of them moves every lane's runtime.
- The store-binary path used on 2026-09-26: `node scripts/release.mjs build production
  --platform <p> --non-interactive --freeze-credentials --no-wait` from a `release/*` branch
  whose exact commit has a green `release-gate.yml`. Then, for iOS only, `eas submit
  --platform ios --profile production --id <build>` with `APP_VARIANT=production
  BINGD_LANE=production` set. Without them a bare `eas submit` resolves the dev bundle id.

---

## 7. Web (bingd.app)

Cloudflare Pages project `bingd`, git-connected to `main`. There is no wrangler and no
local credentials, so deploying means merging to `main`. DNS and the registrar are both
Cloudflare (nameservers `rick` / `courtney.ns.cloudflare.com`). Landing screenshots are built
by `web/shots.mjs` from `02 Screenshots/App Store/`, which is **not in Git**. Restore that
folder from cloud storage before re-shooting. Detail: [web-deployment.md](../architecture/web-deployment.md).

---

## 8. GitHub Actions

These already live on GitHub and need nothing from you. For reference:

| Secret / variable | Used by |
|---|---|
| `SUPABASE_URL_NONPROD`, `SUPABASE_SERVICE_ROLE_KEY_NONPROD` | trending refresh (staging) |
| `SUPABASE_URL_PRODUCTION`, `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` | trending refresh, welcome email |
| `RESEND_API_KEY_WELCOME`, `WELCOME_POSTAL_ADDRESS` | welcome email |
| `BINGD_PRODUCTION_TRENDING` (variable) | enables the production trending run |

GitHub secrets cannot be read back. If one must be re-entered, regenerate it at the vendor.

---

## 9. Stores

- **Apple**: App Store Connect in a browser. Uploads go through `eas submit` with the
  `production` submit profile, using the EAS-held App Store Connect API key (`7L8FQ94SZX`,
  confirmed 2026-09-26). Submitting for review and choosing the release mode are clicks in
  App Store Connect.
- **Google Play**: Play Console in a browser. There is no Play Developer API service account,
  so `eas submit --platform android` cannot run: download the `.aab` from the EAS build page
  and upload it under Production → Create new release. **VERIFY** that Play App Signing is
  on. If it is, a lost upload key is recoverable through Play support; if not, the keystore
  backup in section 6 is the only copy.
- Store listing copy and Play graphics currently live only in `store-assets/google-play/`
  (locally excluded). Restore them from cloud storage, or read them back from the consoles.
  Review access: [store-review-access.md](../release/store-review-access.md).

---

## 10. Database restore (high level)

**Read 2026-09-26 with `npx supabase backups list --project-ref <REF>`:**

| | Backups | PITR | Newest | Oldest |
|---|---|---|---|---|
| Production | 8 daily physical (WAL-G), all `COMPLETED` | **off** | 2026-09-26 07:12Z | 2026-09-19 |
| Staging | 8 daily physical | off | 2026-09-26 06:07Z | 2026-09-19 |

Recovery granularity is one day. **No off-platform logical export exists yet**, and no
protected cloud location has been set up to hold one (founder TODO). Staging needs no backup
beyond Supabase's own: everything on it can be recreated.

| Scenario | Procedure |
|---|---|
| Bad write or bad migration, project intact | [backup-and-recovery.md §4a](../release/backup-and-recovery.md): stop the push drain, restore in the dashboard, `migration list`, re-run `bootstrap-production.mjs --target production --apply`, remote smoke |
| Project deleted or org lost | Supabase backups go with the project. The only recovery is the latest **off-platform logical export** (section 11), restored into a new project per [production-bootstrap.md](../release/production-bootstrap.md). A new ref means a new binary |

What a database backup **does not** contain:

- **Avatar image files** (Storage bucket `avatars`). Only their `storage.objects` metadata
  is in Postgres. Losing the project loses the images, and profiles fall back to initials.
  On 2026-09-26 this was **3 files, 95 kB**: not worth a separate backup job. No other bucket
  holds user data, and no user or business data lives outside Postgres.
- Edge Function code (it is in Git) and function secrets (re-set them from the vendors).

What is regenerable: the TMDB catalogue, Trending, seasons and episodes (`seed:fetch`,
`catalogue:enrich`, `trending:refresh`, and the adapter on demand). What is **not**: auth
users, rankings, reviews, notes, lists, the social graph, award ledgers and the welcome-email
ledger.

---

## 11. Standing backups (what should already exist)

| What | Where | How often |
|---|---|---|
| Code on `main` and pushed branches | GitHub | continuous |
| `git bundle create bingd-<date>.bundle --all` from the canonical clone (turn stashes into branches first; a bundle keeps only the newest stash) | cloud drive | weekly, and before any clean-up |
| Non-code source material: `02 Screenshots/`, `store-assets/`, `design-references/`, `Bingd-Workspace/01_Product`, `03_GTM`, `03_Review`, `05_Assets`, `02_Development/QA` and `Handoffs` | cloud drive (synced folder, **not** the Git checkout) | continuous sync |
| Credential files (`02 JSO/*`, Android keystore download, 2FA recovery codes, DB passwords) | password manager | on change |
| Production logical export (`supabase db dump` of roles, schema and data), **encrypted** because it contains user PII | cloud drive | weekly; before every migration to production |
| Claude memory (`~/.claude/projects/c--Users-saisu-Documents-Bingd/memory/`) | cloud drive | weekly |

---

## 12. Verification checklist

- [ ] `git log -1` on `main` matches GitHub; `npm ci` succeeds
- [ ] `npm test` and `npm run typecheck` are green
- [ ] `npx supabase migration list` for both refs shows local = remote
- [ ] `node supabase/tests/remote-smoke.mjs` against staging (keys from the CLI, child process only)
- [ ] `eas whoami`; `eas env:list --environment production` shows the expected **names**
- [ ] `npx expo-updates fingerprint:generate` for a lane equals the runtime on its latest EAS build (proves `google-services.json` and the env are right)
- [ ] a Preview OTA publishes to the `preview` channel and reaches the physical staging build
- [ ] bingd.app serves `main` (Cloudflare Pages → latest deployment SHA)
- [ ] Actions: the latest `trending-refresh` and `welcome-email` runs are green
- [ ] Sentry and PostHog dashboards open and show recent events
- [ ] the ignore rules from section 3 are back; `git status` in the new clone shows nothing sensitive

---

## 13. What is still only on the laptop (2026-09-26)

**Git: nothing.** Every local branch's commits are on GitHub, and the meaningful stashes are
on `backup/stash/*`. `stash@{3}` (one line of `skills-lock.json`) was deliberately not kept.

**No cloud backup destination is set up.** `Documents` is not redirected to OneDrive, and
nothing bingd-related is in OneDrive. Until a destination is chosen, everything below exists
once:

| Folder | Size | Belongs in | Notes |
|---|---|---|---|
| `Bingd-Workspace/05_Assets/` | 489 MB | cloud drive | App Store processing, device captures |
| `Bingd-Workspace/02_Development/QA/` | 60 MB | cloud drive | acceptance PDFs, QA logs |
| `Bingd-Workspace/02_Development/Handoffs/` | 17 MB | cloud drive | context packs |
| `Bingd-Workspace/01_Product/` | 8.4 MB | cloud drive | exported PRD and research copies |
| `Bingd-Workspace/02_Development/Backups/` | 1.4 MB | **encrypted** cloud | staging SQL dumps from 2026-09-08 (test data, but still a database dump) |
| `Bingd-Workspace/03_GTM/`, `03_Review/` | 1.3 MB | cloud drive | welcome-email copy and review |
| `Bingd/02 Screenshots/App Store/` | 8 MB | cloud drive | read by `web/shots.mjs` |
| `Bingd/store-assets/` | 1.7 MB | cloud drive | the Play listing text and graphics |
| `Bingd/research/` | 224 KB | cloud drive (or Git, if wanted) | competitive audit plus appendices |
| `Bingd/.agent-workflow/` | 81 MB | **encrypted** cloud | review transcripts; `backups/` holds old nonprod JSON that may contain personal data |
| `Bingd/design-references/` | 3.5 GB | cloud drive, optional | third-party reference captures, re-collectable |
| `Bingd/02 JSO/` | 8 KB | **password manager** | FCM service-account key; `google-services.json` copy |
| `~/.claude/projects/c--Users-saisu-Documents-Bingd/memory/` | about 1 MB | cloud drive | operational history across sessions |
| `Bingd-Workspace/WORKSPACE_POLICY.md`, `README_FIRST.md` | KB | cloud drive | the local layout |

**Not worth backing up:** `Bingd-Workspace/02_Development/Builds/` (2.7 GB of release clones;
every HEAD is on GitHub), `99_Archive/Completed-Worktrees`, `node_modules`, `dist/`.

**The manual action, about 15 minutes:** create one folder in a cloud drive (for example
`OneDrive/bingd-backup/`) and copy the rows marked "cloud drive". Put `02 JSO/*` and the
2FA recovery codes in a password manager. Encrypt the two "encrypted" rows (a password-protected
7-Zip archive is enough) before copying them. Repeat monthly, or after any asset work.
