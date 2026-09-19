# Recommendation note + Watch next — design

**Status:** **APPROVED 2026-09-19** (founder decisions F1 and F2 in §14). Implemented by the four PRs in §12: backend migrations `20260929000100` (recommendation note) and `20260929000200` (Watch next), each with a client PR stacked on it. Nothing is deployed to production and no OTA is published; the tranche waits for the bundled device QA in §11.3.
**Audited against:** `origin/main` at `c77d524` (after #171–#173). Every file and line reference below is at that commit, and some have moved since.
**Scope:** two small features in one bounded tranche. Both are JS + SQL and OTA-deliverable. There are no new dependencies and no native changes.

---

## 0. Summary

| | Recommendation note | Watch next |
|---|---|---|
| What | An optional note of up to 140 characters sent with a direct recommendation | Up to 3 Watchlist titles pinned to the top of the Watchlist |
| Entry | An "Add a note (optional)" field above the RecommendSheet footer. Sending without a note takes the same taps as today | Press and hold a Watchlist poster or row → "Add to Watch next" |
| Recipient sees | A 2-line note in the Sent to you row, and the full note in a card on the title page, placed below the title rather than on the artwork | n/a (private to the owner) |
| Backend | 1 migration: `message` column, a 4-arg `recommend_title`, `message` in `recommendations_to_me`, a title-page lookup RPC, a `recommendation` report subject | 1 migration: a `watch_next` table with an FK into `watchlist` (cascade), one definer RPC, a structural cap of 3 |
| Feed / push | Nothing new. Push copy is unchanged and never carries the note | Nothing. No feed event, no notification |
| PRs | R1 backend, R2 client | W1 backend, W2 client |
| Ship | **The same QA/release bundle**: one staging window, one physical QA pass, one production OTA (§13) | |

---

# Part A — Recommendation note

## 1. Current-state audit

### 1.1 Schema: `title_recommendations`

Created in `20260817001300_recommend_to_a_friend.sql` §1 and extended by `20260826000400_a_recommendation_that_waits_for_you.sql` and `20260827000600_a_recommendation_that_hears_back.sql`.

| Column | Meaning |
|---|---|
| `id, sender_id, recipient_id, media_item_id` | `unique (sender_id, recipient_id, media_item_id)`, meaning one row per pair and title for good. Checked `sender_id <> recipient_id`. |
| `created_at` | First send. Conversion is measured from this. |
| `recommended_at` | Latest send. A resend moves it. |
| `opened_at` | Set once by `mark_recommendation_opened`. Never cleared, so a resend cannot re-badge the recipient. |
| `state` | `pending` / `delivered` / `dismissed` (20260826000400 §1). **Granted to nobody** (column privileges). |
| `fulfilled_at` | Written by `_rank_finalize` (20260827000600). Granted to nobody. |

All FKs are `on delete cascade` (profiles, media_items).

**RLS and grants** (20260826000400 §2):
- `title_recommendations_recipient`: `recipient_id = auth.uid() and state = 'delivered'`.
- `title_recommendations_sender`: `sender_id = auth.uid()`.
- `select (id, sender_id, recipient_id, media_item_id, created_at, recommended_at, opened_at)` is granted to `authenticated`. **Any new column is invisible until it is granted explicitly.** This is the pattern that hides `state` and `fulfilled_at`, and it is the safe default for `message`.

**Explicit prior decision to reverse.** The header of 20260826000400 lists under "WHAT IS DELIBERATELY NOT HERE": *"No message, no reply, no read receipt."* This tranche reverses **"no message"** only. Reply and read receipt stay out.

### 1.2 Send path

- `recommend_title(p_operation_id, p_recipient_id, p_media_item_id)`: latest body in 20260826000400 §5. Order: `assert_can_write` → `_claim_operation` → rate limits 20/h and 50/day → `_lock_pair` → `_may_recommend_to` (the sender approvedly follows the recipient) → exact object only (movie or season) → per-pair pending cap of 5 when the recipient does not follow back → `delivered` if they do, `pending` otherwise → a `recommendation` notification **only when the row enters `delivered`**. Refusals are *returned*, not raised, so a refused attempt still spends its rate-limit claim.
- Client: `src/features/recommendations/RecommendSheet.tsx` is a multi-select picker (PeoplePicker) with a sticky footer `[Recommend] [Share off bingd]`. One `recommend_title` call per chosen person, sequentially, each under its own held operation id. A batch that partly fails keeps the failures selected.
- `src/features/recommendations/use-recommend.ts:195` still says *"no multi-select, no send-to-all, no message"*. The comment is already stale (multi-select shipped) and must be rewritten in R2.
- Awards: Hype Courier counts sends through a trigger `after insert on title_recommendations` (20260828000100). The note does not affect it.

### 1.3 Recipient state and surfaces

| Surface | Today |
|---|---|
| **Sent to you** (`src/features/recommendations/SentToYouList.tsx`) | `recommendations_to_me(p_limit)` is **security invoker**. It has no visibility logic of its own: RLS drops pending/dismissed rows and `profiles_read` drops blocked or private senders. The list shows unopened first, then newest, capped at 200. The client hides already-ranked titles (`withoutRanked`, `src/features/recommendations/use-sent-to-you.ts:149`). Each row is: title (year) / `"Ada recommended this · 2d ago"` / metadata, with a bookmark toggle and an unopened dot. |
| **Requests** (pending) | `recommendation_requests()` is **security definer** because a private sender must still be nameable. Rows are grouped by sender. Actions: Add / Dismiss / Dismiss all. Pending rows never file a notification. |
| **Title page** (`app/title/[id].tsx`) | Context arrives as **route params** `recBy` / `recAt` (lines 199–203), set **only** by Sent to you (`app/(tabs)/recommendations.tsx:636`). `RecommendedCallout` (line 2286) is a one-line, non-interactive pill. When there is artwork it is overlaid absolutely at the hero's **lower** edge (`bottom: space[3]`, line ~2601). Without artwork it sits in the flow after the identity block (line 1450). |
| **Opened** | `mark_recommendation_opened` fires only from a Sent to you tap. Opening the title from the inbox, a push, search or the Feed shows **no context and does not mark it opened**. This is a real gap today, and the note makes it worse. |
| **Notifications** | Inbox row `recommendation`. Push copy is `"{name}: recommended {title}"` (`supabase/functions/push-sender/copy.ts:231`). Routing: title first, then profile (`src/features/notifications/routing.ts:223`). The copy file's rule is that push never quotes user text (mentions are the same). |
| **Fulfilment** | `_rank_finalize` (latest 20260902000100) stamps `fulfilled_at` and files `recommendation_ranked` to each sender who passes `can_view_profile`. |
| **Feed** | Recommendations produce no feed events. |

### 1.4 Deletion, block, duplicates

- **Block** (latest `block()` in 20260826000400 §11): deletes pending rows in both directions. Delivered rows stay but disappear from every invoker read while the block stands (`profiles_read`).
- **Unfollow:** a delivered row is never demoted.
- **Account deletion:** FK cascade.
- **Suspension:** `p.status = 'active'` joins drop the sender everywhere.
- **Duplicates:** a resend updates the one row. `recommended_at` moves, `opened_at` stays, no second notification (the anti-ping rule).
- **Moderation:** `report(report_subject, uuid, text, text)` covers `profile, display_name, username, list, list_title, watch_tag, comment, review` (20260825000100). **PRD §22 makes reporting mandatory for surfaces that carry user writing**, and a note is user writing, so it needs a report path.
- **Analytics:** `recommendation_sent {media_kind, surface}` and `recommendation_opened {media_kind, surface: 'sent_to_you'}` (`src/lib/analytics.ts:418`).

## 2. MVP

### 2.1 Rules

1. **Optional, at most 140 characters, plain text.** The server normalises: trim, collapse any whitespace run (including newlines) to one space, and treat empty as null. Over 140 raises `22023` **before** `_claim_operation`, so a too-long note spends no quota. No links are rendered and no mentions are parsed.
   *Why 140:* the examples are 30–50 characters. The profile bio is 120 and a comment is 1000. At 140 it stays a note rather than a review, and it fits the Sent to you row in two lines and the title card in three.
2. **One note per send, and the same note for every recipient in that send.** When two or more people are selected, the placeholder says so.
3. **A resend with a note replaces the stored note. A resend without a note keeps it.** Every existing duplicate rule still holds: no second notification, `opened_at` untouched, `recommended_at` moves.
4. **Delivered recommendations show the note. Pending requests do not.** A pending row comes from someone the recipient has *not* followed back, which is the exact trust boundary 20260826000400 was built around. Showing their free text in Requests would give an untrusted sender a new message channel. The note is stored and appears once the row is delivered (Add, or a follow-back).
5. **Push and the inbox row stay unchanged.** The lock screen never shows the note. The inbox row still reads "recommended {title}". Tapping it opens the title page, which now shows the note (rule 6).
6. **The title page shows the context whenever the viewer holds an unranked delivered recommendation for that exact title, however they arrived** (Sent to you, inbox, push, search, Feed). This replaces the `recBy`/`recAt` route params. It reverses the page's current reasoning that "the fact belongs to the navigation": a friend's unanswered note is a fact about this title *for this viewer* until they rank it, in the same way "on your Watchlist" is. The ranked rule is the one Sent to you already uses.
7. **Opening marks it opened.** When the title page shows the context, it calls `mark_recommendation_opened` once for each displayed unopened row. This closes the gap that exists today for inbox and push opens.
8. **Report.** Long-press the note on the title page (and the row's accessibility action) → Report. This uses the existing `report()` with a new subject, `recommendation`, whose owner is the sender.
9. **No edit, no unsend, no reply, no read receipt.** Unfollow, block and report are the recipient's controls, as they are today.

### 2.2 Send UX (RecommendSheet)

- A **single-line text field directly above the footer**, visible whenever there is anyone to pick. Placeholder: *"Add a note (optional)"*. With two or more selected: *"Add a note — everyone you picked sees it"*.
- **No expander.** An "Add a note" link that opens a field costs one extra tap to write a note and saves nothing when you don't. The field adds no tap to the no-note path, because Recommend works with it empty.
- The field grows to 3 lines as you type (`multiline` for wrapping only; the return key does not insert a newline). `maxLength={140}`. A counter appears only in the last 20 characters (`"12 left"`).
- `Sheet` already rises with the keyboard (`src/ui/components/Sheet.tsx:109`), so the field and footer stay visible above it. PeoplePicker's search field has used this path since #89.
- The note survives a partly failed batch, so a retry resends it.
- **"Share off bingd"** includes a typed note as the message's first line (`"{note}\n\n{title} on bingd\n{url}"`). Otherwise text someone just typed would be silently dropped.
- **No-note sends call the existing 3-arg RPC unchanged.** Only a non-empty note calls the 4-arg form. So the common path is byte-for-byte what ships today, including against a backend that is one migration behind.

### 2.3 Recipient list UX (Sent to you)

- **In the row, truncated to 2 lines**, quoted, in secondary tone. The note **replaces the metadata line**, so a row stays at three text lines. Metadata still drives filters, and the title page shows it anyway.
- Rows without a note are unchanged.
- The full note is on the title page. Nothing expands in place (see §3.2).

### 2.4 Title page

**Recommendation (default): one in-flow card below the identity block, whether or not there is artwork.** Nothing is drawn on the hero.

- The card goes exactly where the no-artwork callout already renders (after the identity/actions block, before Scores). The two layouts become one, and `recommendedOverlay` is deleted.
- It is above the fold on every supported phone. The hero (16:9) and identity block together are about 420pt tall on a 390pt-wide phone.
- It sits beside Rank / Save / Recommend, the actions the note is trying to prompt.
- It follows the founder's 2026-09-07 rule for this page: primary text never depends on being readable over a backdrop nobody chose.

**Evaluated and not recommended: a top-aligned overlay under the nav bar.** On a 390pt phone the hero is about 220pt, and the transparent nav bar plus safe area takes the top ~100pt. A top-aligned card of 1–3 lines would cover most of the artwork that is left, and a hero-top element competes with the back control's tap area. A **one-line top pill with the note in the flow** (wireframe C.3) is a valid variant if the founder prefers the attribution on the artwork, but it splits one fact into two objects. Founder decision F1 (§14).

### 2.5 Multiple recommenders of one title

- The card shows the **newest** recommender's note, attributed as *"Ada and 2 others · 2d ago"* with an avatar stack (max 2) and a chevron.
- Tapping opens **one small sheet** listing every recommender (avatar, name, time, full note or "No note"). Newest first. Tapping a name goes to the profile.
- With one recommender, the card is not tappable except for Report on long-press.
- If the newest recommender wrote no note but an older one did, the card shows the **newest note that exists**, still attributed to that person. A note is the more useful fact, and the sheet has the rest.
- Nothing else: no stack animation, no carousel, no per-sender pagination. The server returns at most 10.

### 2.6 Privacy and deletion matrix

| Event | Note behaviour | Mechanism (existing unless marked) |
|---|---|---|
| Sender unfollows the recipient | Delivered note stays visible | Delivered is never demoted (20260826000400 §5) |
| Recipient unfollows the sender | Stays if the sender's profile is public. Disappears if the sender is private (the recipient can no longer view them) | `profiles_read` in the invoker reads |
| Either party blocks | Pending row (and its note) **deleted**. Delivered note hidden while the block stands, and back on unblock | `block()` §11 + `profiles_read` |
| Recommendation fulfilled (recipient ranks the title) | Gone from Sent to you and from the title card | Client ranked filter (existing and new lookup) |
| Recipient dismisses a pending request | Tombstone. The note is never shown | Existing state machine |
| Sender or recipient deletes their account | Row and note deleted | FK cascade |
| Sender suspended | Hidden everywhere | `status = 'active'` joins |
| Title removed from the catalogue | Row deleted | FK cascade |
| Reported | Row unchanged. A report is queued with owner = sender. The operator reads the live text (**as for reviews**, which are also editable and not snapshotted) | **NEW** `report_subject` value `recommendation` |
| "Recommendation removed" (unsend) | Does not exist, and is not added | n/a |

## 3. Wireframes

### 3.1 RecommendSheet

```
┌─────────────────────────────────────────┐
│ Recommend The Martian                   │
│ ┌─────────────────────────────────────┐ │
│ │ 🔍 Search your friends              │ │
│ └─────────────────────────────────────┘ │
│ (◉) Ada Lovelace                    [ ] │
│ (◉) Bo                              [✓] │
│ (◉) Cy                              [ ] │
│                 … scrolls …             │
├─────────────────────────────────────────┤  ← pinned region (unchanged position)
│ ┌─────────────────────────────────────┐ │
│ │ Add a note (optional)               │ │  ← NEW: 1 line, grows to 3
│ └─────────────────────────────────────┘ │
│                                12 left  │  ← only in the last 20 chars
│ [    Recommend    ] [ Share off bingd ] │
└─────────────────────────────────────────┘
```

### 3.2 Sent to you row

```
With a note:
┌──────┬──────────────────────────────────────────┐
│poster│ The Martian (2015)                   •  🔖│
│      │ Ada recommended this · 2d ago            │
│      │ "The second half is insane. Watch it     │
│      │  before Saturday so we can talk ab…"     │
└──────┴──────────────────────────────────────────┘
Without a note: exactly as today (metadata as line 3).
```

### 3.3 Title page (recommended: in flow)

```
┌─────────────────────────────────────────┐
│ ‹                                       │ ← transparent nav
│                                         │
│          [ backdrop, nothing on it ]    │
│                                         │
├─────────────────────────────────────────┤
│ The Martian                   ┌───────┐ │
│ 2015 · 2h 24m · Sci-fi        │poster │ │
│ [ Rank ]  🔖  ✈                │       │ │
│                               └───────┘ │
│ ┌─────────────────────────────────────┐ │ ← NEW position, same for no-artwork
│ │ (◉) Ada · 2d ago                    │ │
│ │ "The second half is insane."        │ │ ← up to 3 lines, then "…"
│ └─────────────────────────────────────┘ │
│ Scores …                                │
```

No note: one line, `✈ Recommended by Ada · 2d ago`, in the same card position.

Several recommenders:

```
│ ┌─────────────────────────────────────┐ │
│ │ (◉◉) Ada and 2 others · 2d ago    › │ │
│ │ "The second half is insane."        │ │
│ └─────────────────────────────────────┘ │
        tap ▼
┌─────────────────────────────────────────┐
│ Recommended by                          │
│ (◉) Ada · 2d ago                        │
│     "The second half is insane."        │
│ (◉) Bo · 5d ago                         │
│     No note                             │
│ (◉) Cy · 1w ago                         │
│     "This is the one I was talking      │
│      about."                            │
└─────────────────────────────────────────┘
```

**Variant C.3 (founder's top-aligned option, not recommended):** a one-line solid pill at `top = insets.top + NAV_BAR_HEIGHT + space[2]` on the hero reading `✈ Ada · 2d ago`, with the note card still in the flow as above.

## 4. Data and schema changes (PR R1, one migration)

Numbered `20260929000100`, from the range reserved for this tranche (main's head was `20260927000100` when it was taken). It is **additive only**, per the applied-migrations-are-immutable rule.

1. **Column**
   `alter table title_recommendations add column message text constraint recommendation_message_length check (message is null or (char_length(message) between 1 and 140));`
   Then `grant select (message) on title_recommendations to authenticated;`. With the existing policies, only the sender (own rows) and the recipient (delivered rows) can read it. **Pending notes stay unreadable to the recipient by construction**: the recipient policy does not admit pending rows, and `recommendation_requests` does not return the column.
2. **Writer: rebuild in full from the 20260826000400 §5 body** (SQL rebuild trap: grep every `recommend_title` hit first; today the only bodies are 20260817001300 and 20260826000400).
   - New `recommend_title(p_operation_id uuid, p_recipient_id uuid, p_media_item_id uuid, p_message text)` with **no default**, holding the whole body plus: normalise and validate before the claim; on insert, write `message`; on update, `message = coalesce(v_message, message)`.
   - The existing 3-arg `recommend_title` becomes a `create or replace` **thin wrapper** calling the 4-arg with `null`. Its grant is preserved, and the iOS/Android binaries in the field keep working. The two signatures do not collide in PostgREST because neither has a default: three named args match only the 3-arg function.
   - Grant execute on the 4-arg to `authenticated`.
3. **Reader: `recommendations_to_me`.** The return type changes, so `drop function` + `create function` + restate the grant (the `drop` takes the grant with it; see the 20260817001300 §7 note). Add `message text`. It stays **security invoker** with no visibility logic. Old clients ignore the extra column.
4. **New reader: `title_recommendations_for_me(p_media_item_id uuid)`.** **Security invoker**, the same join shape as `recommendations_to_me` (inner join `profiles` with `status = 'active'`), `where r.recipient_id = auth.uid() and r.media_item_id = p_media_item_id`, `order by recommended_at desc limit 10`. Returns `id, sender_id, sender_username, sender_display_name, sender_avatar_path, message, recommended_at, opened_at`. RLS handles delivered-only, blocks and privacy exactly as it does for Sent to you.
   Index: `create index title_recommendations_recipient_media on title_recommendations (recipient_id, media_item_id);` (the inbox index leads with `recommended_at`).
5. **Moderation.** `alter type report_subject add value if not exists 'recommendation';` and rebuild `report()` from its **latest** body (find it with the rename-aware grep; 20260825000100 is the last known) with one new branch: the subject is a `title_recommendations.id` where the caller is the recipient, **`message is not null`** and the row is delivered, and the owner is `sender_id`. Anything else gets the existing not-found answer. Using the new enum value only inside a plpgsql body in the same file is the 20260825000100 precedent and is safe in one transaction.
6. **Unchanged:** `recommendation_requests`, `add_recommendation`, `dismiss_*`, `block`, `_rank_finalize`, `my_notifications`, `claim_push_batch`, push copy. **No edge-function deploy** (see the edge-function deploy gap).

---

# Part B — Watch next

## 5. Current-state audit

### 5.1 Schema

- `watchlist (user_id, media_item_id, created_at)`, PK `(user_id, media_item_id)`, cascading from `profiles` and `media_items` (20260813000500). It accepts movies, seasons **and series**.
- **Reads are public profile content** since 2026-08-20: `watchlist_read using (can_i_view(user_id))` (20260820000200). Any column added to this table is readable by anyone who can view the profile unless column grants are narrowed. That is the main reason Watch next does **not** go on this table (§8).
- There is **no order or priority concept.** The client orders by `created_at desc`, then applies the sort chip.
- Indexes: `watchlist_owner_recent (user_id, created_at desc, media_item_id)` and `watchlist_recent (created_at)`.

### 5.2 Every writer

| Writer | Effect | Source |
|---|---|---|
| `set_watchlist(op, media, present)` | Definer, op-id. An add also writes the **one durable** `watchlist_added` feed event (partial unique index) | 20260820000300 |
| `_leave_watchlist()` triggers | Deletes the exact (user, title) when it is watched or ranked: `user_media` insert/update **transitions**, `rankings` insert | 20260815040000 |
| `_leave_series_watchlist()` triggers | Deletes a **series** once every released normal season is met. Advisory key `series-watchlist:{user}:{series}`, strictly innermost | 20260906000100 |
| Letterboxd import apply | Inserts `watchlist` rows **directly** (no feed event) | 20260917000300 |
| Award triggers | Queue Dragon, after insert and after delete | 20260828000100, 20260904000100 |
| Account / title deletion | FK cascade | |

Unlog does **not** restore a watchlist row (a deliberate one-way rule, 20260815040000).

### 5.3 Client

- `useWatchlist` reads every page (`src/features/collection/use-collection.ts:363`). The Feed, Recommendations and Queue Dragon build `saved` sets from it.
- Collection → **Movies/TV** partition → **Watched / Watchlist / Unranked** segment → `CollectionView` (`src/features/collection/CollectionView.tsx:126`), shared by all three segments.
  - **Poster** (default) is the virtualised `PosterGridList`, **3 columns** (`src/ui/components/PosterWall.tsx:194`). **List** is a FlashList of `TitleRow`.
  - Watchlist sort axes: Recently added / Year / Title / Shuffle (`sortAxesFor`, `src/features/collection/filters.ts:534`). The filter sheet has no buckets. The count line reads "N titles" or "N of M".
  - **No long-press anywhere in CollectionView.** The non-virtualised `PosterGrid` already accepts `onLongPressTile` (For You uses it). `PosterGridList` and `TitleRow` do not.
- The title page's `Save` is a one-tap bookmark toggle. The only overflow menu is the Ranked menu, which exists only for ranked titles, and those are never on the Watchlist. The Lists PRD (BUILD-READY, L2) adds a title-page **⋯** with "Add to list…" first.
- The profile Watchlist shelf shows the 12 most recent and is public.
- Group Picks reads members' watchlists as an invoker RPC.

## 6. MVP

### 6.1 Rules

1. **A hard cap of exactly 3.** It is enforced structurally (§8). Three is one full row of the 3-column poster wall, so the pinned block is one clean row in Poster mode.
2. **Watch next is a subset of the Watchlist, by foreign key.** Removing the Watchlist row by any path (Save toggled off, logging, ranking, finishing a series, the import, account or title deletion) removes the pin automatically. There is no trigger to maintain and every current and future watchlist writer inherits it.
3. **Any Watchlist row can be pinned:** movie, season or series. A pinned series survives watching one season, because the series row stays until it is finished (20260906000100).
4. **Private to the owner.** It is not shown on the profile shelf, not visible to followers, not used by Group Picks and not in the Feed. See F2 (§14) if the founder wants it social later; that is a one-line policy change.
5. **No feed event, no notification, no award.**
6. **Order:** by slot (1–3). A new pin takes the lowest free slot. A replacement takes the replaced title's slot. There is no manual reordering in the MVP.

### 6.2 Entry point: press and hold, nothing added to the add flow

- **Collection → Watchlist: press and hold any poster or row** → a small sheet titled with the title → **"Add to Watch next"**, or **"Remove from Watch next"** if it is pinned. That is 2 gestures, and nothing changes when adding to the Watchlist.
- **Accessibility:** the same action is exposed as a VoiceOver/TalkBack custom action on each tile and row (`accessibilityActions`), because a long-press is invisible to screen-reader users.
- **Discoverability:** a **one-time hint line** under the count, *"Press and hold a title to pin it to Watch next."*, shown only when the Watchlist has at least 5 titles and nothing is pinned. It is dismissed permanently by its ✕ or by the first pin (device preference, like the view mode). There is no coach-mark and no badge.
- **Title page:** **not in the MVP.** Adding a ⋯ just for this breaks the no-clutter brief. When Lists L2 ships the title-page ⋯, W3 adds one row, *"Add to Watch next"*, shown only when the title is on the Watchlist. If Watch next ships first, the title page gains nothing until then.
- Not offered from Sent to you, For You, Search or the profile.

### 6.3 When 3 are already pinned: replace in the same sheet (recommended)

Press and hold a 4th title → the same sheet opens straight into **"Watch next is full. Replace one:"** with the three pinned titles as rows. Tapping one swaps it atomically (one RPC). Cancel leaves everything as it was. **That is 2 taps total.**

| Option | Verdict |
|---|---|
| **Replace picker in the same sheet** | **Chosen.** No dead end, one atomic write, and it teaches the cap when it first matters |
| Disable and explain | A dead end. The user must cancel, find a pinned title, unpin it, and come back: 4+ gestures |
| Allow 4 temporarily | Breaks the server cap and turns "about three" into "however many" |
| Auto-evict the oldest | Silent data loss of something the user chose |

### 6.4 Watchlist display

- **One list, with the pinned titles drawn as the list's header, in the current mode's own idiom.** In Poster mode that is up to 3 tiles in one row. In List mode it is up to 3 `TitleRow`s. A small label, *"Watch next"* (footnote, secondary tone), sits above, followed by `space[4]` and then the rest.
- **No duplicate rendering:** pinned titles are removed from the virtualised data and drawn only in the header. The header is `ListHeaderComponent`, so it scrolls with the list and is not sticky. Virtualisation of the rest is untouched.
- **Medium:** pins follow the Movies/TV partition. On the Movies tab only pinned movies appear, and on TV only pinned seasons and series. **The cap is 3 across both.** If the Movies tab has 0 pinned, it shows no header even when 3 TV titles are pinned. The full-sheet lists all 3 whatever the medium, so replacing across media works.
- **Filters apply to pinned titles too.** A Comedy filter hides a pinned drama, and the "N of M" count stays honest. If every pinned title is filtered out, the header disappears. (The alternative, "always visible", would put a non-matching title above the result set and make the count lie.)
- **Sort does not apply to pinned titles.** They stay in slot order above the sorted rest under every axis, including Shuffle.
- The **count line counts pinned titles** ("14 titles" means the whole Watchlist, as today).
- **Small screens:** at 320pt three tiles are about 90pt wide, the same tile as the rest of the wall. The header is at most one poster row or three list rows (about 200pt).
- **Logged or ranked** → the pin leaves with the Watchlist row (the cascade). **Save toggled off on the title page** → the same.

## 7. Wireframes

### 7.1 Poster mode (default)

```
┌─────────────────────────────────────────┐
│      [ Movies | TV ]                    │
│  [ Watched | Watchlist | Unranked ]     │
│ [Filters] [Recently added ↓]    [▦][≡]  │
│ 14 titles                               │
│ Watch next                              │ ← only when ≥1 pinned is visible
│ ┌─────┐ ┌─────┐ ┌─────┐                 │
│ │Dune │ │Anora│ │Brut-│                 │ ← header row, not virtualised
│ │ 2   │ │     │ │alist│                 │
│ └─────┘ └─────┘ └─────┘                 │
│                                         │ ← space[4], no rule
│ ┌─────┐ ┌─────┐ ┌─────┐                 │
│ │     │ │     │ │     │                 │ ← virtualised rest, sorted
│ └─────┘ └─────┘ └─────┘                 │
```

Zero pinned, 5 or more saved, hint not yet dismissed:

```
│ 14 titles                               │
│ Press and hold a title to pin it to  ✕  │
│ Watch next.                             │
│ ┌─────┐ ┌─────┐ ┌─────┐                 │
```

### 7.2 List mode

```
│ 14 titles                               │
│ Watch next                              │
│ [p] Dune: Part Two (2024)               │
│     2h 46m · Sci-fi                     │
│ [p] Anora (2024)                        │
│     2h 19m · Drama                      │
│                                         │
│ [p] … rest, sorted …                    │
```

### 7.3 Long-press sheet

```
Not pinned, room available:        Pinned:
┌───────────────────────────┐      ┌───────────────────────────┐
│ Dune: Part Two            │      │ Dune: Part Two            │
│ 📌 Add to Watch next      │      │ 📌 Remove from Watch next │
│    Cancel                 │      │    Cancel                 │
└───────────────────────────┘      └───────────────────────────┘

Full (3 pinned):
┌───────────────────────────────────────┐
│ Watch next is full                    │
│ Replace one with Dune: Part Two?      │
│ [p] Anora (2024)                  ›   │
│ [p] The Brutalist (2024)          ›   │
│ [p] Severance · TV                ›   │
│    Cancel                             │
└───────────────────────────────────────┘
```

## 8. Data and schema changes (PR W1, one migration)

**A separate owner-only table with an FK into `watchlist`.** This is the smallest representation that meets every requirement without touching the watchlist's schema, policies, grants, triggers or feed rule.

```sql
create table watch_next (
  user_id       uuid        not null,
  media_item_id uuid        not null,
  slot          smallint    not null constraint watch_next_slot check (slot between 1 and 3),
  created_at    timestamptz not null default now(),
  primary key (user_id, media_item_id),
  constraint watch_next_one_per_slot unique (user_id, slot),
  constraint watch_next_on_watchlist foreign key (user_id, media_item_id)
    references watchlist (user_id, media_item_id) on delete cascade
);
alter table watch_next enable row level security;
create policy watch_next_own on watch_next for select using (user_id = auth.uid());
revoke all on watch_next from anon;
grant select on watch_next to authenticated;
-- no insert/update/delete policy: writes are definer-only (AD-4)
```

**Why not the alternatives**

| Option | Problem |
|---|---|
| `watch_next_slot` column on `watchlist` | `watchlist_read` is public (`can_i_view`). Hiding one column means revoking the table-wide select and granting a column list on a table that the profile shelf, Group Picks (invoker), the Feed's saved sets and the import all read. That is a grant change across the product for a private flag |
| A `priority` rank over the whole watchlist | This is the "ranked queue of 50" the brief rules out |
| A system List (Lists v1) | Lists are shareable objects with their own visibility and a 100 cap. Watch next must vanish with the Watchlist row, which a List would need sync triggers to do |

**How each requirement is met**

- **Max 3, server-side:** `check (slot between 1 and 3)` plus `unique (user_id, slot)` means a fourth row cannot exist, whoever writes it.
- **Deterministic order:** by `slot`.
- **Race-safe:** the RPC takes `pg_advisory_xact_lock(hashtextextended('watch-next:' || auth.uid(), 0))` before reading, the same pattern as `create_invite_link`. The constraints are the backstop if a future writer forgets the lock (the loser gets a 23505, never a fourth row).
  **Lock placement:** this key is taken first and holds nothing else. The RPC then takes only row locks on `watch_next` and the FK's `KEY SHARE` on the watchlist row. It never takes `_lock_pair`, `_award_lock` or the `series-watchlist:` key. Cascade deletes from watchlist writers never take this key. So there is no cycle with the 20260825000200 hierarchy. This is proven by the race tests in §11.
- **Watchlist invariants preserved:** no watchlist writer or trigger changes. The cascade runs inside whichever writer deleted the row (FK cascades bypass RLS, which is correct here).
- **No feed activity:** the RPC writes only `watch_next`.

**Writer**

```
set_watch_next(p_operation_id uuid, p_media_item_id uuid, p_present boolean,
               p_replace_media_item_id uuid default null) returns jsonb
```

A single signature, so the default causes no overload ambiguity. Security definer, `search_path = public, pg_temp`, schema-qualified relations (the `_leave_watchlist` hygiene).

1. `assert_can_write()`. A null `p_present` raises `22023`.
2. `_claim_operation(p_operation_id, 'set_watch_next')`, where a replay returns `already_applied`. Then `_assert_operation_rate('set_watch_next', 'watch_next.max_per_day', 200)` (new `app_config` row, the `dismiss_for_you` precedent).
3. The advisory lock.
4. `p_present = false`: delete the caller's row. Return `{status: ok, pinned: [...]}` (idempotent).
5. `p_present = true`:
   - Already pinned → `ok` (idempotent).
   - Not on the caller's watchlist → **returned** `{status: refused, reason: not_on_watchlist}`.
   - `p_replace_media_item_id` given and pinned → delete it and insert the new title into its slot.
   - Otherwise, 3 pinned → **returned** `{status: refused, reason: full, pinned: [ids in slot order]}`, so a stale client can still draw the replace picker. If fewer, insert at the lowest free slot.
6. Every `ok` returns the full `pinned` array in slot order, so the client can set its cache from the reply.

Refusals are returned, not raised, per the schema-wide rule (a raise would refund the rate-limit claim). A concurrent watchlist removal between the membership check and the insert surfaces as a 23503 from the FK. The RPC catches it and returns `not_on_watchlist`.

**Client read:** a separate small query, `from('watch_next').select('media_item_id, slot').eq('user_id', me).order('slot')`, under `[...queryKeys.collection(userId), 'watch-next']`, so every existing collection invalidation (log, rank, watchlist change) refreshes it for free. It is **not** embedded in `useWatchlist`: if that read fails, the Watchlist renders exactly as today with no header. It is never a failure of the list.

---

# Part C — Across both

## 9. Interaction and invariant risks

| # | Risk | Handling |
|---|---|---|
| 1 | A note as a harassment channel | Send still requires the sender to follow the recipient. Pending notes are hidden. A block hides delivered notes and deletes pending ones. A report path is added. The lock screen never shows the text. 140 characters, no links rendered |
| 2 | A sender edits a note by resending after it was read | Accepted. The same live-text model as editable reviews, and the anti-ping rule still files no notification. The operator sees the current text |
| 3 | Old binaries after R1 | The 3-arg `recommend_title` survives as a wrapper. `recommendations_to_me` only gains a column. Nothing else they call changes |
| 4 | The client ahead of the backend (OTA before migration) | Prevented by the deploy order (§11.5). As a second guard, no-note sends use the 3-arg path, and a failing Watch next read renders the plain Watchlist |
| 5 | The title-page lookup adds a round trip on every title open | One indexed invoker query, limit 10, `staleTime` 60s. Sent to you seeds the cache for the row being opened (`setQueryData`), so the most common path shows the card on the first frame |
| 6 | The title card shows on every visit until the title is ranked | Intended (rule 6). It is compact and in the flow, and it disappears the moment the title is ranked, matching Sent to you |
| 7 | Marking opened from the title page changes what `recommendation_opened` counts | The event gains `surface: 'title'`, so the historical `sent_to_you` series stays comparable |
| 8 | Multi-select sends one note to N people | The placeholder says so. Each recipient still gets their own row and their own write, with no broadcast primitive |
| 9 | A pin silently disappears after logging | Intended (rule 2). Logging means it was watched, which was the point of the pin |
| 10 | Unlogging does not restore the pin | Consistent with the existing one-way watchlist rule (20260815040000) |
| 11 | Watch next vs the Movies/TV partition | Cap 3 across both, the header follows the partition, and the full-sheet lists all three (§6.4) |
| 12 | Lock ordering with the series trigger or the award lock | The Watch next key is outermost and exclusive (§8). Race tests WN1–WN3 |
| 13 | `set_watchlist(true)` on a title that is already pinned | `on conflict do nothing` keeps the row, so the pin survives |
| 14 | Migration-number collision with Lists L1 or the watch-history epic | Take numbers at PR time, not now. R1 and W1 are independent files |
| 15 | Staging and production are behind main | Per the memory index, #171–#173's `20260926000100` and `20260927000100` may still be unapplied. A production `db push` from main would carry them too. Verify with `migration list` and decide deliberately before the R1/W1 push |

## 10. Analytics

All events are schema-typed. They must be added to both the `AnalyticsEvent` union **and** `ANALYTICS_EVENTS`, with the pinned test updated. No event carries note text, a title or a username.

| Event | Change | Emitted when |
|---|---|---|
| `recommendation_sent` | **+ `has_note: boolean`** | Unchanged: once per stored recommendation (`ok` only) |
| `recommendation_opened` | **+ `has_note: boolean`**. `surface` now also `'title'` | After the server confirms, once per row per process (the existing `reportedOpens` guard) |
| `recommendation_note_reported` | **new** `{}` | `report()` returned ok |
| `watch_next_changed` | **new** `{ action: 'added' \| 'removed' \| 'replaced'; count_after: 0–3 }` | After the RPC returns `ok` (not on a refusal, not on `already_applied`) |
| `watch_next_full_shown` | **new** `{}` | The replace picker was presented (it measures how often the cap bites) |
| `title_logged` | **+ `was_watch_next: boolean`** (from the Watch next cache at log time) | Unchanged. This is the only way to measure pin → watch, because the cascade deletes the row |

**Server-truth queries** (no event needed): note adoption = `count(message is not null) / count(*)` over rows created after the deploy. Note effect = the `fulfilled_at` rate with a note vs without. Watch next adoption = distinct `user_id` in `watch_next` / weekly actives.

## 11. QA plan

### 11.1 Automated: backend

**`supabase/tests/recommendation-note.test.mjs`** (new):
- A note is stored normalised (trim, whitespace collapsed). Whitespace-only is stored as null. 141 characters raises `22023` **and spends no claim** (the rate-limit count is unchanged).
- The 3-arg call works and stores no note (the old-binary path).
- A resend with a note replaces it. A resend without one keeps it. Neither files a second notification, and `opened_at` is untouched.
- Visibility: the recipient reads the note through `recommendations_to_me` and `title_recommendations_for_me`. The sender reads their own. A third party reads nothing. A **pending** row's note is unreadable to the recipient by any path (a direct select, both RPCs, `recommendation_requests`).
- A block hides the delivered note in both readers, and an unblock restores it. A block deletes a pending row. Account deletion cascades.
- `title_recommendations_for_me` returns only the caller's delivered rows for that exact item (never the season's parent series), newest first, at most 10.
- `report('recommendation', id)`: the recipient succeeds with owner = sender. A third party, the sender (self-report), and a row with no note each get the existing refusal. One open report per reporter holds.

**`supabase/tests/watch-next.test.mjs`** (new):
- Pinning requires Watchlist membership (`not_on_watchlist`). A 4th pin returns `full` with the ids in slot order. Replace is atomic and keeps the slot. Re-pin and unpin are idempotent. An op-id replay returns `already_applied`.
- A direct definer insert of a 4th row, or a slot of 4, fails on the constraints.
- **The cascade from every watchlist writer:** `set_watchlist(false)`, `log_watched` (`_leave_watchlist`), a `rankings` insert, a finished series (`_leave_series_watchlist`, with released seasons as fixtures), account deletion, and `media_items` deletion.
- RLS: the owner reads. A follower of a **public** profile reads nothing. Anon reads nothing.
- No `feed_events` and no `notifications` rows are written by any path.

**Race harness (real Postgres, not PGlite: see the Group Picks lesson):**
- R-N1: a resend with a note racing a `block`. Either the delivered note stays hidden, or the pending row is deleted. Never a pending row surviving a block.
- WN1: two concurrent pins with 1 slot free: exactly one `ok` and one `full`. With 2 free: both `ok`, in distinct slots.
- WN2: a pin racing `set_watchlist(false)` on the same title: `not_on_watchlist`, or pinned-then-cascaded. Never an orphan and never an error.
- WN3: a pin racing a season completion that finishes the series (`_leave_series_watchlist`): no deadlock within the harness timeout.
- Mutation check: deleting the advisory lock must make WN1 surface a 23505, and the test must catch that.

### 11.2 Automated: client (Jest/RNTL)

Follow the local traps: one render per test, no double `fireEvent.press` in one test, `includeHiddenElements`, `TitleRow` year in the same text node, and run with the `.claude` worktrees filtered out.

- **RecommendSheet:** the no-note send calls the **3-arg** RPC with exactly today's params (a regression pin). With a note, the 4-arg is called per recipient with the trimmed note. The counter appears at 20 remaining. The multi-recipient placeholder. The note is retained after a partial failure. Share off bingd includes the note.
- **SentToYouList:** a note row renders with `numberOfLines={2}` and replaces the metadata line. A row without a note matches today's snapshot.
- **Title page:** 0 / 1 / 3 recommenders. The newest-note-that-exists rule. Hidden when ranked. The same position with and without artwork (no `recommendedOverlay`). `mark_recommendation_opened` once per unopened row. The multi-recommender sheet. Report on long-press.
- **CollectionView:** the pinned header in Poster and in List mode. Pinned ids absent from the virtualised data. A filter hides a pinned title and the header disappears when all are hidden. Shuffle leaves the pins first. The count is unchanged. No header at zero. Medium partition. The hint's show and dismiss conditions.
- **WatchNextSheet:** the add, remove and full→replace states. A `refused: full` from a stale cache opens the picker from the server's `pinned` list.
- `analytics.test.ts` pins the new names.

**RN-web screenshot harness** (the esbuild harness in memory): the title card (1-line, 3-line, multi) and the Watch next header (poster and list) at widths 320/375/430 × font scale 1.0/1.3, attached to the PR. That takes layout out of the device pass and leaves only behaviour there.

### 11.3 Manual device QA: one pass on the physical staging lane

| # | Check | Accounts |
|---|---|---|
| M1 | Recommend with **no** note: same taps as today, push arrives, copy unchanged | A → B (B follows A) |
| M2 | Recommend with a note on the **smallest available phone**, keyboard up: the field and footer stay visible, and the counter shows near the limit | A only for the input. B to receive |
| M3 | B: the Sent to you row shows the 2-line note. Tap → the in-flow card on the title page, nothing on the artwork, and the row loses its dot | B |
| M4 | B opens the same title **from the push/inbox** instead → the card shows, and Sent to you marks it opened | B |
| M5 | A resends with a new note → no second push. B sees the new note and the row at the top | A → B |
| M6 | B long-presses the note → Report → confirmation | B |
| M7 | Long-press a Watchlist poster → Add → it appears in the header row. Repeat in **List** mode | Any one account |
| M8 | Pin 3, long-press a 4th → replace picker → replace | One account |
| M9 | Switch Movies/TV, apply a filter, choose Shuffle → the pins behave per §6.4 | One account |
| M10 | Log or rank a pinned title from its page → it leaves Watch next and the Watchlist | One account |
| M11 | VoiceOver or TalkBack: the custom action "Add to Watch next" exists on a tile | One account |

**Two accounts are needed only for M1 and M3–M6.** Use the founder account plus one existing second account, with B following A back. The pending-request case (note hidden until Add), multiple recommenders, blocks and private senders are covered by the DB tests and screenshots, so **no extra fake accounts are needed**. If the founder wants to *see* the multi-recommender card on a device, seed two rows on **staging** with the service key from existing test accounts (the staging-keys-from-the-CLI recipe) rather than creating accounts.

**One account covers all of Watch next** (M7–M11). "Others can't see it" is proven by the RLS test and needs no second device.

### 11.4 What is not QA'd manually

Anything in §11.1: races, cascades from each writer, RLS, report refusals, old-binary compatibility.

### 11.5 Migration and deploy sequence

1. **R1 and W1** merged after `test:db` and `test:race` pass. Numbered codex reviews follow the usual convention (diff written to a file; codex must not run git).
2. **Staging:** `node scripts/ops/apply-staging-migrations.mjs` (plan) then `--apply`, which runs one transaction per file. Then remote smoke. **From this point R1 and W1 are immutable**; any correction is a new file.
3. **R2 and W2** merged after the release gate on their exact SHA. Then **one staging/preview OTA** from that SHA to the physical staging lane.
4. **One manual pass** (§11.3).
5. **Production backend:** `supabase migration list` must show exactly the intended pending files (see risk 15), then `db push`. Old binaries keep working (risk 3).
6. **Production OTA**, both platforms, via `scripts/release.mjs` (clean tree including untracked files; stash the founder-local files, never `.gitignore` them). No fingerprint inputs change (no package, `app.config`, `eas.json`, asset or native changes), so the runtime is unchanged. Prove it with the git-diff method before publishing.
7. **No edge-function deploy.** `push-sender` is untouched.

**Rollback:** revert the OTA. The backend additions are inert when no client uses them (the new column is nullable, the new table is empty, the wrapper keeps the old signature).

## 12. Proposed PR sequence

| PR | Contents | Depends on | Size |
|---|---|---|---|
| **R1** backend: recommendation note | Migration §4 (column + grant, 4-arg writer + 3-arg wrapper, `recommendations_to_me` rebuilt, `title_recommendations_for_me` + index, report subject + `report()` branch). `recommendation-note.test.mjs`, race R-N1. PRD §13/§22 as-built, the moderation doc | none | S–M |
| **W1** backend: Watch next | Migration §8 (table, RLS, `set_watch_next`, `app_config`). `watch-next.test.mjs`, races WN1–3, mutation check. PRD watchlist section | none (in parallel with R1) | S |
| **R2** client: recommendation note | RecommendSheet field, `use-recommend` 3/4-arg split, SentToYouList note line, the title card moved into the flow plus the lookup hook, cache seeding and removal of the route params, the multi-recommender sheet, opened from the title page, Report, analytics, screenshots. Rewrite the stale `use-recommend.ts` header | R1 on staging | M |
| **W2** client: Watch next | `useWatchNext`, CollectionView header + `onLongPressItem`, `PosterGridList` header and long-press props, `TitleRow.onLongPress`, a11y actions, WatchNextSheet, hint preference, analytics, screenshots | W1 on staging | M |
| W3 *(deferred)* | One row in the title-page ⋯ once Lists L2 has shipped it | Lists L2 + W2 | XS |

R2 and W2 share only `analytics.ts` (and its test) and docs, which is a trivial merge. They touch disjoint screens: R2 the Recommend sheet, Sent to you and the title page; W2 the Collection.

## 13. Should they ship in the same bundle?

**Yes: one backend window, one staging OTA, one manual pass, one production OTA.**

- Both are OTA plus one additive migration each, with **no fingerprint change**. The release mechanics are identical, so doing them together saves a full gate → staging → device → production cycle.
- Their surfaces don't overlap (§12), so a defect in one does not invalidate the other's QA.
- The manual pass is small together: 11 checks, of which 5 need the second account.
- **The escape hatch:** keep R2 and W2 as separate PRs. If one fails device QA, revert that PR alone and ship the other on the same day. The backend half can stay deployed because it is inert.
- **Do not bundle with Lists L1/L2 or the watch-history epic.** Those are larger, touch the title page and `user_media`, and would make this pass many times bigger.

## 14. Founder decisions

Both were decided on 2026-09-19.

| # | Decision | **Decided** | Not taken |
|---|---|---|---|
| **F1** | Where the recommendation context sits on the title page | **APPROVED: below the title, in the flow, not over the hero artwork** (§2.4, wireframe 3.3) | A one-line pill under the nav bar (variant C.3) |
| **F2** | Is Watch next visible to others? | **APPROVED: private to the owner in v1** | Visible wherever the Watchlist is (a later one-line policy change, `can_i_view(user_id)`) |

**Defaults taken without asking** (overrule any of them if you disagree): a 140-character note · the note replaces the metadata line in the Sent to you row · the note is hidden in Requests until delivered · push and inbox copy unchanged · a resend replaces the note · a cap of exactly 3 · replace-in-sheet when full · press and hold as the only MVP entry point, plus a one-time hint · pins obey filters and the medium, but not sort · no title-page entry until the Lists ⋯ exists.
