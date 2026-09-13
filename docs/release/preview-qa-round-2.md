# Preview QA, round 2: Letterboxd, memory aids, and the physical-QA fixes

**Lane:** preview. **Backend:** staging `fjxhcbowoxuzulwirzyr`. **Never production.**

Integration `integration/preview-qa-r2` = main `da23d15` + staging separation + comparison
memory aids + Letterboxd + three fixes off main (score confirmation, invite label, Dismiss).
EAS `fingerprint:compare` matches the installed preview builds exactly (iOS `aa3056e7…`,
Android `8e8731a2…`), so this is an OTA, not a binary.

**Order matters when shipping it.** Deploy `letterboxd-import`, `tmdb-adapter` and
`push-sender` to staging, then push migrations `20260917001400`–`20260917001600`, then publish
the preview OTA. The OTA calls `profile_title_counts`; the migration's poster nudge calls the
new `tmdb-adapter`.

Update ids: _filled in at publish._

---

## Getting the update

Force-quit the plum preview app, reopen it, wait a few seconds, force-quit and reopen again.
Settings ▸ About shows the update id; it should match the one above.

Before you start: have your Letterboxd ZIP on the phone, and allow notifications for the
preview app (a push is expected on staging; the notification inbox has the rows either way).

---

## 1. Onboarding (fresh email-code account)

| # | Do this | Expect |
|---|---|---|
| 1 | Pick a first film, tap *I liked it* | **No sheet rises.** The picker says "*Title* landed at *score*" with a small poster. No Done tap. |
| 2 | Pick a second film in the same bucket and answer the comparison | The sheet slides away still showing the pair (**not an empty strip**), then "landed at" shows the real score. |
| 3 | Leave the confirmation and wait | It stays. It clears when you tap the next title. |
| 4 | While "Ranking *title*…" shows, tap *Not now* | Nothing happens until the placement lands. **You must not be sent to People mid-placement.** |
| 5 | Finish the fifth | *Your First Five* with all five scores, as before. |
| 6 | Look below the five | A small card: *Use Letterboxd? Import your history anytime from Settings.* **No button, no way out of the flow.** |
| 7 | On People, tap *Invite friends*, then cancel the share sheet | The button never says *Inviting…* (a flash of *Opening…* before the sheet is fine). Fast double tap opens one sheet. After cancel it works again. |

## 2. Importer copy and flow

| # | Do this | Expect |
|---|---|---|
| 8 | Settings ▸ Import from Letterboxd | *Bring your Letterboxd history*, four steps ending *Come back to bingd. and choose it here.*, *Choose Letterboxd ZIP*, a two-sentence privacy line. |
| 9 | Choose the ZIP | *Ready to import*, counts, *Import N films*. **Nothing sent yet.** |
| 10 | Import | Upload says *Keep bingd. open while we send your history.* Then *Importing your Letterboxd history* with **You can close bingd. Your import will keep running** and *Leave it running*. **Never "Matching".** |
| 11 | Tap *Leave it running*, then force-quit bingd | The import keeps going on the server. |
| 12 | Wait for the push *Letterboxd import started* (arrives right after step 10) | Tapping it opens the running import screen for that job, even after a force-quit. |
| 13 | Wait for *Your Letterboxd history is ready* ("N movies added as watched. Ready to rank.") | Tap it with the app closed: the summary for **that** job. Try again with the app backgrounded, and from the bell inbox with the app open. |
| 14 | Read the summary | *Your Letterboxd history is in*, number-first rows (zero rows hidden), *Imported movies start unranked…*, buttons *Rank imported movies* / *Done* / *Import another file*. |
| 15 | Tap *Rank imported movies* | Collection, **Movies** side, **Unranked** tab selected, the imported films present. |
| 16 | Collection ▸ Unranked and Watched | **Posters on imported films** (Shrek, Free Solo and the rest), without opening each title. Initials only for a film TMDB genuinely has no poster for. |
| 17 | Re-import the same ZIP | Heading *Your Letterboxd history is already here*; no *Rank imported movies*; a new *started* and *ready* notification for the new job. |

## 3. Counts, prompts and what must not move

| # | Do this | Expect |
|---|---|---|
| 18 | Own profile | **Movies = watched movies including imports** (about 25 for your archive plus anything ranked; a ranked-and-imported film counts once). |
| 19 | Rank one imported film, pull to refresh the profile | Movies unchanged (same film, counted once). |
| 20 | Top Ranked / leaderboard / streak / feed | Imported films **absent** from Top Ranked, the leaderboard, the streak and the feed. |
| 21 | Collection ▸ Watched, the unranked card | Buttons *Rank* and **Dismiss**. Dismiss hides the card; the Unranked tab stays. |
| 22 | Awards | A watched-count award may reflect imported history, and nothing was announced per film during the import. |

## 4. Still in this update: comparison memory aids

| # | Do this | Expect |
|---|---|---|
| 23 | In a comparison, open Details on a film and on a season | Reminder sheet; the season shows its episodes. Closing returns to the same pair. |

## Known and not changed in this round

- The profile's Movies/TV drill-down still lists **ranked** titles, so the number can be larger than the list.
- Opening Details in the ~300 ms between answering the last comparison and the placement landing is a pre-existing two-modal edge (main has it too).
- Award pushes say "You earned a new Award" without the award's name: `claim_push_batch` lost `award_name` in `20260830000100`. Older than this work.
- No completion time is promised: one measured 24-film import took two minutes.

## If something is wrong

Settings ▸ About (update id, build). For an import, the job id is in the notification's route
(`/settings/import?job=…`) and on staging in `import_jobs`.
