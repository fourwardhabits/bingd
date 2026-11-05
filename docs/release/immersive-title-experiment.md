# Immersive title page: experiment record and rollback

**Status:** experimental and unreleased. It is in no production build or OTA. It was not
on Android Preview when this was written; the Preview section below is filled in when it
is published.

This page is the durable record. The procedure below does not depend on any conversation
or agent session.

---

## What the experiment is

An alternative layout for the title page (`app/title/[id].tsx`) called **Immersive
Scroll**:

- **The first screen** is near full screen and carries:
  - the artwork;
  - the title and its metadata;
  - the three scores in one compact strip (Your score, bingd, Following);
  - the actions: Rank (or Edit ranking once ranked), Watchlist, Add to list and Share.
- **Ordinary scrolling** then shows each section once: About, Where to Watch, Episodes or
  Seasons where they apply, Cast, Reviews, Similar titles and Details.

There is no tab bar, and nothing on the page is repeated.

**It is a layout, not a data or behaviour change.**
- Both layouts render from the same reads and call the same handlers.
- Ranking, scoring, the log sheet, the ranking sheets, Add to list, Recommend and the
  watchlist are untouched and shared.
- No database migration, no new table, no new RPC and no native dependency.
- Two reads that the original page loads only when their tab is selected (Episodes,
  Similar) also load on the immersive page, because it shows those sections without tabs.
  Both are existing reads.

## Where each version lives

| | |
|---|---|
| **Original page** | The original branch of `app/title/[id].tsx`: the children of the scroll view under `{immersive ? immersiveContent : (<> … </>)}`. Its JSX lines are unchanged. The tab bodies and the notices moved verbatim into `tabContent(...)` and `notices`, which the original still renders exactly as before. |
| **Immersive page** | `immersiveContent` in `app/title/[id].tsx`, plus these components in `src/features/title/`:<br>• `ImmersiveHero.tsx`, the first screen<br>• `ImmersiveScores.tsx`, the score strip<br>• `title-layout.ts`, the switch |
| **Shared, extended without changing defaults** | `TitleActions.tsx` gains an optional `tone="artwork"` and a rank `label`/`icon` override.<br>`TitleReviews.tsx` gains an optional `limit`.<br>With neither passed, both render exactly as before. |
| **Settings** | `app/settings/index.tsx`, a **Labs → Title page** row. It is shown only where the experiment is available. |
| **Branch** | `experiment/immersive-title` |
| **Based on** | `0144268c8f25d1c70a7bb28b12d554a5eb5b8043` (ranking-start Option A, `feature/rank-start-option-a`), which is on `505ae33e03ddc8c97d1d5351be1715b1f8a84c35` (final polish, live on Android Preview group `4212ffa9`) |
| **Experiment code commit** | `811ccd0c26c14ca93bc934a87ace59d5c1aa69da` on `experiment/immersive-title`. This document is the commit after it. |

## The switch

`src/features/title/title-layout.ts`:

- **Device-local preference.** Stored under `pref.title.layout`, with values `original` or
  `immersive`. Anything missing or unrecognised reads as `original`. It is per device, not
  per account.
- **Default.** `original` everywhere.
- **Lane gate.** `isTitleLayoutAvailable()`, which is `lane !== 'production'`:
  - In **production** the Labs row is not shown, and `useTitleLayout()` returns `original`
    whatever the device stored. A production OTA carrying this code therefore renders the
    original page for every user until this line is deliberately changed.
  - On **Preview, Beta and development** builds the Labs row is shown, and its value
    decides the layout.
- **Opting in and comparing.** Settings → Labs → **Title page**. Tapping the row switches
  between Original and Immersive immediately; the next title page opened uses the new
  layout. Testers opt in on their own device.

**Nothing remote is built.**
- The repository has no feature-flag service, and the brief excluded adding one, a
  migration or remote config.
- The simplest remote control available, if a limited production test is approved later,
  is the existing `app_config` table. Its read policy already lets clients read keys
  starting `public.` and no migration is needed.
- A key such as `public.labs.immersive_title = {"enabled": true}` could:
  - make the Labs row visible in production for everyone, opt-in, default off;
  - or, set to `false`, force Original as a kill switch without an OTA.
- Targeting named users that way would mean publishing their account ids in a
  client-readable row. Don't do that; prefer opt-in plus a short tester list told where
  the row is.
- Building this needs a separate approval. It is a client read plus one row that the
  founder inserts in production.

## Android Preview

Not yet published. When it is, record here the update group, update id, runtime, commit,
date and the group it replaced. The replaced group is the rollback target.

| | |
|---|---|
| Update group | — |
| Android update id | — |
| Runtime | expected `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` (unchanged; JS only) |
| Commit | — |
| Replaces | `4212ffa9-2668-4613-bb65-f6f78ad6a047` (`505ae33`, final polish) |

## Restoring the original page

From the fastest option to the most permanent:

1. **One device.** Settings → Labs → Title page → Original. Immediate, and stored on that
   device.
2. **Every Preview device, by republishing.** Republish the Preview group this candidate
   replaced. It contains neither the experiment nor the Labs row:

   ```sh
   npx eas update:republish --group 4212ffa9-2668-4613-bb65-f6f78ad6a047 --message "rollback: before immersive title experiment"
   ```

   Phones take it at their next launch, as with any update. That also removes the
   ranking-start Option A change, which shipped in the same candidate. To keep Option A,
   use option 3 instead.
3. **Every device, keeping everything else.** Publish an update from this branch with
   `isTitleLayoutAvailable()` returning `false` in `title-layout.ts`. Every device then renders
   Original whatever it stored, and the Labs row disappears.
4. **Remove the code.** Revert the experiment commit (`git revert 811ccd0c26c14ca93bc934a87ace59d5c1aa69da`). The
   original page needs no restoration because it was never rewritten. The only shared edits
   are the two optional props and the two moved blocks, and the revert undoes them.

**No data migration in either direction.** The experiment stores one device preference
and nothing on the server. An orphaned `pref.title.layout` value left after removal is
inert.

## Limits of OTA rollback and of switching off

- **An OTA takes a launch to apply.** A phone that is open keeps the update it has until
  it is closed and reopened, so a republish or a `false` gate is not instant on a device
  in use.
- **Runtime match.** Rollback by republish works only onto the same runtime. Everything
  here is JS-only, so the runtime stays `2503ffaa` on Android Preview. A future native
  change would need a matching group to roll back to.
- **The preference outlives the code.** Rolling the code back does not clear a tester's
  stored `immersive`. If the experiment returns later, those devices open in Immersive
  again until switched. That is harmless, but worth knowing when reading test feedback.
- **iOS.** No iOS Preview binary runs the current runtime, so iOS has never received this,
  and an Android rollback says nothing about iOS.

## Prerequisites before any production exposure

1. Founder device QA on Android Preview of the combined candidate (ranking-start Option A
   plus this experiment), with the checklist in the handoff.
2. A separate decision on a limited production test, and on how testers are reached:
   - opt-in row only;
   - or the `app_config` key above, which needs its own approval and one production row.
3. If the row is to appear in production, change `isTitleLayoutAvailable()` deliberately,
   in its own reviewed commit. It must never be flipped as a side effect.
4. The normal production gates in `docs/release/cloud-ota.md` and
   `docs/release/safe-update-runbook.md`: a merge to `main`, the production fingerprint
   check, and the release record in `docs/release/production-state.md`.
5. iOS: a production OTA reaches iOS too. Look at the layout on an iOS device or simulator
   before any production exposure. These checks were Android and web renders only.
