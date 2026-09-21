# Letterboxd → bingd Lists import (T6c)

**Status: DESIGN, not built.** A read-only analysis from 2026-09-21, revised the same day to
match the Lists terminology and behaviour after the #196 founder QA pass. Nothing in this
document is implemented except **T6c-0**, the archive member-count fix, which is PR #200.

**Depends on:** the Letterboxd importer (production since 2026-09-14,
[`letterboxd-import.md`](letterboxd-import.md)) and Lists v1
([`lists-prd.md`](lists-prd.md), built in #196, staging only at the time of writing).

**What does not change here.** Importing a list never makes anything a watched title.
Putting a title in a list creates:

- no watched state;
- no watch date;
- no ranking;
- no Watchlist entry;
- no Collection membership.

Imported lists produce **no Feed events**.

---

## 0. What the audit found first

1. **No real Letterboxd list file exists anywhere in this repository.** The founder's export
   (`src/features/import/__fixtures__/real-export.ts`) has no `lists/` folder, only
   `likes/lists.csv`, because that account has no lists. None of the list file's columns
   can be confirmed from real data, and this document assumes none of them (§1).
2. **The shipped importer probably refuses exports from people with many lists.**
   `archive.ts` refused any archive with more than 50 members, and a base export already has
   16. Letterboxd is reported to write one CSV per list, so an account with about 34 lists
   was refused as "That file is too big" and could not import its watched history at all.
   **Fixed in PR #200 (T6c-0):** the limit is now 1,000, and the listing stops at the limit
   plus one. The byte caps, which are the real protection against zip bombs, are unchanged.
   List files are still never read.
3. **A new import row kind added the obvious way would be written to the Watchlist.**
   `_import_apply_batch` reads `if kind = 'watched' … else <insert into watchlist>`. Its
   latest body is #196's `20261003000100` (T1), not `20260917000300`. `_import_settle`'s
   `unmatched` and `ambiguous` counts ignore the kind as well. §9 makes pinning this the first
   requirement.

---

## 1. What the Letterboxd export can do

| Question | Status | Evidence |
|---|---|---|
| Are lists exported? | **Likely.** Letterboxd's own *Importing data* page says the ZIP contains "CSVs of your profile, films, reviews, lists and more". | `letterboxd-import.md` §4; PRD §12 ("each custom list"), a secondary source |
| File path and shape | **Not verified** | No file in the repo |
| List name, description, tags | **Not verified** | — |
| Item order | **Not verified.** Letterboxd offers a "List Order" sort even on unranked lists, so the order is real data. | `research/appendix/A1-…` §3 |
| Ranked / numbered state | **Not verified.** Letterboxd lists can be ranked or unranked. | A1 §3 |
| Visibility | **Not verified.** Letterboxd has four modes: public, anyone with the link, friends, private. | A1 §3 |
| Identifiers for matching | **Not verified for list files.** History files carry `Name`, `Year` and a `boxd.it` URI, with no TMDB or IMDb id. | Fixture |
| `likes/lists.csv` | Present, and records **other people's** lists the person liked. **Never imported.** | Fixture listing |
| TV | Letterboxd has no TV, so list items are movies. The SQL matcher is `kind = 'movie'`. | A2; `_import_match_batch` |

The design reads headers rather than assuming a shape, and each unknown has a safe default:

- **Order** is always the file's row order.
- **Numbered** is set only if the real export shows a ranked field.
- **Visibility** is the import-level choice (§3).
- **Tags and per-item notes** are never imported.

---

## 2. Data mapping

| Letterboxd | bingd | Rule |
|---|---|---|
| List name | `lists.title` | Trimmed and cut to 100 characters (the `lists_title_length` check). An empty name becomes "Untitled list". Cuts are reported. |
| Description | `lists.description` | Plain text. HTML is stripped only if the real file turns out to contain it. Cut to 1,000 characters with "…". |
| Item order | `list_items.position` = the Letterboxd position, or the row index if there is none | This order is the list's **manual order**. Gaps are allowed, because readers number items 1..N at read time. |
| Ranked / numbered flag, **only if the real export proves the field exists** | `order_style = 'ranked'`, shown as **Numbered** | Otherwise `order_style = 'unranked'`. Numbered is never assumed. |
| Item name, year, URI | an `import_rows` entry of new kind `list` | The existing matcher, unchanged (§4) |
| Tags, per-item notes, list dates | not stored, not sent | Lists v1 has no field for them. |
| — | `lists.source = 'imported'` | Already exists, and exempt from the 100-list in-app ceiling (PRD §12) |

**Numbered is a way of displaying the order, not a second order.** In Lists v1 the manual
order is always the order underneath, and **Numbered** only decides whether 1, 2, 3… are drawn
against it (`EditListSheet` → `order_style`). An imported list keeps Letterboxd's row order
whether or not it is numbered, and anyone can switch Numbered on or off later without
reordering anything.

---

## 3. Privacy

Lists v1 has three visibility levels, and this document uses only their labels:

| Level | Meaning |
|---|---|
| **Only you** | The owner only |
| **Anyone with the link** | Anyone holding the URL. It works on a private profile too, as an exception for that one list (`_list_readable`). |
| **Public** | Readable by anyone who can see the owner's profile. **A Public list may also appear on the owner's profile, but appearing there is not what Public means.** |

**If the real export shows no visibility field**, the person chooses once for every imported
list:

- One picker on the preview, using `VisibilityPicker` and the three labels above.
- **Only you is the default.**
- Public is disabled, with #196's reason, while the profile is private, because the writers
  refuse Public on a private profile.
- The summary says: "12 lists added · Only you. You can change any list later."
- Nobody edits lists one at a time.

**If the real export shows a reliable visibility field**, each list gets the stricter of its
Letterboxd visibility and the import-level choice. An import never makes a list more visible
than it was on Letterboxd:

| Letterboxd | bingd |
|---|---|
| Private | Only you |
| Friends | Only you (bingd has no followers-only list) |
| Anyone with the link | the stricter of Anyone with the link and the import choice |
| Public | the import choice |

**Other rules:**

- **A profile that turns private mid-import.** If the profile became private between the
  choice and the lists being created, a list chosen as Public is created as **Only you**, and
  the summary says so.
- **Re-imports** never change the visibility of a list that is already in bingd.
- **No Feed events and no notifications.** The worker runs with the import flag
  (`bingd.import_running`) on, Lists v1 writes no `feed_events`, and imported lists must not
  add any. The existing `import_completed` notification is the only thing sent.
- **The importer's privacy promise changes.** It currently says every custom list is never
  extracted. That becomes "extracted only when the person turns Lists on".
  - Before that, only list file **names** are read from the central directory, to count them.
  - Only `<wrapper>/lists/<name>.csv` is ever read.
  - `likes/`, `deleted/` and `orphaned/` stay unread.
  - Only name, year, URI and position leave the device. Tags and per-item notes are never
    sent.

---

## 4. Matching and unmatched items

### Matching

- **One matcher.** Each distinct list title becomes one row, keyed by the same
  (name, year) correlation key the history import uses. Rows go through the same tiers:
  - **T0**, the trusted film-URI mapping, with its year check;
  - **T1**, the local catalogue, with the Hamlet and Past Lives year rules;
  - then the **TMDB** tier.
- **No double staging.** When a correlation is already a watched or watchlist row in the
  same job, the list entry uses that row's result and no second row is staged.
- **List rows read the trusted mapping only when the item URI has the same `boxd.it` form as
  the history files.**
- **List rows never write `letterboxd_match_claims`.** The shared mapping's protection is
  therefore exactly what it is today.

### Items that aren't placed

- **Genuine ambiguity** (a remake, or a translated title with a native namesake) is never
  guessed. The item is left out and kept for repair.
- **Unmatched items** are left out. The summary gives a count per list: "3 titles couldn't be
  placed." For a Numbered list the numbers close up around the gaps, so bingd's #37 can
  differ from Letterboxd's #37, and the summary says so.
- **What is kept for repair:** a left-out entry keeps its list, original position and
  correlation. The name and year stay on the redacted import row, as today. When repair
  (T6b) places the title, it goes after its nearest earlier neighbour that is still in the
  list, or at the end.

### Duplicates

- `list_items` forbids the same title twice in one list. The first position is kept and the
  rest are counted.
- Two different Letterboxd films that resolve to one bingd title are handled the same way.
- Two lists with the same name are both kept.

### Titles that aren't in the person's Collection

A list entry refers only to the catalogue title. The TMDB tier may add that title to the
shared catalogue, which is not about any person. Nothing is written about the person:

- no `user_media` row and no Collection membership;
- no `imported_titles` row;
- no watch history entry and no watch date;
- no ranking;
- no Watchlist entry.

Awards, profile counts and leaderboards don't move. The list's "seen" flag
(`_viewer_has_seen`) stays false until the person actually logs the title.

---

## 5. Idempotency

**New table `imported_lists`:**

| Column | |
|---|---|
| `list_id` | Deleted along with the list |
| `user_id` | |
| `source` | |
| `source_key_hash` | SHA-256 of the list's key |
| `job_id` | |
| `imported_at` | |

It is unique on (`user_id`, `source`, `source_key_hash`).

- **The key** is the list's own URL from the file if the file has one, otherwise its file
  name. Only the hash is stored, because a Letterboxd list URL contains the username.
- **A re-import skips lists that are already there** ("Already in bingd, left as is").
  Anything changed in bingd — order, removals, Numbered, visibility — is never overwritten.
- **A deleted bingd list** takes its mapping with it, so a re-import recreates it. To keep it
  gone, untick it in *Choose lists*.
- **A list renamed on Letterboxd** whose file has no URL imports as a new list. This is a
  documented limit.
- **Within one job:** unique per (job, list key) and per (job, list key, position), so
  resending a page changes nothing. `import_jobs_one_live` already rules out two imports at
  once for one account.

---

## 6. UX

These are additions to the existing importer screens. There is no new route.

1. **Preview ("Ready to import")** gains a Lists section when list files are present:
   - "Lists · 12 found · 3 already in bingd", with a toggle that is **on by default** (safe,
     because the default visibility is Only you);
   - **Who can see them**, with Only you / Anyone with the link / Public;
   - **Choose lists ›**, everything ticked except lists already in bingd. This is required
     when there are more lists than the cap.
2. **History gets its own toggle**, so someone who has already imported can bring **lists
   only**.
3. **Summary:**
   - counts: "12 lists added · Only you", left-out items per list, "3 already in bingd",
     "2 longer than 500: first 500 kept";
   - actions: **See my lists**, which opens **Collection ▸ Lists**, and **Remove imported
     lists**.
4. **Remove imported lists** deletes that import's lists after a confirmation. Lists edited
   since the import are kept, and the confirmation says so. It exists because Lists v1 has no
   bulk delete.
5. **Imported lists are ordinary Lists.** They appear in the **Movies / TV / Lists**
   Collection selector like any other list, with no badge and no separate section. They can
   be opened, edited, reordered, numbered, shared and deleted with the same controls.
6. **Repair:** until T6b ships, left-out items are counts only. With T6b they appear in
   *Review unmatched titles*, labelled with the list they belong to.

---

## 7. Scale and performance

| Limit | Value | Where |
|---|---|---|
| Items per list | 500 (the existing `lists.max_items`) | The client stages positions 1–500 only, so no provider requests are spent on items that could not be kept. Anything longer is reported. |
| Lists per import | 100 (new `import.max_lists`) | Client chooser and server |
| Imported lists per account | 100 (new `lists.max_imported_per_user`) | Server. Imported lists currently have no limit at all. |
| List entries per job | 50,000 | Server. List rows also count toward the existing 50,000-row / 32 MiB job ceiling. |
| Archive members | 1,000 (was 50) | Client. **Done in PR #200.** |

- **Payload.** An entry is about 60 bytes. A heavy account (60 lists, about 6,000 entries)
  is about 0.4 MB.
- **Provider cost.** List-only titles are exactly the ones least likely to be in the
  catalogue already, so expect more provider requests per title than the 2,500-title gate's
  621. The existing lease, refund and grace-period mechanics already handle that.
- **Creating the lists** is a new phase after items are placed and before settle. It must see
  final matches, and it must run before settle deletes the staged rows. It creates a few
  lists per tick, with one insert per list, which is milliseconds.
  - **Locking:** the new-list insert and T6c-4's repair insert take the same per-list advisory
    lock that `_add_list_item_unchecked` takes since `20261011000100`.
- **Posters.** The bounded poster top-up (`_import_thin_titles`) should also cover list items
  from a recent import. Otherwise new list covers draw initials instead of posters.
- **Tests and reads.** #196's scale test covers 100 lists and needs to cover 200 (100 created
  in the app plus 100 imported). `my_lists_for_title`'s `limit 100` would cut the Add-to-list
  sheet short and needs raising.

---

## 8. Tranche

This is a **separate T6c**, not part of T6 or T6b.

- **Not T6.** T6 (*Rank what you've watched*) is ranking, and a list import must not touch
  ranking.
- **Not T6b, but it reuses it.** T6b's repair writes a Collection row "exactly as the importer
  would". It has to learn about the new kind: fixing a list entry adds it to its lists only,
  and adds to the Collection only if the same correlation is also a watched row.

| Step | What | Depends on |
|---|---|---|
| **T6c-0** | Archive member count 50 → 1,000; the listing stops at the limit plus one. Client only, OTA. | **PR #200** |
| **T6c-1** | A real export with lists (§10). Commit a scrubbed fixture that leaves out `profile.csv`. Settle every "Not verified" row in §1. | the founder |
| **T6c-2** | Backend (§9), behind `import.lists_enabled = false` | #196 on production |
| **T6c-3** | Client: the list-file path rule, a section-aware CSV reader on the existing tokenizer, preview and summary. OTA. | T6c-1, T6c-2 |
| **T6c-4** | Repair for list entries | T6b |

---

## 9. Migrations and API likely needed

**One migration.** `20261014000100` is now taken on #196, so use the next free number at
build time, checked on both projects. It must rebuild each function from its **latest**
definition:

- `_import_apply_batch` from `20261003000100`;
- `_import_match_batch` from `20260925000100`;
- `import_stage` and `_import_settle` from `20260917001300`;
- `_add_list_item_unchecked` from `20261011000100`.

**`import_rows` kind `list`:**

- `_import_apply_batch` gets an explicit `elsif kind = 'list'` branch that writes nothing and
  marks the row applied, then `elsif kind = 'watchlist'`, then `else raise`.
- `import_stage` accepts `list` and drops `rating`, `bucket`, `watchedOn` and `watches` for
  it.
- The claim pass skips `list` rows.
- `_import_settle` counts only `watched` and `watchlist` rows for its film totals.
- **Pinned by a test:** a list-only title adds **zero** rows to `user_media`, `watchlist`,
  `imported_titles`, `imported_watches`, `watch_events`, `rankings` and `feed_events`.

**Staging tables `import_lists` and `import_list_entries`:**

- deleted at settle, except left-out entries, which are kept for repair;
- a failed or abandoned job deletes everything, so `_import_redact_on_complete` and
  `_import_sweep_abandoned` are extended.

**Also:**

- `imported_lists` (§5): the owner can read it, and clients cannot write to it.
- `import_jobs.list_visibility` (null means no lists) and a history on/off flag.
- **RPCs:** `import_stage_lists(job, page)` (bounded), `_import_apply_lists(job, limit)`
  (internal), `my_imported_list_keys()` for "already in bingd", and
  `import_remove_lists(operation_id, job)`.
- **`app_config`:** `import.lists_enabled`, `import.max_lists`,
  `lists.max_imported_per_user`.

**Deploy order.** A new client talking to an old server would have its list rows silently
dropped by `import_stage`. The client therefore waits for `import.lists_enabled`, which also
serves as the off switch. The `letterboxd-import` Edge Function should need no change,
because the provider tier doesn't look at the row kind; confirm that during the build.

---

## 10. What's needed from the founder

No product decision is left open that a default can't cover. The one thing that can't be done
without the founder is **T6c-1**. On Letterboxd, make:

- a small **ranked** list that includes a remake title (e.g. *Hamlet*);
- an **unranked** list;
- a **private** list;
- a list shared with **anyone with the link**;
- a list with a multi-line description containing a link, with per-item notes and tags;
- a list whose name has a comma and an emoji;
- one **deleted** list.

Then export again. That answers every "Not verified" row in §1:

- If the export has a ranked field, it maps to Numbered (§2).
- If the export has a reliable visibility field, it maps as in §3.
- If it has neither, the defaults stand: manual order kept, not Numbered, and the one
  import-level visibility choice with Only you as the default.
