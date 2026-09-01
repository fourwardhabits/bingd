# Android Preview — physical acceptance

Founder-run, on a real Android phone, on the Preview build. Nothing here can be claimed
by anybody who did not hold the device: **no line in this file may be marked PASS on the
strength of a passing test.**

## The build under test

| | |
|---|---|
| Profile | `preview` |
| Package | `app.bingd.preview` |
| App name on the home screen | **bingd preview** |
| Channel | `preview` |
| Backend | staging (`fjxhcbowoxuzulwirzyr`) — see note below |
| Build | **`0.1.0 (4)`** — confirm in Settings, bottom of the screen |
| Runtime | `e6c5f7da` |
| Build page | https://expo.dev/accounts/fourward/projects/bingd/builds/ce8fc0ec-f5ec-4c85-8814-733c7c842044 |

> **The two projects swapped roles on 2026-08-31 and the Supabase dashboard names did
> not follow.** The `preview` lane now points at STAGING `fjxhcbowoxuzulwirzyr`, which the
> dashboard still calls **bingd-production**. PRODUCTION is `abheeqyjzekiowkztfxv`, which
> the dashboard still calls **bingd-nonprod** and which holds every real user. If this
> Preview build reports `backend abheeqyjzekiowkztfxv`, it is pointed at PRODUCTION —
> stop the acceptance run and report it. Trust the ref, never the name;
> `config/backends.cjs` is the source of truth.

**Before anything else, open Settings and scroll to the bottom.** Four lines:

```
Bingd 0.1.0 (4)
preview · preview
runtime e6c5f7da · embedded
backend fjxhcbowoxuzulwirzyr
```

**All four have to match, and the build number is the one that catches the likely
mistake.** Three Preview APKs were produced on this branch — `(2)`, `(3)` and `(4)` — one
per review round, because each round's changes moved the native fingerprint and an
acceptance run against a superseded binary is an acceptance run against different code. If
the version reads `(1)`, it is the August 14 build; anything below `(4)` is superseded. If
`backend` reads anything but `fjxhcbowoxuzulwirzyr` (`abheeqyjzekiowkztfxv` is PRODUCTION), stop and report it — the app is
talking to a database it was not meant to.

## Installing

1. Open the build page above on the phone and tap **Install**, or scan the QR code.
2. Android will ask to allow installs from the browser. Allow it.
3. It installs beside any other Bingd — different package, different name, different icon
   label. `bingd dev` and `bingd preview` can both be on the phone.

## Accounts

Use the founder account for most of this. Use a **disposable second account** for anything
that changes another person's state — follow requests, recommendations, comments,
invitation redemption — and for the deletion test.

**Never delete the founder account.** The deletion test is on a disposable account only.
Do not put real credentials or another person's data into a screenshot.

---

## Auth

- [ ] Sign up with **email one-time code**. The code arrives; the wrong code is refused
      with a message that says so.
- [ ] Sign up with **Google**. The browser sheet opens, returns, and lands you signed in.
- [ ] Complete the profile: handle, display name, date of birth.
- [ ] Under-13 date of birth is refused, and nothing is left behind.
- [ ] Sign out. The app returns to the signed-out screen, and back-gesture does not
      re-enter Settings.
- [ ] Sign in again as the same person. The collection is where you left it.
- [ ] **Force-stop the app and reopen it.** The session restores without a sign-in.

## Onboarding

- [ ] The initial ranking flow runs to completion.
- [ ] Comparisons make sense — no title compared against itself, no repeated pair.
- [ ] Backing out mid-flow and returning does not lose the positions already set.
- [ ] The summary reports a count that matches what you actually ranked.

## Search

- [ ] **Title search**: a film by exact name, a film by partial name, a series.
- [ ] Punctuation and apostrophes behave (`WALL·E`, `Schindler's List`).
- [ ] A search with no results says so rather than showing an empty list.
- [ ] **Member search**: find a public account by handle.
- [ ] Find a **private** account by exact handle and send a follow request.
- [ ] Search does not reveal anything about a private account beyond its existence.

## Title

- [ ] Open a **movie**. Poster, cast, runtime, trailer link, source line
      ("Metadata from TMDB").
- [ ] Open a **series**, then a **season**. A season shows the series' data where TMDB
      only publishes it on the series.
- [ ] **Rank** it. It takes a position.
- [ ] **Change the rating** of something already ranked; the position updates coherently.
- [ ] **Remove from collection**; it disappears from Collection and from Ranked.
- [ ] **Watchlist**: add, then remove.
- [ ] **Recommend** it to the second account.
- [ ] Write a **note/review**; it appears under Reviews as yours.
- [ ] Open a **person** from the cast; their filmography loads and grows in twelves.

## Collection

- [ ] The **Movies** and **TV** switcher; positions are never merged across the two.
- [ ] **Filters**: genre, decade, at least one more. Clearing them restores everything.
- [ ] **Unranked** items are visible and clearly distinguished from ranked ones.
- [ ] The header count matches the list.
- [ ] Scroll a long list — no blank rows, no jumping.

## For You

- [ ] Recommendations render.
- [ ] **Filters** apply and clear.
- [ ] **Sent to you** shows what the second account recommended.
- [ ] Opening one marks it opened, and it stays opened after a relaunch.

## Social

- [ ] **Follow** a public account. It takes effect immediately.
- [ ] **Follow request** to a private account: it is pending, and the private account sees
      it in Notifications and can approve it.
- [ ] After approval, the follower can see the collection.
- [ ] **Comment** on something; the other account sees the comment.
- [ ] **React**; the count moves and the other account is notified.
- [ ] **Watched with**: tag the second account; they see the attribution.
- [ ] **Block** from the second account: the first can no longer see or reach them, in both
      directions.
- [ ] Unblock restores the previous state.
- [ ] **Notifications**: every kind above appears in the inbox, and **tapping one routes to
      the right screen** — not to a list, to the thing itself.
- [ ] **Notification Settings**: turning a category off stops that category arriving.
- [ ] There are **no push notifications**. This is correct — the inbox is the only channel.

## Profile

- [ ] Edit display name, bio, and profile picture. All three persist after a relaunch.
- [ ] **Privacy**: switch to private. A stranger can no longer read the collection; an
      approved follower still can.
- [ ] Switch back to public.
- [ ] **Goals**: set one, and the progress reflects real activity.
- [ ] **Awards**: at least three, and each one **opens to a drill-down** that explains
      itself.
- [ ] **Share** your profile from the share sheet; the copied URL is
      `https://bingd.app/u/<your handle>`.

## Invitations

- [ ] Settings › Privacy: **create an invitation link**. It is
      `https://bingd.app/i/<token>`.
- [ ] Open that URL **in Chrome on the same phone**. The bingd.app invitation page renders
      — the one that says "You have been invited to Bingd" — not the generic closed-testing
      page.
- [ ] The page's install button says the beta is not open for this device yet. That is
      correct today: no Play opt-in URL is configured.
- [ ] **Redeem it** on the disposable second account: sign out, tap the link, sign up
      through it.
- [ ] The inviter is notified.
- [ ] Rank ten titles on the second account and confirm the inviter gets
      **invite activated**.
- [ ] **Revoke** the link from Settings › Privacy. The revoked URL no longer redeems, and a
      new one is issued.

## App Links — the part that has never been tested on hardware

**Do not tap these links inside Chrome's address bar or from a bingd.app page.** Same-page
and same-domain navigations are deliberately not handed to apps. Put them somewhere else
first: a note, an SMS to yourself, a chat with yourself.

First, ask Android whether it verified the domain at install:

```
adb shell pm get-app-links app.bingd.preview
```

Expect `bingd.app: verified`. If it says `none` or `legacy_failure`, the fingerprint in
`assetlinks.json` does not match this build and every link below will open Chrome.
Re-verification can be forced with:

```
adb shell pm verify-app-links --re-verify app.bingd.preview
```

Then, from a **note or a message**, tap each:

- [ ] `https://bingd.app/u/<a real handle>` → **Bingd opens on that exact profile.** Not a
      chooser, not Chrome, not the Bingd home screen.
- [ ] A real **title** share URL (copy it out of the app's share sheet) → **Bingd opens on
      that exact Movie or Season.**
- [ ] A real **invite** URL → **Bingd opens on the invitation flow** for that token.
- [ ] `https://bingd.app/privacy` → **Chrome, showing the privacy page.** This one must
      *not* open the app; the app has no screen for it.
- [ ] With Bingd **already running in the background**, tap a profile link. It routes
      inside the running app rather than restarting it.

A chooser dialog ("Open with…") means the intent matched but the domain was not verified.
That is **not** a pass — it is the failure this test exists to catch.

## Platform behaviour

- [ ] **Keyboard**: on every screen with a text field, the field stays visible above the
      keyboard. Search, note, comment, bio, handle, the deletion confirmation.
- [ ] Dismissing the keyboard does not leave a gap or a jump.
- [ ] **Photo picker**: choosing an avatar asks for photo permission with a prompt that
      says what the photos are for. **Nothing asks for the camera.**
- [ ] Denying photo permission is handled — a message, not a crash.
- [ ] **Share sheet** opens from a profile and from a title, and the shared text carries a
      bingd.app URL.
- [ ] **Background and restart**: background the app for a minute, return. State is intact.
- [ ] Kill the app from the task switcher and reopen. Session and collection restore.
- [ ] **Offline**: turn on airplane mode. Screens show an error state rather than a spinner
      forever or a crash. Turn it off; the app recovers without a restart.
- [ ] Rotate the phone. The app stays portrait.
- [ ] The tab bar sits above the system navigation buttons with no grey band.

## Deletion — **disposable account only**

- [ ] Settings › **Account & Data** is reachable in two taps from the app.
- [ ] The screen states plainly that deletion is permanent and cannot be undone, and lists
      what goes.
- [ ] It requires typing the handle. A wrong handle is refused.
- [ ] The confirmation dialog says it cannot be undone.
- [ ] Delete. The app returns to signed out.
- [ ] Signing in with those credentials again offers a **new signup**, not the old account.
- [ ] The deleted account is gone from the founder account's followers and from search.
- [ ] **Nowhere does the app ask the user to email anybody to delete their account.**

---

## Recording the result

For each section: PASS, FAIL, or NOT RUN. A FAIL needs the build number, the screen, and
what you expected. Put the results in `.agent-workflow/continuation.md` under a dated
heading — not in this file, which is the checklist rather than the record.
