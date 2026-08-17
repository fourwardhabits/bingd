# Device acceptance checklists

Written at the end of the feature-completion run, 2026-08-17, against
`ui/visual-pass` at `dc7bee6` with bingd-nonprod at migration `20260817000700` and
`tmdb-adapter` v4.

**These are the checks a machine could not make.** Everything that could be verified
without a device has been: 762 Jest tests, 620 database tests, 64 remote probes, a
51-check two-user acceptance against the deployed project and a 21-check adapter probe.
What is left is what only a person holding a phone can answer — whether it *looks* like
one thing, whether a gesture *feels* like it worked, and whether an image that loads in
a test renderer actually appears.

Work top to bottom. A checklist that is skipped in the middle proves less than one that
was never started, because it produces a report nobody can trust.

---

## Android

Build: `eas build --profile preview --platform android`, or the existing dev client with
the latest OTA update. Confirm the build fingerprint in **Settings › Build** before
starting, or the report will be about code that is not on the device.

### Setup

- [ ] Two accounts on two devices, or one device and one browser session. Several checks
      below are about what *the other person* sees, and answering them from one account
      is guessing.
- [ ] At least eight titles ranked on each account, with five in common. Taste Match
      needs five and the Following score needs one.

### First run and navigation

- [ ] Cold start reaches the sign-in screen without a flash of the tab bar.
- [ ] Email code sign-in completes; the code field accepts a paste.
- [ ] A new account reaches the first-five onboarding and cannot skip past it into an
      empty app.
- [ ] The five tabs all load. Nothing shows a spinner that never resolves.
- [ ] **The tab bar clears the system navigation bar** — gesture navigation *and*
      three-button, which are different heights. This is the one that has regressed
      before.
- [ ] A pushed detail screen's back gesture works from the left edge without catching
      the hero's horizontal scroll.
- [ ] Rotating the device does not strand a sheet half-open.

### Feed

- [ ] The Trending shelf renders artwork, not placeholders.
- [ ] **Pull down to refresh.** New activity from the other device appears. This is new
      in this run and has never been on a device.
- [ ] Tap a reaction; the count moves. Long-press; the picker opens and dismisses.
- [ ] Tap the reaction count; the detail sheet names people and their profiles open.
- [ ] Comment on the other account's activity. It appears on their device.
- [ ] A spoiler-marked note is masked, and tapping reveals it.
- [ ] Share produces a link that opens the right title.
- [ ] No row appears twice.

### Collection

- [ ] Movies and TV both populate. Watched, Watchlist and the segments all switch.
- [ ] List and Wall both render; the Wall's posters are not stretched.
- [ ] Filters and Sort change the list and can be cleared.
- [ ] Shuffle produces a different title each time and never an empty screen.
- [ ] A title added to the watchlist elsewhere shows as saved here.
- [ ] Ranked scores are on the rows, and **`10.0` fits inside its circle** at every size.
- [ ] Dividers and spacing survive a long title and a missing poster.

### Log and Search

- [ ] All / Movies / TV / Users all return results.
- [ ] Recents only appear for searches that were **committed**, not for every keystroke.
- [ ] A search for something obscure reaches TMDB and the result is openable
      immediately, with no import step.
- [ ] A user search finds the other account, and the row is visually a person — round
      avatar — not a title row.
- [ ] A series result is compact and does not list its seasons inline.
- [ ] Series → Seasons → a season → log and rank it. **Verify the series itself offers
      no rank control.**
- [ ] The log sheet's spoiler and visibility controls save without a Done button.
- [ ] Companions can be added and removed; the other account is notified.
- [ ] **There is no "Photos" row.** It was removed in this run.

### For You

- [ ] The poster wall fills. No blank tiles.
- [ ] The slate is not four films from one franchise.
- [ ] Quick watchlist from a tile works and the state persists on return.
- [ ] A title already watched does not appear.
- [ ] A brand-new account gets something rather than an empty screen.

### Title detail

- [ ] The hero image loads and fades into the page; the poster overlaps it.
- [ ] The maroon score badge and the rank line read correctly.
- [ ] Rank / Ranked opens the ranking flow and the comparison screen is usable one-handed.
- [ ] Watchlist and Share both work.
- [ ] Community score and, once the other account has ranked it, the Following score.
- [ ] Cast portraits load. Tapping a face opens that person.
- [ ] **Videos tab appears and a trailer opens YouTube** — the app if installed, the
      browser otherwise. New in this run; the facet was empty on the deployed database
      until today.
- [ ] **TMDB Reviews render**, under that exact heading, with the line saying they are
      written by TMDB members. A rating reads "Rated 8 on TMDB", never a bare number.
- [ ] A long review truncates to four lines and expands; "Read the full review on TMDB"
      appears only when there is more to read.
- [ ] **A season shows no TMDB Reviews section at all.**
- [ ] Pull down to refresh. New in this run.
- [ ] Scrolling reveals the title in the header bar, once, without flicker.

### Person

- [ ] **A filmography, not "In your catalogue".** Films the device has never seen.
- [ ] Portrait, name, known-for line and biography.
- [ ] Movies / TV filter appears for someone with both, and not for someone with one.
- [ ] See more loads twelve more.
- [ ] "Showing N of M credits TMDB lists" is present when TMDB had more than forty.
- [ ] The bookmark on a row saves to the watchlist and the glyph fills.
- [ ] Ranked / Watched / On your watchlist appear on rows where they should.
- [ ] Tapping a credit opens the title and it is fully populated.
- [ ] Opening a person nobody has opened before resolves within a few seconds rather
      than sitting on a spinner.

### Profile

- [ ] Large avatar with name and @handle beside it — the approved layout.
- [ ] **No bio, and no placeholder where one would go.**
- [ ] Goals, Top Ranked, Recent Activity all render.
- [ ] The other account's profile shows **Taste Match**, and your own does not.
- [ ] Follow / Following / Requested reads correctly on both sides.
- [ ] Comments and activity navigate to the right places.

### Settings — all new in this run

- [ ] Five destinations, no "not built yet" anywhere.
- [ ] **Edit Profile**: change the display name, see it on the other device.
- [ ] Change the handle. The warning names the consequences before the change, not
      after. The old handle's link redirects. A second change inside thirty days is
      refused with a date.
- [ ] Avatar picker: choose, crop, upload, and remove.
- [ ] **Privacy**: the switch shows the real current state and never a guess. Turn it
      on; from the other device, confirm the profile becomes unfindable and a follow
      becomes a request.
- [ ] Turn it off. Confirm the pending request is approved and **no "approved your
      request" notification is sent**.
- [ ] Blocked accounts list shows somebody you blocked, and Unblock works from there —
      this is the only place they appear.
- [ ] **Notifications**: the follow request is there with Approve and Decline. Approve
      it from this device and confirm the other one gains access.
- [ ] Tapping a notification opens the actor's profile.
- [ ] A comment notification names the title.
- [ ] The pending count on the Settings hub matches.
- [ ] **Account & Data**: Sign out returns to sign-in and signing back in restores
      everything.
- [ ] Delete account: the button stays disabled until the handle is typed, then asks
      once more. **Do this on a throwaway account only.** Afterwards, confirm from the
      other device that the profile, their activity and their comments are gone.

### Offline and error states

- [ ] Aeroplane mode: log a title, then reconnect. It syncs.
- [ ] Aeroplane mode on the Feed: an error state with a way to retry, not a blank screen.
- [ ] A title screen with the backend unreachable still shows the film.

---

## iOS

**No iOS validation of any kind has been performed at any point in this project.** No
Apple hardware was involved. Everything below is unverified, and the first person to run
it should expect to find things — this is a first pass, not a re-check.

Build: `eas build --profile preview --platform ios`, on a physical device. The simulator
is not sufficient for the items marked ⚠, which are the ones most likely to differ.

### Everything in the Android list

Run all of it. The application logic is shared and most of it should hold.

### And these, which are where the platforms differ

- [ ] ⚠ **Sign in with Apple.** `expo-apple-authentication` is wired and has never run.
      A new account, an existing account, and the "Hide My Email" path, which produces a
      relay address the profile flow has never seen.
- [ ] ⚠ Safe area at the top on a device with a Dynamic Island, and at the bottom on a
      device with a home indicator.
- [ ] ⚠ The transparent title-screen header over the hero: iOS composites large titles
      differently and this screen sets `headerTransparent` with a background view.
- [ ] ⚠ The back-swipe gesture on every pushed screen — title, person, public profile,
      and all five settings screens.
- [ ] ⚠ Sheets: the log sheet, the ranking sheet, the comment sheet and the reaction
      detail. Dismissal by drag, and by tapping outside.
- [ ] ⚠ The keyboard over the comment composer and over the Edit Profile fields. Android
      resizes; iOS does not, and neither settings screen has a `KeyboardAvoidingView`.
- [ ] ⚠ Photo library permission for the avatar picker, including the "Selected Photos"
      partial-access state iOS added.
- [ ] ⚠ Opening a YouTube trailer: the app if installed, Safari otherwise.
- [ ] ⚠ Share sheet contents and the link it produces.
- [ ] ⚠ Dynamic Type at the largest accessibility size on the Feed, the title screen and
      the ranking comparison. Nothing may clip.
- [ ] ⚠ Dark mode, if the device is set to it. The palette is light-first.
- [ ] ⚠ Universal links: `https://bingd.app/title/...` and `/u/...` opening the app.
      `apple-app-site-association` has never been served or verified.
- [ ] ⚠ Pull-to-refresh on the Feed and title screen — the control is styled with
      `tintColor`, which iOS renders and Android ignores.

### Known to be missing before an iOS submission

None of these blocks the checklist, and all of them block the store:

- The `apple-app-site-association` file and the associated-domains entitlement.
- The external account-deletion page Apple requires for an app with account creation.
- A privacy manifest and the App Store privacy questionnaire answers.
- The approved TMDB logo, unmodified and less prominent than Bingd's own mark. The
  wording obligation is met; the logo is not.

All four are Beta Hardening.
