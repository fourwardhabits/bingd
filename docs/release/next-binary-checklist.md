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

- [ ] Restore from `bc225f9`:
  - `assets/brand/icon-preview.png` and `assets/brand/icon-adaptive-preview.png`;
  - the variant-keyed `icon` / `adaptiveIcon` in `app.config.ts`, for development and
    preview only;
  - the preview render in `assets/brand/render.mjs`;
  - the variant assertions in `config/variants.test.mjs`.
- [ ] **The production variant keeps `./assets/brand/icon.png` and
      `./assets/brand/icon-adaptive.png`, byte for byte.** `beta` builds the production
      variant, so it keeps them too.
- [ ] Measure the fingerprint of `production` and `beta` before and after the restore.
      **Both must be unchanged.** A moved production runtime strands every installed store
      build from OTAs. This is the same class of trap as editing `eas.json` or
      `config/backends.cjs`. Only the preview/development runtime may move.
- [ ] `bc225f9` also gates universal links on the variant (`claimsWebLinks`) and edits
      `web/deep-links.config.json`. That is a separate decision. Restore it deliberately or
      leave it out, but do not bring it in by accident with the icon.
- [ ] On the next preview build: preview and the store app installed side by side show two
      different icons.

## 3. Not for the binary (recorded so nobody bundles it in)

- The Supabase Auth hourly email ceiling stays at **30/hour** until it is raised as its own
  decision: first the email provider's quota, then the dashboard, then
  `supabase/auth-templates/templates.json` `limits`, in one change. `check-auth-config.mjs`
  fails if they disagree.
