# Preview 2026-11-20: #319 drag stability fix

**Integration commit:** `1440407c` (`integration/preview-1120`). It is the previous Preview `bf721a9a` plus #319's `1f43d86d` and `855a246c`. #321 and `main` are unchanged.

## Founder Android QA, 2026-11-20 (Galaxy S25 Ultra), on `bf721a9a`
- Passed: same-category drag, rank and score reflow, Undo, persistence, and a cross-category move in List view (Ratatouille → It was fine at #11, score 4.1).
- Failed: after a scroll, the lifted item was drawn away from the finger in both Poster and List, and sometimes left a blank gap.
- The old "Drag it within that group" notice also appeared. That text is not in `bf721a9a`; it belongs to `f010b51f`, the previous Preview. The app applies a new update on its next cold start, so those attempts ran the old bundle.
- **#321 (follow-back immediately taggable): founder QA PASS** for the reported defect.

## Root cause and fix
See `docs/architecture/collection-rerank.md`, "Where the lifted copy is drawn".
- The copy's top came from `measureLayout`. On the new architecture that value can lag Android's scroll position.
- It is now computed from FlashList's own layout and scroll offset.
- Also changed:
  - scrolling turns off at the lift;
  - other titles ease into place;
  - the drop prediction is synchronous;
  - Android Back cancels a held title;
  - the learned left edge is keyed to the view and width (Codex).

## Evidence
- Jest: 7091 passed on the integration commit. The new `use-lift-drag` tests fail on the old hook (6 of 12).
- Database: `collection-rerank` 34/34.
- Races: the rerank tests (CR1–CR6) 8/8.
- CI: green on `855a246c`.
- Codex: "Didn't find any major issues" on `855a246c`.
- Staging: migration head `20261129000200`, nothing pending. The cross-category smoke test passed 14/14 again.
- Clean `npm ci` checkout. Fingerprints equal the installed runtimes: Android `2503ffaa`, iOS `ef07f4b8`.

| Platform | Update | Group |
|---|---|---|
| Android | `01a1f582-bbbc-7dd7-b990-5c56fe0bb3a5` | `c1b101c2-82d9-44cd-87ac-ba21360411dd` |
| iOS | `01a1f582-bbbc-790a-a05f-0fc87ca58827` | `6134f1fe-53e3-4567-be85-29b48b8b17ff` |

The live manifest shows the `preview` channel serving `1440407c` on both platforms against the staging backend `fjxhcbowoxuzulwirzyr`.

**Rollback:** republish `bf721a9a`. Its groups are `226c4345-d4ad-451a-9815-a9009b1dbb0b` (Android) and `d0f1bafb-3329-4521-be28-3f398751ca10` (iOS).
