# `bingd.app` — hosting, and what a tapped link actually does

Status as of **2026-08-19**, working tree at `715d4fe` on `ui/visual-pass`.

This document exists because the previous continuation recorded `bingd.app` as *not
hosted* while it had in fact been serving for five days. The gap was not a small one:
everything downstream — Universal Links, App Links, the whole invitation funnel — was
described as blocked on a deploy that had already happened, and was actually blocked on
that deploy being **five commits stale**.

So the facts are written down here rather than inferred again.

---

## Where the domain lives

| | |
|---|---|
| Registrar / DNS | **Cloudflare** — nameservers `rick.ns.cloudflare.com`, `courtney.ns.cloudflare.com` |
| Host | **Cloudflare Pages**, project `bingd` (`bingd.pages.dev` resolves) |
| Custom domain | `bingd.app`, proxied (A/AAAA to Cloudflare anycast) |
| `www.bingd.app` | **does not exist** — no record. Typing it fails to resolve rather than redirecting |
| HTTPS | valid, no warning, no redirect loop. `http://` → `301`. `.app` is HSTS-preloaded at the TLD, so browsers refuse plain HTTP regardless |
| Cookies | none set on any route |

**Cloudflare Scrape Shield email obfuscation is on for this zone.** It rewrites the
`mailto:hello@bingd.app` in the footer into a `/cdn-cgi/l/email-protection` link and
injects a same-origin decoder script. Harmless, but it means the deployed HTML is never
byte-identical to `web/dist` and a diff will always show those two lines.

### How a deploy happens

The Pages project is **git-connected to `fourwardhabits/bingd`** and **runs the site build
itself**. Nobody has opened the Cloudflare dashboard to confirm this, so it is worth being
exact about which parts are demonstrated and which are inferred — review 27 raised the
distinction and it is a fair one.

**Demonstrated**, by two observations a direct-upload project cannot produce:

- **Per-branch preview deployments exist.** `fix-assetlinks-always-writte.bingd.pages.dev`,
  `feat-core-loop.bingd.pages.dev`, `feat-build-details-2.bingd.pages.dev` and
  `fix-review-findings.bingd.pages.dev` all return `200`. Only a git-connected project
  builds an alias per branch. (`main` has no alias — the production branch is served at
  the project root and at the custom domain.)
- **Those previews contain per-branch *generated* output.** The `fix/assetlinks-always-written`
  preview serves an `assetlinks.json` of exactly three bytes — `[]` — which is that
  branch's build result and appears in no commit anywhere. Pages ran `build.mjs`.

**Inferred, and not confirmed against the dashboard:** that the production branch is
`main`, and the exact build command and output directory. The evidence is strong —
`bingd.app` serves precisely `main`'s build and nothing else's, `main.bingd.pages.dev`
returns 404 in the way a production branch does because it is served at the project root
instead, and no other branch's output matches the live bytes — but "strongly inferred from
deployed bytes" is what it is. **Confirm it in one look**: Cloudflare dashboard → Workers &
Pages → `bingd` → Settings → Builds & deployments.

There is no `wrangler` in the project, no deploy workflow in `.github/`, and no Cloudflare
credentials on the founder machine, so nothing here can deploy without that connection.

A push of any branch also produces a **preview URL before anything reaches `bingd.app`**,
which is the safe way to check a deploy: the routes, the two `.well-known` files and their
content types can all be verified on real Cloudflare infrastructure without touching the
live domain. Universal Links will *not* verify there, because the app is entitled for
`bingd.app` and nothing else — but everything except the OS handoff can be confirmed
first.

`.github/workflows/ci.yml` runs `test:web` and `test:web:mutants` on every push to `main`
and every pull request, which puts the site's build and its identity checks in front of
the deploy rather than behind it.

### Build environment

`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` should be set in the Pages
build environment. They are optional: without them the site is complete and simply
records no invitation opens. The anon key is public by construction — it is in the mobile
bundle already and is bounded by row level security — so baking it into a static page
leaks nothing.

---

## What is deployed right now, and what is not

`origin/main` is `ec3d205` (2026-08-14). The invitation resolver landed in `715d4fe` and
**has never been pushed**. The live site is therefore the pre-resolver build:

| path | live behaviour | should be |
|---|---|---|
| `/` | the generic "closed testing" page | unchanged |
| `/i/<token>` | falls back to the generic page, `200` | the invitation page |
| `/u/<handle>` | falls back to the generic page, `200` | the profile page |
| `/title/<id>` | falls back to the generic page, `200` | the title page |
| `/lists/<id>` | falls back to the generic page, `200` | the list page |
| `/page.mjs`, `/router.mjs` | **not deployed** — same HTML fallback | the two modules |
| `/.well-known/assetlinks.json` | `200`, `application/json`, byte-identical to the current build | unchanged |
| `/.well-known/apple-app-site-association` | `200`, `application/json`, **claims `/list/*`** | `/lists/*` |

That last row is the `/list/*` typo corrected in `715d4fe`. It is still live, and it is
still on Apple's CDN.

**The document routes are now four, not three.** `/terms` joined `/privacy`,
`/support` and `/account-deletion` on 2026-08-25, generated by the same template and
under the same three rules: nothing aspirational, no JavaScript, and deliberately
unclaimed by the app. `web/router.test.mjs` asserts the last of those in both directions
for all four.

The fallback-to-`index.html`-with-a-200 for unmatched paths is Cloudflare Pages' own
behaviour, not a rule in `_redirects` — `main`'s `build.mjs` writes no `_redirects` at
all. It is the reason `build.mjs` writes an empty `assetlinks.json` rather than omitting
the file: an omitted file would be served as HTML with a `200` and, thanks to the
`Content-Type` rule in `_headers`, labelled `application/json`.

---

## Release mode — the switch that turns the launch on

**Added 2026-08-25.** `web/distribution.config.json` carries a `mode`, either `beta` or
`public`. It exists because the same sentence — *"Bingd is in closed testing"* — was
hardcoded in seven places including the front page, and launch day would otherwise have
been an exercise in finding all of them, with the one that was missed being the one a
stranger reads first.

It decides three things and nothing else:

| | `beta` (today) | `public` |
|---|---|---|
| Closed-testing language | on every page | absent |
| `X-Robots-Tag` and the `robots` meta | `noindex, nofollow` | not emitted |
| Invitation return copy | "once Bingd is installed… TestFlight or Play" | "After installing Bingd, come back to this page… " |

**Two files stopped being static so that it could reach them.** `web/public/` is gone:
it held `_headers` and `index.html`, and a directory copied verbatim cannot be
mode-aware. Both are generated by `build.mjs` now, which is also why the `_headers`
mutants in `web/mutation-check.mjs` target `build.mjs`.

### The lock

**The build refuses `public` while either `storeUrl` is null.** That is a deliberate
lock rather than input validation: the failure it prevents is a page that says *download
it now* over a button with no destination, which reads as a broken product rather than an
unlaunched one — and, once indexed, a `/u/<handle>` route that no privacy setting in the
app can withdraw.

The consequence is the useful part: **this configuration is safe to merge and sit on.**
There is no window in which pushing to `main` makes bingd.app claim a store listing that
does not exist, because the URLs the copy promises cannot exist before the apps are
approved. `web/router.test.mjs` additionally asserts the mode is still `beta`, so the
flip is a deliberate commit that updates a test, not a config edit somebody could make
absent-mindedly.

Anything unset, misspelt or missing reads as `beta`. The failure modes are not symmetric.

---

## Verification status — what is proven, and by what

Nothing below is claimed as physically verified. The distinction is the point of the
table.

| claim | evidence | status |
|---|---|---|
| The domain serves over valid HTTPS with no redirect loop | external probes, this run | **verified externally** |
| `.well-known` files return `200`, correct JSON, `application/json`, no login wall, no cookies | external probes, this run | **verified externally** |
| Apple has fetched and accepted the AASA | `app-site-association.cdn-apple.com/a/v1/bingd.app` returns it, `200` | **verified externally** — but the *stale* file |
| Google's verifier parses `assetlinks.json` for `app.bingd` and `app.bingd.preview` | `digitalassetlinks.googleapis.com/v1/statements:list` returns both statements | **verified externally** |
| The AASA names the bundle identifiers the app is built with | `web/router.test.mjs`, cross-checked against `app.config.ts` | **config verified** |
| Every claimed path has an Expo Router screen | `web/router.test.mjs`, checked against the tree on disk | **config verified** |
| The binary is entitled `applinks:bingd.app` | `app.config.ts`, asserted by test | **config verified** — no binary inspected |
| A tapped `https://bingd.app/i/<token>` opens the app on iOS | — | **PENDING — never tested on hardware** |
| A tapped `https://bingd.app/i/<token>` opens the app on Android | — | **PENDING — never tested on hardware** |

The Apple team ID (`98729PG8GD`) deserves its own line: it has exactly one source in this
repository and nothing to cross-check it against, so **no offline test can catch it being
wrong**. It is verified by a link opening on a device, and by nothing else.

---

## Which builds can actually open a link

This is the part most easily overstated, because three variants and two platforms give
six answers and they are not the same.

### iOS

`associatedDomains: ['applinks:bingd.app']` has been in `app.config.ts` since the first
scaffold commit (`7ddb801`), so **every iOS build ever made carries the entitlement** —
including the development build already on the founder's iPhone. The deployed AASA lists
all three appIDs. There is no per-variant gap on iOS.

The stale file still claims `/i/*`, `/u/*` and `/title/*` correctly. **Only `/lists/*` is
affected by the typo.** So the iOS physical test for invitations, profiles and titles does
not have to wait for the deploy — although the web fallback for somebody without the app
does, because the router pages are not live.

iOS fetches the AASA through Apple's CDN, not from the origin, and caches it hard. After
the deploy, expect a delay before a device sees `/lists/*`. Reinstalling the app forces a
refetch.

### Android

Path claiming works differently and it matters. `assetlinks.json` grants the **whole
host**; the intent filter decides paths. `app.config.ts` declares
`data: [{ scheme: 'https', host: 'bingd.app' }]` with **no `pathPrefix`**, so on Android
the app claims *every* path on the domain, not the four in the AASA. Today that is
harmless — every path either has a screen or is the root — but it means a future
`/privacy` or `/terms` page would open the app onto `+not-found` instead of the browser.
Fixing it is a manifest change and therefore a new build and a new fingerprint, so it is
recorded here rather than done.

| variant | package | fingerprint in `assetlinks.json` | can App Links verify? |
|---|---|---|---|
| development | `app.bingd.dev` | **none** — no development build has ever been made | **no** |
| preview | `app.bingd.preview` | EAS preview keystore | **yes** — APK straight from EAS, never re-signed |
| production (TestFlight/Play) | `app.bingd` | EAS **upload** key only | **not from Play** — see below |

**An Android development build cannot verify App Links.** If the founder's Android device
has the dev client, the physical test needs a Preview build.

**Play re-signs.** The single fingerprint under `production` is the EAS upload key. Play
App Signing strips it and re-signs with a key Google holds, so a device that installs from
Play checks a fingerprint that is not in the file and App Links silently fail. The Play
fingerprint must be **added alongside** the existing one — never in place of it, because
the upload key is still what an EAS-distributed production APK carries.

---

## The two beta destinations, still absent

`web/distribution.config.json` has `ios.betaUrl`, `android.optInUrl`, `android.betaUrl`
and both `storeUrl`s at `null`. That is correct today and every route says so honestly:
*the Bingd beta is not open for this device yet*. `build.mjs` refuses any value that is
not an absolute `https://` URL, which is the open-redirect gate.

Filling them in is **one file, no app rebuild, and no reissued invitation**. What a person
pastes into a group chat is `https://bingd.app/i/<token>` and it is permanent; only the
destination behind it moves.

- `ios.betaUrl` ← the public TestFlight link, `https://testflight.apple.com/join/XXXXXXXX`
- `android.optInUrl` ← the closed-test opt-in page, `https://play.google.com/apps/testing/app.bingd`

The Android ordering is the easy thing to get wrong: a closed test is unreachable from the
store listing until the tester has opted in, so `optInUrl` leads while it is set.

---

## The physical acceptance test, when the deploy lands

Five things, and each is recorded separately because passing one says nothing about the
next.

1. Safari receives `https://bingd.app/i/<token>` — from Messages or Notes, **not** typed
   into the address bar and **not** tapped from a page on `bingd.app` itself. Both of
   those are cases iOS deliberately does not hand to the app.
2. Tapping it opens Bingd rather than Safari.
3. Expo Router lands on `app/i/[token].tsx` with the token in `useLocalSearchParams`.
4. `https://bingd.app/u/<handle>` opens the correct profile.
5. `https://bingd.app/title/<id>` opens the correct title.

On Android the same five, plus `adb shell pm get-app-links <package>` to read the domain
verification state — which requires platform-tools, not currently installed on the
founder machine. Use the **Preview** package, `app.bingd.preview`.

Uninstalled behaviour is the other half and needs a device without the app: the same link
must reach the web router and offer the beta destination for that platform, or say
honestly that there is none. There is no deferred attribution — a token does not survive a
trip through the App Store or Play, and the invitation page says so to the person it
affects.
