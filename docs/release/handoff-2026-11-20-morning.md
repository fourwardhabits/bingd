# Morning handoff (overnight 2026-11-19 → 20)

## 1. Production

**Shipped:** the #320 Feed spacing fix (28pt → 16pt) and #323 Feed engagement consistency.
- Release commit: `main` `a3300bf0`.
- Client-only. No database change: production's migration head stays `20261128000100`.
- #319, #321 and #322 are not included.

**Before publishing:**
- #323 CI passed and Codex reported no major issues.
- `main` CI and the release gate both passed on `a3300bf0`.
- `ota-production.yml`'s preflight, fingerprint, runtimes and publish jobs all passed. The runtimes job proved both fingerprints equal the live store binaries.

| | Android | iOS |
|---|---|---|
| Update | `01a1f30d-2913-7baa-8ac8-1148dc047899` | `01a1f30d-2913-7f2a-9dbb-dd49880a5a8f` |
| Group | `e9ea7c27-d921-42b3-8acc-4e11c8a75d8b` | `78bc77db-b45f-42a8-b96c-90ef70bfba2b` |
| Runtime | `ec79e181…`, the live store binary | `8ea562b7…`, the live store binary |

**After publishing:**
- The live manifest serves both updates on the `production` channel at commit `a3300bf0`.
- The production environment points at the production backend `abheeqyjzekiowkztfxv`.

**Rollback:** republish the previous `0170506` groups, per `safe-update-runbook.md` §4a:
- Android: `80f10846-a79e-4eb5-bf19-4cef3fad544f`
- iOS: `7d2f3828-30e3-4a77-90c6-1aa9c0dc410d`

A rollback needs your go-ahead.

## 2. Staging Preview: ready for Android QA

**Integrated commit:** `bf721a9a` (branch `integration/preview-1120`). It contains:
- `main` `a3300bf0`: #320 spacing and #323 Feed engagement;
- #319 at `5e40acc8`: drag across rating categories;
- #321 at `2b50825b`: the searchable companion picker.

| | Android | iOS |
|---|---|---|
| Update | `01a1f2f7-3efe-7730-adcf-1033aadb0c29` | `01a1f2f7-3efe-7277-8143-7970fb14e6d0` |
| Group | `226c4345-d4ad-451a-9815-a9009b1dbb0b` | `d0f1bafb-3329-4521-be28-3f398751ca10` |
| Runtime | `2503ffaa…`, the installed Preview binary | `ef07f4b8…` |

- **Served:** both updates are served on the `preview` channel at `bf721a9a`. The Preview environment points at the staging backend `fjxhcbowoxuzulwirzyr`.
- **Published from:** a clean checkout with a real `npm ci`. Both fingerprints were checked against the installed runtimes before publishing.
- **iOS:** `config/live-runtimes.json` still records no iOS Preview binary, so nothing in the repo proves the iOS build receives this update. Android is proven.

**Staging migration head:** `20261129000200_a_move_across_a_line` (205 versions, none pending).

**Staging smoke:** 14/14 with real cross-category writes on disposable accounts, deleted afterwards.
- The acceptance case: a 10.0 dragged among It was fine titles became It was fine at 5.2. It persisted on reload, the latest watch's post followed, and Undo restored 10.0.
- An upward move, same-category calls from the installed build, refusals, no new posts, comparisons or watches, and all invariants.

**Rollback:** if this Preview misbehaves, republish `f010b51f` (Android group `28ff2ad6…`, iOS group `34da676e…`). The SQL rollback is `docs/release/pr319/rollback-20261129000200.sql`, rehearsed.

## 3. Remaining work

| PR | State |
|---|---|
| [#319](https://github.com/fourwardhabits/bingd/pull/319) Drag to rerank, across categories | Draft. Codex found one issue, a change of category that kept the position slipped past the stale guards. Fixed with an expected-category guard. **Re-review: no major issues.** Database 3340/3340, races 221/221, mutation check 24/24. **Waiting on your device QA**; not for production before that. |
| [#321](https://github.com/fourwardhabits/bingd/pull/321) Companion picker | Draft, CI green, Codex clean. In the Preview. Unchanged. **Waiting on your device QA.** |
| [#323](https://github.com/fourwardhabits/bingd/pull/323) Feed engagement | Merged; see §1. |
| [#322](https://github.com/fourwardhabits/bingd/pull/322) Workstream C, follow-story engagement | Draft, **not in the Preview and not on staging.** Codex reviewed it three times, and every finding was fixed:
- Mention candidates, and the validation errors on a picked mention, could reveal a block between two other people. Fixed by checking eligibility only on the recipient side, silently.
- Editing a comment, and the inbox and push filters, could reveal a hidden story owner's follow graph. Fixed by guarding each with the owner's visibility.
- The freeze was lost when the only reaction was removed. It is now recorded at first engagement.
- Notifications are re-checked at read and at delivery.
- The reaction count and its who-reacted control were restored on the labelled row.

**Latest review: "Didn't find any major issues".** Database 3330/3330 and races 214/214 on `e75f03e6`. The rollback is rehearsed.

**Why I kept it out of tonight's Preview anyway:** its migration rebuilds the shared notification functions (`my_notifications`, `claim_push_batch`). Applying it to staging would change the backend under the #319 and #321 QA round, which you asked to keep independent. It is ready for its own staging migration, Preview and QA round on your word. |

## 4. Android QA (about 12 minutes)

**A. Drag across categories (#319, Movies, Collection, Watched, Rating highest first)**
1. Long-press a 7.x I liked it movie and drag it onto a 4.x title. While you drag across the line, the lifted poster reads **Move to It was fine** and the phone ticks once. Drop it. The bar reads `Moved "X" to It was fine · #N · 4.x`, and the score badge is now an It was fine score.
2. Pull to refresh, or leave Collection and come back. The title is still in its new place with its new score.
3. Do it again and tap **Undo**. It goes back to its original place, category and score.
4. Drag an I didn't like it title up onto an I liked it title. It becomes I liked it.
5. Do steps 1–4 in **List** view too.
6. Within a category, drag as before: there are no regressions, and auto-scroll near the top and bottom edges still works.
7. TV: tap Reorder → **TV shows**, drag a show across categories, then Done. Then Reorder → **TV seasons**. Seasons and shows move only within their own editor.
8. Optional: with TalkBack, the last I liked it title offers **Move down into It was fine**.

**B. Companion picker (#321).** Log a watch, then **Who I watched with**:
- search by name and by username;
- picked chips stay visible;
- a long friend list scrolls;
- a friend you just followed back appears without restarting;
- the 10-person limit still applies;
- Save on a new watch and on an edited Watch History entry.

**C. Feed (#323, also in production)**
- An award post (Tourist, Dabbler or Season Snacker) shows a full-size **Like · Comment** with labels. Like opens the long-press picker, and Comment opens the sheet.
- A grouped watchlist or ranking post shows Like · Comment in equal columns. The poster rail scrolls and each poster opens its title.
- "and 3 others" and "6 titles" are bold. Tapping one opens the full list, never the representative title.
- "watched with Anna and 2 others" opens the companions list.
- The Like / Comment / Save / Share row on single-title posts is unchanged, apart from equal columns.

## 5. Release readiness

- **Promote right after your QA approval:**
  - #319: merge, apply `20261129000200` to production (one migration, rehearsed rollback), then publish to production;
  - #321: merge and OTA only.
  - Both are OTA-compatible with the current production binaries; the fingerprint is checked at publish.
- **Ready for its own round, not yet for production: Workstream C (#322).** Engineering and review are complete; it needs its staging migration, a Preview and your QA.
