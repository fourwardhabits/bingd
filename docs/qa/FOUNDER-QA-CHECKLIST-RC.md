# bingd founder QA checklist: release candidate (#263 + #265), Android + iPhone, one sitting

**This is the single authoritative checklist for draft PR #266** (`qa/founder-rc-2026-11-11`). It merges the earlier #263 checklist (head `a039368`, founder copy) with the RC's TV Rankings checks. **Every earlier item is kept.** Items that overlapped are merged into one row, and items the RC changed are marked *(changed)*.

**What is being tested**
- `58c2de7`, which is main + #257 #259 #255 #258 #247.
- Then #254 → #261 → #249 → #241 → #262 (merged by SHA), #260 (cherry-pick), and the #263 fix commits, together `1f3a4ea4`.
- Then #265 TV show and season ranking (`c9b42bf1`), merged `--no-ff`, plus the RC's review fixes and the IMDb copy fix.

**Build:** the internal Preview from `STAGING-OPS-RC.md` step 5.
- Source is the RC's **build-source commit** named there. Every later commit changes `docs/` only.
- It installs as "bingd preview", and Settings should show the staging backend `…rzyr`.
- The old **58c2de7 Preview** is no longer needed for section 8: the old-client self-reaction refusal check is gone (founder decision, 2026-11-11).

## How to record
- Each section is a table with **A** (Android) and **i** (iPhone) columns. Write ✅, ❌ or – (not checked) in each, and anything worth saying under **Notes**.
- Take a screenshot for every ❌, on a real device only.
- Post the filled-in file, or a summary of the ❌ rows, on #266.

## Staging prerequisites
Each item's **Needs** column names the step it depends on. Without it, the item fails or looks wrong.

| Tag | Step in `STAGING-OPS-RC.md` | Needed by |
|---|---|---|
| `S0` | Gate: CI green on the RC head; names-only secrets check | everything |
| `S1` | `letterboxd-import` deployed. **Being run separately by the founder's operator**, from `47eef0c`; its source is identical at the build-source commit. | 7 (imports) |
| `S3` | The 12 migrations applied (the 11 plus `20261115000100`, which lets you react to your own posts and comments) | 2, 3, 7, 8, 9, 10.7, 11, 12 |
| `S4a` | `push-sender` deployed | 7 (pushes), 8.3, 8.5, 9 |
| `S4b` | `tmdb-adapter` deployed | 10.6 (full actor sorting) |
| `S4c` | TMDB key set, **only if S0 found it missing** | 7.8 (matching) |
| `S5` | The new internal Preview installed on both phones | everything |

**Flags stay off for the whole sitting.** No `proactive.*` switch, `push.delivery_enabled` change or `release.push_enabled` change. Section 9 checks that proactive behaviour is absent.

## Test accounts and files
Accounts are listed in `docs/release/staging-qa-inventory.md`. Handles only; credentials are never written here.
- **Reader:** `whatever`.
- **Friend:** `bingdsocial2`. The two follow each other.
- **Imports:** `bingdtest2`, or `whatever`.
- **Ranked TV seasons already present:** `qa_tv_fan_g2`.

Files, kept on the phone and never uploaded anywhere else:
- your own **IMDb ratings CSV**, holding at least one TV Series, one TV Mini Series and one TV Episode;
- your own **Letterboxd ZIP**;
- an IMDb **watchlist** CSV, for the refusal check.

Before starting:
- **Android:** use the narrowest phone available. Section 13 needs Settings → Display → Display size **largest** and Font size **largest**; keep both at default until then.
- **iPhone:** section 13 needs Settings → Accessibility → Larger Text at the largest size.

---

## 1. Installation, sign-in, staging backend, native permission text
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 1.1 | Install the new Preview. Open it and sign in as `whatever`. | It opens and signs in. Settings shows backend `…rzyr` and the new build's version. | S5 | | | |
| 1.2 | Profile → change photo. | **i:** the iOS permission prompt reads **"bingd uses your photos so you can choose a profile picture."** (lowercase; this native string is why a new build is needed). **A:** the picker opens. | S5 | | | |

## 2. Title pages: Rank Movie / Show / Season, Log rewatch, Edit ranking
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 2.1 | Open an **unranked** movie, an unranked whole **show** and an unranked **season**. | The filled primary reads **Rank Movie**, **Rank Show** and **Rank Season**. Watchlist, Add to List and Recommend sit beside it, all on **one row**. *(changed: a show used to have no rank control)* | S3 | | | |
| 2.2 | Start a ranking on an unranked title, kill the app halfway, reopen and tap Rank again. | The half-finished ranking resumes at the same comparison. Covers movie, show and season. | S3 | | | |
| 2.3 | Open a **ranked** movie. | The primary button is **Log rewatch** (repeat icon). There is no Rank button and no second prominent Edit ranking. | | | | |
| 2.4 | Tap Log rewatch, then close the sheet. | "Log another watch" opened at once. After closing, the watch count, history and Feed are unchanged. | | | | |
| 2.5 | Log rewatch → band → finish the comparisons. Separately, start one and close mid-comparison. | Finished: Watch History gains one viewing and Feed gets exactly one activity. Closed: the old score is kept. | | | | |
| 2.6 | ⋯ menu on a ranked movie. | The Ranking group row reads **Edit ranking**; "Update your rating" appears nowhere. It changes the score without adding a watch or a Feed post. | | | | |
| 2.7 | Repeat 2.3–2.6 on a ranked **season** and a ranked whole **show**. | The same, with one difference: an Edit ranking on a show or season that **moves** it posts one "updated their ranking of …" (see 12.2). Landing in the same place posts nothing. *(changed)* | S3 | | | |
| 2.8 | On a ranked show and a ranked season. | The row reads **Log rewatch** · Watchlist · Add to List · Recommend, on one row. Edit ranking is in ⋯. | S3 | | | |

## 3. Watch History: editing, dates, companions, removal, rewatch
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 3.1 | Open a title watched 2+ times → Watch history. | Back arrow, wordmark, divider, no blank band. It reads "Watched N times / First … · Latest …". | | | | |
| 3.2 | Look at the rows. | Newest first, "(First watch)" on the earliest, Edit under the date, and frozen per-watch scores. | | | | |
| 3.3 | Edit a row: companions, date, a long note, then Save. | The keyboard does not hide the note, and the edits are saved. | | | | |
| 3.4 | **Edit ranking** in the expanded editor. Cancel once, then finish once. | It is the same flow as ⋯ → Edit ranking. Cancel changes nothing; finishing moves only the current ranking. | | | | |
| 3.5 | Remove one watch. Then remove the last watch. | One watch removed. For the last one: "Remove from collection", then back to the title page. | | | | |
| 3.6 | Log rewatch on a ranked whole **show**, then open its Watch history. | It behaves exactly like a film's history. Update Show is **not** offered from Watch History. | S3 | | | |

## 4. Collection: Runtime sorting, Shuffle, My Lists, dropdown behaviour
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 4.1 | Movies → Watched → Filters & Sort → Runtime. Then switch Grid ↔ List, and add a genre filter. | ↑ shortest first, ↓ longest first, runtime-less titles last. Grid ↔ List keeps the order, and a genre filter keeps the runtime order. | | | | |
| 4.2 | TV → Watched / Unranked, then TV → Watchlist. | Watched / Unranked: no Runtime option (it falls back to Rating). Watchlist: series ordered by episode length. | | | | |
| 4.3 | Shuffle, several times. Then scroll, refetch, switch Grid / List, switch segments and background the app. | The sheet closes and each tap gives a new order. The order is stable across scroll, refetch, Grid / List, segment switch and background. | | | | |
| 4.4 | Profile → Manage / Collection → My lists, then + New list. | No blank band above MY LISTS, and + New list works (#259). | | | | |
| 4.5 | Tap the Watched ▾ marquee, choose Watchlist (or switch Movies ↔ TV), then **immediately** reopen the marquee while the list loads. 5× on each phone, and once on a poor network. | The menu stays open until you choose or tap outside. | | | | |
| 4.6 | **Visual sign-off:** watch a section that is loading, empty and failed (use airplane mode). | The skeleton, empty and error states sit **under the toolbar inside the list**, centred in about the middle of the screen. Filters & Sort appear once there are titles. Say if this looks wrong. | | | | |

## 5. For You, Sent to You, dropdown stability
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 5.1 | Switch Movies ↔ TV or Recommended ↔ Top Rated, then **immediately** open Recommended ▾ while the skeleton shows. 5× on each phone, and once on a slow network. | The menu stays open when the wall lands. | | | | |
| 5.2 | Cold start → Sent to You. Open the menu before the list lands. | It stays open. | | | | |
| 5.3 | **Visual sign-off:** loading, empty and error states (use airplane mode). Then pull to refresh on a failed wall. | The states sit under the toolbar in the same scroller. A pull on a failed wall retries it. | | | | |
| 5.4 | Switch Recommended ↔ Top Rated. | It switches, and the Movies/TV switch keeps its value. | | | | |
| 5.5 | **A only:** with nothing loading, open the dropdown from a cold start, then again on a scrolled wall. Wait 5 s each time. | It stays open. **Note any instant close:** that would confirm the unproven window-size cause, which was deliberately **not** changed (it is pinned by a unit test). | | | – | |

## 6. Discover People: names, usernames, Follow
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 6.1 | Feed → People. | DISCOVER PEOPLE heading (uppercase maroon, LEADERBOARD size). It fits beside the toggle on a small phone. | | | | |
| 6.2 | Scroll the list; Follow someone, then Requested. | Name and @username always visible, long names truncate, and Follow / Requested work. | | | | |

## 7. IMDb and Letterboxd imports, duplicate prevention, notifications
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 7.1 | Settings → **Import from** (both marks) → "Bring your watch history". | Only Letterboxd and IMDb are offered. | S1 S3 | | | |
| 7.2 | IMDb → instructions → pick your ratings CSV (with shows and an episode). | **Preview** shows Movies / **TV shows, not added** / Ratings / Not supported, plus the episode note.<br>The TV note reads: "We’ll look for the N shows you rated and count the ones we find in your summary. **bingd lets you rank entire TV shows or individual seasons. TV shows from IMDb imports aren’t added yet.**" *(changed copy)*<br>No copy says "tracks TV by season". No copy says IMDb ratings become bingd scores. The button counts movies only. | S1 S3 | | | |
| 7.3 | Import, then leave the app. | Push **"IMDb import started"**, then **"Your IMDb history is ready"**, with body "N movies added as watched. Ready to rank." | S1 S3 S4a | | | |
| 7.4 | Open the summary. | Heading "Your IMDb history is in". "TV shows matched, not added" sits on its own line.<br>The line under it reads: "N TV shows were matched but not added. **bingd lets you rank entire TV shows or individual seasons. TV shows from IMDb imports aren’t added yet.**" *(changed copy)*<br>Episodes: "N TV episodes weren’t added…". | S1 S3 | | | |
| 7.5 | **Whole-show behaviour:** check Collection → TV, Profile, Feed and Search for the shows in that file. | **No show and no season was added.** There is no show or season ranking and no Feed activity for any show. Movies are in Collection ▸ Unranked with no score, and there are no Feed posts for the import. The show is still rankable by hand: Search → `+` → Rank Show (11.1). | S1 S3 | | | |
| 7.6 | **Re-import the same file.** | Push body **"Nothing new to add. Open bingd to see the summary."** (never "now in bingd"). Summary heading **"Your IMDb history is already here"**. **No duplicates** in Collection. | S1 S3 S4a | | | |
| 7.7 | *(Optional)* A file where nothing matches, or an account where every row is unsupported. | Summary heading **"Nothing was added"**, followed by the unmatched / TV / unsupported lines. | S1 S3 | | | |
| 7.8 | **Matching quality.** | Most movies match. If most are **unmatched**, the staging TMDB key is missing: run `STAGING-OPS-RC.md` step 4c. | S1 S3 (S4c) | | | |
| 7.9 | Pick a Letterboxd ZIP on the IMDb page, then an IMDb **watchlist** CSV. | Both are refused clearly. | S1 S3 | | | |
| 7.10 | Notification inbox. | Import rows show the title only, with no misleading body. | S4a | | | |
| 7.11 | **Letterboxd:** ZIP → preview → import → summary. | Pushes still say **Letterboxd**. A watchlist-only result reads "N films added to your Watchlist." | S1 S3 S4a | | | |
| 7.12 | **Duplicate prevention:** import Letterboxd and IMDb files with overlapping films, on an account where one of them is already ranked. | No duplicates, and the pre-ranked film keeps its score and position. | S1 S3 | | | |
| 7.13 | Onboarding after *Your First Five*: "Already tracking movies somewhere else?" Then kill and relaunch mid-import. | Letterboxd / IMDb / Not now are offered. After the relaunch it lands correctly. | S1 S3 | | | |
| 7.14 | *(Note only, not on device)* PostHog analytics. | Covered by tests: `provider` is on every import event (it used to be stripped); `import_started.films` counts movies only, plus `tv_shows`; Settings counts `import_opened` when a service is picked, so that number drops from today. | | – | – | |

## 8. Reactions: self-reactions allowed, reaction summaries
**Founder decision (2026-11-11):** you can react to your own posts and comments. This reverses #249's restriction (`20261115000100`). The reaction summary, the picker, the heart and emoji sizing and the responsive layout from #249 are unchanged.

| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 8.1 | Look at your **own** post (Feed, the Activity page from a notification, Profile) and your own comment. | The heart / Like is there, and a long press opens the picker, exactly as on a friend's post. Others' reactions and the summary line still show and open the reactor list. | S3 | | | |
| 8.2 | React to your **own** post and your own comment, then change and remove the reaction. | Each saves with **no alert**. The count goes up by one and the summary includes you ("You reacted", "You and Alex like this"). Change and remove work. **You get no notification** for your own reaction. | S3 | | | |
| 8.3 | As the friend, react to the reader's post and comment, then change and remove the reaction. | React, change and remove all work, and the author gets one notification. | S3 S4a | | | |
| 8.4 | Check staging's existing reactions. | Historical self-reactions **count normally** again: in counts, names, glyphs and the reactor list. Staging's 5 existing reactions are all self-reactions, so they are back in their posts' counts. Nothing was deleted. | S3 | | | |
| 8.5 | As the friend, react to and comment on a **TV update post** (made in 12.2); then, as the reader, react to it too. | It works like any post, for both. | S3 S4a | | | |
| 8.6 | *(Covered by tests; hard to trigger on a device)* A server that still refuses self-reactions (`20261110000100` without `20261115000100`). | The new client says **"You can’t react to your own post."** / "…comment." and the screen re-reads. Once S3 is complete this never happens. | | – | – | |

## 9. Notification settings, reactive pushes, proactive behaviour disabled
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 9.1 | Settings → Notifications. | At most 10 controls (9 switches + 1 button). | S3 | | | |
| 9.2 | Look at an account that never touched Reactions. | **Reactions is off** by default; explicit earlier choices are kept. | S3 | | | |
| 9.3 | Toggle Watchlist & discovery off, then on. Kill the app and reopen. | The value stuck. | S3 | | | |
| 9.4 | `whatever` follows `bingdsocial2`. | The reactive push arrives. | S3 S4a | | | |
| 9.5 | Complete a watch goal. | The new `goal_completed` push copy arrives. | S3 S4a | | | |
| 9.6 | **Proactive stays off:** rank a title that a mutual has on their Watchlist. Also Edit ranking a **show** a mutual has saved, so that it moves. | **No** proactive inbox row and **no** proactive push, for either. | S3 S4a | | | |

## 10. Actor pages: filmography sorting, biography, loading, navigation
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 10.1 | Open Brad Pitt from a cast strip; scroll; use every back gesture. | Parchment band, with the portrait overlapping it. The compact name appears only after the large name scrolls away. All back gestures work. | | | | |
| 10.2 | Biography `… more`, open and close. | It opens and closes. "Shortened. The full biography is on TMDB." shows only when fully open and the text was cut. | | | | |
| 10.3 | FILMOGRAPHY sort chip: go through each sort. | Popular (default) → Release date ↓ newest / ↑ oldest (undated last) → Highest rated (TMDB), with thinly voted titles last. **No TMDB score is displayed.** | S4b | | | |
| 10.4 | Switch Cast / Crew and All / TV / Movies. Then See more, and save a bookmark. | The sort is kept, and the list resets to 12. See more works, and bookmarks fill Maroon. | | | | |
| 10.5 | Bryan Cranston (TV), Christopher Nolan (Crew), and a newcomer. Then 200% text, and airplane mode on a never-opened person. | Each page loads correctly online, and 200% text stays readable. Offline, a person never opened before shows a loading or error state, never a blank page. Note what you see. | | | | |
| 10.6 | Sorting with and without `tmdb-adapter`. | Without S4b: a "sorted within the N kept" caveat appears, as expected. With S4b and a refresh: no caveat for most people. A long career may show "From here on, not every one of their older credits is listed." | S4b | | | |
| 10.7 | **Shows on actor pages (RC fix):** open an actor from Shameless's cast after 11.1. | The **Shameless** row reads **Ranked**. A show logged as a show but unranked reads **Watched**. A show only saved reads **On your watchlist**. A show where only seasons were logged or ranked claims nothing. | S3 | | | |
| 10.8 | **Visual sign-off:** the whole actor page on both phones. | Say whether it looks right. | | | | |

Known limitations:
- Popular rank has gaps after row 60.
- Series sort by first air date.
- Self-appearances get no edge slots.

**#262 decisions for you** (from the PR), each still open:
1. Deploy `tmdb-adapter`: staging step 4b now, production later.
2. Accept up to about 31 extra catalogue rows per very prolific person.
3. "Highest rated (TMDB)": thresholds of 100 votes per film and 50 per series, Bayesian priors of 6.5 for films and 7.0 for TV, and whether film and TV mix under All.
4. Newest / Oldest as one "Release date" axis with an arrow.
5. Complete sorting would need storing every credit. That is a retention change and has not been done.

## 11. Whole-show and season rankings, Update Show, independent pools, Candidate A, S1/SP pills
Use a long show the reader has not ranked; Shameless is the example. Do 11.1–11.9 in order on one phone, then repeat 11.1, 11.5 and 11.7 on the other.

| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 11.1 | Search "Shameless" → tap **`+`** on the show row → "I liked it" → answer the comparisons. | `+` opens the show's own bands, **not a season picker**. The reveal reads `#N in TV shows`. Searched again, the row shows its score circle instead of `+`. | S3 | | | |
| 11.2 | Open the show page. | Seasons are listed under the show content. Each has a Maroon **`+`** and a bookmark, plus a score circle once ranked. Tapping a row (not the `+`) opens the season page with Rank Season / Log rewatch and its episodes. | S3 | | | |
| 11.3 | Tap **`+`** on S4 and rank it as a first log. On the reveal tap **Done**. | The reveal reads `#N in TV seasons` and shows **[Add details] [Update Show]**, with **Done** as a quiet text button centred underneath. After Done: Feed has **one S4 activity** and no show activity. S4's row shows its score circle, and its bookmark still toggles the Watchlist. | S3 | | | |
| 11.4 | **Independent pools:** note the show's score and place, then rank S5 in a very different band. | The show's score and place are unchanged. S5 is compared only with **seasons**, never with the show or a film. | S3 | | | |
| 11.5 | **Update Show:** rank **S6** from its `+` as a first log → tap **Update Show** → keep the band (or pick another) → answer the comparisons. | The show's **band chooser opens first**, with its current band selected. There is no extra card or confirmation. The show starts near its old place and can move far either way. Feed, on both phones: **S6's activity only**, with no show activity and no "updated their ranking of Shameless". The reveal for the show offers no Update Show. | S3 | | | |
| 11.6 | **Abandon:** rank S7 from its `+` → Update Show → close the show's band chooser without choosing. | The show's score is unchanged, and Feed has S7's activity only. | S3 | | | |
| 11.7 | **Not offered:** an Edit ranking of a season; a season ranked from the backlog sitting; a movie; a show; a season ranked from a custom list or from Watch History. | None of these offers Update Show; each ends on the ordinary Add details \| Done. | S3 | | | |
| 11.8 | **Collection → TV (Watched): Candidate A.** | Shameless shows **S4, S5, S6 (and S7)** posters, each with a pill such as `S4 9.1` (Parchment, Maroon border), and **no Shameless show poster**. A show ranked with no ranked season shows **its poster** with the filled Maroon number. | S3 | | | |
| 11.9 | **Pills:** rank S10 of a show with 10+ seasons, and a Specials season. | `S10 …` on one line, and **`SP …`** for Specials. | S3 | | | |
| 11.10 | **The precedence rule** (check whichever cases your data allows). | Show only → the show. S1 → S1. S1 + S2 → both. Show + S1 → S1. Show + several seasons → every season, and no show poster. | S3 | | | |
| 11.11 | Collection → TV → Rating sort. Reload twice. | Each pool's scores read on their own scale, and equal scores keep a stable order across reloads. | S3 | | | |

## 12. Feed, profile, Taste Match and recommendations, as TV Rankings affects them
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 12.1 | Feed after 11.1 and 11.3, seen from the friend's phone too. | One "ranked Shameless" and one S4 activity. A show renders like a film, with Recommend / Share. | S3 | | | |
| 12.2 | **Standalone TV update:** show page ⋯ → **Edit ranking** → pick a band that moves it. Repeat, landing in the same place. Then S4 page ⋯ → Edit ranking → move it. | The moving edit posts one "updated their ranking of Shameless", and the first "ranked Shameless" post **keeps its original score**. The same-place edit posts **nothing**. The S4 edit posts one "updated their ranking of Shameless, S4". | S3 | | | |
| 12.3 | **Movie unchanged:** ⋯ → Edit ranking on a film, moving it. Then Log rewatch on a film. | The edit posts no Feed activity, as before. Log rewatch posts exactly one. | S3 | | | |
| 12.4 | **Profile:** Top ranked → TV, and **See all**. | The same precedence as Collection. A whole show's row reads `#N` with **show** under it, so the show and season lists never read as one list. | S3 | | | |
| 12.5 | Look at the profile TV count. | Ranked seasons + shows with no ranked season. | S3 | | | |
| 12.6 | The reader's public profile, seen from the friend's account. | The same as 12.4–12.5. | S3 | | | |
| 12.7 | **For You → TV.** | Shameless (logged and ranked) is not recommended back, and neither are its seasons. | S3 | | | |
| 12.8 | **Taste Match** with the friend, after the friend ranks the same show and some of its seasons. | One series counts once, not once per season. A show is never compared with a season. | S3 | | | |
| 12.9 | **Scores** on a show both accounts ranked. | bingd / Following on the show page count **show rankings only**. A season's page shows that season's. | S3 | | | |
| 12.10 | **Recommend** a whole show to the friend from its page. | It sends, and the friend's Sent to You row names the show. | S3 | | | |

## 13. Branding, accessibility, narrowest Android width at largest text, small screens, states
| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 13.1 | Title score label, sign-in, invite copy, and the new TV strings (reveal, Update Show, pills, import notes). | The word reads **bingd** with no period. The logo / wordmark still shows `bingd.` | | | | |
| 13.2 | **A:** largest Display size + largest Font size, on the narrowest phone. **i:** Larger Text at its largest. Open an unranked movie (Rank Movie), an unranked show (Rank Show), an unranked season (Rank Season), and a ranked one (Log rewatch). This also covers the earlier "Log rewatch on one line" check. | The label stays on **one line** and shrinks rather than being cut. All three icons stay on the **same row**, and each is tappable (about 44 pt). Photograph anything that wraps, clips or overlaps. | S3 | | | |
| 13.3 | At the same text size: the season reveal (`[Add details] [Update Show]` + Done), Collection pills (`S10 …`), and the profile "show" marker. | Nothing clipped or overlapping, and the pill stays on one line. | S3 | | | |
| 13.4 | Smallest phone at default text: Feed → People heading, the For You toolbar and the Collection toolbar. | They fit, with no truncated controls. | | | | |
| 13.5 | **Loading / empty / error:** use airplane mode on Collection, For You, Sent to You, an actor page, a show page and the import screen. | No blank screen and no crash. Note any error state that offers no way to retry. The For You and Collection states sit under the toolbar (4.6, 5.3). | | | | |

## 14. Website and store verification (separate from the app; post-merge)
**Not part of the device sitting.** bingd.app changes only when the RC's components merge to `main`. Nothing here ships in the build.

| # | Step | Expected | Needs | A | i | Notes |
|---|---|---|---|---|---|---|
| 14.1 | *(Optional now)* Open the Cloudflare branch preview https://qa-founder-rc-2026-11-11.bingd.pages.dev. | The store buttons read "Get bingd on Google Play / on the App Store / for iPhone / for Android". "Open in bingd." and page titles are unchanged. | | | | |
| 14.2 | **After merge only:** the same check on bingd.app. | The same. | merge | | | |
| 14.3 | **After merge only:** the store listings. | No change in this RC; store-listing updates are out of scope. | merge | | | |

---

## Known limitations for this sitting
- Applying the staging ops changes what the installed 58c2de7 Preview sees: the Reactions default turns off. Self-reactions work there as they always did.
- The invite push needs `push-sender` (S4a). The sign-in email subject needs `check-auth-config --apply`, which is not planned.
- Proactive notifications are not tested with flags on; that needs separate approvals.
- **Update Show** is offered only from title-page flows: the season page and a show page's season rows.
- A logged-but-unranked show (an abandoned first show ranking) is not in the TV backlog or its Unranked count. It shows on the Watched grid and resumes from Rank Show.
- Goals, the monthly board, the season and genre awards, and the TV Top Rated wall stay on seasons and films. The rankings award counts shows.
- A show page has no Reviews section yet (#265 limitation). A note written on a show's log is saved.
- The original title layout, a per-device saved choice, keeps its Ranked pill. The immersive default shows Log rewatch.
- The For You / Collection toolbar move needs your visual sign-off (4.6, 5.3).

## Tracked pre-production issues (1 resolved, the rest not)
1. ~~**A historical self-reaction on another person's comment** may give an inconsistent count for other readers.~~ **Resolved by the founder's decision of 2026-11-11** (`20261115000100`): self-reactions are allowed and count normally everywhere, so the count and the reactor list agree again. No `activity_comments` migration is needed.
2. **TV ranking-update posts must not become false watch signals** before proactive notifications are enabled. Today the watchlist-social trigger and resurfacing count any `title_ranked`, including `"update": true`. This must be fixed or decided before `proactive.generation_enabled` is turned on.
3. **Season-premiere eligibility for show-only rankers** is deferred while `proactive.season_enabled` is off: a reader who ranked only the whole show would not be told about its next season.
4. **Actor-page decisions and visual sign-off** happen in this sitting (section 10).
5. **IMDb whole-show imports are unsupported this release.** Shows are matched and reported, not added. The switch is `_import_imdb_destination_supported`.

**Out of this RC:** Rec V2, Onboarding 2.0, broader Visual 2.0, store-listing updates, new marketing.
