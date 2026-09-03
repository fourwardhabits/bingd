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

## The install destinations

> **Updated 2026-09-02.** This section used to be headed *"the two beta destinations,
> still absent"* and said both were `null`. Two of the four are filled in now.

`web/distribution.config.json` today:

| key | value | what a visitor gets |
|---|---|---|
| `ios.storeUrl` | `null` | — |
| `ios.betaUrl` | `https://testflight.apple.com/join/kkgaYsqx` | *Get the Bingd beta for iPhone* |
| `android.storeUrl` | `null` | — |
| `android.optInUrl` | `https://play.google.com/apps/testing/app.bingd` | *Join the Bingd beta on Android* |
| `android.betaUrl` | `null` | — |

`build.mjs` refuses any value that is not an absolute `https://` URL, which is the
open-redirect gate. Changing any of them is **one file, no app rebuild, and no reissued
invitation**. What a person pastes into a group chat is `https://bingd.app/i/<token>` and
it is permanent; only the destination behind it moves.

**The App Store swap, when the URL exists.** `destinationFor` prefers `storeUrl` over
`betaUrl` on both platforms, so setting `ios.storeUrl` alone changes every iOS visitor's
button from *Get the Bingd beta for iPhone* to *Get Bingd for iPhone*, pointing at the
public listing. It is a config edit plus a Cloudflare deploy — **no OTA, no app rebuild,
no change to any link already sent**. Do not invent the URL: it is
`https://apps.apple.com/app/id<id>` and the `id` comes from App Store Connect once the app
is approved. The separate `"mode": "public"` flag is a bigger switch and is not this one —
it lifts `noindex` site-wide and rewrites the closed-testing copy, and the build refuses it
while either `storeUrl` is null.

**Android is still Closed Testing and the copy must keep saying so.** `optInUrl` leads
while it is set, and the ordering is the easy thing to get wrong: a closed test is
unreachable from the store listing until the tester has opted in, so sending somebody to
the plain listing first shows them *this app is not available for your device*, which
reads as *Bingd is broken* rather than as *you have not joined yet*. The opt-in page also
only works for an account already on the tester list — a Google Group membership the
founder maintains by hand. Nothing on the site automates that and nothing on the site
claims Bingd is publicly available on Google Play.

---

## What a shared link carries, and what the page says back

**One link per share, and it is the content's.** As of 2026-09-02 a title share sends
`https://bingd.app/title/<id>` alone and a profile share sends `https://bingd.app/u/<handle>`
alone. Neither carries an invitation URL, a referral token or a second call to action;
`https://bingd.app/i/<token>` appears only when somebody taps **Invite friends**. PRD §6F's
As-built block carries the reasoning. The consequence for this site is that
`/title/*` and `/u/*` have no sender and no origin to know about, and their pages are
identical for every visitor.

**The page now names what was shared, and reads nothing else.** Updated 2026-09-03.

A `/title/<id>` page shows the film or season's name, its year and its poster. A
`/u/<handle>` page shows a public account's display name, handle and avatar. Both are
fetched in the browser, one request each, with the anon key the page already carries.

This is not a new read path and could not have been built as one. Two policies that
already existed decide all of it:

| table | policy | what a signed-out reader gets |
|---|---|---|
| `media_items` | `using (true)` since `20260813000400` | the catalogue, which is TMDB data with nobody attached to it |
| `profiles` | `using (can_i_view(id))` | `can_view_profile` answers a **null viewer** with `visibility = 'public' and status = 'active'` and nothing else |

So a private account, a suspended account and a handle nobody has are one case from out
here: zero rows, and the page keeps its generic line. **The privacy rule is Postgres's,
enforced on the same policy the app obeys, and this page cannot widen it.** If a private
profile ever appeared here it would mean `can_view_profile` had changed, and it would be
visible in the app long before it was visible on the web.

What is deliberately not read: `profiles.bio`, which *is* readable for a public account
and is still nobody's business on a link preview; and anything under `user_media`,
`rankings`, `follows` or `feed_events`. The page shows what was shared. It never shows
what anyone did with it, and it never names the sender.

The columns are named in the `select` rather than taken with `*`, so a column added to
`media_items` later is not shipped to every visitor by accident. `overview` is the one
that would hurt: a plot synopsis on a link preview is a spoiler nobody asked for.

**The preview card is generic, and the page is not.** Each page carries `og:site_name`,
`og:title`, `og:description`, `og:image` and the Twitter equivalents, all static text plus
one image: `social-card.png`, 1200x630, the wordmark on the brand ground, shipped from
`web/src/`. It is `summary_large_image`, which the card was built for. It was `summary`
while the only asset was the square app icon, which every unfurler either letterboxed or
cropped into a corner of itself.

The card cannot name the film even though the page can, and the reason is structural
rather than a decision left unmade: these files are static, one per route, so a `<meta>`
tag is the same bytes for every visitor. Naming the film in the card needs a Worker doing
a lookup on every unfurl request. Deferred, see `deferred-roadmap.md` §45.

`og:url` is the **route prefix** and never the visited URL, so the token, handle or id in
a link is not copied into a card that messaging services fetch, log and cache.

**Two app screenshots, and neither has a person in it.** `shot-collection.jpg` and
`shot-ranking.jpg` are cropped from the store set, with the Android status and navigation
bars removed. They were chosen out of fifteen on one criterion: the feed screens are the
better advertisement and every one of them has other people's accounts, handles and faces
in it. These two have posters and scores and nothing else.

**The site still has no analytics of its own.** The one measurement it takes is
`record_invite_open`, called from the invitation page only, and the published privacy
policy says the website carries no analytics. Counting title- and profile-fallback views
would mean either a new Supabase RPC and migration or a third-party script, and either
would need that policy sentence changed first. Deferred deliberately, not overlooked.

---

## Android App Links: the first hardware test, and what it found

**2026-09-03.** The founder tapped `https://bingd.app/title/<id>` on an Android phone with
the closed-test build installed. Samsung Browser opened the fallback page instead of the
app. This section is the audit, because the answer is not in the repository.

**Every link in the chain that this repository controls is correct**, and each was checked
rather than assumed:

| link | state | how it was checked |
|---|---|---|
| package of the closed-test build | `app.bingd` | `eas.json` `build.beta` sets `APP_VARIANT=production` |
| intent filter, `autoVerify`, four path prefixes | present | `app.config.ts` **at commit `89631bf`**, which is the commit build 0.1.0 (7) was made from |
| `assetlinks.json` served | `200`, `application/json`, no redirect | direct request |
| fingerprints in it | upload key **and** Play app-signing key | `web/deep-links.config.json`, both present since `2fbdc66` (2026-08-21), before the build |
| Google's own verifier | **`linked: true` for both fingerprints** | `digitalassetlinks.googleapis.com/v1/assetlinks:check` |
| the route that receives it | `app/title/[id].tsx` | asserted by `router.test.mjs` |
| the rewrite | `/title/*  /title  200`, and `.well-known` never rewritten | asserted by `router.test.mjs` |

So the configuration is not the defect. **The remaining candidates are all on the device**,
and the distinction that matters is that Android verifies a domain **at install time** and
caches the result. It does not retry on its own.

`docs/architecture/web-deployment.md` recorded both hardware claims as *PENDING, never
tested on hardware* until this attempt, and the site's own deploy history is the other half
of the story: the closed-test build was installed on 2026-08-27, and a build whose
verification attempt found no `assetlinks.json` at that moment records a failure that
survives every later fix to the website.

**Classification: D, a device-side verification state, with C as its cause.** Not A, not B,
not F. The evidence for that is the Google verifier answering `linked: true` today for the
exact package and both certificates, against a page that had already failed to open.

**No new binary is required to test this, and none should be built for it.** The two things
that re-trigger verification are, in order of effort:

1. Settings, Apps, bingd., **Open by default** (Samsung calls it *Open supported links*).
   Check whether `bingd.app` appears under **Supported web addresses** and whether the
   setting is on. If the domain is listed but unverified, this is confirmed.
2. Reinstall the closed-test build from Play now that the domain serves a correct
   `assetlinks.json`. Verification runs again on install.

One caveat worth keeping: **Samsung Messages may hand the URL to the browser explicitly**
rather than dispatching it as an App Link, which bypasses verification whatever its state.
Testing from a different app, a note or an email, separates that from the cache question,
which is why the founder QA below does it that way.

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
