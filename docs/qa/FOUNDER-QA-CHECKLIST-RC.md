# Founder QA checklist: release candidate (#263 + #265)

**One sitting, with an Android phone and an iPhone side by side.** Build: the internal Preview from `STAGING-OPS-RC.md` step 5, on the staging backend. Every section of #263's QA list is kept (sections 1–7). Section 8 is new: TV Rankings from #265.

**Tags**
- `[ops 1]`, `[ops 3]`, `[ops 4a]`, `[ops 4b]`: needs that step of `STAGING-OPS-RC.md` done first.
- `[build]`: needs the new Preview build (every item does; it is listed where it matters).
- `[web, after merge]`: cannot be checked in this sitting.
- `[A]` / `[i]`: Android only / iPhone only. Untagged means both.

**Accounts** (`docs/release/staging-qa-inventory.md`):
- **Reader:** `whatever`.
- **Friend:** `bingdsocial2`. The two follow each other, so each sees the other's Feed.
- **Imports:** `bingdtest2`.
- Sign the reader in on both phones, and the friend on whichever phone checks the Feed from the other side.

**Before starting**
- Both phones have the new build installed. Settings → About shows Preview and staging.
- **Android:** the narrowest phone available. Settings → Display → Display size **largest** and Font size **largest**, needed for 8.4. Leave them at default for everything else.
- **iPhone:** Settings → Accessibility → Larger Text, the largest size, also for 8.4.
- Flags: nothing is turned on for this sitting. No proactive notification is expected anywhere.

---

## 1. For You: the dropdown stays open `[build]`
1. Switch Movies ↔ TV, or Recommended ↔ Top Rated. Open **Recommended ▾** at once, before the wall loads.
   - **Expected:** the menu stays open when the wall lands.
2. Cold-start the app, go straight to **Sent to You**, and open the menu while the list loads.
   - **Expected:** the menu stays open.
3. Pull to refresh on a failed or empty wall (airplane mode, then back).
   - **Expected:** a pull on a failed wall retries.

## 2. Collection: the dropdown stays open `[build]`
1. Switch Watched → Watchlist, or Movies ↔ TV, and open the marquee before the list lands.
   - **Expected:** it stays open.
2. A failed or empty section is centred vertically. Filters & Sort appear once there are titles.

## 3. Android only: the marquee with nothing loading `[A]`
1. With nothing loading, open the Collection or For You marquee and wait 5 s without touching it.
   - **Expected:** it stays open.
   - **If it closes on its own,** record it: that proves the window-size hypothesis in #263 §8, and the rule should then compare width only.

## 4. Reactions (#249) `[ops 3]`
1. On your own post and your own comment there is no heart and no long-press picker. Other people's reactions still open the reactor list.
2. As the friend, react to the reader's post. The reader sees it and gets the reactive notification.
3. **Expected on staging:** all 5 existing reaction rows are self-reactions, so **every staging reaction count drops to zero.** That is correct.
4. An old build tapping its own heart gets the server's refusal in its existing alert. Optional; needs an older Preview.

## 5. Title page ⋯: Edit ranking `[build]`
1. Open a ranked movie and tap ⋯.
   - **Expected:** it reads **Edit ranking** beside Log another watch. **Log rewatch** is still the main action on the page.
2. Edit ranking → choose a band that moves the film.
   - **Expected:** no Feed activity, as before. **Log rewatch** on a film still posts one activity.

## 6. Import (#261) `[ops 1]` `[ops 3]` `[ops 4a]`
Use `bingdtest2`. The IMDb steps use the founder's own IMDb export; it is never committed.
1. **An IMDb file that holds movies and shows.**
   - **Expected (preview):** **Movies** and **TV shows, not added**, with the note under them.
   - **Expected (pushes):** "IMDb import started", then "Your IMDb history is ready".
2. **A re-import that adds nothing.**
   - **Expected:** the push reads "Nothing new to add. Open bingd to see the summary.", and the summary says "already here".
3. **A file where nothing matches.**
   - **Expected:** the summary says "Nothing was added", then its unmatched / TV / unsupported lines.
4. **A Letterboxd import** still says Letterboxd, end to end.
5. **PostHog:** `provider` is on every import event, and `films` / `tv_shows` are on `import_started`.
6. TV shows in an IMDb file: see **8.13** for the TV-specific checks.

## 7. Web `[web, after merge]`
- After merge only: the store buttons read "Get bingd on Google Play / the App Store / for iPhone / for Android". **Not in this sitting.**

## 8. TV Rankings (#265) `[ops 3]` `[build]`
Use a long show the reader has not ranked; Shameless is the example. Do 8.1 to 8.12 (and 8.14) in order on one phone, then repeat 8.4 and 8.9 on the other.

### 8.1 Rank a show
1. Search "Shameless" and tap **`+`** on the show row.
   - **Expected:** the show's own bands (Loved it / Liked it / …), **not a season picker.**
2. Rank it: "I liked it", then answer the comparisons.
   - **Expected:** the reveal reads `#N in TV shows`.
3. Feed (the friend's phone too):
   - **Expected:** one "ranked Shameless" activity.
4. Search again.
   - **Expected:** the show row now shows its score circle instead of `+`.

### 8.2 Rank a season
1. Open the show page. Seasons are listed under the show content, each with a Maroon **`+`**, a bookmark and, once ranked, a score circle.
2. Tap **`+`** on S4 and rank it as a first log.
   - **Expected:** the reveal reads `#N in TV seasons`.
3. Expected on the reveal: **[Add details] [Update Show]**, with **Done** as a quiet text button centred underneath.
4. Tap **Done**.
   - **Expected:** the flow ends. Feed shows **one S4 activity** and no show activity.
5. Back on the show page, S4's row shows its score circle in place of `+`, and the bookmark still toggles the Watchlist.

### 8.3 Show and season pools are independent
1. Note the show's score and its `#N in TV shows`.
2. Rank S5 in a very different band from the show.
   - **Expected:** the show's score and place are unchanged. S5's comparisons are only against **seasons**, never the show or a film.
3. Collection → TV → rating sort. Scores from each pool read on their own scale, and equal scores keep a stable order across reloads.

### 8.4 One row: Rank / Log rewatch · Watchlist · Add to List · Recommend
1. On an **unranked** show: **Rank Show** (filled), then Watchlist, Add to List and Recommend, on one row.
2. On an **unranked** season: **Rank Season**. On an unranked movie: **Rank Movie**.
3. On a **ranked** show or season: **Log rewatch** in the compact outline, then the same three icons, on one row. **Edit ranking** is in ⋯.
4. **[A] Largest text at the narrowest width,** and **[i] Larger Text at its largest:**
   - **Expected:** the word stays on one line and shrinks rather than being cut. All three icons stay on the same row, and each is tappable (about 44 pt).
   - Photograph it if anything wraps, clips or overlaps.

### 8.5 Season rows: `+` and the score circle
1. On the show page, tap **`+`** on an unranked season.
   - **Expected:** ranking starts directly for that season. If a placement was left unfinished, it resumes.
2. Tap the row itself, not the `+`.
   - **Expected:** the season page opens, with **Rank Season** or **Log rewatch**, and its episodes listed.

### 8.6 Search `+` ranks the show
1. On a different series, tap `+` in Search.
   - **Expected:** the show-level ranking, with no season picker anywhere on that path.

### 8.7 Collection: Candidate A precedence and pills
1. Collection → TV (Watched).
   - **Expected:** Shameless shows **S4** and **S5** posters, each with a pill such as `S4 9.1` (Parchment, Maroon border), and **no Shameless show poster**.
2. A show ranked with no ranked seasons shows **its poster** with the filled Maroon number.
3. A show with 10+ seasons: rank S10.
   - **Expected:** the pill reads `S10 …` on one line.
4. A ranked Specials season reads **`SP …`**.
5. **The rule:**
   - show only → the show;
   - S1 → S1;
   - S1 + S2 → both;
   - show + S1 → S1;
   - show + several seasons → every season and no show poster.

### 8.8 Update Show from a season reveal
1. Rank **S6** from its `+` as a first log, then tap **Update Show**.
   - **Expected:** the show's **band chooser opens first**, with its current band selected. There is no extra card or confirmation.
2. Keep the band, or pick another, and answer the comparisons.
   - **Expected:** the show starts near its old place and can move far either way.
3. Feed (the friend's phone too):
   - **Expected:** **S6's activity only.** There is no show activity, and no "updated their ranking of Shameless".
4. The reveal for the show offers no Update Show.
5. **Abandon:** rank S7 from its `+`, tap Update Show, then close the show's band chooser without choosing.
   - **Expected:** the show's score is unchanged, and Feed has S7's activity only.
6. **Not offered:**
   - an Edit ranking of a season;
   - a season ranked from the backlog sitting;
   - a movie;
   - a show.

### 8.9 A standalone TV update posts only when it moved
1. Show page → ⋯ → **Edit ranking** → choose a band that moves it.
   - **Expected:** one "updated their ranking of Shameless". The first "ranked Shameless" post **keeps its original score**.
2. Repeat, landing in the same place.
   - **Expected:** **no activity.**
3. A season: S4 page → ⋯ → Edit ranking → move it.
   - **Expected:** one "updated their ranking of Shameless, S4".
4. As the friend, react to and comment on the update post.
   - **Expected:** it works like any post. The reader cannot react to their own update post (no heart).

### 8.10 Profile: the "show" marker
1. Profile → Top ranked → TV, and **See all**.
   - **Expected:** the same precedence as Collection. A show row reads `#N` with **show** under it, so the show and season lists never read as one list.
2. The profile TV count = ranked seasons + shows with no ranked season.
3. The same on the reader's public profile, seen from the friend's account.

### 8.11 Recommendations and Taste Match keep shows and seasons separate
1. For You → TV.
   - **Expected:** Shameless (logged and ranked) is not recommended back. Its seasons do not appear as recommendations either.
2. Taste Match with the friend, after the friend ranks the same show:
   - **Expected:** a show match counts once, not once per season.
   - **Expected:** a show is never compared with a season.
3. On a show both accounts ranked, the **bingd** and **Following** scores on the show page count show rankings only. A season's page shows that season's.

### 8.12 Restart mid-ranking
1. Start a first ranking on a new show, kill the app mid-comparison, reopen, and tap **Rank Show**.
   - **Expected:** it resumes the same comparison.

### 8.14 Actor pages list shows (#262 × #265) `[ops 4b]`
1. Open an actor from Shameless's cast (title page → Cast).
2. The **Shameless** row reads **Ranked**, because the reader ranked the show.
3. A show the reader logged as a show but did not rank reads **Watched**.
4. A show the reader only saved reads **On your watchlist**.
5. A show where the reader logged or ranked only seasons claims nothing.
6. Sorting (#262) works on a filmography that mixes films and shows.

### 8.13 IMDb import of a TV show (§5 of the RC brief) `[ops 1]` `[ops 3]` `[ops 4b if the key was missing]`
Use `bingdtest2`, with an IMDb export holding at least one TV Series, one TV Mini Series and one TV Episode.
1. **Preview:**
   - **Expected:** "TV shows, not added" counts the series and mini-series; the episode is under Not supported.
   - **Expected:** the Import button counts movies only.
2. **After the import:**
   - **Expected (summary):** "TV shows matched, not added" counts the shows found.
   - **Expected:** nothing of the show reaches Collection → TV. No show poster and no season.
   - **Expected:** **no show or season ranking**, and no Feed activity for any show.
3. The show is still rankable by hand: Search → `+` ranks it as in 8.1.

---

## Known limitations (not bugs for this sitting)
- **Update Show** is offered only from title-page flows: the season page and a show page's season rows. Lists and Watch History end on the ordinary Add details | Done.
- **TV backlog:** a logged-but-unranked show (an abandoned first show ranking) is not in the TV backlog or its Unranked count. It shows on the Watched grid and resumes from Rank Show.
- **Seasons and films only:** goals, the monthly board, the season and genre awards, and the TV Top Rated wall. The rankings award counts shows.
- **Show reviews:** a show page has no Reviews section yet. A note written on a show's log is saved.
- **IMDb shows are matched and reported, not added** (#261's labelled limitation). Its copy still gives the reason "bingd tracks TV by season", which #265 makes untrue; see the PR's IMDb finding.
- **Watchlist nudges and TV update posts:** gated off, `proactive.generation_enabled` = false. Once generation is on, a TV ranking edit that moved the title would count as "a friend watched it" for watchlist nudges. This is an open finding on #266, and nothing in this sitting can show it.
- **Season-premiere notices** (gated off, `proactive.season_enabled` = false) consider season history only. A reader who ranked only the whole show would not be told about its next season. This is an open finding on #266.
- **Original title layout** (a per-device saved choice) keeps its Ranked pill. The immersive default shows Log rewatch.
- **#263's open items:** the third-party comment self-reaction count, and the For You / Collection toolbar move (visual sign-off).

## Record
For each item note **pass / fail / not checked**, the phone, and a screenshot for anything that fails. Then post the results on #266.
