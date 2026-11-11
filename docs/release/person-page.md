# Actor pages: visual refresh and filmography sorting (2026-11-11)

Founder-approved, focused (not a redesign). Client: `app/person/[id].tsx`,
`src/features/person/{filmography,biography,use-person}.ts`. Adapter:
`supabase/functions/tmdb-adapter/normalize.ts` (`personCredits`) and `index.ts` (`handlePerson`).
No migration: the extra fields live in the free-form `person_cache.payload`.

## What changed on screen

- **Header.** The navigator's opaque bar became `TitleTopBar` over the collapsed Parchment band,
  as the title page and a list without artwork already draw it. The portrait straddles the band.
  The compact name fades into the bar only once the large name has scrolled under it.
- **Identity.** Portrait, DM Serif name, then one line of facts (known for · born · place),
  left-aligned like the title and list pages. Less vertical space than the old centred stack.
- **Biography.** Uses the shared `ClampedText` (3 lines, `… more` on the last line, closes
  again). When the cached text was cut by the adapter's 1,200-character cap, it now ends on
  a whole sentence. Once fully open it says *"Shortened. The full biography is on TMDB."*
- **"Known for" is now "Filmography"**, with the shared `SortChip`/`SortMenu` in the section's
  header row. Cast/Crew and All/Movies/TV are unchanged. Rows have hairline dividers, and
  *See more* is a full 44pt target.
- **Loading** shows the band, a portrait placeholder and skeleton rows, with Back available.

## Sorting

| Axis (menu label) | Order | Notes |
|---|---|---|
| Popular (default) | The cache's stored TMDB-popularity order | Undirected, like Shuffle |
| Release date | ↓ newest first, ↑ oldest first. Press again to flip | Undated last in both directions, under "No release date yet". A series sorts by its first air date |
| Highest rated (TMDB) | TMDB audience rating, confidence-weighted, best first | Offered only when the half has scored credits. Credits under the vote threshold go last, in popularity order, under "Too few TMDB ratings to rank" |

Newest and Oldest are the two directions of one **Release date** axis. That is the shared sort
contract (`ui/sort.ts`): a label names the axis and the arrow gives the direction.

Ties fall back to popularity order and then the catalogue id. Sorts work within the chosen
Cast/Crew half and the All/Movies/TV filter. The order is kept across those switches, and any
sort or filter change resets to the first page. Sorting writes nothing.

## Coverage: why a date sort can now be trusted, and what it says when it can't

The adapter keeps 60 acting, 30 crew and 10 self-appearance credits, chosen by popularity, so
a newest-first sort over them used to be able to miss the newest work. Two changes:

1. **Edge slots.** Each half also keeps its newest, oldest and best-rated credits
   (cast 10/5/5, crew 5/3/3) on top of the popularity caps. That is at most 31 extra
   catalogue rows on a very long career, usually far fewer because they overlap, and no extra
   TMDB requests. These credits are stored at their popularity position, so Popular is unchanged.
2. **A coverage record** (`payload.coverage`). For each half and kind it records the newest and
   oldest date and the best score among the credits that were **dropped**, and whether any
   undated or unrated credits were dropped. The page vouches for every row up to the first one
   it cannot vouch for, and puts a note there: *"From here on, not every one of their older
   credits is listed."* There is no note when nothing was dropped.

A row cached before this change has no record. A date sort then shows *"Sorted within the N
acting credits kept here, of M TMDB lists."*, and there is no rating axis. Rows refresh on
their 7-day TTL once the adapter is deployed.

## Highest rated (TMDB): source and rules

- Source: `vote_average` and `vote_count` on TMDB's `combined_credits` entries. This is the same
  response the adapter already fetches, so it costs no extra requests.
- Threshold: 100 votes for a film, 50 for a series. Below that, a credit has no score.
- Score: Bayesian average `(v·R + m·C)/(v + m)`. `m` is the kind's threshold and `C` is a
  per-kind prior: 6.5 for films, 7.0 for TV, because TV audiences rate higher. The score is
  stored per credit as `tmdb_score` and is never shown. A title with 2 votes of 10 cannot
  outrank an established film.
- Under All, films and series are ranked together on their own weighted scores.

## Renders

Rendered with Expo web from the real `PersonScreen`, using `__fixtures__/people.ts` data
(posters and portraits blanked, scores invented). **These are not device captures.** Device QA
below is still required.

`person-page/01…11-*.jpg`: Popular (top); biography opened, with the shortened notice; sort menu;
Movies newest-first with the coverage note; oldest-first; highest rated; compact header after
scrolling; legacy-cache caveat; TV actor; director (crew only); limited credits.

## QA (Android and iOS)

Do every step on one Android phone and one iPhone. Before deploying the adapter, steps 5–7
show the legacy caveat instead.

1. Open Brad Pitt from a title's cast strip. Back is drawn over a Parchment band and the
   portrait overlaps the band's edge. Scroll down: the bar turns Paper, and "Brad Pitt" appears
   in it only after the large name has gone. Back, the iOS edge swipe and Android hardware back
   all return to the title.
2. Tap the biography. It opens and closes. If it was shortened, the notice appears only when
   open, and the text ends on a sentence.
3. FILMOGRAPHY shows "Popular" on the chip. The first rows match today's order.
4. Chip → Release date: the newest film is first, the arrow points down, and TalkBack/VoiceOver
   reads "Sort. Release date, newest first". Choose Release date again: oldest first, arrow up.
   Undated credits come last both times.
5. Movies + Release date (newest): a note appears where the list stops being complete (or none
   for a short career). Every film above the note should match TMDB's newest films.
6. Chip → Highest rated (TMDB): well-known, well-rated films are first. Thinly voted credits are
   at the end under "Too few TMDB ratings to rank".
7. Switch Cast → Crew → Cast and All → TV → Movies while sorted. The order is kept, the list goes
   back to 12 rows, and See more still works.
8. Bookmark a title in a sorted list: it fills Maroon. Unbookmark it. Ranked/Watched/On your
   watchlist labels are unchanged. A row opens its title page.
9. Repeat 1–4 for a mostly-TV actor (e.g. Bryan Cranston), a director (Christopher Nolan, who
   opens on Crew with job titles), and someone with very few credits.
10. Large text size (200%): the chip wraps under the heading rather than off the screen, and rows
    and notes wrap.
11. Airplane mode on a never-opened person: skeleton, then "Nothing here yet" with Try again.

## Known limitations and follow-ups

- Popular now has small gaps after row 60: the edge-slot credits sit at their popularity
  rank, so it can jump from #61 to #85. Only the "Showing N of M" count signals this.
- Self-appearances (presenters) get no edge slots, so a date sort over them shows the note early.
- A series sorts by its first air date, not by when this person appeared in it.
  TMDB's combined credits carry no per-credit air dates.
- Fully complete sorting would mean storing every credit (often several hundred catalogue rows
  per person). That is a policy and retention decision, not done here.
