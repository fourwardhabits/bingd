# Combined Android Preview candidate — record and rollback

**Status:** assembled and verified on 2026-11-04, then published to **Android Preview only**
on 2026-11-05 (group `8272a1af`, from `85a8a03`). Nothing is pushed or merged, and nothing
is in production. There is no iOS update.

This page is the durable record. Rollback needs nothing beyond this repository.

---

## What is in it

Branch `integration/preview-combined`. The candidate's code is merge `88113f2`, and this
record is the commit after it. Every component sits on `505ae33`, the build Android Preview
runs today.

| | Component | Final head | Branch | Record |
|---|---|---|---|---|
| A | Final UI polish (the base) | `505ae33` | `polish/final-spec` | `docs/design/screens.md` |
| B | Ranking-start Option A, the remembered Share choice, the date-save fix | `91d3198` (contains `0144268`, `94c789a`, `e510c53`) | `feature/rank-start-option-a` | `docs/design/screens.md`, `docs/product/decision-log.md` |
| C | Immersive title page: Cinematic Editorial refinement plus the immersive Reviews tab (opt-in; Original is the default) | `8c7eac9` (contains `811ccd0`, `02f713d`, `5699db7`, `568afd8`, `f1d17c0`, `af77ffb`) | `experiment/cinematic-editorial-title` | `docs/release/immersive-title-experiment.md` |
| D | Cinematic Social Feed, without card comment previews | `b5d1388` | `feature/feed-cinematic` | `docs/release/cinematic-feed.md` |

Merges onto `af77ffb`, in order:

| Merge | Brings |
|---|---|
| `e9d9389` | B `e510c53` |
| `9942738` | D `25157c9` |
| `c134556` | B `91d3198` |
| `530042a` | D `14c9122` |
| `24fbb9f` | D `8ca81b7` |
| `8e77275` | C `8c7eac9` |
| `23a7d32` | D `f5b1c84` |
| `c3f2a01` | D `36c16f6` |
| `88113f2` | D `b5d1388` |

D's commits from `14c9122` to `36c16f6` were successive fixes to the card comment preview,
and `b5d1388` removes that preview. Across all of D, `use-comments.ts` and the conversation
components end identical to `505ae33`.

**Founder approvals:**
- C and D are approved for integration and Preview QA. D is subject to final visual
  inspection, and neither is a production design approval.
- The founder chose to ship D without card comment previews, after four review rounds each
  found a new race in them.
- B's note rule and the Reviews-tab follow-up are the founder's decisions of 2026-11-04.
- Android Preview publication is approved (to the session running it) if these gates pass.

## What changed for a reader

- **Log sheet (B):**
  - The order is Note, Watch date, Who I watched with, then the three buckets. Tapping a
    bucket goes straight to the comparisons.
  - A first-ever note opens **private**. A later new note opens on the reader's last
    explicit *Share as a review* tap.
  - Opening, saving or ranking never changes that remembered choice. Stored notes keep their
    own visibility, and "Write a review" opens shared.
  - The note composer waits for the remembered choice, so its state is on screen before
    anything autosaves.
- **Title page (C):** Original stays the default everywhere.
  - On Preview, Beta and development builds, Settings → Labs → Title page switches the
    device to Immersive. In production the row is hidden and Original always renders.
  - Immersive shows a floating module over the artwork, the genre line, the scores and
    actions, then About, Where to Watch, Episodes, Cast, and the Similar, Reviews, Trailers
    and Details tabs.
  - Its Reviews tab shows the reader's own review first, with Edit review.
- **Feed (D):** cinematic cards for title activity, with reactions, a Comment button, Save
  and Share. Comment text is read only inside the conversation, as on `505ae33`.

No migration, no new RPC, no native dependency, and no change to ranking or scoring. Grouped
watchlist activity is **not** in this candidate; it waits on a separate backend proposal.

## Verification

| Check | Result on `88113f2` |
|---|---|
| Typecheck | clean |
| Lint | 0 errors (81 pre-existing warnings) |
| Jest | 278 / 278 suites, 5320 / 5321 tests, 1 skipped (env-gated, as on `505ae33`) |
| Original is the default; Labs switch; production lock | covered: `title-layout.test.ts`, `SettingsScreens.test.tsx` "Labs in Settings", `TitleScreen.test.tsx` "is not what anybody sees unless they opted in" |
| Note sharing rule | covered: `LogSheet.test.tsx` "the remembered share choice" (each rule mutation-checked) |
| Independent review | Codex gate on `505ae33..88113f2`: **approve**, no material findings (see the review history) |
| Android Preview runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543`, computed by EAS in the clean publish checkout (`../worktrees/visual2-preview-publish`, real install) at `88113f2`; equal to the installed Preview APK. Dependencies and config are identical to `505ae33`. This record is docs only. |

**Review history** (Codex, reports in the gitignored `.agent-workflow/codex-reviews/`):

1. **`9942738`** had three findings:
   - [high] a stale feed comment preview, in the preview that was later removed;
   - [medium] a date picked before the Share preference loaded was dropped — fixed in
     `91d3198`;
   - [medium] the default-date fill race — deferred, see the residuals.
2. **Three further rounds** on the card comment preview each found new [high] races. The
   founder then removed the preview (`b5d1388`).
3. **Final gate on `88113f2`:** **approve**, "no defensible material regression found against `505ae33`".
   - No new comment-text exposure.
   - Edit review and Write a review route through the log sheet under the note rule; stored visibility comes first, the composer is gated, and only the Share toggle writes the choice.
   - The Original page is preserved, the production lock can't be bypassed, and there are no native, dependency, config or schema changes.

**Known residuals, accepted for Preview:**
- **Default-date fill race.** A note written before choosing a bucket leaves the title
  undated. The bucket then fills in Today only if a fresh read shows it still undated.
  - If the same reader sets an explicit date on another device within that read-to-write
    round trip, it's overwritten with Today.
  - It's a wrong date, not a privacy issue, and the date stays editable.
  - The real fix is a server-side conditional write, a migration that is excluded from this
    candidate.
- **A conversation read in flight across a block can return the rows from before the
  block.** This is unchanged from `505ae33`, which doesn't reset comment queries on a block
  at all. D now also invalidates comment queries on follow, unfollow, block and unblock, so
  the next read is post-block.

## Android Preview

Published on 2026-11-05 at 13:01 UTC by the app-ab session, from the clean publish checkout
(`../worktrees/visual2-preview-publish`, detached at `85a8a03`). The publish was Android only,
and there is no iOS group.

| | |
|---|---|
| Update group | `8272a1af-902c-42ce-8e52-a5f737808236` |
| Android update id | `01a1abcd-2599-7289-a18e-d4297f2811d5` |
| Branch | `preview` |
| Runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` (EAS's fingerprint at publish matched the local one) |
| Commit | `85a8a031d93a488b2802ea325f508898b475717e` (code `88113f2` plus this record) |
| Replaces | `4212ffa9-2668-4613-bb65-f6f78ad6a047` (`505ae33`, final polish) — the rollback target |

Confirmed with `eas update:view 8272a1af-902c-42ce-8e52-a5f737808236 --json`: a single
Android entry, with the commit and runtime as above.

## Rollback

From the fastest option to the most permanent. None needs a data migration: the candidate
writes no new server state. Its only new device state is two preferences:
- `pref.title.layout`
- `pref.<user>.notes.share-choice`

Both are inert without the code.

1. **The title page only, on one device.** Settings → Labs → Title page → Original.
2. **The whole candidate, on every Preview device.** Republish the previous Preview group:

   ```sh
   npx eas update:republish --group 4212ffa9-2668-4613-bb65-f6f78ad6a047 --message "rollback: before the combined candidate"
   ```

   Phones take it at their next launch. This removes B, C and D together and returns to
   `505ae33`.
3. **One component, keeping the others.** Rebuild this branch from `505ae33` without that
   component's head (the first table), then publish it.
   - For the title page alone, it's enough to publish an update where
     `isTitleLayoutAvailable()` returns `false`.
   - For the feed, `docs/release/cinematic-feed.md` names its files.
   - For the note rule, `91d3198`, `e510c53` and `94c789a` revert cleanly from B, newest
     first.
4. **Code.** Revert the merge commits on this branch, newest first (`git revert -m 1 <merge>`
   for each merge in the table above), or rebuild the branch without a component.

**Limits:**
- An OTA applies at the next launch, not instantly.
- Republishing works only onto the same runtime (`2503ffaa`).
- A device keeps its `title.layout` and `share-choice` values after a rollback. That's
  harmless, but a returning experiment opens on them.
- iOS has no Preview binary on this runtime, and nothing here has been checked on iOS.

## Before any production exposure

1. Founder device QA of this candidate on Android Preview (checklist below).
2. A separate decision on each component:
   - D is not production-approved.
   - C's production lock must be lifted deliberately, in its own reviewed commit.
   - Card comment previews need a new design before they return.
3. The normal production gates: merge to `main`, the production fingerprint, the cloud OTA
   runbook (`docs/release/cloud-ota.md`) and the record in `docs/release/production-state.md`.
4. An iOS check, because a production OTA reaches iOS.

## One-session Android phone QA checklist

Feed (from `docs/release/cinematic-feed.md`, app-ab; the comment-preview lines are gone with
the preview):

- [ ] Feed opens on Activity; the Leaderboard and People icons still switch modes; Back and
      re-tapping the tab return to Feed.
- [ ] A ranking card shows the backdrop, the Maroon score with its light ring, readable on dark
      and pale artwork.
- [ ] A TV-season card shows the series' artwork and `Show, S1`.
- [ ] A title without a backdrop shows its poster upright over a blurred field, not stretched.
- [ ] A shared review shows under the artwork; "… more" expands it; a spoiler review is masked
      for a title you haven't seen.
- [ ] A ranking with no review has no empty text area.
- [ ] Tap the heart: it fills and the count goes up; tap again removes it. Press and hold: the
      six reactions appear; choosing one replaces the heart with that glyph and its label.
- [ ] Tap the reaction summary: the who-reacted sheet opens.
- [ ] Comment opens the conversation; post a comment; it appears there. The card shows no
      comment text.
- [ ] Save adds the title to your watchlist (bookmark fills); not offered on your own posts.
- [ ] Share opens Recommend; "Share off bingd" still reaches the system sheet.
- [ ] Watchlist adds appear as cards with Save and Share; a burst appears as separate cards
      (grouping is pending backend approval).
- [ ] Pull to refresh; scroll to the end ("You're all caught up"); nothing duplicated or missing.
- [ ] Awards, goals and follow stories still render in their compact rows.
- [ ] Settings → Display size at its largest: cards, score and actions still fit.

Ranking start and note sharing:

- [ ] Log sheet: Note, Watch date, Who I watched with, then the bucket choices at the foot.
- [ ] A first-ever note opens with *Share as a review* **off** and "Only you can read this."
      showing before you type.
- [ ] Turn sharing on, write, and close: the next new note on another title opens **on**.
      Turn it off on a note: the next new note opens **off**.
- [ ] An existing review opens shared and an existing private note opens private, whatever
      you last chose. "Write a review" on a title's Reviews opens shared.
- [ ] Type a note, then tap a bucket straight away: the comparisons start, and the watch date
      shows Today afterwards. Pick a watch date immediately after opening the sheet: it is kept.
- [ ] A private note does not appear in the Feed or in the title's Reviews.

Title page (app-ab):

- [ ] Original title page is the default.
- [ ] Settings → Labs → Title page → Immersive. Check a ranked film, an unranked film, a TV
      season, a poster-only title and a no-artwork title.
- [ ] On each: floating module, genres on one line with +N opening all of them, year · rating
      · length, Rank or Edit ranking, the three scores.
- [ ] Below the module: About, Where to Watch, Episodes (season), Cast with See all, then the
      Similar | Reviews | Trailers | Details tabs.
- [ ] Reviews tab: your own review first with Edit review; a compact Write a review when you
      have none; no full-width Edit your review button; no second score circle.
- [ ] "From your circle" appears only when someone you follow has published a review.
- [ ] Scroll: the top bar turns opaque before Edit ranking passes under it.
- [ ] Switch back to Original.

Navigation and polish (`505ae33`):

- [ ] For You and Collection share one row; Movies | TV toggle works; Lists hides the toggle.
- [ ] Header spacing identical on all five tabs; Leaderboard chips scroll; rank-1 trophy shows.
