# Preview 2026-11-20b: #319 final QA refinements and TV direct ranking

**Integration commit:** `219e2953` (`integration/preview-1120`). It is the previous Preview `1440407c` plus #319 at `0aabaa18`. #321 and `main` are unchanged.

## What changed since `1440407c`

| Commit | What |
|---|---|
| `d27a1cb3` | **A.** The top three no longer stop responding after a few drags. **B.** The drop is settled, with no flash. **C.** The "Move to …" label is gone. |
| `b2b3b6c0`, `0aabaa18` | **D/E database**, migration `20261129000300`: silent TV corrections; `rank_promote_show` / `rank_unpromote_show`; W1 accepts a series' seasons' watches. Codex P2 fixes: a series-evidence lock, the `tv_seasons` lock with an in-lock re-check, and the watchlist left untouched. |
| `858c13bb` | **D client.** The TV wall is dragged directly (`tv-wall.ts`), the copy glides to the landing, and the promotion has its Undo path. The pool editors stay. |

**Root cause of A.** The copy's top was computed from FlashList's `getAbsoluteLastScrollOffset()`. That is the last scroll event's offset plus the *current* header height, so at the top of the list it was off by the header whenever the header had changed since the last scroll. The hook now tracks the list's own `contentOffset`.

## Evidence

| Gate | Result |
|---|---|
| `tsc`, `eslint` | 0 errors (79 warnings, as on `main`) |
| Jest, #319 head | 7,075 passed |
| Jest, integration `219e2953` | 7,125 passed |
| Database (PGlite), full | 3,354 / 3,354 |
| Races (real PostgreSQL), full | 221 / 221, including CR7–CR12 |
| Mutation check | 24 / 24 detected, 3 / 3 controls |
| `test:config` | 200 / 200 |
| CI on `0aabaa18` | green |
| Codex | 3 × P2 on `858c13bb`, fixed. **`0aabaa18`: "Didn't find any major issues".** |

**Staging:**
- Migration `20261129000300` applied. The head is now `20261129000300` (206 versions).
- `tv-promote-staging-smoke.mjs`: **16 / 16** (new).
- `rerank-cross-staging-smoke.mjs`: **14 / 14** again.
- Both smokes use disposable accounts, deleted afterwards.
- **Global invariant check:** W1–W5 hold across staging. P1 reports six rankings without a placement. All six belong to one fixture account seeded directly on 2026-11-16, before this work, and nothing in this change created them. They are left as they are.

**Rollback:** `docs/release/pr319/rollback-20261129000300.sql`, rehearsed twice: rollback, then forward again.

## Published

From a clean checkout with a real `npm ci`. The fingerprints equal the installed runtimes. The Preview environment points at the staging backend `fjxhcbowoxuzulwirzyr`.

| Platform | Update | Group | Runtime |
|---|---|---|---|
| Android | `01a1f616-71fc-76c9-b2ff-7b26d5b77e60` | `c3b6dcce-ce0b-4f28-8ff4-25efa735d123` | `2503ffaa…` |
| iOS | `01a1f616-71fc-7d5f-8cfe-fec6f169c90f` | `420d6710-ae3b-4ebb-a81a-12d9c8de630c` | `ef07f4b8…` |

The live manifest serves both at `219e2953`. iOS: `config/live-runtimes.json` still records no iOS Preview binary.

**Rollback:** republish `1440407c` (Android group `c1b101c2-82d9-44cd-87ac-ba21360411dd`, iOS group `6134f1fe-53e3-4567-be85-29b48b8b17ff`), together with the SQL rollback above.
