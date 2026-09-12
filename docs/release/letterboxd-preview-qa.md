# Letterboxd importer — physical QA

**Lane:** preview. **Backend:** staging `fjxhcbowoxuzulwirzyr`. **Never production.**

The preview app installs *beside* the shipped one: plum icon, `app.bingd.preview`,
`bingd-preview://`, and it cannot reach the production backend — `config/backends.cjs`
refuses at config time, not at runtime.

Delivered as a **preview-channel OTA**, not a new binary. The importer needs no native
module (`expo-file-system`'s `File.pickFileAsync`, and `fflate` for the zip), and EAS's own
`fingerprint:compare` reports an exact match against the builds already installed:

| platform | runtime | build |
|---|---|---|
| Android | `8e8731a26d9c47e30da2dd709c0308db6f2d3f88` | `b517cd51-d7cd-441f-98d5-e13471719a18` (1.0.1 (7)) |
| iOS | `aa3056e7287bb313062fff27726cfa3f2e675c8d` | `bc57cede-cd01-42ec-ac54-732fae65c8a4` (1.0.1 (7)) |

**Published** from integration `2ac3388`:

| platform | update group | update id |
|---|---|---|
| Android | `e00eb991-3919-4762-a892-ddd7e2f2d589` | `01a094d2-c11c-7108-8521-fd4ee51eb9a7` |
| iOS | `d8b4eb32-c3de-41a1-b7f5-c5543d9baded` | `01a094d2-c11c-7d9b-a1ac-11b0bf27dfb8` |

---

## Getting the update

**Android.** Open the preview app (plum icon). Force-quit it once, reopen, and give it a
few seconds on the splash — Expo fetches the update on launch and applies it on the *next*
one, so the second cold start is the one that has it.

**iOS.** The same. If the preview app is not installed, it is the TestFlight build named
above, or the internal-distribution link from the EAS build page.

**Confirming you are on it:** Settings ▸ About shows the update id. It should match the id
in the publish output rather than the one the binary shipped with.

---

## Before you start

Have your real Letterboxd export ZIP on the phone — Files, Downloads or Drive all work. If
your computer unzipped it, use the original download rather than the folder.

Staging has its own accounts. Your production account does not exist there; sign up fresh.

---

## The checklist

Each row is one thing to look at. **Bold** is what would make it a bug.

| # | Do this | Expect |
|---|---|---|
| A | Settings ▸ Import from Letterboxd, with a small export (a few films) | Counts on the preview match the archive. **Nothing sent before you tap Import.** |
| B | Tap *Choose your export* and pick the ZIP from Files, then repeat from Drive and from Downloads | The picker opens and the file is selectable in all three. **A file greyed out is a dead end — there is no "show me everything anyway".** |
| C | Import an export containing watched films, ratings, diary entries and a watchlist | Films in the collection as watched; ratings become Loved / Fine / Not for me; watchlist separate. |
| D | Include a film you have logged more than once | One film in the collection, several *Diary entries kept*. **Not several films.** |
| E | Start a large-ish import, then background the app for a minute and reopen it | It carries on. Reopening shows *Matching your films*, or the summary if it finished. **Not the intro screen with your import lost.** |
| F | Import the same archive a second time | Summary says **Added to your collection: 0**, *Already here, left alone: n*, and the heading reads *Import finished* rather than *Your history is in*. Nothing duplicated. |
| G | After a finished import, tap *Import another file* and choose a different ZIP | It starts a fresh import. **Not a silent no-op, and not the previous summary again.** |
| H | Double-tap *Choose your export*, then double-tap *Import n films* | One picker, one import. **Two pickers, or a spinner with no buttons, is the freeze this guards.** |
| I | Include a film Bingd cannot place (an obscure title, or one with a wrong year) | The summary names the count and says the names were kept. **Not silently dropped, and not a wrong film.** |
| J | Read the summary arithmetic | Added + already + unmatched should account for the films in the archive. *Diary entries kept* is a count of viewings, not films, and may be larger. |
| K | Open an imported title | It shows as **watched**, with your Letterboxd rating's bucket. **No score, no rank, no position — an imported film is not a ranked one.** |
| L | Rank an imported film yourself | Your ranking wins and sticks. |
| M | Re-import the archive after ranking it | The ranked film is untouched and counted under *Already here, left alone*. **Its bucket and rank must not revert.** |
| N | Watch the Feed and the notification bell during and after an import | **No burst of activity, no notification storm.** An import announces nothing. |
| O | Settings ▸ Import from Letterboxd, from a cold start | The row is there, under Account, and opens the importer. |
| P | Sign up fresh and go through First Five | After the fifth film, *Your First Five* carries one line about Letterboxd. **It must not interrupt the ranking, and there must be no button that leaves the flow.** |
| Q | If practical: a large export (a few thousand films) | Preview appears without freezing; the upload reports "Part n of m"; it finishes. |

---

---

## Also in this update: the comparison memory aids

The preview binaries were built with this feature; the first Letterboxd OTA replaced the
whole JS bundle and therefore took it back out. This update carries both, so it is worth a
look that it is still there and still behaves.

| # | Do this | Expect |
|---|---|---|
| R | Start a ranking comparison and open the details on one of the two titles | A reminder sheet: poster, overview, cast, and for a season its episodes. **No score, no community rating, no watchlist control, no reviews** — an action here would compete with the comparison you are in. |
| S | Close it and carry on comparing | The comparison is exactly where you left it. **Not restarted, and no answer lost.** |
| T | Open the details on a **season** | It says what that season actually was — episodes, not the show in general. |
| U | Open it twice on the same title | The second time it opens collapsed rather than re-expanded, and quickly. |
| V | Open it with no network | It fails quietly inside the sheet. **The comparison behind it must not break.** |

## What staging will and will not show you

- **The TMDB tier works there now** and is the thing most recently fixed — a film not in
  Bingd's catalogue should still be placed. That is worth a deliberate look (item I with a
  real but obscure film).
- **The catalogue is thinner than production's**, so more films go to TMDB than would in the
  real app. More unmatched than you expect is not necessarily a bug; a *wrong* film is.
- **Nothing here touches production.** Your real account, collection and rankings are not
  involved and cannot be.

## If something is wrong

Settings ▸ About has the update id and the build number. Both, plus what you did and what
you expected, is enough to find it. The import itself leaves a job record on staging that
can be read by id.
