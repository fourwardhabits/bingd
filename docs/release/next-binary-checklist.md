# Next store binary — checklist

Things that must be true of the **next iOS and Android store binaries**, and that an OTA
cannot deliver. Each item gets a result and a date when the binary is built. After that,
this file starts again empty for the binary after.

Build only through `scripts/release.mjs`, never bare `eas`. See
[`safe-update-runbook.md`](./safe-update-runbook.md) §1 and
[`release-lanes.md`](./release-lanes.md).

---

## 1. Embed the fresh-install reload guard — REQUIRED, iOS and Android

**Build from `main` at or after `a5f9f1d`** (merge of #198). That also carries `cc4fd31`
(#195), the resend cooldown fix.

**Why an OTA is not enough.** On a fresh install, the only code that has run is the
binary's *embedded* bundle. The embedded copy of `src/lib/updates.ts` decides whether to
reload when the app returns to the foreground. Every binary built before #198 reloads onto
the newest OTA at that moment. For a new user that return is from Mail with a sign-in code.
The reload lands them on an empty sign-in form. An update carrying the guard cannot prevent
this, because the update is only launched *by* that reload. See `src/lib/updates.ts` and
`safe-update-runbook.md` §1 and §3.

Until this binary is what both stores serve, every OTA published to `production` re-arms one
unguarded reload for fresh installs of the older binary.

**Acceptance, on a device with the app deleted first.** The channel must carry an update
newer than the binary's embedded bundle, or there is nothing to reload onto.

- [ ] Install the store build (TestFlight or the Play internal track). About reads `embedded`.
- [ ] Enter an email and request a code. Switch to Mail, then come back to the app.
      **Still on the code screen, with the address shown.** No reload.
- [ ] Enter the code. Onboarding starts. Answer the notification prompt (a system sheet).
      **Still in onboarding, on the same step.**
- [ ] Finish onboarding. Background the app, then foreground it. **Now** it reloads, and
      About reads the update id instead of `embedded`.
- [ ] Record the build ids, runtime versions and date here.

## 2. Preview binaries: restore the distinct maroon preview icon — production icon unchanged

Preview and development builds sit on the same home screen as the shipped app. They need an
icon that can be told apart before anything is opened. That icon was built in `bc225f9`
("a preview build you can tell apart, and that cannot reach production"). The commit calls
the colour the brand plum: the mark in Paper on plum, with a band at the foot and no text.
**It never reached `main`**; it lives only on the `integration/preview-*` and
`preview/letterboxd-main` branches. `app.config.ts` on `main` draws `assets/brand/icon.png`
for every variant, so a future preview binary built from `main` would look like production.

Before the next **preview** binary:

- [x] **2026-09-23 — restored from `bc225f9`:**
  - `assets/brand/icon-preview.png` and `assets/brand/icon-adaptive-preview.png`, byte
    for byte from that commit;
  - the variant-keyed `icon` / `adaptiveIcon` / `adaptiveBackground` in
    `app.config.ts`, for development and preview only;
  - the preview render in `assets/brand/render.mjs`;
  - `config/variants.test.mjs` (new here), its icon assertions unchanged.
- [x] **The production variant keeps `./assets/brand/icon.png` and
      `./assets/brand/icon-adaptive.png`.** Asserted for production *and* beta by
      `config/variants.test.mjs`, which resolves the real config per lane.
- [x] **Fingerprints, measured before and after in one working tree, 2026-09-23** (local
      resolution, so the numbers are lower than EAS's; what is being proven is the
      before/after pair, not the absolute value):

      | lane              | before     | after      |
      | ----------------- | ---------- | ---------- |
      | production / iOS  | `e0eb045d` | `e0eb045d` |
      | production / Android | `93e55ba2` | `93e55ba2` |
      | beta / Android    | `93e55ba2` | `93e55ba2` |
      | preview / Android | `772229b8` | `8f829d57` |

      Only the preview runtime moved, which is the whole permitted effect. **The preview
      APK installed for founder QA (EAS runtime `0832dd3e`) therefore cannot receive
      updates from a preview build made after this**; it does not need to — the new
      binary embeds everything that OTA carried.
- [x] `claimsWebLinks` and `web/deep-links.config.json` were **deliberately left out**,
      per the line below. Every lane still declares the `bingd.app` links exactly as
      `main` has always had it, and `config/variants.test.mjs` now asserts that for all
      four lanes so the state is pinned while the decision is open.
- [ ] On the next preview build: preview and the store app installed side by side show two
      different icons. **(Founder, on the device.)**

## 3. Not for the binary (recorded so nobody bundles it in)

- The Supabase Auth hourly email ceiling stays at **30/hour** until it is raised as its own
  decision: first the email provider's quota, then the dashboard, then
  `supabase/auth-templates/templates.json` `limits`, in one change. `check-auth-config.mjs`
  fails if they disagree.
