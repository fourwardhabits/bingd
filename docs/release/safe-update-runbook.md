# Safe update runbook

**The one rule.** JavaScript and assets can be shipped over the air. Anything native needs
a new build. Anything in the database is a separate, separately reviewed release.

Get that wrong in the dangerous direction — publish an update whose JavaScript calls into a
native module the installed binary does not contain — and the app crashes on launch, every
launch, with no way for the user to recover. `runtimeVersion` exists to make that
impossible, and the rest of this document is how to work with it rather than around it.

Every command here is meant to be copied and pasted.

---

## 1. Is this change native?

Answer three questions. **Any yes means a new build.**

### Yes — native. A new binary, distributed again.

- A dependency added, removed, or upgraded across a version that changes native code —
  in practice, **anything in `package.json` that ships an Android or iOS module**.
- Any change to `app.config.ts` outside `extra`: name, icon, splash, `version`, bundle
  or package identifier, `scheme`, `orientation`, `userInterfaceStyle`, `backgroundColor`.
- **Permissions and privacy strings** — the `expo-image-picker` photo prompt, anything in
  `infoPlist`, anything the plugins write into `AndroidManifest.xml`.
- **`associatedDomains`** (iOS Universal Links) and **`intentFilters`** (Android App
  Links). Both are manifest entries; both are why the path-prefix correction on
  2026-08-20 required a new build.
- Any entry in `plugins`, or any option passed to one.
- `expo-build-properties` — `manifestQueries`, SDK versions, anything it writes.
- An Expo SDK upgrade.
- New asset files that are referenced from native config (icon, adaptive icon, splash).

### No — JavaScript and assets. An OTA update is possible.

- Any file under `app/` or `src/`.
- Copy, layout, colours, spacing, typography — anything in `src/ui/`.
- New images, fonts or JSON *imported from JavaScript*.
- Query logic, React Query keys, client-side validation, analytics call sites.
- A new screen, if it uses only modules already in the binary.

### Neither — a server release

- Anything in `supabase/migrations/`. A migration is applied to a database, not shipped to
  a phone, and it is released and reviewed on its own. **The ordering rule is that the
  server change must be compatible with the oldest client still installed** — clients do
  not upgrade in step and cannot be made to.
- Anything in `supabase/functions/` (the TMDB adapter).
- Anything in `web/`. That is a Cloudflare Pages deploy, triggered by a push to `main`.

### If you are unsure, ask the fingerprint

`runtimeVersion` is `{ policy: 'fingerprint' }` — a hash of everything native in the
project. So the question "is this native?" has a mechanical answer:

```
npx expo-updates fingerprint:generate
```

Run it before your change and after. **If the hash moved, the change is native.** This is
authoritative and the list above is a summary of it.

---

## 2. What `runtimeVersion` protects, exactly

An update is offered to a build **only if the build's runtime version equals the update's**.
Nothing else is consulted — not the app version, not the build number, not the date.

So when the fingerprint changes:

- Builds on the **old** runtime keep running the last JavaScript that works for them. They
  are not offered the new bundle. They do not crash. They simply stop receiving updates.
- Builds on the **new** runtime receive updates published against it.
- The old builds never catch up. **The only way forward for them is a new install.**

That is the whole safety property, and its cost is honest: every native change strands
every existing tester until they install again. `eas update` prints a warning saying so
rather than leaving it to be discovered.

**A practical consequence for the friend beta:** batch native changes. Three native changes
in a week is three redistributions, and a friend tester who has been asked to sideload
three times stops answering.

---

## 3. Publishing an update

Updates go to a **branch**; a branch is mapped to a **channel**; a build listens on the
channel named in its `eas.json` profile. Today: `development → development`,
`preview → preview`. `beta` and `production` are created by the first build that names them.

**`--environment` is not optional, and leaving it off is the quiet failure.** `eas update`
compiles the bundle on *your machine*, from *your* `.env`, and `EXPO_PUBLIC_SUPABASE_URL` is
baked into what it publishes. Without `--environment`, an update takes whatever local
configuration happens to be lying around and pushes it to every device on that channel.

`config/backends.cjs` now refuses an update compiled against a project the lane may not use
— that is what closes the hole rather than the flag — but the flag is what makes the update
carry the *right* values rather than merely a permitted set.

### Preview — the founder's own build

```
npx eas update --branch preview --environment preview --message "what changed, in one line"
```

### Beta — friend testers. Intentional releases only.

```
npm run update:beta -- --message "what changed, in one line"
```

Not `eas update` directly. That script is `eas update --branch beta --environment preview`
behind `scripts/release-guard.mjs`, which refuses unless the working tree is clean, HEAD is
on `main` or `release/*`, and **the release gate passed for this exact commit**.

An update to `beta` reaches every friend tester's phone the next time they bring the app to
the foreground — `src/lib/updates.ts` checks on foreground and applies immediately, which
turns "days" into "the next time they pick up their phone" and also means there is no window
in which to notice a mistake.

### Check what you are about to hit, first

```
npx eas channel:view preview
npx eas branch:view preview
```

The runtime version on the most recent update should match the runtime of the build you
expect to receive it. If it does not, the update will be published and nobody will get it —
which is silent, and looks exactly like the update not working.

---

## 4. Rolling back

Three mechanisms. They are not interchangeable.

### 4a. Republish a known-good update — the ordinary rollback

```
npx eas update:list --branch preview
npx eas update:republish --group <GROUP_ID> --message "rollback to <what it was>"
```

`--group` is the group id from `update:list`, not the id of a single platform's update.
This publishes the old bundle as a **new, newer** update, so devices take it by the ordinary
foreground check. Typically a minute or two on the tester's next foreground.

### 4b. Roll back to the embedded bundle — when nothing published is good

```
npx eas update:roll-back-to-embedded --branch preview --message "back to the shipped bundle"
```

Every device on that branch returns to the JavaScript compiled into its own binary. Use it
when the last several updates are suspect, or when you do not yet know which one broke
things. It is the safest possible state: it is the build that was tested before it was
distributed.

### 4c. A new build — when a rollback cannot help

**An OTA rollback cannot fix a native problem**, because the native side is not what an
update contains. A new binary is required when:

- the fault is in native code, a permission, an entitlement, an intent filter, or an icon;
- the fault is in a dependency's native module;
- the fingerprint has moved since the last good state, so the good update is on a runtime
  the broken build cannot receive;
- the app **crashes before `expo-updates` can apply anything**. An update is fetched by the
  running app; an app that dies on launch has no opportunity to replace itself. This is the
  failure mode `runtimeVersion` exists to prevent, and it is unrecoverable over the air.

```
npx eas build --platform android --profile preview
npx eas build --platform ios --profile preview
```

### Which one, in one line

> Bad JavaScript, same runtime → **republish**. Unknown-bad JavaScript → **roll back to
> embedded**. Anything native, or a launch crash → **new build**.

---

## 5. A Preview-only update drill

Safe to run today: `beta` and `production` do not exist as channels, so nothing published
to `preview` can reach anyone but the founder's own Preview build.

```
# 1. What runtime is the Preview build on?
npx eas build:list --platform android --buildProfile preview --limit 1
#    Note the runtimeVersion. It must match what step 3 reports.

# 2. Publish a harmless update — no code change needed, this republishes current HEAD.
npx eas update --branch preview --environment preview --message "update drill"

# 3. Confirm it landed on the right runtime and nothing else.
npx eas channel:view preview

# 4. On the phone: background Bingd, wait a moment, foreground it. It reloads.
#    Settings now reads `runtime <8 chars> · update <8 chars>` instead of `embedded`.
#    That transition — embedded to an update id — is the whole proof.

# 5. Put it back.
npx eas update:roll-back-to-embedded --branch preview --message "end of drill"
#    Foreground the app again. Settings reads `embedded` once more.
```

Step 4 is the only step that proves anything, and it needs the phone. **Nothing about this
drill should ever be run against `beta` or `production` to prove a point.**

---

## 6. The release gate

Ordinary pull requests run the fast suite (`.github/workflows/ci.yml`): typecheck, lint,
Jest, the WebAssembly-Postgres database tests, the web router tests and their mutants, and
the Deno checks on the Edge Function.

A release candidate runs more, including the real multi-connection PostgreSQL concurrency
suite, which is too slow and too heavy to put in front of every UI commit. It is a separate
workflow (`.github/workflows/release-gate.yml`), started by hand:

```
gh workflow run release-gate.yml --ref <branch>
gh run watch
```

Or locally, in this order, stopping at the first failure:

```
npm run typecheck
npm run lint
npm test -- --ci
npm run test:db
npm run test:race
npm run test:race:mutants
npm run test:web
npm run test:web:mutants
npm run test:config
npm run functions:check
npm run functions:lint
npx expo export --platform android
```

**`npm run build:beta` and `npm run update:beta` will not run until this gate has passed on
the exact commit they are about to publish.** That is `scripts/release-guard.mjs`, and it
checks the SHA rather than the branch: a gate that passed two commits ago did not run on
what is about to ship.

Being precise about what that buys, because an earlier version of this line said the gate
was "the only thing standing between unfinished work and a friend's phone" and independent
review 28 was right that this overstates it. Channels and runtimes protect against the wrong
*build* receiving an update; they say nothing about the wrong *code* being in one. The guard
covers the documented path. **`eas` is still a command anybody can type**, so what the guard
converts is an accident into a deliberate act — not a possibility into an impossibility.

---

## 7. Turning Sentry source maps on

Preview and Beta crashes are minified today. Two commands fix it and the first one needs a
Sentry login, so it is the founder's.

```
# 1. In Sentry: Settings > Developer Settings > Auth Tokens > Create New Token.
#    Organization token. Scopes: project:releases and org:read.
#    Copy it once — Sentry does not show it again.

# 2. Store it as an EAS secret. It never enters the repository and never enters a bundle.
npx eas env:create --environment preview   --name SENTRY_AUTH_TOKEN --type sensitive --value <token>
npx eas env:create --environment production --name SENTRY_AUTH_TOKEN --type sensitive --value <token>
```

Then delete `"SENTRY_DISABLE_AUTO_UPLOAD": "true"` from the `preview` and `beta` profiles in
`eas.json` — leave it on `development`, where a dev client serves its bundle from Metro and
there is nothing to symbolicate — and make the next build.

**Do not enable it before the token exists.** `sentry-xcode.sh` treats a missing token as
`error: sentry-cli ...` and stops the iOS build.

---

## 8. What must never be shipped over the air

- **A database migration.** It is not in the bundle. An update that assumes a column the
  live database does not have breaks every device that takes it, immediately.
- **A change to `web/`.** The site is deployed by Cloudflare Pages from `main`. `eas update`
  does not touch it.
- **A native change.** Covered above; the fingerprint refuses.
- **An update to `beta` or `production` to test something.** Test on `preview`.
