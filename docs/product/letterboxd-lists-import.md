# Letterboxd → bingd Lists import (T6c)

**Status: DEFERRED ON PURPOSE, post-freeze (T6c).** It is not in the stopping-point release.
It is a deliberate **acquisition/migration feature**: a way to bring an existing Letterboxd
account's lists across. It is **not unfinished core work**. Native Lists are complete and
shipping without it. The 2026-09-22 build-readiness pass came back **NO-GO**, and the founder
accepted that. §D below records why, what a future build must do, and (§D.3) the founder's two
decisions. The rest of this document is the design.

**Status of the design: DESIGN, not built.** A read-only analysis from 2026-09-21, revised the same day to
match the Lists terminology and behaviour after the #196 founder QA pass. It was then
**reconciled against a real Letterboxd export that contains lists** (2026-09-21 22:08 UTC;
scrubbed fixture at `src/features/import/__fixtures__/real-list-export.ts`). Nothing in this
document is implemented except **T6c-0**, the archive member-count fix: PR #200, **merged**
(`8feddf7`) and shipped in the production OTA from `a17880d` (2026-09-23).

**Depends on:** the Letterboxd importer (production since 2026-09-14,
[`letterboxd-import.md`](letterboxd-import.md)) and native Lists v1
([`lists-prd.md`](lists-prd.md)), merged in #196 and in production since 2026-09-23.

**Native Lists vs Letterboxd Lists import.** *Native Lists* are bingd's own lists: created,
ordered, shared and deleted in the app (`lists.source = 'in_app'`). *Letterboxd Lists import*
(this document) would only create those same list objects from an archive
(`source = 'imported'`). It adds no list behaviour of its own.

**What does not change here.** Importing a list never makes anything a watched title.
Putting a title in a list creates:

- no watched state;
- no watch date;
- no ranking;
- no Watchlist entry;
- no Collection membership.

Imported lists produce **no Feed events**.

---

## D. Deferred: the 2026-09-22 NO-GO

**Decision.** Letterboxd Lists import is **not built for the stopping-point release**. It stays
**T6c, post-freeze**. The build-readiness pass of 2026-09-22 stopped before writing any code,
and nothing was applied, flagged or published.

**What is already done, and is separate from this.** Native bingd Lists (Lists v1,
[`lists-prd.md`](lists-prd.md), built in #196) is a **completed feature of its own**. It does
not wait on this import, and nothing here changes how native Lists behave. This document
only adds a way to fill them from a Letterboxd archive.

### D.1 Why it stopped

1. **The design needs a substantial schema and changes the import worker.** §9 is one
   migration, but inside it:
   - three new tables: `import_lists`, `import_list_entries` and `imported_lists`;
   - four new RPCs: `import_stage_lists`, `_import_apply_lists`, `my_imported_list_keys` and
     `import_remove_lists`;
   - a new "create lists" phase in `_drain_import_jobs`, the worker every import runs
     through;
   - two new `import_jobs` columns, a new `import_rows` kind and three `app_config` rows;
   - rebuilds of `import_stage`, `_import_match_batch`, `_import_apply_batch`,
     `_import_settle`, `_import_redact_on_complete`, `_import_sweep_abandoned`,
     `_import_thin_titles` and `my_lists_for_title`.
2. **A smaller version does not exist.** Matching runs later, on the server worker, so
   creating the lists has to be a server phase too. The client cannot create them with
   `create_list`, for three reasons:
   - it stamps `in_app`, not `imported`;
   - it is limited to 20 lists a day;
   - the client never learns the matched title ids for titles that appear only in lists.
3. **Two decisions were still open** at the time (D.3). They have since been decided.

### D.2 What a future build requires

- **A migration after Unified Ranking, numbered `20261020000100` or later.** #196 ends at
  `20261018000100` and Unified Ranking (#203) at `20261019000100`; both projects stand at
  `20261019000100` as of 2026-09-23. **The number must be rechecked on the repo, staging,
  production and every open PR before implementation starts.** §9's list of which migration
  holds each function's latest definition must be checked again at the same time.
- **#196 on production first.** The functions this rebuilds are #196's versions (for
  example `_import_apply_batch` from `20261003000100`). **Met 2026-09-23:** production has
  all of #196 and #203.
- **PR #200 (T6c-0) merged.** Without it, any archive with more than about 34 lists is
  refused before its watched history can be imported. **Met:** merged `8feddf7`, in the
  2026-09-23 production OTA.
- **The architecture in §9:** the three tables, the four RPCs and the new worker phase,
  behind `import.lists_enabled = false`.
- **Checked on 2026-09-22, and still to confirm at build time:** `_import_provider_claim` and
  the `letterboxd-import` Edge Function select rows by status alone. A `list` kind should
  therefore need no Edge Function change or deploy.

### D.3 The two founder decisions (recorded 2026-09-23)

1. **"Edited since the import" means any user-initiated rename, visibility change, reorder,
   or adding or removing a title.** System and moderation changes do **not** count. *Remove
   imported lists* (§6 item 4) keeps a list the person has edited in any of those ways and
   deletes the rest.
   - **Consequence for the build:** `lists.updated_at` cannot be the test. Every native list
     writer bumps it, and so does the moderation `hide_list`. The build needs an explicit
     "user-edited" mark (for example a timestamp on `imported_lists`) set only by the
     user-facing writers: `update_list` for title and visibility, `move_list_item`, and the
     add and remove item writers. `hide_list` and any other system path must never set it.
2. **More than 100 lists in one import: import the first 100 deterministically and report the
   skipped count.** The archive is not refused, and the watched history and every other part of
   the import go ahead. The summary states how many lists were skipped. Re-running the same
   archive must choose the same 100.

**Left for the build to specify, within these decisions** (see §10):

- **"First" needs a defined order.** Archive member order, the list `Date`, and file name are
  all candidates. It has to be stable across re-exports, or *first* is not deterministic.
- **How decision 2 meets *Choose lists*** (§6 item 1), which was specified as required above the
  cap. Does the chooser pre-tick the first 100, or disappear?
- **How decision 2 meets the per-account cap** (`lists.max_imported_per_user = 100`, §7), when an
  import would cross it (for example 60 already imported plus 60 new). The natural extension is
  "fill to the cap in the same order and report the rest", but that is not yet stated as a
  decision.
- **Whether editing the description or switching Numbered counts as an edit.** Decision 1 lists
  rename, visibility, reorder and add or remove. It does not name those two.

### D.4 What is kept for the future build

- **The real v7 fixture findings (§1).** They come from real bytes and do not need redoing:
  - `src/features/import/__fixtures__/real-list-export.ts` and its 11-test pin;
  - one CSV per list at `lists/<name>.csv`, CRLF with no BOM, in three sections;
  - `Position` runs 1..N;
  - an item's `URL` is the film's `boxd.it` URI, the same one `watched.csv` uses;
  - there is no field for ranked state or visibility.
- **The §10 questions** stay open, and they do not block a build.
- **A throwaway branch.** `feat/letterboxd-lists-import` (local only, `a124187`) is #196
  `b9b07c2` plus #200 and #201 merged. The import and Lists jest suites passed on it: 19/19
  suites, 324 tests. It has no commits of its own, and a future build can start there or
  start fresh.

### D.5 This is not the import-complete ranking bridge

**Today's Letterboxd watched-title importer already hands off to ranking. That hand-off is
separate from T6c, needs no Lists import, and must not be tied to this deferral.**

- **Today (stopping point):** the import summary leads with **Rank imported movies**
  (`ImportScreen` → `unrankedMovies()`, Collection ▸ Movies ▸ Unranked), and imported
  titles arrive unranked. Unranked carries the unified backlog's *Start ranking*
  ([`refine-rankings-t5.md`](refine-rankings-t5.md)), so imported titles are ranked in the
  one Unified Backlog flow. There is no separate "Rank your imports" product.
- **Open, not in the release:** PR #204 rewords that button to *Rank imported titles* and
  shows it only while the backlog has titles.
- **The bridge uses only watched rows.** A list import writes no `user_media` row, no
  watch and no ranking (§4), so list-only titles are never in Unranked and the bridge never
  deals them. Shipping, changing or re-pointing the bridge therefore needs nothing from this
  document, and T6c needs nothing from the bridge.

---

## 0. What the audit found first

1. **The list format is now known from real bytes.** The first draft had no list file to work
   from, because the 2026-09-10 export came from an account with no lists. On 2026-09-21
   the founder exported an account with two lists. §1 separates what that export confirms
   from what it cannot show.
2. **The shipped importer refused exports from people with many lists.** `archive.ts`
   refused any archive with more than 50 members, and a base export already has 16. The
   real export confirms **one CSV per list** (`lists/<name>.csv`), so an account with about
   34 lists was refused as "That file is too big" and could not import its watched history
   at all. **Fixed in PR #200 (T6c-0):** the limit is now 1,000, and the listing stops at the
   limit plus one. The byte caps, which are the real protection against zip bombs, are
   unchanged. List files are still never read.
3. **A new import row kind added the obvious way would be written to the Watchlist.**
   `_import_apply_batch` reads `if kind = 'watched' … else <insert into watchlist>`. Its
   latest body is #196's `20261003000100` (T1), not `20260917000300`. `_import_settle`'s
   `unmatched` and `ambiguous` counts ignore the kind as well. §9 makes pinning this the first
   requirement.
4. **A list whose name matches a history file shares that file's name.** A list named
   "Watched" would export as `lists/watched.csv`. That path is two segments, which is the
   "root or one wrapper folder" shape `archive.ts`'s rule accepts. Today the importer still
   picks the root `watched.csv`, but only because `inspect` takes the **first** match in
   listing order, and the real export stores root files before `lists/`. That makes it
   correct by order, not by rule.
   - **Risk:** if an export ever stored `lists/` first, the list file would be taken as the
     history. Its three-section shape has no `Name`/`Year` header, so the likely result is
     an "empty export" refusal rather than wrong data.
   - **What T6c-3 should do** (it changes current behaviour, so not before then): never
     accept `lists` as a wrapper folder, and prefer a root-level match.

---

## 1. What the Letterboxd export can do

**Evidence.** The founder's export of 2026-09-21 22:08 UTC: a 4,486-byte ZIP, 18 members,
two lists. The scrubbed copy is `src/features/import/__fixtures__/real-list-export.ts`, and
`real-list-export.test.ts` pins the structure. What follows is read from the bytes. Anything
not in the bytes is marked as such rather than inferred.

### 1a. The file, exactly

One file per list, at `lists/<name>.csv`, with **CRLF** line endings and **no BOM**. Here is
one real list, with the account-identifying values scrubbed:

```
Letterboxd list export v7
Date,Name,Tags,URL,Description
2026-09-22,Fixtureone,,https://boxd.it/LSTa1,

Position,Name,Year,URL,Description
1,Free Solo,2018,https://boxd.it/iEEq,
2,The Joke,1969,https://boxd.it/3A8q,
3,A Joke,1966,https://boxd.it/tLI2,
4,Ali: Fear Eats the Soul,1974,https://boxd.it/2aRi,
```

| Section | Line(s) | Content |
|---|---|---|
| Preamble | 1 | `Letterboxd list export v7`: one field, no commas |
| List header | 2 | `Date,Name,Tags,URL,Description` |
| List row | 3 | one row. `URL` is the list's `https://boxd.it/<code>` short link |
| Separator | 4 | an empty line |
| Item header | 5 | `Position,Name,Year,URL,Description` |
| Item rows | 6… | one per film. `Position` is 1..N and contiguous in file order. `URL` is the **film's** `https://boxd.it/<code>` URI |

The archive stores no wrapper folder and no directory entries. Member order is the 16 base
files, then `lists/`.

**The existing `parseCsv` cannot read this file.** It takes line 1 as the header. T6c-3 needs
a section-aware reader on the existing tokenizer: check the preamble, read one metadata
record, skip the blank record, then read the item header and rows.

### 1b. What this export confirms, rules out, and leaves open

| Question | Finding |
|---|---|
| Are lists exported? | **CONFIRMED PRESENT.** One CSV per list under `lists/` |
| File path | **CONFIRMED PRESENT:** `lists/<name>.csv`. Both real names were one word, and each file was that word in lower case. The rule for multi-word, punctuated or duplicate names is **STILL UNKNOWN**. |
| Format version | **CONFIRMED PRESENT:** `Letterboxd list export v7`, in the preamble |
| List name | **CONFIRMED PRESENT:** `Name` in the list row |
| List created date | **CONFIRMED PRESENT:** `Date`, `2026-09-22` for an export taken on 2026-09-21 UTC, the same next-day timezone stamp as `real-export.ts`. **Not used.** |
| List tags | **Column CONFIRMED PRESENT, empty in both lists.** The format of a non-empty value (separator, quoting) is **STILL UNKNOWN**. |
| List description | **Column CONFIRMED PRESENT, empty in both lists.** Multi-line, quoted, HTML or Markdown content is **STILL UNKNOWN**. |
| Canonical list URL | **CONFIRMED PRESENT:** a `https://boxd.it/<code>` short link, not a `letterboxd.com/<user>/list/<slug>/` URL. Whether it survives a rename is **STILL UNKNOWN**. |
| Item order | **CONFIRMED PRESENT:** `Position`, 1..N, matching file row order |
| Item name, year | **CONFIRMED PRESENT:** `Name`, `Year` |
| Item URL | **CONFIRMED PRESENT:** the film's `boxd.it` URI, **the same identifier `watched.csv` uses**. *Free Solo* is `boxd.it/iEEq` in both. |
| TMDB / IMDb id, original title | **CONFIRMED ABSENT IN THIS EXPORT** |
| Per-item note | **Column CONFIRMED PRESENT** (item `Description`), **empty in every row**. Its content format is **STILL UNKNOWN**. |
| Ranked / numbered state | **CONFIRMED ABSENT IN THIS EXPORT.** No column, no preamble marker, no other file. Both lists carry `Position` either way. Whether `Position` is also written for an unranked list, and so whether ranked state can be told apart at all, is **STILL UNKNOWN**: it depends on how the founder had these two lists set. |
| Visibility | **CONFIRMED ABSENT IN THIS EXPORT.** No column anywhere. Whether a **private** list is exported at all is **STILL UNKNOWN** until the founder confirms each list's setting. |
| Deleted lists | **CONFIRMED ABSENT IN THIS EXPORT.** No `deleted/lists*` member, and `deleted/` holds only `diary`, `reviews` and `comments`. Whether a deleted list would ever appear is **STILL UNKNOWN** unless a list was deleted before this export. |
| `likes/lists.csv` | **CONFIRMED PRESENT**, header `Date,Content`, empty here. It records **other people's** lists the person liked. **Never imported.** |
| TV | Letterboxd has no TV, so list items are movies. The SQL matcher is `kind = 'movie'`. |

**Nothing about the product defaults changes because this export lacks a field:**

- **Order** is always the file order and `Position`.
- **Numbered** defaults **off**. It maps from Letterboxd only if a later export proves a ranked
  field exists.
- **Visibility** is the import-level choice (§3), with Only you as the default.
- **Tags, the list date and per-item notes** are never imported.

---

## 2. Data mapping

| Letterboxd | bingd | Rule |
|---|---|---|
| List `Name` | `lists.title` | Trimmed and cut to 100 characters (the `lists_title_length` check). An empty name becomes "Untitled list". Cuts are reported. |
| List `Description` | `lists.description` | Plain text. HTML is stripped only if a later export shows it. Cut to 1,000 characters with "…". |
| List `URL` (`boxd.it`) | `imported_lists.source_key_hash` | The idempotency key (§5), stored only as a hash |
| Item `Position` | `list_items.position` | This order is the list's **manual order**. If `Position` is ever missing or not a number, the row index is used. Gaps are allowed, because readers number items 1..N at read time. |
| Ranked / numbered flag | none: **the field does not exist in this export** | `order_style = 'unranked'`, so **Numbered is off**. It maps to `ranked` only if a later export proves such a field exists. `Position` alone never turns Numbered on. |
| Item `Name`, `Year`, `URL` | an `import_rows` entry of new kind `list` | The existing matcher, unchanged (§4) |
| List `Tags`, list `Date` | not stored, not sent | Lists v1 has no field for them. |
| Item `Description` (per-item note) | **not stored, not sent** | It **never** becomes a bingd note, review, `user_media.note` or watch detail. Lists v1 has no per-item note, and turning it into anything else would invent the person's own writing somewhere they didn't put it. |
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

**The real export has no visibility field** (§1b), so this is the design that ships. The
person chooses once for every imported list:

- One picker on the preview, using `VisibilityPicker` and the three labels above.
- **Only you is the default.**
- Public is disabled, with #196's reason, while the profile is private, because the writers
  refuse Public on a private profile.
- The summary says: "12 lists added · Only you. You can change any list later."
- Nobody edits lists one at a time.

**Reserved for a future export that has a reliable visibility field.** None exists today.
Each list would get the stricter of its Letterboxd visibility and the import-level choice,
so an import never makes a list more visible than it was on Letterboxd:

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
  - Only `lists/<name>.csv` is ever read, at the root or under the export's single wrapper
    folder.
  - `likes/`, `deleted/` and `orphaned/` stay unread.
  - Only the list name, description and URL, and each item's name, year, film URI and
    position, leave the device. The list URL is hashed on arrival. Tags, the list date and
    per-item notes are never sent.

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
- **List rows can read the trusted mapping.** The real export confirms that an item's `URL` is
  the film's `boxd.it` URI, the same identifier `watched.csv` uses (*Free Solo* is `iEEq` in
  both). T0 keys on exactly that. The client still stages a list item's URI only if it has
  that `https://boxd.it/<code>` shape, in case a later format changes.
- **Real matching cases in the fixture:**
  - three *Batman* rows (1989, 1943, 1966), which exercise the exact-year rule;
  - *The Joke* (1969) beside *A Joke* (1966), which are distinct names because
    `media_squash` keeps articles.
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

- **The key is the list row's `URL`**, a `https://boxd.it/<code>` short link that **is present
  in the real export**. The file name is the fallback only if a row has no URL. Only the hash
  is stored, because the short link resolves to the owner's list page and so identifies the
  account.
- **A re-import skips lists that are already there** ("Already in bingd, left as is").
  Anything changed in bingd — order, removals, Numbered, visibility — is never overwritten.
- **A deleted bingd list** takes its mapping with it, so a re-import recreates it. To keep it
  gone, untick it in *Choose lists*.
- **A list renamed on Letterboxd.** If its `boxd.it` short link stays the same across the
  rename, which looks likely because short links are ID-based but is **not yet shown**, a
  re-import recognises it. Otherwise it imports as a new list. The file name changes with
  the name, so it is never the primary key.
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
   - **Choose lists ›**, everything ticked except lists already in bingd. ~~This is required
     when there are more lists than the cap.~~ **Superseded by founder decision D.3.2:** above
     100, the first 100 (in a deterministic order) are imported and the rest are reported as
     skipped. The archive is never refused for it. How the chooser presents this is left to the
     build.
2. **History gets its own toggle**, so someone who has already imported can bring **lists
   only**.
3. **Summary:**
   - counts: "12 lists added · Only you", left-out items per list, "3 already in bingd",
     "2 longer than 500: first 500 kept";
   - actions: **See my lists**, which opens **Collection ▸ Lists**, and **Remove imported
     lists**.
4. **Remove imported lists** deletes that import's lists after a confirmation. Lists edited
   since the import are kept, and the confirmation says so. "Edited" is defined by founder
   decision D.3.1: any user-initiated rename, visibility change, reorder, or adding or removing
   a title. System and moderation changes do not count. It exists because Lists v1 has no
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
| Lists per import | 100 (new `import.max_lists`) | Client chooser and server. Above it, the first 100 are imported deterministically and the skipped count is reported (D.3.2) |
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

- **Not T6.** T6 (*Rank what you've watched*) was ranking. As a standalone flow it no longer
  exists, because the Unified Backlog (#203) is it. Either way, a list import must not touch
  ranking.
- **Not T6b, but it reuses it.** T6b's repair writes a Collection row "exactly as the importer
  would". It has to learn about the new kind: fixing a list entry adds it to its lists only,
  and adds to the Collection only if the same correlation is also a watched row.

| Step | What | Depends on |
|---|---|---|
| **T6c-0** | Archive member count 50 → 1,000; the listing stops at the limit plus one. Client only, OTA. | **PR #200** |
| **T6c-1** | A real export with lists, and a scrubbed fixture that leaves out `profile.csv` | **Done, 2026-09-21:** `real-list-export.ts` plus its test (§1). The questions in §10 are still open. |
| **T6c-2** | Backend (§9), behind `import.lists_enabled = false`. **Deferred post-freeze (§D).** | #196 on production (met 2026-09-23); #200 (merged); the two decisions in §D.3 (made 2026-09-23); a rechecked migration number; a founder go |
| **T6c-3** | Client work, OTA-deliverable: the `lists/<name>.csv` path rule, which never takes `lists` as a wrapper folder and prefers a root match (§0 item 4); a section-aware reader for the v7 format on the existing tokenizer (§1a); preview and summary | T6c-2 |
| **T6c-4** | Repair for list entries | T6b |

---

## 9. Migrations and API likely needed

**One migration.** It is numbered `20261020000100` or later: #196 ends at `20261018000100`,
and Unified Ranking takes `20261019000100` (§D.2). Both projects stood at `20261019000100` on
2026-09-23. **Recheck the heads on the repo, both projects and every open PR before
implementation.** It must rebuild each function from its **latest** definition, and that list must
be checked again at build time too:

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

The two blocking decisions are made (§D.3, 2026-09-23). The details §D.3 leaves to the build
(the order that defines "first 100", the per-account cap crossing, and whether description or
Numbered edits count) are the only product questions left. No other product decision is left
open that a default can't cover. The 2026-09-21 export settled
the format: file layout, columns, film URIs and ordering (§1b). **None of what is still open
blocks T6c-2**, because every open question has a safe default already in this document.

**1. Two quick answers about the export already taken**

- Were the two lists in that export (`fixtureone` and `fixturetwo` in the fixture) **ranked**
  or **unranked** on Letterboxd? If one was each,
  `Position` is written for unranked lists too, so ranked state can't be told from the file.
  Numbered then stays off permanently.
- What was each list's **visibility**? If one was private, private lists are exported, and
  the one import-level picker is the right design.
- Was a list **deleted** before exporting? If so, deleted lists are left out of the export.

**2. One more export, only to pin the formats nobody has seen yet**

- a list with **tags**;
- a **multi-line description** containing a link, a comma and a quote;
- **per-item notes**;
- a **multi-word name with punctuation**, to learn the file-name rule;
- two lists with the **same name**;
- one list **renamed** since the first export, to check whether its `boxd.it` link survives.

**Whatever these show, the defaults stand:**

- the manual order from `Position`;
- Numbered off unless a real field says ranked;
- one import-level visibility choice, Only you by default;
- tags, the list date and per-item notes never imported;
- nothing written about the person: no Collection membership, watch, date, ranking or
  Watchlist entry.
