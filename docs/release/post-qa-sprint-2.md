# Post-QA Refinement Sprint 2 — record and rollback

**Status:** Verified and **published to Android Preview only** on 2026-11-05: group `1f99a23b`, from
`0681248`. Nothing is pushed, merged or in production, and there is no iOS update. The previous Preview group `8272a1af`
(`85a8a03`) is the rollback.

This page is the durable record. Rollback needs nothing beyond this repository and the EAS
dashboard.

---

## Where it comes from

- **Base:** `3a6c05d` on `integration/preview-combined`. That is the combined candidate
  `85a8a03`, which is live on Android Preview, plus its docs-only record.
- **Branch:** `refine/post-qa-2`, in worktree `../worktrees/qa-refine-2`. It is local
  only and not pushed.
- **Code commits:**
  - `529c739`: Phase A (Feed social area, score row, module frame, reveal, buckets).
  - `9fed1ed`: Phase B (Reviews after Cast and the Reviews sheet).
  - `ea23790`: removes an unused import and types a test.
  - `0f82e93`: fixes from the independent review, a sort control that stays put while
    an order loads, and a failure state for the Reviews preview.
- **Scope:** JavaScript only. Every changed path is under `src/` or `app/`. There are no
  migrations and no backend, native, `app.config.ts`, `eas.json` or package changes.

## What changed for a reader

### Feed card

- **One social area:**
  - A compact reaction summary sits first: up to three glyphs, the reader's own first,
    then "N reactions". The whole summary opens the existing list of who reacted.
  - A hairline follows, then Like, Comment, Save and Share.
- **One edge:** all three share the card's gutters. The first glyph, the hairline and the
  Like icon start on one edge, and Share ends on the artwork's right edge.
- **No reactions:** no summary and no hairline are drawn.
- **Unchanged:**
  - Tap to like, long-press for the six reactions, and the selected state.
  - The counts, the Comment and Share actions, and the 44pt targets.
- **Same height.** The card is the same height as before.
- **Save on Feed cards (unchanged):** a fourth action, Save/Saved, sits on everybody
  else's title activity. It is deliberately absent on the reader's own activity, and a
  test pins that.
- **Artwork height and crop: deliberately unchanged.**
  - The frame is 16:9 of the card width, clamped to 150–190pt. It crops about 4% at
    384dp and about 11% at 412dp.
  - Taking 12pt off would raise that to about 10% and 17%, on every title, including the
    ones flagged.
  - The feed has no focal-point metadata. A global top bias barely moves anything at
    these crop sizes, and it would be the rejected "global alignment".
  - The awkward frames (*Spider-Man: Brand New Day*, *One Ranger*) come from the source
    backdrop TMDB publishes, not from our crop.
  - Picking a different backdrop would need the TMDB images endpoint, which is new
    backend work.

### Cinematic Editorial title page (Labs, Preview only)

- **Bottom frame:** the softened artwork continues **12pt below the floating module**, the
  same as the side inset, then ends with a clean edge on Paper. There is no gradient,
  blur field or gap. Poster-only and no-artwork titles get the same frame.
- **Score row:**
  - Three columns of exactly equal width. Each value is centred, with its label centred
    beneath it, and the padding above and below is equal.
  - Labels: `Your score`, `bingd. (4)`, `Following (0)`. The number in brackets is the
    server's **rating** count, drawn only once the server has reported it, never as a
    0 while loading.
  - A missing score is a dash. Its reason is what the screen reader says for that
    column instead of a wrapped second line: "Not enough ratings yet", "No ratings yet
    from people you follow", "Not ranked yet", "Score loading".
  - Your score keeps the filled Maroon circle. At a large text size on a narrow phone the
    row still stacks into three rows.
- **Reviews after Cast:**
  - A Reviews section with See all, showing two reviews: yours first, in the quiet "Your
    review" treatment with its small Edit, then the most helpful of everyone else's,
    three lines each.
  - Without reviews it shows "No reviews yet" and a compact Write a review. An unranked
    reader gets "Rank to leave a review", which keeps the rank-first rule.
- **Reviews sheet (See all):**
  - Your review is pinned first, with everyone else's below.
  - Spoiler masks, the thumbs-up Helpful (now the review's only visible reaction, as the
    heart count is gone from the sheet), Report and Edit are all there.
  - Edit closes the sheet before the log sheet opens.
- **Lower tabs:** now Similar | Trailers | Details. The "From your circle" line is gone,
  because the preview supersedes it, and Following stays a filter in the sheet.
- **Original page and Labs switch:** unchanged. The Original page keeps its Reviews tab and
  its Top / Following / Recent control.

### Review ordering in the sheet

| Order | Source | Reversal |
|---|---|---|
| Most Helpful (default) | server, `title_reviews_v2` `top_desc` | tap again: least helpful first (`top_asc`) |
| Newest | server, `recent_desc` | tap again: **Oldest** (`recent_asc`) |
| Rating | the complete Most Helpful list re-ordered on the device | tap again: lowest first |
| Following | server filter, ordered by Helpful | none (it is a filter) |

- **Ceiling:** the read now asks for the server's ceiling, 100 rows, instead of 50. There
  is still no paging, because the server has none.
- **Rating:**
  - It is offered only when the server returned fewer than 100 rows, which proves the
    list is complete. A cut-short list is never re-sorted and presented as a global
    order.
  - A review whose author has no score goes last either way. Ties keep the Most Helpful
    order, so a Helpful tap never moves a row.
- **At the ceiling:** when an order returns 100 rows, the sheet says "Showing the first 100
  reviews in this order" and Rating is not offered.
- **No new cache:** the preview, the default order and Rating all read the same
  `['title-reviews', id, 'top_desc']` entry. Every Helpful vote and collection change
  already updates and invalidates it.

**The smallest safe follow-up for real paging and a server Rating order** needs a
migration and founder approval. It is not built.
- Add `title_reviews_v3(p_media_item_id, p_sort, p_limit, p_cursor)`, with the same
  visibility predicate as v2.
- Add the sorts `score_desc` and `score_asc`, ordered on the live `score_for` value with
  nulls last.
- Use keyset pagination on (sort key, `note_updated_at`, `user_id`).
- Keep v1 and v2 untouched, because v1 serves the public build 7.
- The client then moves the sheet to an infinite query.

### Ranking start (log sheet buckets)

- **Grouping:** a hairline on the gutters now closes the optional details, with the three
  choices 12pt beneath it.
- **Circles:** each unchosen circle holds a faint wash of its own colour (Maroon, Sage,
  Stone), and the chosen one fills as before.
- **Labels:** semibold, and still **below** their circles. Labels above would push the
  circles to the sheet's bottom edge, next to the system gesture area. Below keeps the
  44pt targets and the grouping.
- **Unchanged:**
  - The order, the radio semantics, and "How was it?" as the group's spoken name.
  - The note privacy and autosave behaviour, and the remembered Share choice from `e510c53`.
- **Onboarding:** its taste sheet uses the same component, so it gets the same circle and
  label polish. Its layout is unchanged.

### Ranking score reveal

- **New hierarchy:** score, title, then **the placement or genre ranks as the loud line**
  (Maroon, headline face, for example `#9 Thriller · #10 Drama`). Then Above / Below in
  footnote, and then any award this ranking unlocked.
- **Which lines show is unchanged:**
  - Top-ten overall suppresses the genres.
  - At most two genres, none worse than tenth.
  - The re-rank movement sentence.
- **Awards:**
  - An award comes only from the existing before-and-after ledger diff, the one the
    celebration already uses. A placement token stops a slow read from attaching one
    placement's award to another.
  - Nothing is reserved while the read is out, and nothing is drawn if it finds nothing
    or fails.
  - The celebration after Done is unchanged, and a test proves it still plays.
- **Unchanged:** the comparison engine, score derivation, rank calculations, award
  eligibility and persistence.

## Verification

- **Typecheck:** `tsc --noEmit` is clean.
- **Lint:** `eslint .` reports 0 errors. Across the changed files the warnings match the
  base exactly; the base has three, all pre-existing.
- **Jest:** 278/278 suites at `0f82e93`, with 5354 passed and 1 env-gated skip. The
  base had 5320 passed.
- **New or updated tests:**
  - Score row: equal columns, centring, padding, compact labels, zero and nonzero counts,
    no count while loading, spoken reasons, and 320 and 360pt at large text.
  - Feed social area: none, one, several kinds, and your own selected reaction, plus
    reactor-list access, gutter alignment and targets.
  - Reveal: the hierarchy styles, at most two genres, and an earned award after the
    neighbours. No award space when nothing was earned, and the celebration still plays.
  - Buckets: the wash, the fill, semibold labels and the 44pt circles.
  - Reviews:
    - Preview: two shown, yours first, the private note never shown, the spoiler mask
      (screen-reader label too), the empty state, rank-first, and no circle line.
    - Sheet: listing once, Helpful vote, Report present, Done, Newest then Oldest, and
      Rating over a complete list in both directions.
    - Limits and filters: no Rating at the ceiling, the truncation note, Following as a
      filter, your pinned review and Edit closing the sheet.
    - Original: its controls are unchanged.
- **Not done:** no device or web render. Visual verification is by component tests and
  style audit only; the founder's phone QA is the visual check.

## Independent review

Two Codex adversarial reviews (`codex-companion` `adversarial-review`, base `3a6c05d`).
Reports are in the worktree's gitignored `.agent-workflow/codex-reviews/`.

1. **`post-qa-2-review1.md`, on `ea23790`: needs-attention, two MEDIUM, no HIGH or
   CRITICAL.** Both are fixed in `0f82e93`, with regression tests.
   - **Reveal overflow.** Two award rows at a large text size on a small phone made the
     reveal taller than the sheet's 90% cap, with no way to scroll. Now the body above the
     exits scrolls inside a bounded height, and Done and Add details stay under it.
   - **Rating at the ceiling.** With Rating chosen over 99 reviews, a refetch at the
     100-row ceiling left a Rating label over a Most Helpful list. Now one effective order
     drives both the rows and the control.
2. **`post-qa-2-review2.md`, on `0f82e93`, the whole branch: approve, no material
   findings.** It also confirmed there are no migration, backend, native or config changes.

## Android Preview

Published on 2026-11-05 to **Android Preview only**, from the clean checkout
`../worktrees/visual2-preview-publish` (real `npm ci`), with
`npm run update:preview -- --platform android --non-interactive`, run from Git Bash.

| | |
|---|---|
| Update group | `1f99a23b-01d4-497e-b89b-15470b53f393` |
| Android update id | `01a1ac31-f3b8-70c5-a7d9-093506ec9909` |
| Branch | `preview` |
| Runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` (the EAS fingerprint at publish matched the local one) |
| Commit | `06812489f45ae86ea0817e09d10b919b0f0e08ce` (code `0f82e93` plus this record) |
| Replaces | `8272a1af-902c-42ce-8e52-a5f737808236` (`85a8a03`), the rollback target |

Confirmed with `eas update:view 1f99a23b-01d4-497e-b89b-15470b53f393 --json`: a single
Android entry, with the commit and runtime as above. `eas update:list --branch preview`
still lists `8272a1af` and `4212ffa9` beneath it. There is no iOS group.

## Rollback

Nothing here needs a data rollback. This sprint writes no new server state and no new
device state.

1. **The title-page changes only, on one device:** Settings → Labs → Title page →
   Original. The Original page does not have the score row, frame or Reviews changes.
2. **The whole sprint, on every Preview device:** republish the previous Preview group.

   ```sh
   npx eas update:republish --group 8272a1af-902c-42ce-8e52-a5f737808236 --message "rollback: before post-QA sprint 2"
   ```

   Phones take it at their next launch, back on `85a8a03`. The group before that,
   `4212ffa9` (`505ae33`), is still listed as well.
3. **One change, keeping the others:** revert its part on this branch and publish again.
   The Feed, reveal, buckets and score row live in `529c739`, the Reviews work in
   `9fed1ed`, and both have follow-ups in `0f82e93`.

**Limits:**
- An OTA applies at the next launch.
- Republishing works only onto runtime `2503ffaa`.
- iOS has no Preview binary on this runtime, and nothing here has been checked on iOS.

## Phone QA checklist (differences from the current Preview first)

1. **Feed card with reactions:**
   - A glyph cluster and "N reactions" sit at the left, then a hairline, then Like,
     Comment, Save and Share.
   - Like starts under the first glyph, and Share ends at the artwork's right edge.
   - Tapping the summary opens who reacted.
2. **Feed card with no reactions:** no summary and no hairline, just the action row.
3. **Your own reaction:** your glyph leads the cluster, and Like shows its name ("Wow").
   Long-press still offers the six.
4. **Title page (Labs → Cinematic Editorial):** a 12pt strip of artwork shows under the
   floating card, the same width as the sides, then plain Paper.
5. **Score row:**
   - Three even columns: `Your score`, `bingd. (N)`, `Following (N)`.
   - Each value is centred over its label, and a dash shows where there is no score.
   - Try 320/360-wide and large system text.
6. **Reviews after Cast:**
   - Your review first, with Edit, then the most helpful other review.
   - A title with none says "No reviews yet" with Write a review, or Rank to leave a
     review while unranked.
7. **See all:**
   - The sheet shows your review pinned, then everyone else's.
   - Try Helpful (tap twice to reverse), Newest then Oldest, Rating (tap twice), and
     Following.
   - Try the thumbs-up Helpful, the ⋯ Report, and Edit, which closes the sheet and opens
     the log sheet.
8. **Lower tabs:** Similar | Trailers | Details only, with no "From your circle" line.
9. **Rank a movie and a TV season, then look at the reveal:**
   - The genre ranks or the overall placement are the Maroon line under the title, and
     Below/Above are smaller beneath them.
   - An award earned by that ranking appears last, and still celebrates after Done.
10. **Log sheet buckets:**
    - Faint tinted circles, semibold labels, and a hairline above the three.
    - The order and the tap-to-rank behaviour are unchanged.
11. **Original fallback:** switch Labs → Title page → Original, and the old page and its
    Reviews tab are back.

## Production

This is not production-ready by itself, and nothing here reaches production.
- **The title page is locked:** `isTitleLayoutAvailable()` is still
  `lane !== 'production'`, so production renders the Original page whatever a device
  stored.
- **To make Cinematic Editorial the single production page later, with a rollback:**
  1. After phone QA approval, change the resolution so a device with no stored choice
     gets `immersive` in every lane. Keep `original` reachable through the same Labs row
     in Preview only.
  2. Ship it to production as an OTA. The rollback is one OTA that returns the default to
     `original`. The page is chosen on the client, so no data, migration or build is
     involved.
  3. Optionally, for a no-OTA kill switch, read a `public.title.layout_default` key from
     the existing `app_config` table. It needs no migration, but it does need founder
     approval.
  4. After a stable period, delete the Original branch of `app/title/[id].tsx` and the
     switch.
- **Before this reaches production:**
  - The founder's phone QA of this Preview, and explicit production design approval for
    the Feed and the title page.
  - The trailer-thumbnail privacy inventory item (`i.ytimg.com`), from the title-page
    record.
  - The normal production release gates in `docs/release/safe-update-runbook.md`.
