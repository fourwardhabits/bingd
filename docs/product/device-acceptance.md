# Device acceptance checklists

Rewritten at the end of the **founder acceptance correction pass**, 2026-08-17, against
`ui/visual-pass` at `76c38e7`.

**The backend this certifies is the one produced by that pass's deployment**, which is a
prerequisite rather than a description of what was live when this was written:

| | |
|---|---|
| Migration | through `20260817001100` |
| `tmdb-adapter` | **v6** — the version that no longer writes the `reviews` facet |

**Establish all three before starting**, or the report is about something else:

- [ ] Build fingerprint in **Settings › Build** matches the build under test.
- [ ] `npx supabase migration list --linked` shows local and remote in step through
      `20260817001100`.
- [ ] `npx supabase functions list` shows `tmdb-adapter` at **version 6 or later**. The
      adapter must be deployed **before** the migrations — v5 still writes a facet the
      new constraint forbids, and every enrichment fails in between.

**These are the checks a machine could not make.** Everything that could be verified
without a device has been: 773 Jest tests, 641 database tests, the remote probes, the
two-user acceptance against the deployed project and the adapter probe.
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
- [ ] **Trending does not stick to the top** as you scroll — it leaves with the rest.
- [ ] **A divider and a heading separate Trending from the activity below it**, so the
      two do not read as one list.
- [ ] **Pull down to refresh.** New activity from the other device appears. This is new
      in this run and has never been on a device.
- [ ] Tap a reaction; the count moves. **The heart fills**, and the row does **not** gain
      the word "You" or change width — a tap must not shift the action row.
- [ ] Long-press; the picker opens and dismisses.
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
- [ ] A brand-new account gets something rather than an empty screen, under
      **`Popular right now — rank a few titles and this becomes yours.`** A cold slate may
      never be described as personalised.

**The copy and the filters, both corrected in this run.**

- [ ] **The headline says what is true of the whole wall**, and `Inspired by …` is an
      aside beneath it rather than the basis. The old line named three films and implied
      they were the whole reason; the engine uses up to six anchors, a taste vector over
      every genre and language, and a popularity prior.
- [ ] The aside reads **`Inspired by … + more`** when **four or more distinct anchors are
      named across the rendered slate** — which is not the same as the engine having used
      four. Count the anchors the wall actually attributes, not the ones it considered.
- [ ] **Genre, Language, Decade and Anime** are the filters, and **Anime is peer-level**
      with the other three rather than buried inside Genre. **There is no actor filter** —
      its absence is correct.
- [ ] **Languages read as full names** in the filter sheet — `Telugu`, not `te`. This was
      the founder's Android Preview finding and it was a real bug: the app resolved names
      through `Intl.DisplayNames`, which Hermes does not implement, so every device fell
      back to the code while every test passed on Node's full ICU. Names now come from a
      shipped table (`src/lib/language.ts`) that covers every language in the seed and
      everything TMDB enrichment brings in, **so every code this catalogue can produce
      must read as a word, and a raw code here is a failure.** A code outside the table
      still falls back to the code by design, so that an option present in the data stays
      selectable — which is why the check is "report *which* code you saw" rather than
      "no code anywhere": an unrecognised provider value is a different and much smaller
      thing than the Hermes defect, which showed *every* code on *every* device.
- [ ] **The heading never shows a raw code.** It falls back to the neutral `For you`
      instead, so `te for you` on the heading is a failure in every case.
- [ ] **One filter names the heading** — `Comedy for you`, `Telugu picks for you`,
      `Anime for you`. **Two or more revert to the neutral heading**, deliberately.
- [ ] Applying a filter **re-ranks the wall rather than cutting it**: the result should
      still be varied, because filtering happens before the slate is built.
- [ ] Clearing the filters restores the unfiltered wall and its heading.
- [ ] **Anime in Collection too**, where it is equally first-class.

### Title detail

**The hero is the first thing to check and the least verified.** The banded fade — sixty
stacked views each stepping 1.5% of alpha — is replaced by a single
`experimental_backgroundImage` gradient, React Native's own. **It has never been seen on a
device**, and no test renderer can answer whether it draws.

- [ ] **The fade is smooth, with no visible bands or steps**, on an OLED screen and at low
      brightness, which is where banding shows.
- [ ] **The gradient renders at all.** A hard edge, a flat block or a missing fade means
      `experimental_backgroundImage` is unsupported on this build — report it as such
      rather than as a styling nit, because the fix is a different mechanism.
- [ ] **The crop is anchored top-centre**: on a wide backdrop of a person, the face is in
      frame rather than cropped out of the top.
- [ ] The poster overlaps the hero, and there is **no dead space** where a score used to
      sit.
- [ ] **Title, then a muted year**, then `certification · runtime · director` — present
      and correctly punctuated. Any of the three being absent must collapse the line
      cleanly, not leave a stray separator.
- [ ] **Genres sit above the description**, and the **scores are static above the tabs**
      rather than scrolling with them.
- [ ] **The tab row follows the rules, which are conditional rather than fixed** — a tab
      that could only ever be empty is not shown at all:
      - A film: `Cast · Reviews · Videos · Details`. **Cast appears only if there are
        credits and Videos only if there is a trailer**, so a sparse title legitimately
        shows fewer. Reviews is **always** there, because the reader can write the first
        one and its empty state is the invitation to.
      - A series: `Seasons` **first**, then Cast if there are credits, then Videos if
        there are trailers, then Details. **No Reviews tab** — a series cannot be ranked,
        so nobody has a score to review it with. Seasons shows even when empty, because
        it is the page's only exit.
      - Fewer tabs than expected is only a failure if the content is demonstrably there.
- [ ] The maroon score badge and the rank line read correctly.
- [ ] Rank / Ranked opens the ranking flow and the comparison screen is usable one-handed.
- [ ] Watchlist and Share both work.
- [ ] Community score and, once the other account has ranked it, the Following score.
- [ ] Cast portraits load. Tapping a face opens that person.
- [ ] **Videos tab appears and a trailer opens YouTube** — the app if installed, the
      browser otherwise. New in this run; the facet was empty on the deployed database
      until today.
- [ ] **The Reviews tab is Bingd's own**, not TMDB's. Changed in this run: TMDB's user
      reviews are gone from the product entirely, so **seeing them anywhere is a
      failure**, not a pass. The rows are public Notes written by Bingd accounts, each
      with the author named and their live Bingd score.
- [ ] **Top and Recent both work.** Top orders by reactions on the activity the note
      belongs to; switching to Recent reorders by when the note was last edited.
- [ ] **A note marked as containing spoilers is masked**, under the words
      `Contains spoilers`, and reveals on a tap. A viewer who has already watched sees it
      unmasked with no second reveal.
- [ ] **No literal `<br>` or other HTML** appears in any review body. This was TMDB's
      markup arriving unrendered; nothing strips markup, so a Bingd member who *types*
      `<br>` will still see those characters, and that is not a failure of this check.
- [ ] "No reviews yet" is what an unreviewed title shows — not an error and not a blank.
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

- [ ] **The approved layout, which changed in this run**: avatar, display name and
      @handle **stacked and centred**, not side by side.
- [ ] **A bio, which is new.** Set one in Edit Profile and confirm it appears here and on
      the other device. An account without one shows nothing rather than a placeholder.
- [ ] **One Top Ranked wall and no duplicate list below it.** All / Movies / TV seasons
      filter it in place.
- [ ] Recent activity renders and **reads like the Feed** — the same row, not a weakened
      copy of it.
- [ ] **`ProfileIdentity` and `TopRanked` are shared between your own profile and
      `/u/<handle>`**, so the avatar/name/handle block and the Top Ranked wall must look
      and behave identically on both. That sharing is the correction; the rest of the two
      screens is **deliberately different** and must not be reported as a mismatch:
      - **Goals appear only on your own profile.**
      - **Notes appear only on `/u/<handle>`**, carrying the spoiler rules resolved
        against *your* watched list.
      - An empty Recent activity is **omitted entirely** on `/u/<handle>`.
- [ ] The other account's profile shows **Taste Match**, and your own does not.
- [ ] Follow / Following / Requested reads correctly on both sides.
- [ ] Comments and activity navigate to the right places.

### Goals — the drill-down is new in this run

- [ ] **Each goal's progress row is tappable** and opens the sheet. It was a bar that did
      nothing before.
- [ ] **The sheet lists the titles that counted**, and the number of rows matches the
      number on the bar exactly. They come from one traversal, so a disagreement is a real
      defect and not a rounding difference.
- [ ] Tapping a row opens that title.
- [ ] **There are no exclusion controls on the sheet**, deliberately — the way to change
      what counted is to change the watch, and every row leads there.
- [ ] A goal with nothing yet opens to an empty state rather than refusing to open.

### Settings — all new in this run

- [ ] **Four navigation rows** — Edit Profile, Privacy, Notifications, Account & Data —
      plus **Sign out**, which sits *above* About, and an inline About block carrying a
      readable version. No "not built yet" and no "coming soon" anywhere, and no
      diagnostics.
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

**Read and unread, which is the whole of this run's notifications correction.** What this
replaced marked the inbox read in an effect on first render, so every reader saw zero
unread, always.

- [ ] **The bell carries an unread badge** and the count is of *unread news*, not of
      pending follow requests.
- [ ] **Unread rows are visibly distinct from read ones.**
- [ ] **Mark all read** clears every unread row and the badge with it, in one action.
- [ ] Leave the screen and come back: the rows stay read. Generate new activity from the
      other device and confirm the badge returns.
- [ ] **The Settings hub row still counts pending requests**, not unread news — a request
      is a task and news is not, and the two numbers are allowed to differ.
- [ ] **Account & Data**: Sign out returns to sign-in and signing back in restores
      everything.
- [ ] Delete account: the button stays disabled until the handle is typed, then asks
      once more. **Do this on a throwaway account only.** Afterwards, confirm from the
      other device that the profile, their activity and their comments are gone.

### The keyboard — the largest item in this run, and Android is where it was broken

`create-profile` was on a `KeyboardAvoidingView` whose Android `behavior` was `undefined`
— not a behaviour but a deferral to a window resize that **edge-to-edge does not perform**,
so it did nothing while looking correct. `useKeyboardHeight` measures the keyboard instead,
and `Sheet` pads its modal **root**, which lifts every bottom-anchored sheet at once.

Every one of these is "type in it and watch": the field you are typing in must stay
visible, and the button you then need must be reachable **without dismissing the keyboard
first**.

- [ ] **Create profile** — display name and handle. This is the one that was broken.
- [ ] **Edit Profile** — every field, including the bio, which is the longest.
- [ ] **Settings › Account & Data** — the deletion confirmation field, which is the last
      thing on a long page, and its button.
- [ ] **The comment composer**, with the sheet already scrolled down.
- [ ] **The log sheet's note field.**
- [ ] **The goal sheets and the filter sheets.**
- [ ] A sheet with the keyboard up is still **fully readable** — it must rise, not just
      shrink to a strip.
- [ ] Dismissing the keyboard returns each sheet to where it was, with no jump.

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
- [ ] ⚠ **The whole Android keyboard list above, again.** The two platforms take
      different paths through the same components: `KeyboardScreen` uses
      `automaticallyAdjustKeyboardInsets` on iOS and the measured height on Android, and
      `Sheet` pads its root from the same measurement on both. So iOS exercises code that
      has been reasoned about and never run — the composer, the Edit Profile bio, the
      account deletion field and every bottom-anchored sheet.
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
- ~~The approved TMDB logo, unmodified and less prominent than Bingd's own mark.~~ Added
  2026-08-21 (`assets/brand/tmdb-logo.svg`, Settings › About); the wording obligation was
  already met.

The remaining three are Beta Hardening.

---

## Friend Recommendations — the short list, 2026-08-17

**Do this section first.** It is the only part of the app that changed since the last
re-smoke, and it is the whole of what this run added. Everything above it was certified at
`76c38e7` and is unchanged.

Baseline for this section, and it supersedes the three items at the top of this file:

- [ ] `npx supabase migration list --linked` shows local and remote in step through
      **`20260817001300`**.
- [ ] `npx supabase functions list` shows `tmdb-adapter` at **version 6 or later**.
      It was **not** redeployed this run and does not need to be.
- [ ] Build fingerprint in **Settings › Build** matches the build under test.

You need **two accounts on one device or two devices**, A and B, and they must follow each
other. A one-way follow is the case half of this section is about.

### Recommend

- [ ] Open any film. The action row reads **Watchlist · Recommend · Share**, in that order.
- [ ] Open a **series** (not a season). There is **no Recommend** on it.
- [ ] Tap **Recommend** on a film. The sheet is headed `Recommend <the film>` and lists
      only people who follow you back. Somebody you follow one way must **not** be there.
- [ ] Tap a person. It sends on that one tap: no second Send button, no checkboxes, no
      spinner left behind. The sheet closes and the title screen says
      `Recommended to <name>`.
- [ ] Tap **Recommend** again on the same film and send to the same person. It succeeds
      quietly. Their inbox must **not** ring a second time (check on B).
- [ ] Open a **season** and recommend it. The sheet heading must read
      `<Show> — Season N` and never a bare `Season N`.
- [ ] ⚠ **Share with someone not on Bingd** opens the OS share sheet. Read the message it
      produces: it must carry the title link *and* a `bingd.app/i/…` invite link. The
      invite page itself is not built and says so — that is expected.

### On B's device

- [ ] The bell carries an unread count and the inbox row reads
      `<A> recommended a movie` with the title on the line beneath.
- [ ] Tapping that row opens **the title**, not A's profile.
- [ ] **Recommendations tab → Sent to you** carries a count on the tab itself.
- [ ] The row shows the poster, the title, `<A> recommended this · 2d ago`, and a
      bookmark. Unopened rows are tinted and carry a dot.
- [ ] Tap the row. It opens the title, and on returning that row is no longer marked new.
      Unopened rows stay above opened ones.
- [ ] Tap the bookmark on a row. It fills, and the title appears in Collection → Watchlist.

### Filters, shared across both tabs

- [ ] On **For you**, apply a Genre filter. Switch to **Sent to you**. The filter is still
      on, the chip still reads `Filters · 1`, and only matching recommendations are shown.
- [ ] Filter to something nothing matches. The empty state says so and there is exactly
      **one** `Clear all` on screen.
- [ ] `Clear all` restores both tabs.

### Follow back

- [ ] From A, follow B (B must not already follow A). On B, the inbox row for that follow
      carries a **Follow back** button.
- [ ] Tap it. It succeeds and the button disappears.
- [ ] Now that they are mutual, the row must **not** offer Follow back again.
- [ ] Make B private, request a follow from a third account, and check the request row
      shows **Approve / Decline** and **no Follow back beside them**.

### Who I watched with — narrowed this run

- [ ] Log a watch and open **Who I watched with**. Only people who follow you back are
      listed. Somebody you follow one way is absent.
- [ ] ⚠ **If you had a companion tagged before this build**, open that watch's picker.
      That person must still be listed and still ticked, even if the follow has since
      lapsed, and you must be able to save the list. This is the grandfather clause and
      it is the one thing here that cannot be verified without a pre-existing tag.

### What is not testable here, and is not a defect

- The invite link resolves to nothing. There is no web property; `app/i/[token].tsx` says
  invitations are not active in this build. Redemption and activation are Beta Hardening.
- No push notification arrives. Delivery is dark by design (AD-10).
