# iOS Preview — physical acceptance

Founder-run, on the registered iPhone, on the Preview build. **Nothing here may be marked
PASS on the strength of a passing test.** iOS has never been validated on hardware in this
project at all — not the layout, not the keyboard, not a single Universal Link.

## The build under test

| | |
|---|---|
| Profile | `preview` |
| Bundle identifier | `app.bingd.preview` |
| App name on the home screen | **bingd preview** |
| Channel | `preview` |
| Backend | staging (`fjxhcbowoxuzulwirzyr`) — see note below |
| Associated domain | `applinks:bingd.app` |
| Distribution | ad hoc, to the registered iPhone 11 (`00008030-00061DA202BB802E`) |
| Build page | *created by the founder — see below* |

> **Check the ref, not the name.** The `preview` lane points at STAGING
> `fjxhcbowoxuzulwirzyr` (`bingd-staging`). PRODUCTION is `abheeqyjzekiowkztfxv`
> (`bingd-production`) and holds every real user. The two projects swapped roles on
> 2026-08-31 and the dashboard names only caught up on 2026-09-01, so older notes may
> disagree — `config/backends.cjs` is the source of truth. If this Preview build reports
> `backend abheeqyjzekiowkztfxv`, it is pointed at PRODUCTION: stop the acceptance run
> and report it.

### This build does not exist yet, and one command makes it

The iOS Preview build could not be started from this session. `app.bingd.preview` has no ad
hoc provisioning profile, creating one requires signing in to the Apple account, and EAS
refuses to prompt for that without a terminal:

> `Input is required, but stdin is not readable. Do you want to log in to your Apple account?`

So this is one founder command, run in an ordinary terminal, answered with the Apple ID and
its 2FA code:

```
npm run build:preview -- --platform ios
```

**Not `eas build --profile preview`.** `scripts/release.mjs` supplies `BINGD_LANE` and
`APP_VARIANT`, and it is the only supported way to build or publish a lane — a document
printing the bare command is a documented bypass rather than the residual the other pages
acknowledge. Review 28d found this line still doing it.

When it asks which devices the ad hoc profile should cover, **select the iPhone**. It is
already registered — it was added on 2026-08-18 for the development build — so no new
device registration is needed. EAS creates the App ID, the distribution certificate and the
provisioning profile, and stores them; **subsequent iOS builds run non-interactively.**

The build number will be **4 or higher**: three attempts from this session incremented the
remote counter to 3 before failing on credentials. Read the real one off Settings.

---

**Before anything else, open Settings and scroll to the bottom.** Four lines:

```
Bingd 0.1.0 (4)
preview · preview
runtime <8 chars> · embedded
backend fjxhcbowoxuzulwirzyr
```

The build number **must not be a dash**. It was, on every iOS build made before
2026-08-20 — `BuildDetails` was reading the Android key — and confirming that this now
reads a number is itself one of the things this acceptance run is for. If `backend` reads
anything but `fjxhcbowoxuzulwirzyr`, stop and report it — `abheeqyjzekiowkztfxv` is PRODUCTION.

## Installing

1. Open the EAS build page on the iPhone and tap **Install**.
2. iOS may ask to allow the installation. Allow it.
3. If iOS refuses to launch it: Settings › Privacy & Security › **Developer Mode**, on,
   then restart the phone. An ad hoc build usually does not require this, but a build
   installed from a link sometimes does.
4. If iOS says the developer is untrusted: Settings › General › VPN & Device Management ›
   trust the certificate.

It installs beside `bingd dev` — different bundle identifier, different name.

## Accounts

Founder account for most of it; a **disposable second account** for anything that changes
another person's state, and for the deletion test. **Never delete the founder account.**

---

## Everything in the Android list

Run [`android-preview-acceptance.md`](./android-preview-acceptance.md) in full on this
device: auth, onboarding, search, title, collection, For You, social, profile, invitations,
platform behaviour, deletion. The functional surface is the same code and the same backend;
what differs is below.

Two Android-only steps do not apply: `adb shell pm get-app-links` (there is no equivalent —
see Universal Links below) and the system-navigation-bar check.

## Sign in with Apple — iOS only, and Apple requires it

Bingd offers Google sign-in, which triggers App Review guideline 4.8. The entitlement is in
`app.config.ts` (`usesAppleSignIn: true`) and EAS turns it into the capability on the App
ID during the first build.

- [ ] The **Sign in with Apple** button is present on the sign-in screen, and on iOS only.
- [ ] It is not visually subordinate to the Google button.
- [ ] Signing in with **Hide My Email** works, and the account is created against the relay
      address.
- [ ] Apple returns the name **once**: on the very first authorization, the display name is
      pre-filled from it. (To retest this you must revoke Bingd in iOS Settings › your name
      › Sign in with Apple, or the name never comes back.)
- [ ] Cancelling the Apple sheet returns you to the sign-in screen with **no error
      message** — a dismissal is not a failure.
- [ ] Sign out and back in with Apple; the same account is restored, not a new one.

## Universal Links — never once tested on hardware

**Do not tap these in Safari's address bar, and do not tap a bingd.app link from a page on
bingd.app.** iOS deliberately refuses both: an address-bar navigation and a same-domain link
are not handed to apps. Put each URL in **Notes** or send it to yourself in **Messages**, and
tap it from there.

- [ ] `https://bingd.app/u/<a real handle>` from Notes → **Bingd opens on that exact
      profile.**
- [ ] The same link from **Messages** → same result.
- [ ] A real **title** share URL (copied from the app's own share sheet) → **Bingd opens on
      that exact Movie or Season.**
- [ ] A real **invite** URL → **Bingd opens on the invitation flow** for that token.
- [ ] `https://bingd.app/privacy` from Notes → **Safari, showing the privacy page.** This
      one must *not* open the app.
- [ ] With Bingd already in the background, tap a profile link. It routes inside the running
      app.
- [ ] Long-press a bingd.app link in Messages. The menu offers **Open in "bingd preview"**.
      That menu item is the clearest single proof the association resolved.

Opening Safari instead of the app is a **FAIL**, and the two likely causes are that iOS has
not fetched the association file yet (delete the app, reinstall, wait a minute, retry on
Wi-Fi) or that the file does not name this bundle. The deployed file currently claims
`98729PG8GD.app.bingd`, `98729PG8GD.app.bingd.preview` and `98729PG8GD.app.bingd.dev`;
`curl -s https://bingd.app/.well-known/apple-app-site-association` confirms it.

## Layout and safe areas

- [ ] **Nothing is under the notch or Dynamic Island** on any screen: home, collection,
      title, profile, settings, onboarding.
- [ ] **Nothing is under the home indicator.** Buttons at the bottom of a screen are
      tappable, not clipped.
- [ ] The tab bar sits above the home indicator with the right amount of room.
- [ ] Scroll to the very top and the very bottom of a long collection; content clears both
      insets.
- [ ] Full-screen sheets and modals respect the top inset.

## Keyboard

- [ ] On **every** screen with a text field, the field stays visible above the keyboard:
      search, note, comment, bio, display name, handle, the deletion confirmation, the
      email one-time code.
- [ ] The keyboard does not cover the primary button on any of those screens.
- [ ] Dismissing it does not leave a gap, and does not jump the scroll position.
- [ ] The one-time-code field accepts the code from the **QuickType suggestion bar**.

## Gestures

- [ ] **Swipe-back** works on every pushed screen: title, person, profile, each settings
      screen.
- [ ] Swipe-back does not fire inside a horizontally scrolling row (the cast strip).
- [ ] A **sheet drags down to dismiss**, and dismissing it does not lose typed input
      without warning.
- [ ] Dismissing a sheet mid-ranking does not corrupt the flow.

## Dynamic Type

Settings › Accessibility › Display & Text Size › Larger Text. Set it two or three steps
above default (not the accessibility sizes).

- [ ] Nothing is **clipped** on the home, collection, title or profile screens.
- [ ] No text is **truncated where it carries meaning** — a title, a handle, a position.
- [ ] Buttons still fit their labels.
- [ ] The tab bar labels are still legible.
- [ ] Return the setting to default afterwards.

## Photos

- [ ] Choosing an avatar prompts with **"Bingd uses your photos so you can choose a profile
      picture."** — not a generic string.
- [ ] **Nothing ever asks for the camera.** The permission is not in the build.
- [ ] The limited-photo-access option ("Select Photos…") works and does not break the
      picker.
- [ ] Denying access is handled with a message, not a crash.

## Share sheet

- [ ] The iOS share sheet opens from a profile and from a title.
- [ ] The shared payload carries a `https://bingd.app/...` URL.
- [ ] Sharing to Messages, and to Notes, both produce a working link.
- [ ] Cancelling the sheet returns cleanly.

## Background, relaunch, and the network

- [ ] Background for a minute and return. State is intact.
- [ ] **Background for ten minutes** and return. iOS may have terminated the app; it
      restores rather than showing a blank screen.
- [ ] Kill from the app switcher, reopen. Session and collection restore.
- [ ] **Airplane mode**: screens show an error state, not an endless spinner and not a
      crash. Turn it off; the app recovers without a restart.
- [ ] Returning to the foreground triggers the update check — on this build there is nothing
      to fetch, so nothing should visibly happen.

## Account deletion — **disposable account only**

Apple requires an in-app path to account deletion (guideline 5.1.1(v)). This is that path.

- [ ] Settings › **Account & Data** is reachable in two taps from inside the app.
- [ ] It states plainly that deletion is permanent, and lists what is removed.
- [ ] It requires typing the handle; a wrong handle is refused.
- [ ] The confirmation dialog says it cannot be undone.
- [ ] Deleting returns the app to signed out.
- [ ] Signing in again with those credentials offers a **new signup**.
- [ ] **The app never asks anyone to email support to delete their account.**

---

## Recording the result

PASS, FAIL or NOT RUN per section. A FAIL needs the build number, the screen, and what you
expected. Results go in `.agent-workflow/continuation.md` under a dated heading.
