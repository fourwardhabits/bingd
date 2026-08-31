# Final physical acceptance — A to T

**Written 2026-08-29 against `54e32fd`; reconciled 2026-08-30 against `95fd4d7`, then
`2f27577`, and again the same day against `37e8584`.** The last founder run on a real phone
before the release candidate. Everything below is a behaviour that shipped in the tranches
from PR #63 to PR #78 and that **only a physical device can confirm** — nothing here is
covered by the test suite, and nothing here needs a production environment.

> ## Reconciled 2026-08-30 (third pass) — the six-item retest for `37e8584`
>
> **`37e8584` (PR #78) fixed two things a device has to confirm and one it should**, and
> the six checks below are the whole of what this tranche owes a phone. Everything else in
> this document stands and is still owed.
>
> | # | Item | Why it needs a device |
> |---|---|---|
> | 1 | **D1** — Collection → Rating: highest first | The photographed defect. The chip and the rows have to agree, and only an eye can see that they do |
> | 2 | **D2** — Rating again: lowest first, same label | The toggle, and the rule that the label does not move with the direction |
> | 3 | **D3** — Recently added, both directions | The axis that replaced the one that never worked. **The word must be "added", never "watched"** |
> | 4 | **D4** — label, arrow and order across Movies/TV and grid/list | The state survives four different switches, and a stale label is invisible to a test |
> | 5 | **D5** — another profile's See all | Two orders, truthful wording, **no watch date and nothing implying one** |
> | 6 | **P-iv** — earn, lose and re-earn a collection award | On a **disposable nonprod account**: the tier, the feed post and the inbox row go together, a supported lower tier stays, and re-earning produces exactly one of each |
>
> **P-v (Leaderboard Back and tab re-tap) is worth the extra minute** and is not in the six
> because it was already half-working: Android Back returned to the Feed before this
> tranche, and only the tab re-tap is new.
>
> **Do items 1–5 in one sitting on the Collection tab** — they are five presses on one
> screen. Item 6 needs a second account and about ten minutes.
>
> **The previous eight-item retest for `2f27577` and the ten-item one for `95fd4d7` are
> both preserved below and both still owed.** Neither has been run on a device.

> **On the lettering.** There is no literal A–Q acceptance list in this repository to
> inherit — `git grep` and the PR bodies for #63–#75 have none — so these items were derived
> from the tranches themselves. The set runs to **T** rather than Q because the two
> platform-specific pairs (R, S) and the one destructive check (T) are kept separate rather
> than folded into an earlier item. Nothing was dropped to reach a letter.

**Budget: 30–45 minutes.** Run it in order; the sections are arranged so setup done early is
reused later.

> ## Reconciled 2026-08-30 (second pass) — the eight-item retest for `2f27577`
>
> This list was written for a full pass, and **the tranche merged as `2f27577` needs a much
> shorter one** for the same reason its predecessor did: everything in it is either covered
> by the test suite or is a change to something this list already checks. Two of the four
> items were also **verified against deployed nonprod before the OTA was published**, which
> is noted per row — the device run is confirming the client half.
>
> | | | Already verified server-side? |
> |---|---|---|
> | **1** | `@silky` — or any account whose titles carry no watch date — appears on the **monthly** Titles board with the right count | ✅ `leaderboard()` on nonprod now returns all twelve accounts, `@silky` at 2 |
> | **2** | A private, unapproved account is still a **minimal row**: rank, name, handle, avatar, lock, count — and **no Match** | ✅ `viewable=false` with `match_percent` and `shared_count` null at the server |
> | **3** | **Search and title detail both show Anime first, and neither shows Animation**, for the same anime title. Search it fresh so the provider pass runs | — client only |
> | **4** | A non-anime animated title (any Pixar or Disney film) still shows **Animation** | — client only |
> | **5** | **Jujutsu Kaisen** shows Specials and Season 1, **each with its episode count** (10 and 59), and any Season 1 state you already had is intact | ✅ counts landed; see the note below about Season 2 |
> | **6** | A second previously incomplete series — try **Attack on Titan** or **Severance** — shows every season the provider publishes, with counts | ✅ 1,700 of 1,747 season rows now carry a count, up from 0 |
> | **7** | **Awards stay in the same order before and after an unlock.** Note the order, earn something, reopen the sheet | — client only |
> | **8** | **Recommendations**: no change was made. Confirm only that For You still draws and rotates; the audit conclusion is in `recommendations.md` §9 | audit, not a fix |
>
> ### Item 5 needs one thing said plainly before you run it
>
> **TMDB has no Season 2 for Jujutsu Kaisen.** The provider models the show as a single
> 59-episode Season 1 under `/tv/95479`; what everyone else calls season 2 is episodes 25–47
> of that one. Confirmed by re-running the enrichment against nonprod and by reading TMDB's
> own seasons page. So the acceptance for item 5 is **Specials + Season 1 with their episode
> counts**, and a missing "Season 2" row is the provider's answer rather than a defect
> Bingd can fix. The two real defects underneath the report were fixed and are what items 5
> and 6 actually check.
>
> The rest of the list stands as the fuller pass to run against the **production release
> candidate**.
>
> **Explicitly deferred to the RC** by founder decision, and *not* part of the short retest:
> the full invite and new-account acceptance (items M, N, O's OTP half), the full iOS
> push and deep-link pass (R-i, R-ii), the broad UGC report and block retest, and the
> destructive account deletion (T). Nothing in those features changed in this tranche.
>
> **The previous short retest**, for `95fd4d7`, is preserved below because it has not been
> run on a device yet and is still owed: the causal feed order (A), Too tough everywhere
> (B, C), alphabetical filters (E), the muted locked award title (F), the single rule under
> an activity (G), and the private leaderboard row (now item 2 above).

---

## Before you start

| | |
|---|---|
| **Build** | The installed **friend beta** — iOS build 5 or Android build 7, both from `89631bf`. **Unchanged**: this tranche has no native delta, so there is no new binary to install |
| **Update** | Background the app, wait, foreground it, and let it reload. Settings → bottom must show an update id, not `embedded` |
| **The right update** | iOS group `73cf8cb0-abfb-4fa6-97ac-dc6b553522c7` (update `01a055c0-f323-7c7c-8558-977b4446e69b`) · Android group `1c3ce036-c180-4c04-88bc-6ffd9a5035ab` (update `01a055c0-f323-7553-a1c8-faf6da45812b`) — both published from `37e8584` and messaged *"Sort says what it orders by; an award the collection still supports"* |
| **Runtime** | iOS `d3b308f74a08…` · Android `41a907174ba3…`. `37e8584` fingerprints to **byte-identical** values against `2f27577`, measured in one tree with one env by checking each SHA out over the other — and **none of the 33 changed files is a fingerprint source**. Both hashes also match the runtime versions of the installed builds exactly. Native delta **NONE**, **no new build needed for this run** |
| **Backend change** | This tranche has two, and both are already done: migration `20260904000100` is applied to nonprod, and the **push-sender edge function was redeployed** — it had been at v3 since 2026-08-25 and this tranche changes it. Nothing to do on the phone |
| **Accounts** | Your own (**A**) and a second one (**B**) on another device or another install. Several items need both |
| **Backend** | nonprod, and that is correct for this run |

**Evidence.** Keep a screenshot or a short screen recording for every item marked
📷 — those are the ones where "it looked right" and "it was right" have come apart before.

---

## Part 1 — Either platform, single account (about 15 minutes)

### A. Ranking — a pair you declined never comes back

| | |
|---|---|
| **Setup** | An account with at least 10 ranked films |
| **Actions** | Rank a new film. When a comparison appears, tap **Too tough**. Keep answering. Then rank another new film and keep going for a few comparisons |
| **Expected** | The pair you called *Too tough* is **never offered again in this session**, and neither is any title already offered. When the walk runs dry the title is placed at the midpoint — and **the reveal says nothing about it**: no "you skipped a few", no estimate paragraph, nothing about Too tough at all. It states the score and the placement, as it does for every other ranking. No comparison is recorded for a pair you did not call |
| **Evidence** | 📷 the *Too tough* screen and the placement that follows |
| PASS / FAIL | ☐ |
| Notes | |

> This is the founder's own repeat from the last run. `ranking_sessions.seen_items` now
> holds every title the session has offered and `_rank_offer` refuses all of them.

### B. Rank again is a second opinion, not a reset

| | |
|---|---|
| **Setup** | A title already ranked |
| **Actions** | Open it → **Rank again** → answer the comparisons → look at the score |
| **Expected** | You are offered pairs freely again (it is a new session), and the score you end with is a considered result rather than a wipe. **Your rank** updates and the collection reorders |
| PASS / FAIL | ☐ |
| Notes | |

### C. Anime is a genre, not a type

| | |
|---|---|
| **Setup** | Collection tab |
| **Actions** | Open the filter sheet. Look for a **Type** section. Then find **Anime** in **Genre**. Select Anime **and** another genre, e.g. Horror. Switch Movies → TV with Anime still selected. Then **open an anime title** and read its genre pills. Then open a non-anime animated one — a Pixar film — and read its pills. Then look at the order of the Genre, Language and Decade lists |
| **Expected** | There is **no Type section**. Anime sits in **Genre**. Anime + Horror returns *either* (union within the facet), not the intersection. Movies + Anime returns anime films; TV + Anime returns anime seasons. The count beside Anime matches what selecting it returns. **The anime title shows `Anime` and not `Animation`** — never both — and keeps its other genres, e.g. *Action · Adventure · Anime*. **The Pixar film still shows `Animation`** and never `Anime`. **Genres and Languages are alphabetical** by the word shown, and **Decades run oldest first** — Earlier, 1990s, 2000s, 2010s, 2020s |
| PASS / FAIL | ☐ |
| Notes | |

### D. The sort control says what it does — **the six checks that matter most this run**

> **This is the founder's photographed defect.** The chip read *Recently watched* over a
> wall plainly in rating order, because every ranked row reached the comparator with no
> watch date and the sort left them in the order they arrived in — which is score order.
> Both halves are fixed; both halves need eyes.

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| D1 | Collection → Watched → sort chip → **Rating** | Highest ratings first, arrow **down**, chip reads **Rating** | ☐ |
| D2 | Press **Rating** again | Lowest ratings first, arrow **up**, chip still reads **Rating** — the label must not change with the direction | ☐ |
| D3 | Choose **Recently added** | Newest additions first, arrow down. Press again: oldest first. **The word is "added", never "watched"** | ☐ |
| D4 | Switch Movies ↔ TV, and grid ↔ list, in each order | Label, arrow and the order on screen stay correct and stay together. Nothing silently reverts | ☐ |
| D5 | Somebody else's profile → **See all** under Top ranked | Two orders only — **Rank** and **Recently ranked**. No watch date anywhere, and no wording that implies one | ☐ |
| D6 | Profile → **See all** from the **Movies** side | Lands on **Movies**, whatever the tab last remembered; the ordinal is drawn | ☐ |

**Evidence** 📷 D1 and D2 side by side, and D3 — the chip and the first three rows in each.

> **What a failure looks like.** The list not changing when the direction is toggled, or
> two different axes producing the same order, is the original defect returning: it means a
> comparator is answering *equal* and the incoming order is showing through.

### E. The title hero — artwork, and a rank line only when it earns one

| | |
|---|---|
| **Actions** | Open a title you have ranked **inside your top 10**. Then one ranked well outside it |
| **Expected** | The hero is 16:9 artwork, correctly inset. The top-10 title shows **at most one** placement line — overall top ten, else its best top-ten genre. **The outside-top-10 title shows no placement line at all**, and nothing anywhere says "#17 in English" |
| **Evidence** | 📷 both heroes |
| PASS / FAIL | ☐ |
| Notes | |

### F. One note that saves itself, quietly

| | |
|---|---|
| **Actions** | Open a logged title, start writing a note, and type a full sentence without pausing. Watch the rows **below** the text |
| **Expected** | Nothing jumps. No *Saving…* line appears and disappears mid-sentence. Leave the screen and come back: the text is there. Then turn on airplane mode and type — **now** it tells you the save failed |
| **Evidence** | 📹 a screen recording is worth more than a still here |
| PASS / FAIL | ☐ |
| Notes | |

### G. Search, and the two letters that are always capitals

| | |
|---|---|
| **Actions** | Search tab. Search something that returns films and seasons. Read every label on screen |
| **Expected** | **One list**, not two. Every occurrence of **TV** is capitalised — in the selector, in tabs, in filters, in empty states. Never "tv", never "Tv" |
| PASS / FAIL | ☐ |
| Notes | |

### H. Who I watched with, where it now lives

| | |
|---|---|
| **Actions** | Open a logged title and look at the block around your writing row |
| **Expected** | **Who I watched with** is one row directly under the writing row — **not** hidden behind *Change your rating* |
| PASS / FAIL | ☐ |
| Notes | |

---

## Part 2 — Either platform, two accounts (about 15 minutes)

Do §I–§M in one sitting; each builds on the last.

### I. The feed reads in the order things happened

| | |
|---|---|
| **Setup** | B ranks enough to cross an award tier, or completes a goal |
| **Actions** | On **A**, open the Feed and find B's activity and the award or goal that came from it |
| **Expected** | The **cause** is above its consequence. An award ties with its cause to the microsecond and still sorts after it; a goal that commits seconds later also sorts after it. Never the reverse |
| **Evidence** | 📷 the pair, in order |
| PASS / FAIL | ☐ |
| Notes | |

### J. Reactions and mentions on a comment

| | |
|---|---|
| **Actions** | B comments on A's activity, using **@** to mention A by handle. A opens the comment **from the notification**, reacts to it, and replies |
| **Expected** | The mention renders as a name and links to A's profile. **A is notified of the mention.** Opening the activity from the notification shows the existing reactions — not a confident **0**. The same six reactions are offered on a comment as on an activity. Reacting works from both the row and the detail sheet |
| **Evidence** | 📷 the notification, and the opened activity showing reactions |
| PASS / FAIL | ☐ |
| Notes | |

> The 0 is the specific regression: a read that has not landed is not a zero, and the
> control now waits for the query to settle rather than drawing a confident wrong number.

### K. A recommendation that hears back

| | |
|---|---|
| **Actions** | A opens a title → **Recommend** → selects **more than one** person including B → sends. B opens *Sent to you*, opens the recommendation, then logs the title |
| **Expected** | Multi-select works and the footer **stacks** rather than crushing its buttons. B sees it under *Sent to you* with shelves and dividers. **A is told when B watches it.** A declined recommendation does not come back |
| **Evidence** | 📷 the Recommend footer, and A's notification when B logs it |
| PASS / FAIL | ☐ |
| Notes | |

### L. Match shows its evidence

| | |
|---|---|
| **Actions** | On A's device open B's profile and tap the **Match** score |
| **Expected** | It shows the titles the score is built from — both accounts have ranked them. The number is not larger than the evidence supports |
| PASS / FAIL | ☐ |
| Notes | |

### M. Report, block, and what a block actually does

| | |
|---|---|
| **Actions** | A reports one of B's comments (check the reason list), then reports a review, then a profile. Then A **blocks** B |
| **Expected** | Reporting is available on a comment, a review and a profile. The reason list offers eight reasons. The receipt is the same sentence whether or not you had reported it before. After the block: neither sees the other anywhere, and **any follow between them is gone**. Unblock: they can see each other again and the follow is **not** restored — and the dialog said so beforehand |
| **Evidence** | 📷 the reason list, and the unblock confirmation text |
| PASS / FAIL | ☐ |
| Notes | |

---

## Part 3 — The invitation, on a genuinely new account (about 8 minutes)

### N. An invitation that says so at the time

| | |
|---|---|
| **Setup** | A's invite link from Settings → Privacy or the profile. A **third, brand-new** account (**C**) on a device that has never signed in |
| **Actions** | Send the link to C. C opens it, installs or opens the app, and signs up through it. Watch **A's** notifications at the moment C's account is created — **not** after C ranks ten titles |
| **Expected** | A is told *"joined bingd. from your invite"* **immediately**, and there is **no separate plain "started following you" row for the same event** — the invite row replaces it. If A's account is private, A gets a **follow request** with Approve and Decline instead. The welcome row shows the real relationship — Follow / Follow back / Requested / Following — rather than nothing. C's welcome stays inside the app |
| **Evidence** | 📷 A's notification, timestamped against C's signup |
| PASS / FAIL | ☐ |
| Notes | |

### O. Every comparison surface — the word for one you cannot call

| | |
|---|---|
| **Actions** | As **C**, go through first-run taste onboarding. Reach a comparison and look at the control that is not either poster. Then dismiss the OTP screen and request another code. **Then, as A, rank a title from the Log tab and look at the same control** — and once more through **Rank again** on a title you have already ranked |
| **Expected** | The control reads **Too tough** on **every one of those surfaces** — never *Skip* — and looks the same on each: the same size as Undo, the same fill, the same border. The OTP screen **can be dismissed**, and *Send a new code* delivers a second usable code |
| PASS / FAIL | ☐ |
| Notes | |

> "Skip" reads as *skip ahead* in the middle of a five-film first run. A tester met a
> comparison they could not call and left.
>
> **Amended 2026-08-30.** The word was onboarding-only and the Log tab still said *Skip*, so
> the same control under the same two posters had two names. It is **Too tough everywhere**
> now — and the accessible label says it too, which is where the old word survived longest.

---

## Part 4 — Existing data: awards, goals, leaderboard (about 5 minutes)

These need an account that **already has history** — use A, not C.

### P. An award that says what it was for, by the same name everywhere

| | |
|---|---|
| **Actions** | Cross a tier (e.g. write enough comments), then compare **three** places: the notification, the Awards sheet row, and the feed event |
| **Expected** | **All three name the same tier.** The second line says the achievement — *"Wrote 20 comments"* — not a metal. No duplicate announcement for a tier already held. **P-iv below now covers revocation properly**, on a disposable account rather than on yours |
| **Evidence** | 📷 all three surfaces side by side |
| PASS / FAIL | ☐ |
| Notes | |

### P-ii. A consequence sits above the act that caused it

| | |
|---|---|
| **Actions** | As **A**, rank a title from the **Log tab** — bucket first, then the comparisons — and pick one that will earn an award or finish a goal. Read the Feed top to bottom afterwards. Then check the inbox and the lock screen |
| **Expected** | The **award or goal sits ABOVE the ranking that earned it**, because the feed is newest-first and the award happened after. Never below it. Two awards from one action hold a fixed order. Pull to refresh and open a second page: **the order does not change**. The congratulations arrives in the inbox and as a push **only after the ranking completed** — and a ranking you abandon halfway congratulates you for nothing |
| **Evidence** | 📷 the feed showing the award above the ranking, and the inbox row |
| PASS / FAIL | ☐ |
| Notes | |

> This is the item most worth doing carefully. The Log tab's first tap creates the
> collection row, so the award is announced a minute before the ranking activity exists —
> and the fix is what puts the two back together. Ranking straight from search is the
> easier case and was already right.

### P-iii. A locked award track is grey, title and all

| | |
|---|---|
| **Actions** | Open **Awards** and find a track with no tier earned. Then find one with at least one |
| **Expected** | The unearned track's **title is muted as well as its badge** — the two read as one locked row rather than a black title beside a grey picture. Its progress and its "Next: …" line stay fully readable. The earned track's title is **ink** |
| PASS / FAIL | ☐ |
| Notes | |

### P-iv. An award the collection no longer supports — **new, and the second half of this run**

> **Use a disposable nonprod account**, not your own history. This item deliberately
> destroys collection data, and a tier taken from your real account is a tier you would
> have to earn again.
>
> The cheapest track to cross is **Season Snacker Bronze — fifteen logged TV seasons**, or
> **Queue Dragon Seedling — twenty-five watchlist saves**, which needs no ranking at all.

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| P-iv-1 | On the disposable account, cross a collection-derived tier | The badge appears, **one** feed post, **one** inbox row, and a push if the category is on | ☐ |
| P-iv-2 | Remove enough titles to fall below the threshold, then pull to refresh the Feed and open the inbox | The badge is **gone from Awards**, the **feed post is gone**, and the **inbox row is gone**. All three, not two | ☐ |
| P-iv-3 | If the track had a lower tier you are still above, check it | **The lower tier is still there**, with its own post and its own inbox row untouched | ☐ |
| P-iv-4 | Re-add or re-rank enough titles to cross again | **Exactly one fresh feed post and one fresh inbox row.** Not two, not zero, and not the old ones reappearing | ☐ |
| P-iv-5 | Now do the same on a **history** track — delete a comment, or unfollow a mutual | **Nothing is revoked.** Comment Gremlin, Hype Courier, Invite Instigator, Heart Magnet and Mutual Mania are permanent by design | ☐ |
| P-iv-6 | Re-bucket a ranked title (Rank again, different band) | **No new award announcement of any kind.** A band move loses nothing, so it must announce nothing | ☐ |

**Evidence** 📷 the Awards row, the feed and the inbox **before** P-iv-2 and **after** it,
and the single fresh post after P-iv-4.

> **The one limitation, stated so it is not reported as a bug.** A push already delivered
> to the phone **cannot be recalled** — neither Apple nor Google offers it. If the lock
> screen still shows a congratulations for a tier you have just removed the titles for,
> that is expected and correct. Everything the server owns is gone; the notification
> centre is the operating system's.

### P-v. Leaderboard is a place you can leave — **new**

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| P-v-1 | Feed → the trophy → **Leaderboard**. Android only: press the hardware **Back** button | Returns to the **Feed**, and does **not** exit the app | ☐ |
| P-v-2 | On the Feed root, press Back again (Android) | Ordinary behaviour — this must be **unchanged**; it is not the Leaderboard's business | ☐ |
| P-v-3 | Open the Leaderboard, then tap the **Feed tab** you are already on | Returns to the Feed. Both platforms | ☐ |
| P-v-4 | From the Leaderboard, switch to **Collection**, then back to **Feed** | Still on the Leaderboard — arriving from another tab is not the same as pressing the tab you are on | ☐ |
| P-v-5 | Leave the board by either route, then reopen it | The **timeframe you chose is remembered**; the mode is not | ☐ |

### Q. Goals, leaderboard timeframes, and what another viewer may see

| | |
|---|---|
| **Actions** | Complete a watch goal. Open the **Leaderboard** and switch timeframes and metric. Then open A's profile **from B's device**, and again after A sets the account to **private**. With A private and B **not** an approved follower, look for **A's row on B's leaderboard** and tap it |
| **Expected** | Completing the goal announces **once** — it cannot be announced twice and it cannot be missed by a batch update. The leaderboard's default metric is **titles**; every timeframe returns a board rather than an error or a blank. From B's device, an award A has withheld or that B is not entitled to see shows as **withheld** — **never as somebody else's award, and never as an error**. **A's private row IS on B's board**, with a rank, a name, a handle, an avatar, a small lock and the metric count — and **no Match, no shared count, nothing else**. Tapping it opens the **locked profile shell** with the Follow request, exactly as it always did |
| **Evidence** | 📷 the leaderboard at two timeframes, and A's profile as seen by B |
| PASS / FAIL | ☐ |
| Notes | |

---

## Part 5 — iOS only (about 3 minutes)

### R-i. Sign in with Apple, and the account Apple picks

| | |
|---|---|
| **Actions** | Sign out (*Use a different account*), then **Sign in with Apple** |
| **Expected** | The sheet appears and completes. **If Apple offers a Google address, that is Apple's account picker and not a bug** — it is which Apple ID is signed into the device. Confirm against the backend which identity was actually created before treating it as a fault |
| PASS / FAIL | ☐ |
| Notes | |

### R-i-b. A conversation opened from a notification reads as one surface

| | |
|---|---|
| **Actions** | Have **B** comment on one of **A**'s activities. On A's device, open the notification. Then reach the same conversation by tapping the activity in the Feed. Look at the seam between the post and the comments, on an activity with comments and on one with none |
| **Expected** | **One rule** between the post and the conversation, and **no band of empty page** — the founder's "small bar" was two hairlines with a gap trapped between them. Both routes look identical, because both draw the same screen. The first comment sits the same distance below the rule as later ones sit below each other |
| **Evidence** | 📷 the seam, from the notification route |
| PASS / FAIL | ☐ |
| Notes | |

### R-ii. A push notification on the lock screen, and a link from Messages

| | |
|---|---|
| **Actions** | With the app **backgrounded**, have B do something that notifies A. Then send yourself a `https://bingd.app/u/<handle>` link in Messages and tap it |
| **Expected** | The notification arrives on the lock screen — not only in the in-app inbox. Tapping it opens the right screen. The Messages link opens the **app**, on that profile, not Safari |
| **Evidence** | 📷 the lock screen |
| PASS / FAIL | ☐ |
| Notes | |

> **This is the beta's APNs path, and it is not the production one.** A pass here does not
> discharge check 7 of the runbook's TestFlight table, which is the only thing that proves
> the production entitlement.

---

## Part 6 — Android only (about 3 minutes)

### S-i. Back on the Leaderboard returns to the Feed

| | |
|---|---|
| **Actions** | Feed tab → open the **Leaderboard** → press the system **Back** button |
| **Expected** | You return to the **Feed**. The app does **not** exit. Press Back again from the Feed and the ordinary tab behaviour applies |
| PASS / FAIL | ☐ |
| Notes | |

### S-ii. The keyboard, the note, and the row that used to jump

| | |
|---|---|
| **Actions** | Type a long note with the keyboard up. Watch everything below the text field. Then open the filter sheet and scroll it with the keyboard dismissed |
| **Expected** | Nothing shifts by a couple of millimetres and back. The sheet's footer is reachable and not clipped. Deep links (`/u/`, `/title/`, `/lists/`, `/i/`) open the app; `bingd.app/privacy` and `/support` open the **browser**, not `+not-found` |
| **Evidence** | 📹 the typing |
| PASS / FAIL | ☐ |
| Notes | |

---

## Part 7 — The one destructive check, last (about 2 minutes)

### T. Delete an account, for good

Do this **on account C**, never on A or B, and only after everything above is recorded.

| | |
|---|---|
| **Actions** | As **C**: Settings → **Account & Data** → type C's own handle → **Delete for good** |
| **Expected** | A yes/no dialog is **not** what confirms it — typing the handle is. It completes, signs out, and does not strand a half-signed-in screen. If any avatar bytes could not be removed the app **says so** rather than claiming otherwise. A's invitation credit for C survives with no pointer to C |
| **Evidence** | 📷 the confirmation screen |
| PASS / FAIL | ☐ |
| Notes | |

---

## After the run

- [ ] Every 📷 saved somewhere that is **not** this repository
- [ ] Every FAIL written up with the platform, the build number and the update id from
      Settings → bottom
- [ ] Any FAIL triaged against [`safe-update-runbook.md`](./safe-update-runbook.md) §1 —
      **is it native?** — before anything is published
- [ ] Result recorded against the tranche, and `docs/product/device-acceptance.md` extended
      if a new class of check emerged

**A clean run here does not authorise a production build.** It closes the product side. The
release side starts at
[`production-bootstrap-runbook.md`](./production-bootstrap-runbook.md) §1.
