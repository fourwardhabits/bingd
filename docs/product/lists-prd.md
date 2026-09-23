# Lists — PRD (v1)

> **Status: BUILT, 2026-09-20, on `feat/lists-v1`.** The header below is the state this
> document was written in, and is kept because the rest of it is written against that
> state. This note is what supersedes it.
>
> Everything in §O's six PRs is implemented, in one branch rather than six: the migration
> is `20261010000100`, its suite is `supabase/tests/lists.test.mjs`, the client is
> `src/features/lists/` plus `app/lists/`, the web render is in `web/src/page.mjs`,
> `web/src/router.mjs` and `web/build.mjs`, and the preview Function is
> `functions/lists/[id].js`.
>
> **What has not happened**, none of it a code change: the migration has reached no
> database, no OTA has been published, and the §N device QA has not been run. §O's release
> order still stands — L1 to production, the client on the staging preview lane, device QA,
> one OTA to both lanes, the web deploy, then the Function.
>
> **Three deliberate departures from the letter of this document**, each recorded where it
> was made:
>
> - **The Settings → Privacy line is in the standing private-state explanation, not on a
>   confirmation.** §F.4 asks for it on "the private-profile confirmation", and there is
>   none: going *private* is the protective direction and has never had a dialog — only
>   going public does, because that one changes other people's access. Inventing a
>   confirmation for the safe direction would put friction on the act that screen exists to
>   make easy. The sentence now sits in the block a reader meets every time they check what
>   private means, which is better for what it is for than an alert read once.
> - **The See-all screen is `app/lists/by/[userId]`**, inside the already-claimed
>   `/lists/*`. `listIdFromPath` matches a uuid *directly* under `/lists/` and nothing
>   else, so this path and `/lists` itself both keep the generic install page, exactly as
>   §B requires — and a universal link to either still opens the app.
> - **`Delete list` is a row in the list's ⋯ that opens the editor**, where §H draws it as
>   a fourth menu row. The destructive act stays in one place (§G's edit mode, behind its
>   own confirmation) and the menu row is a way *to* it, so there is one delete path rather
>   than two.

**Status: BUILD-READY AND PARKED, 2026-09-19.** Nothing here is built. Source of truth:
`origin/main` at `0468f1c` (re-checked at `c77d524` and `d675d69`: nothing Lists-related
changed), PRD §3 doctrine 4, deferred-roadmap §50, the competitive audit of 2026-09-16 (a
local research file, not committed to this repository), the founder decisions of
2026-09-19 recorded in [§P](#p-decision-record-2026-09-19), and the **navigation/IA review
of 2026-09-19** recorded in [§Q](#q-ia-review-and-the-hybrid-model-2026-09-19). The audit's "ranked
slices first" sequencing is **superseded**: curated and utility lists are the core, and
ranked slices come later as a template.

**Implementation is intentionally parked** until after Watch History T1–T4 and the
post-foundation hardening/scalability pass. §O's six PRs are the plan for when it unparks,
not a queue that is running.

**The IA changed on 2026-09-19 and this document has been rewritten to match it.**
Management moved from the Profile to Collection; the Profile keeps a read-only shelf of
public lists. Every affected section below carries the new model, and §Q states the
decision and its reasoning in one place. A reader who remembers the "Lists live on the
Profile" version of this PRD is remembering a superseded document.

---

## A. Executive recommendation

Lists are **hand-made, optionally numbered sets of titles**. They are **managed in one
place, reached from Collection**; **public lists appear on the Profile** as a read-only
shelf. They can be created from exactly two points, and have a public web page at the URL
the app already claims (`bingd.app/lists/<id>`).

- **The core object is curation, not a filtered view of your own data.** A list holds the
  titles the owner chose, in the order the owner chose. It never reads the owner's ranking,
  buckets or watch dates.
- **The utility half costs almost nothing.** Each viewer sees their own "seen" marks and a
  "You've seen X of N" line. They can add one title, or every unseen title, to their
  Watchlist. That turns anyone's list into a to-watch plan without adding a checklist
  feature.
- **Three visibility modes, each with one rule.**
  - *Private* is owner only.
  - *Link-only* is an explicit object-level share: anyone with the URL can open it, even
    when the owner's profile is private.
  - *Public* requires a public profile.

  §F has the full matrix.
- **v1 is JS + SQL + web only.** The tables, RLS and deep-link claims already exist. No
  native dependency, no fingerprint change and no binary are needed, so it ships by OTA to
  iOS production and the Android beta.
- **Collection owns management; the Profile owns public display.** This is the same
  treatment the Watchlist already has, and it is why Lists need no new navigation: the
  entry is a `My lists ›` text action on the **unused trailing half of the Collection title
  row**. **No new tab, no Collection segment, no new control row, no icon-only entry**, no
  feed events and no social actions on lists. Lists stay out of the Log → Rank → Browse
  loop (deferred-roadmap §50). §Q has the reasoning.
- **Public and link-only lists are the acquisition object.** A logged-out visitor sees the
  title, description, attribution and posters. The link preview names the list. Install
  buttons come from `distribution.config.json`, so the Android store CTA appears the day
  `android.storeUrl` is set, with no list code touched.

Six bounded PRs (§O). Roughly 2–3 weeks of focused work.

---

## B. Current code reality (verified on `origin/main` 0468f1c)

### What genuinely exists

| Piece | Where | State |
|---|---|---|
| `lists` (`id, owner_id, title, description, visibility, source, created_at`) | `20260813000800` | Deployed to staging + production; **no writer**, so presumably empty (verify with a count before L1) |
| `list_items` (`list_id, media_item_id, position int, added_at`; PK `(list_id, media_item_id)`; index `(list_id, position)`) | same | Same. The PK forbids duplicate titles; `position` has no uniqueness |
| `list_visibility` enum `public / private / link` | `20260813000100` | In place |
| `content_source` `in_app / imported` on `lists.source` | same | In place for the later Letterboxd list import |
| RLS: select-only; owner, or `visibility='public' and can_i_view(owner)` | `20260813001900` | `link` is deliberately excluded (anti-enumeration fix, `20260813001400` §4) |
| `list_by_id(uuid)`, `list_items_by_list(uuid)`: definer, anon-granted, the only read path for `link` | `20260813001400`; grants pinned in `supabase/tests/function-grants.test.mjs` | Gate `link` on `can_view_profile`, which **no longer matches the approved semantics** (§F). They return no owner identity, no media fields, no paging. `search_path = public` without `pg_temp` |
| No insert/update/delete policies | — | Correct under AD-4 (definer writers only) |
| Report subjects `list`, `list_title` | `20260825000100` `report()`; runbook §2d | Backend ready; no client entry |
| Account deletion cascades lists | `20260817000600` | Covered |
| Catalogue retention keeps `media_items` referenced by `list_items` | `20260813002400` | Covered |
| `feed_events.list_id` FK; types `list_created`, `list_added` allowed | `20260912000100` | No writer and none planned for v1 |
| `share_tokens` accepts `object_type='list'` | `20260813001300` | No writer. Not used in v1 |
| `app_config` `lists.base_free_limit = 3`; `capability_grants` / `resolve_capabilities` | `20260813000100`, `…001200` | **Will not be enforced** (§P.1). No client gate component exists |
| Limited-identity precedent: `can_discover_profile`, `profile_identity`, the locked private-profile shell | `20260819000100`, `20260828000400` | "Private means my activity is private, not nobody can find me." The attribution rule for link-only lists reuses exactly this |
| Route `app/lists/[id].tsx` | stub "List unavailable" | Registered under `Stack.Protected guard={signedIn}` |
| Deep-link claims `/lists/*` | `app.config.ts:257`, `web/deep-links.config.json` | **Verified live 2026-09-19** in AASA and `assetlinks.json` |
| Web `lists.html` | `web/build.mjs` ROUTES `dir:'lists'` | Generic install page, 200, `noindex` |
| Web read precedent | `web/src/page.mjs` anon reads; `record_invite_open` → `invite_link_opens` | The pattern for list rendering and external-view counting |

### What must be built

- Every writer, plus columns for `updated_at`, order style, moderation hide and length
  checks.
- A single readability predicate that implements the §F rules, with the two existing link
  readers redefined onto it.
- Screen-shaped read RPCs, limits, and the would-have-exceeded measurement.
- **`app/lists/index.tsx`** — the My lists management screen (§I). It is app-only: the
  deep-link claim is `/lists/*` and `listIdFromPath` accepts a uuid shape and nothing else,
  so `bingd.app/lists` keeps its generic install page and **no claim or web route changes**.
- **A `My lists ›` trailing action on the Collection title row** (§I), and a **read-only
  `LISTS` shelf** on the Profile (§I).
- All client UI and analytics, the web page render, and rich previews.
- `appLinkFor` in `web/src/router.mjs` allows only `['i','u','title']`. It needs `lists`, and
  a new `listIdFromPath` validator.

### Documents this PRD is now consistent with

- **PRD §7 IA already puts Lists inside Collection, and `app/(tabs)/_layout.tsx`'s own
  header comment already reads "Collection holds Ranked, Watched, Watchlist, and Lists."
  Both are correct as written and need no edit.** The 2026-09-19 IA review (§Q) moved this
  PRD back onto them rather than the other way round. L6 **confirms** §7 rather than
  correcting it.
- `ProfileWatchlist.tsx`'s rule — *"Collection is where the full list is, for the account
  that owns it"*, and profile shelves carry no editing controls — is the precedent this
  PRD now follows exactly.

### Stale documents to correct (L6)

- `data-model.md` §6 cites a non-existent `create_list` limit check.
- PRD §8 has "three-list limit enforced" as a v1 must-have; PRD §20's tier matrix and
  resolution note describe that enforcement.
- Audit §P1.2 says ranked slices come first.
- `web-deployment.md` still carries the old AASA `/list/*` note.

---

## C. MVP user jobs

| Job | v1 | Notes |
|---|---|---|
| Create a list; title required, description optional | **MVP** | Plain text; no link rendering |
| Add / remove titles | **MVP** | From the list's Add sheet, and from any title's ⋯ → Add to list… |
| Movies, seasons and whole series in one list | **MVP** | Each row labels its kind |
| Optional ordering | **MVP** | "Numbered" toggle, off by default; the owner arranges the order |
| Private / Link-only / Public | **MVP** | §F |
| View another person's list | **MVP** | In app, and on the web when logged out |
| My lists screen | **MVP** | `Collection → My lists ›`. Every list the caller owns, all visibilities, newest-edited first. The one place lists are created, edited, reordered and deleted |
| Profile Lists shelf | **MVP** | **Public lists only, read-only, on own and other profiles.** Own profile also carries `Manage ›` to the My lists screen |
| Share the URL | **MVP** | The owner shares any non-private list; others can share public lists |
| "You've seen X of N" + per-row seen marks | **MVP** | Derived for whoever is reading — **viewer and owner alike** — never stored. Plain text, no bar (§K) |
| Add one item to Watchlist | **MVP** | The existing bookmark on each row |
| Add all unseen to Watchlist | **MVP** | One bulk RPC; **no feed events** |
| Report a list | **MVP** | Required before public lists are live |
| Rich link preview for public and link-only lists | **MVP** (L5) | §J |
| Drag reorder | v1.1 | Uses the already-installed gesture-handler + reanimated |
| Per-item notes | v1.1 | |
| Group Picks → Save as list | v1.1 | |
| "Start from my ranking" (a ranked-slice snapshot) | v1.1 | Independent of the ranking once created |
| Letterboxd `lists/*.csv` import | v1.1 | `source='imported'`, exempt from the 100 ceiling (PRD §12) |
| Save/follow or copy someone's list | v2 | |
| Watch Next | not designed | Watch Next does not exist. When it does, it is a per-title action on list rows like anywhere else |
| Collaboration | v2+ | "Film club" in v1 is the organiser's link-only list |

---

## D. Explicit non-goals (v1)

- No bottom-nav tab, no Collection segment, **no new control row in Collection**, and no
  Lists control on Feed, Search, Log or For You. The Collection entry is a **text +
  chevron** action on the **unused trailing half of the existing `MediumSelector` title
  row** — not a glyph, not a new row, and outside the Movies/TV medium axis. There is no
  permanent standalone list button anywhere, including the title hero and `TitleActions`.
- **No list management from a Collection poster or row.** No long-press, no per-row
  overflow, no fourth `TitleActions` button. Every Collection row is one tap from the title
  page, which owns the ⋯. Long-press already means three different things elsewhere in the
  app (recall in `RankingSheet`, report on recommendation cards, the reaction picker), and
  Collection rows have never had one. Long-press inside a list screen is a **v1.1**
  question, alongside drag.
- No pairwise ranking of list items, and no reading of `rankings.position` into a list.
- No feed events (`list_created` / `list_added` stay writer-less), no notifications, no
  push.
- No likes, reactions, comments, saves, follower counts or leaderboards on lists.
- No per-item notes, tags or chosen covers. The cover is always the first four posters.
- No collaboration, co-owners or shared editing.
- No live "by my ranking" lists, no generated slices, no recap lists.
- No editorial CMS, featured rails, creator badges or house account (§L only reserves the
  path).
- No search indexing. `/lists/*` stays `noindex`, and lists are not in in-app Search.
- **No user-visible list limit, count or upsell.** The hypothetical three-list limit is
  measured and never shown.
- No new npm or native dependency. `package.json`, `package-lock.json`, `eas.json` and
  `app.config.ts` are fingerprint inputs.
- No progress checklists, due dates, reminders or "complete" state.
- Lists never feed For You, Match or recommendations.

---

## E. Data model

One new migration (L1) alters the existing tables. **Applied migrations are immutable.**

### `lists`, altered

```
+ updated_at   timestamptz not null default now()   -- bumped by every writer, incl. item changes
+ order_style  text not null default 'unranked'
               check (order_style in ('ranked','unranked'))
               -- reserved future value: 'by_my_ranking' (live, explicit opt-in)
+ hidden_at    timestamptz                           -- moderation hide; null = normal
+ check (char_length(btrim(title)) between 1 and 100)
+ check (description is null or char_length(description) <= 1000)
+ index lists_owner_recent on (owner_id, updated_at desc)
```

`source` stays (`in_app` in v1). `visibility` stays, with default `private`.

### `list_items`, altered

```
+ unique (list_id, position) deferrable initially deferred
```

No `note` column in v1. Allowed kinds are `movie`, `season` and `series`, enforced in
`add_list_item`.

### Ordering

- `position` is always maintained. A new item is appended at `max(position)+1`. **The
  number shown is the read-time ordinal (1…N), never the stored integer**, so removal gaps
  are invisible.
- `order_style` only decides whether numbers are drawn. Toggling it never changes the
  order.
- `move_list_item(list, title, to_index)` renumbers compactly in one statement under the
  deferrable unique. Because each move names a single item, concurrent devices cannot
  conflict over a stale array. Last move wins.

### The one readability predicate

`_list_readable(p_list_id uuid, p_viewer uuid) returns boolean` (definer, not granted to
clients). Every list reader calls it, including the two existing ones, which L1 redefines
with the same signatures and grants. That leaves one rule and four callers.

```
owner = viewer                                   → true   (owner sees their own, even hidden)
hidden_at is not null                            → false
owner.status <> 'active'                         → false  (suspension hides every list)
viewer is not null and blocked_between(viewer, owner) → false
visibility = 'private'                           → false
visibility = 'link'                              → true   (independent of profile visibility)
visibility = 'public'                            → can_view_profile(viewer, owner)
```

- **`link` deliberately skips `can_view_profile`.** That is the object-level exception
  (§P.2). It still honours hide, suspension and, for a signed-in viewer, blocks.
- **`public` still goes through `can_view_profile`.** Writers refuse `public` while the
  profile is private, so under normal operation this equals "profile is public". The
  legacy case of a profile made private *after* publishing is covered in §F.
- **The `lists_read` select policy is unchanged in shape.** It admits the owner, or
  `public` + `can_i_view(owner)`, and gains `and hidden_at is null`. It never admits
  `link`, which is what keeps link lists un-enumerable. `list_items_read` mirrors it.

### Owner attribution (`list_view.owner`)

| Viewer relation | Returned |
|---|---|
| Can view the owner's profile (`can_view_profile` true) | `id, username, display_name, avatar_path, profile_visible: true` |
| Link-only list, cannot view the profile (private owner, not an approved follower, or anon) | **Limited identity only**: `username, display_name, avatar_path, profile_visible: false`. **No owner `id`** is returned to anon |

Limited identity is the same set the product already discloses for a private account in
search and follower lists (`20260828000400`). It is never counts, bio, social links,
rankings, Watchlist, other lists or activity.

### RPCs (all `security definer`, `set search_path = public, pg_temp`)

Writers take `p_operation_id`, go through `_claim_operation`, and call `assert_can_write`.

| RPC | Grant | Behaviour |
|---|---|---|
| `create_list(p_title, p_description, p_visibility, p_order_style, p_first_media_item_id default null, p_operation_id)` | authenticated | Refuses `public` with `profile_private` when the caller's profile is private. Enforces `lists.max_per_user` (in-app lists) and `lists.max_created_per_day`. Returns `{id, in_app_count_before}` |
| `update_list(p_list_id, p_title, p_description, p_visibility, p_order_style, p_operation_id)` | authenticated | Owner only. Same `profile_private` refusal. Refuses any visibility change while `hidden_at` is set |
| `delete_list(p_list_id, p_operation_id)` | authenticated | Owner only. **Hard delete**; items cascade |
| `add_list_item(p_list_id, p_media_item_id, p_operation_id)` | authenticated | Owner only. Checks kind and `lists.max_items`. Answers `added` or `already` |
| `remove_list_item(p_list_id, p_media_item_id, p_operation_id)` | authenticated | Owner only |
| `move_list_item(p_list_id, p_media_item_id, p_to_index, p_operation_id)` | authenticated | Owner only; clamps the index |
| `add_list_to_watchlist(p_list_id, p_operation_id)` | authenticated | Requires `_list_readable`. Inserts Watchlist rows for items the caller has neither logged nor saved. **Writes no `feed_events`.** Returns `{added, skipped_seen, skipped_present}` |
| `list_view(p_list_id)` | anon, authenticated | If readable: `id, title, description, order_style, item_count, updated_at`, `owner` (above), `is_owner`, `shareable_by_viewer` (owner: not private; non-owner: `visibility='public'`). For the owner also `visibility, hidden`. **Otherwise zero rows**, one answer for every failure |
| `list_items_page(p_list_id, p_after_position, p_limit ≤ 100)` | anon, authenticated | Keyset page: `media_item_id, kind, title, year, poster_path, season_number, parent_title, ordinal`. Adds `viewer_seen` / `viewer_watchlisted` for a signed-in viewer (null for anon) |
| `list_viewer_progress(p_list_id)` | authenticated | `{seen, total}` over the whole list |
| `my_lists(p_before_updated_at, p_limit)` | authenticated | **The caller's own lists, every visibility**, `updated_at desc` keyset. Returns `id, title, item_count, order_style, visibility, hidden, updated_at` and the **first four `poster_path`s** for the 2×2 cover. Backs `app/lists/index.tsx` and nothing else. It takes no owner argument at all, so it cannot be pointed at another account |
| `profile_lists(p_owner_id, p_before_updated_at, p_limit)` | authenticated | **Public lists only, for every caller including the owner** (§Q.4). Not hidden, and `can_view_profile` must hold. `private` and `link` are never returned by this path, to anyone — **including the owner**, whose own shelf deliberately shows what a visitor sees. Backs the Profile `LISTS` shelf and its See-all screen |
| `my_lists_for_title(p_media_item_id)` | authenticated | The caller's lists with a `contains` flag, most recently updated first |
| `record_list_open(p_list_id, p_platform)` | anon | Returns `void`. Records only when `_list_readable(id, null)`. Rate-capped per list per minute. No IP, UA or referrer |
| `list_preview(p_list_id)` | anon | For the L5 Pages Function: `title, item_count, owner_label` (the `@handle` only when the owner's profile is public, else null). Zero rows unless readable by anon |
| `list_by_id`, `list_items_by_list` (existing) | unchanged grants | **Redefined** onto `_list_readable`, so they cannot disagree with the new readers. Removal is a later cleanup |

### `list_web_opens` (new)

A copy of `invite_link_opens`: `(list_id → lists on delete cascade, platform, opened_at)`,
with `revoke all` from clients. Its only writer is `record_list_open`.

### Limits (`app_config`)

| Key | Value | Enforced? |
|---|---|---|
| `lists.max_per_user` | **100** owned in-app lists | Yes, the only list-count limit. Answers `list_limit` (a sanity ceiling, copy: "You've reached the maximum number of lists.") |
| `lists.max_items` | 500 | Yes |
| `lists.max_created_per_day` | 20 | Yes (spam guard) |
| `lists.base_free_limit` | 3 (existing) | **No.** L1 re-comments it as *hypothetical, measured only, never enforced or shown* (§M) |

### Pagination

- The list screen pages 100 at a time in FlashList, which is already a dependency.
- The web page shows the first 100, then "See all N in the app".
- **My lists** pages on `updated_at desc` through `my_lists`.
- **The Profile `LISTS` shelf** shows up to 10 cards. **See all is a pushed read-only
  screen, not a sheet** (§Q.4), and pages on `updated_at` through `profile_lists`.

---

## F. Visibility and privacy

### The matrix

Rows are viewers; the columns are list modes. "Profile" is the owner's account visibility.

| Viewer ↓ / List → | **Private** | **Link-only**, public profile | **Link-only**, private profile | **Public** (profile must be public) |
|---|---|---|---|---|
| Owner | ✅ full | ✅ full | ✅ full | ✅ full |
| Signed-in stranger with the link | ❌ | ✅ list + full attribution | ✅ list + **limited identity** | ✅ |
| Approved follower of a private owner | ❌ | — | ✅ list + full attribution | n/a (cannot be created) |
| Logged-out web visitor with the link | ❌ | ✅ | ✅ list + limited identity, no profile link | ✅ |
| Blocked either way (signed in) | ❌ | ❌ | ❌ | ❌ |
| Anyone, owner suspended | ❌ | ❌ | ❌ | ❌ |
| Anyone except owner, list hidden by moderation | ❌ | ❌ | ❌ | ❌ |
| **Shown on the Profile `LISTS` shelf** (to anyone, **including the owner**) | never | never | never | yes, to whoever can view the profile |
| **Shown on the owner's My lists screen** | yes | yes | yes | yes |
| **Returned by any browse/list/search path** | never | never | never | `profile_lists` only |
| **Web page** | generic "unavailable" | renders | renders | renders |
| **Link preview** | generic card | title + count + `@handle` | title + count, **no owner** | title + count + `@handle` |
| **Who sees Share** | owner (opens the visibility prompt) | owner | owner | owner + any viewer |

❌ is always the same "List unavailable" answer (zero rows). It never says which reason.

### The rules behind the matrix

1. **Link-only is an object-level sharing exception, not a profile privacy leak.** It grants
   exactly one list and its items. It does **not** grant the owner's profile, Collection,
   Watchlist, rankings, activity, awards, Match or any other list. Each of those reads still
   goes through `can_view_profile`, untouched.
2. **Attribution for a private owner is limited identity**: avatar, display name and
   `@handle`, which is what search already discloses for a private account.
   - **In the app** the attribution opens the ordinary profile route. For a viewer who is
     not approved, that route renders the existing **locked shell**: identity plus a
     follow-request control, with no content. The list adds no path around it; the server
     answers every profile read with `can_view_profile` as it does today.
   - **On the web** the attribution is plain text with no `/u/` link.
   - The list screen never shows "more lists by…".
3. **Public requires a public profile.** `create_list` and `update_list` refuse `public`
   while the profile is private. In the picker, "On your profile" is disabled for a
   private-profile owner with the note: "Make your profile public to publish lists on it."
4. **A profile made private later does not rewrite lists.** Its existing public lists
   follow the profile's audience: approved followers see them in the profile row, anonymous
   visitors and strangers do not, and the web answers "unavailable". Nothing is silently
   converted to link-only. Link-only lists keep working. The Settings → Privacy
   private-profile confirmation gains one line: "Lists you've shared by link stay viewable
   by anyone with the link."
5. **Private is the default. Converting to link-only needs explicit consent.** Tapping
   Share on a private list, or choosing Link-only in the picker, shows:

   > **Anyone with this link can view this list.**
   > They won't see your profile, ratings or other lists.
   > [Cancel] [Make link-only]

   The second line appears only when the owner's profile is private, where it is the true
   and reassuring fact.
6. **Link-only cannot be enumerated.** The select policy excludes `link`. `profile_lists`,
   Search and Feed never return it. `link` reads go only through id-taking RPCs. The id is
   `gen_random_uuid()` (122 random bits). **`my_lists` is the single exception and is not a
   hole**: it takes no owner argument, so it can only ever answer for the caller's own
   account.
7. **Blocks: signed-in only, stated plainly.** A block hides every list both ways for
   signed-in viewers. A logged-out web visitor cannot be matched to a block, so a blocked
   person who signs out and holds a link-only or public URL can read that list. This is the
   same bound every anonymous surface has (a public profile on the web). Recourse is making
   the list private or deleting it.
8. **Link revocation in v1** is making the list private (immediate) or deleting it. Re-sharing
   afterwards reuses the same URL. A revocable per-share token (`share_tokens`) is the
   later answer if people ask to "reset the link".
9. **Link previews.** Previews for public and link-only lists may name the list; holding
   the URL already grants access to it (§P.3). **The owner is named in a preview only when
   the owner's profile is public.** A third-party unfurl cache is a place the owner did not
   choose, so a private account's handle is kept out of it. Private, hidden and unreadable
   lists get the generic card.
10. **Moderation hide wins over every mode** except the owner, who sees a banner and cannot
    change visibility until an operator clears it (runbook §2d, recorded in
    `moderation_actions`).
11. **A list never exposes the owner's** scores, positions, buckets, watch dates or notes.
    Rows show the title and the **viewer's own** state only.
12. **Deletion is hard.** The URL answers "unavailable". Account deletion cascades.

---

## G. Create and edit UX

### Entry points (exactly two)

1. **Collection → `My lists ›` → New list.** `Profile → LISTS → Manage ›` is a second door
   to the same screen, not a third entry point.
2. **Title ⋯ → Add to list…** on every movie, TV season and whole series, whether ranked,
   logged, unwatched or watchlisted.

**Title-page change (approved, §P.4).** `TitleTopBar`'s existing ⋯ slot is present on
**every** title. Today `onMore` is absent for series and for titles that are neither ranked
nor logged. **Add to list…** is the first menu item. Existing items (ranking options, Remove
from collection) keep their place and conditions. Nothing else on the #123 layout changes:
no hero control, no `TitleActions` change, no permanent list button.

### Add to list sheet (from a title's ⋯)

With at least one list:

```
┌─────────────────────────────────────┐
│  Add "Past Lives" to…                │
│  [ + New list ]            ← pinned  │
│ ─────────────────────────────────────│
│  Best breakup movies   14   [ ✓ ]  ▲ │
│  Movies for Dad         8   [   ]  │ │
│  Film club — Sept 🔗    5   [   ]  ▼ │
└─────────────────────────────────────┘
```

Rows toggle membership immediately, ordered by most recently updated first. **Toggling a
row off removes the title from that list**, so this one control covers add, add-to-several
and remove. The sheet stays open after each tap.

**`+ New list` is pinned at the top and does not scroll with the rows.** With twenty lists
it would otherwise sit below the fold, and creating-a-list-while-adding-a-title is the
highest-value path in the flow.

**The confirmation names the destination and offers Undo**: `Added to "Movies for Dad"`
with an **Undo** action, not a bare "Added". Because the sheet stays open and the rows keep
scrolling, the toast is the only feedback that the intended list was the one that was hit.
Undo calls `remove_list_item` under its own operation id.

**With no lists yet**, ⋯ → Add to list… opens the New list sheet directly, with the title
preselected ("Will add: Past Lives"). Create returns to the title with the same
named-destination toast.

### New list sheet

```
┌─────────────────────────────────────┐
│  New list                     Cancel │
│  Title                                │
│  [ e.g. Movies for Dad            ]   │
│  Description (optional)               │
│  [                                 ]  │
│  Numbered list                 ( ○ )  │
│  Show 1, 2, 3 next to each title      │
│  Who can see it                       │
│  (•) Only you                         │
│  ( ) Anyone with the link             │
│  ( ) On your profile                  │
│      └ disabled when the profile is private:
│        "Make your profile public to publish lists on it."
│            [   Create list   ]        │
└─────────────────────────────────────┘
```

- Choosing **Anyone with the link** shows the §F.5 consent copy inline, under the option.
- **From My lists, Create pushes the empty list** with **Add titles** as the one primary
  button. A push, not a sheet over a sheet.

### Add titles sheet (from a list)

```
┌─────────────────────────────────────┐
│  Add to "Oscar catch-up"       Done  │
│  [ 🔍 Search films and shows      ]  │
│  FROM YOUR WATCHLIST                  │
│  [p] Anora            2024   [ + ]    │
│  RECENTLY WATCHED                     │
│  [p] Conclave         2024   [ ✓ ]    │
└─────────────────────────────────────┘
```

- It uses the existing title search (Titles only). A series offers "Whole series" or a
  season through the existing `SeasonPicker`.
- With an empty query, it offers the caller's Watchlist and recently logged titles.
- Each tap is one `add_list_item`, and the sheet stays open.

### Edit mode (owner)

```
┌─────────────────────────────────────┐
│  Done                    Edit list    │
│  [ Best breakup movies            ]   │
│  [ Ones that actually help.       ]   │
│  Numbered list                 ( ● )  │
│  Who can see it: Anyone with link  ›  │
│  1 [p] Eternal Sunshine   [↑][↓] ⋯    │
│  2 [p] Past Lives         [↑][↓] ⋯    │
│  3 [p] Fleabag · S2       [↑][↓] ⋯    │
│  Delete list                          │
└─────────────────────────────────────┘
   ⋯ = Move to top · Move to bottom · Move to position… · Remove
```

- Reordering uses move controls with no new dependency. The same moves are exposed as
  `accessibilityActions`.
- v1.1 drag uses the installed gesture-handler + reanimated and calls the same
  `move_list_item`.
- New items append. No pairwise flow.

---

## H. List view UX

### Someone else's list

```
┌─────────────────────────────────────┐
│ ‹                          [⤴]  ⋯   │   ⤴ only if shareable_by_viewer; ⋯ = Report list
│ Best breakup movies                  │
│ (◉) Maya Chen · @maya            ›   │   › opens the profile route (locked shell if private)
│ Ones that actually help.             │
│ 14 titles · Numbered · Updated Sep 12│
│ You've seen 5 of 14                  │
│ [ Add 9 unseen to my Watchlist ]     │
│  1 [poster] Eternal Sunshine…  ✓     │
│      2004 · Movie                     │
│  2 [poster] Past Lives         🔖    │
│  3 [poster] Fleabag            ☐     │
│      Season 2 · 2019                  │
└─────────────────────────────────────┘
```

- **Trailing control:** ✓ means the viewer has seen it and is inert. Otherwise it is the
  standard bookmark, which is the one-item Watchlist add.
- Numbers show only when the list is numbered. There are never any owner scores.
- **The bulk button says "my Watchlist", not "Watchlist".** On somebody else's list a bare
  "Add 9 unseen to Watchlist" is genuinely ambiguous about whose it is, and the one word
  also restates the §9 boundary in the place a reader is standing.
- Bulk add is hidden when nothing qualifies. Its result reads: "Added 9 to your Watchlist.
  5 you've seen were skipped."
- For a **private-profile owner's link-only list** viewed by a non-follower, the
  attribution is the limited identity with a lock glyph, and › leads to the locked shell.

### Own list

```
┌─────────────────────────────────────┐
│ ‹                          [⤴]  ⋯   │   ⋯ = Edit · Share · Who can see it · Delete
│ Oscar catch-up                       │
│ Everything nominated I haven't got to│
│ 12 titles · Numbered · 🔗 Link ·      │
│ Updated today                        │
│ You've seen 4 of 12                  │
│ [ Add 8 unseen to my Watchlist ]     │
│ [ + Add titles ]                     │
│  1 [poster] Anora              🔖    │
│      2024 · Movie                     │
│  2 [poster] Conclave            ✓    │
└─────────────────────────────────────┘
```

- ⋯ = Edit · Share · Who can see it · Delete.
- **`Add titles` sits below the progress and bulk block**, not above it. The header then
  reads top to bottom as *what this is → how you are doing → what you can do*, and the
  owner's two actions are adjacent instead of separated by a stat line.
- The progress line shows for the owner too (§Q.5), and is **suppressed when the list is
  empty**.
- Chips mark all three modes: 🔒 Only you, 🔗 Link, 🌐 Profile. The same three words the
  New-list picker uses, shortened, so the chip is recognisable as the choice that was made.
- Share on a Private list opens the §F.5 prompt first.

### Unavailable

The existing stub copy, unchanged, for every ❌ in the §F matrix.

---

## I. Collection and Profile integration

**Collection owns management. The Profile owns public display.** This is the treatment the
Watchlist already has, stated in `ProfileWatchlist.tsx`: *"Collection is where the full
list is, for the account that owns it."* §Q has the reasoning; this section is the spec.

### Collection → My lists

The entry is a **text + chevron action on the trailing edge of the existing
`MediumSelector` title row**, in the maroon `sectionHeader` treatment `SectionHeader` uses
for its trailing action.

```
  Movies ▾                                      My lists ›
  [ Watched ][ Watchlist ][ Unranked ]
  ─────────────────────────────────────────────────────────   ← HeaderBoundary
  [Filters] [Sort]                                    [☰│▦]
  …
```

- **Zero added height.** The title row exists and its trailing half is unused.
- **It is not a segment**, so it never inherits the Movies/TV axis. This matters: Watched,
  Watchlist and Unranked are all slices of one medium, and a list mixes movies, seasons and
  whole series by design (§C). A fourth segment would sit under a `Movies ▾` title it had
  to ignore — the same class of disagreement as the Unranked-tab bug recorded at
  `app/(tabs)/collection.tsx`.
- **It is not the `AppHeader` right corner**, which `app/(tabs)/profile.tsx` records as the
  bell's on every root tab, and where a *text* button was already tried and rejected.
- **It is not an icon.** `TitleActions`' rule applies: a glyph names neither the thing nor
  the act.
- **"My lists", not "Lists".** Beside `Movies ▾`, the word "Lists" alone reads as one
  phrase — "Movies lists". "My lists" reads as a destination and distinguishes it from
  other people's.
- It is present on **every segment and both mediums**, and it does not move or change.

### The My lists screen — `app/lists/index.tsx`

A pushed route. Every list the caller owns, all visibilities, `updated_at desc` through
`my_lists`. **No folders, no manual ordering, no sort control in v1.**

**Zero lists**

```
┌──────────────────────────────────────────────┐
│ ‹                                  My lists  │
│                                              │
│                  ▤                           │
│              No lists yet                    │
│                                              │
│   Pull together picks for friends, your      │
│   favorite comfort movies, or anything else  │
│   you want to save. It stays private until   │
│   you choose to share it.                    │
│                                              │
│            [  Create a list  ]               │
└──────────────────────────────────────────────┘
```

**One list**

```
┌──────────────────────────────────────────────┐
│ ‹                                  My lists  │
│  [  + New list  ]                            │
│  ┌────┐  Movies for Dad                  ›   │
│  │▣ ▣ │  8 titles · 🔒 Only you               │
│  │▣ ▣ │  Updated today                        │
│  └────┘                                      │
└──────────────────────────────────────────────┘
```

**~10 lists**

```
┌──────────────────────────────────────────────┐
│ ‹                                  My lists  │
│  [  + New list  ]                            │
│  ┌────┐  Oscar catch-up                  ›   │
│  │▣ ▣ │  12 titles · Numbered · 🔗 Link       │
│  │▣ ▣ │  Updated today                        │
│  └────┘                                      │
│  ┌────┐  Best breakup movies             ›   │
│  │▣ ▣ │  14 titles · Numbered · 🌐 Profile    │
│  │▣ ▣ │  Updated Sep 12                       │
│  └────┘                                      │
│  ┌────┐  Movies for Dad                  ›   │
│  │▣ ▣ │  8 titles · 🔒 Only you               │
│  │▣ ▣ │  Updated Sep 10                       │
│  └────┘                                      │
│  ┌────┐  Film club — September           ›   │
│  │▣ ▣ │  5 titles · 🔗 Link                   │
│  │▣ ▣ │  Updated Sep 8                        │
│  └────┘        … 6 more, paged on updated_at │
└──────────────────────────────────────────────┘
```

**The row contract — one row, three facts, no controls.**

- **Cover** is the first four posters, 2×2, per §D. Fewer than four fills what there is; an
  empty list draws the empty poster frame.
- **Line 2** is `N titles` · `Numbered` (only when `order_style = 'ranked'`) · the
  visibility chip.
- **Visibility chips are three words, never a bare glyph:** 🔒 Only you · 🔗 Link ·
  🌐 Profile. These are the New-list picker's own options, shortened, so the chip is
  recognisable as the choice that was made.
- **Line 3** is `Updated <date>`, which is also the sort key — so the order explains itself
  and needs no sort control.
- **No swipe-to-delete.** Delete lives in the list's own edit mode (§G), in one place.
- A **moderation-hidden** list keeps its row, with the §F.10 banner state on the chip.

### Profile → LISTS

**Public lists only, on every profile including the owner's**, read-only, no editing
controls — the `ProfileWatchlist` rule. A clipped `PosterShelf`, not a grid: a shelf says
"there is more" without claiming to be the whole thing.

Order is unchanged (founder, 2026-09-19): Identity → Actions → Goals → Awards →
Top ranked → Watchlist → **Lists** → Recent activity. Lists are **not** promoted above
Watchlist in v1.

**Another person's profile, with ≥1 public list**

```
│  LISTS                              See all  │   ← See all only when > 3
│  ┌────┐   ┌────┐   ┌────┐                    │
│  │▣ ▣ │   │▣ ▣ │   │▣ ▣ │  ◂ clipped shelf   │
│  │▣ ▣ │   │▣ ▣ │   │▣ ▣ │                    │
│  └────┘   └────┘   └────┘                    │
│  Best      Chicago   Comfort                 │
│  breakup   movies    movies                  │
│  14        9         22                      │
```

**Own profile**

```
│  LISTS                              Manage › │
│  ┌────┐   ┌────┐                             │
│  │▣ ▣ │   │▣ ▣ │                             │
│  └────┘   └────┘                             │
│  Best      Chicago                           │
│  breakup   movies                            │
│  14        9                                 │
```

**Own profile, lists exist but none are public**

```
│  LISTS                              Manage › │
│  Nothing public yet. Lists you publish       │
│  show up here.                               │
```

- **`Manage ›` is always present on the own profile**, whether or not anything is public,
  and pushes the same `app/lists/index.tsx`. It is the second door, not a second home.
- **The own shelf deliberately shows only what a visitor would see.** An owner with four
  private lists sees the "nothing public yet" line, and learns the privacy model by looking
  at it. **Private and link-only lists are never drawn on a profile shelf**, including the
  owner's own.
- **No empty state on anybody else's profile, ever.** The section is absent unless
  `can_view_profile` holds and at least one public list exists — `ProfileWatchlist`'s rule:
  an unviewable shelf and an empty one must render the same nothing, or the absence is
  itself a disclosure.
- **`See all` is a pushed read-only screen, not a sheet.** The `RankedTitlesSheet` pattern
  is dropped here, and with it the "close the sheet before pushing the list screen"
  sequencing hazard the earlier draft carried. A list opens straight from a shelf card.
- Tapping a card pushes `app/lists/[id].tsx` directly. No intermediate sheet anywhere in
  this section.

### Not in v1

Feed stories, Search results for lists, "In N lists" on title pages, featured rails,
folders, pinning, manual ordering of My lists.

---

## J. Public web and deep links

### URL

`https://bingd.app/lists/<uuid>` is stable across renames and already claimed by AASA and
assetlinks (verified live 2026-09-19).

Pretty URLs later (`/u/<handle>/lists/<slug>`) sit under the already-claimed `/u/*`. **They
would apply to public lists only.** A link-only list must never gain a handle-derived,
guessable URL.

### Architecture

```
Tap link
 ├─ app installed + verified → app/lists/[id].tsx (Stack.Protected)
 │     signed out → (auth); destination lost, same as /title and /u (§6F contract)
 └─ not installed / desktop → lists.html (Cloudflare Pages)
       page.mjs:
         listIdFromPath(pathname)            ← uuid shape only; else generic page
         rpc list_view(id)                   ← anon; §E predicate
         rpc list_items_page(id, null, 100)
         rpc record_list_open(id, platform)  ← fire-and-forget
         paintInstall(destinationFor(platform, distribution))
         "Open in bingd." → appLinkFor('bingd','lists',id)   ← add 'lists' to the allowlist
```

- **Every user string is set with `textContent`.** No `innerHTML` path touches a title,
  description or name.
- **Zero rows keeps the generic page.** Private, deleted, hidden and suspended all read
  the same.
- **Attribution:** when `owner.profile_visible`, the name links to `/u/<handle>`.
  Otherwise it is plain text, never a link.
- **Android CTA:** `destinationFor('android')` returns the closed-test opt-in today, and
  switches when `android.storeUrl` is set. No list code names a store, and store rewiring
  stays out of scope.
- **`noindex` stays** on `/lists/*`.

### Logged-out page

```
bingd.
A LIST ON BINGD.
Best breakup movies
(◉) Maya Chen  @maya          ← link to /u/maya only if the profile is public
Ones that actually help.
14 titles · numbered
[ Open in bingd. ]   [ Get bingd. on the App Store ]
 1  [poster]  Eternal Sunshine of the Spotless Mind   2004
 2  [poster]  Past Lives                              2023
 …           See all 14 in the app
Rank what you've watched. See what your friends really think.
```

Desktop shows a 5-column poster grid.

### Link previews (approved, §P.3; built in L5)

- A Cloudflare Pages Function on `/lists/*` calls `list_preview` with the anon key and sets:
  - `og:title` to the list title;
  - `og:description` to "14 titles · a list by @maya on bingd." when the owner is public,
    or "14 titles · a list on bingd." when not.
- It falls back to the static card on any error or zero rows. That covers private, hidden,
  deleted, malformed and suspended alike.
- It caches for 5 minutes, and `og:url` stays the route prefix.
- **The image stays the generic card in v1.** A poster-collage image is approved in
  principle for later: it is image generation in a Worker, and TMDB poster imagery only.
- The Function holds the anon key only, never a service key.

---

## K. Utility-list behaviour

| Behaviour | v1 | Definition |
|---|---|---|
| Seen mark | **Yes** | **Movie:** the viewer has a `user_media` row. **Season:** a row whose `progress` is not `watching`. **Series:** any season of it logged (a documented approximation) |
| "You've seen X of N" | **Yes, for the viewer and the owner alike** (§Q.5) | Derived at read time over the whole list, for whoever is reading. **Plain text, one line, no control.** Suppressed when the list is empty. Never stored, and never on the web. **Strictly viewer-private**: a list's owner sees their *own* progress through it and never any other reader's — "never shown to the owner" means nobody else's figure, not that the owner has none |
| Add one to Watchlist | **Yes** | Existing `set_watchlist`, `surface:'list'`; its per-title event behaviour is unchanged |
| Add all unseen to Watchlist | **Yes** | `add_list_to_watchlist`: **no feed events**. It skips seen and already-saved titles, and the Watchlist invariant still clears each title on watch |
| Checkboxes, due dates, "complete", reminders | **No** | Seen is derived from logging, which people already do |
| Progress **bar**, ring or percentage | **No** (founder, 2026-09-19) | A bar reads as a chore tracker. The line is plain text or it is nothing |
| "Unseen only" filter | **No** in v1; later | |
| Group Picks → Save as list | v1.1 | Creates a private, unnumbered list of the picks |

---

## L. Creator / editorial extensibility

**Ordinary user lists are sufficient.** No ownership change is needed.

- **Creators** are ordinary public accounts with ordinary public lists. A badge, if ever,
  is a `profiles` column.
- **bingd. editorial** is an official public account owning ordinary lists. That keeps it
  under blocks, reports and hides, and is consistent with deferred-roadmap §25 ("clearly
  attributed", never a For You source).
- **Limits:** the 100 ceiling is the only enforced count. An editorial account needing
  more can get an `unlimited_custom_lists` grant through the existing `capability_grants`,
  if `create_list` is taught to honour it then. v1 does not need it.
- **Featured lists (later):** `featured_lists(list_id pk → lists on delete cascade, surface,
  rank, starts_at, ends_at, created_by)`, written by service role from a runbook and read
  through a definer RPC that re-checks `_list_readable` **and `visibility='public'`**.
  Link-only lists can never be featured.
- **Not now:** `owner_kind`/`list_type` columns, organisation accounts, co-owners,
  sponsored lists, or an editorial flag.

---

## M. Analytics and success

### Events (PostHog; "fires exactly when")

| Event | Fires exactly when | Properties |
|---|---|---|
| **`my_lists_opened`** | the My lists screen mounted | **`entry` (`collection`, `profile_manage`)**, `owned_count`. **Built in L2, not deferred to L6** (founder, 2026-09-19) |
| `list_created` | `create_list` answered ok | `surface` (**`my_lists`**, `title_menu`), `visibility`, `order_style`, `has_first_item`, `owned_count_after`, **`would_have_exceeded_3_lists`** |
| `list_item_added` | `add_list_item` answered `added` | `surface` (`list_add_sheet`, `title_menu`), `media_kind`, `count_after` |
| `list_visibility_changed` | `update_list` changed visibility | `from`, `to`, `surface` (`edit`, `share_prompt`), `profile_private` |
| `list_shared` | the share sheet **opened** for a list URL | `visibility`, `item_count`, `is_owner` |
| `list_opened` | the list screen resolved a readable list | `surface` (**`my_lists`**, **`profile_shelf`**, `deep_link`, `title_menu`), `is_owner`, `relation` (`self`, `following`, `other`), `visibility_class` (`public`, `link`) |
| `watchlist_added` | existing | `surface:'list'` |
| `list_watchlist_bulk_added` | `add_list_to_watchlist` answered ok | `added`, `skipped_seen` |
| `list_limit_reached` | `create_list` answered `list_limit` (the 100 ceiling) | — |
| (server) `list_web_opens` | web page resolved a readable list | `platform` |

**`my_lists_opened.entry` is the discoverability tripwire, and it ships in L2** (founder,
2026-09-19). `My lists ›` is a text action rather than a permanent segment, which buys the
clutter constraint at some cost in discoverability. This split is how that cost is
measured, and it is the **only** evidence that would justify ever promoting Lists to a
Collection segment. Deferring it to L6 would mean the first thirty days of data — the ones
that matter — are unrecoverable.

- Readout: `entry = collection` share of `my_lists_opened`, and `surface = my_lists` share
  of `list_created`, both over the first 30 days after release.
- **Rethink the entry** if `entry = collection` is under ~20% of opens *and* `list_created`
  from `my_lists` is near zero, i.e. essentially every list is being born in the title
  menu and nobody is finding the screen. The remedies then, in order of cost: a slim
  full-width row under `HeaderBoundary`, then a conditional segment.
- **This is not a success metric** and does not belong in the §M table below.

**`would_have_exceeded_3_lists`** is true when `in_app_count_before ≥ 3`, where
`in_app_count_before` is returned by `create_list` and counts in-app lists only. Imported
lists are exempt per PRD §12. In other words: this creation would have been refused under a
three-list cap.

- **The event is the source of truth.** A later SQL snapshot misses lists that were
  created and then deleted.
- It is never shown to the user and has no client branch.
- Readout: the share of creators with ≥1 `list_created` where
  `would_have_exceeded_3_lists = true`.

### Success (provisional thresholds; 30-day readout, activated cohort)

| Question | Metric | Healthy | Rethink |
|---|---|---|---|
| Real lists? | % of activated users with ≥1 list of ≥3 items | ≥20% | <10% |
| Creation completes? | % of `list_created` reaching ≥3 items in 24h | ≥50% | <30% |
| Substantial? | median items per ≥3-item list | ≥6 | — |
| Leave the app? | % of ≥3-item lists shared at least once | ≥25% | <10% |
| Reach people? | `list_web_opens` per shared list | ≥2 | <1 |
| Pull people in? | deep-link `list_opened` by accounts <7 days old | tracked | — |
| Drive viewing? | Watchlist adds per non-owner open, then % of those titles logged in 30 days | ≥0.5 adds/open | ~0 |
| Alive? | owner edits or reopens after day 1; non-owner reopen rate | ≥30% | <10% |
| Hypothetical cap | % of creators who would have exceeded 3 | recorded, no bar | — |
| Guardrail | `ranking_completed` per WAU before and after | flat or up | any drop |

**Not success metrics:** total lists, total views, or items in aggregate.

---

## N. QA

### SQL (L1)

- **Readability matrix** over `list_view`, `list_items_page`, `list_by_id`,
  `list_items_by_list`, `list_preview`, `profile_lists` and direct `select`. Cover:
  - viewers {owner, follower, stranger, anon, blocked each way};
  - owners {public profile, private profile, suspended};
  - lists {private, link, public, hidden}.

  The expected results are exactly the §F matrix.
- **The link exception is bounded:**
  - a stranger reading a private owner's link list gets the list and limited identity with
    **no owner id for anon**;
  - with the same viewer, `profile_identity` still answers identity only, and rankings,
    Watchlist, `profile_lists` and activity reads all still return nothing.
- **Enumeration:** a stranger's `select … where visibility='link'` returns zero rows.
  `profile_lists` never returns `link` to a non-owner. `list_preview` answers only for
  anon-readable lists.
- **Public requires a public profile:** create and update answer `profile_private`. A profile
  made private afterwards leaves public lists follower-only, answers anon with zero rows,
  and leaves link lists readable.
- **Writers:**
  - non-owner writes are refused, and operation-id replay returns the first answer;
  - a duplicate add answers `already`;
  - `max_items`, `max_per_user = 100` and the daily rate refuse at the boundary;
  - `in_app_count_before` is correct, and imported lists are excluded;
  - `move_list_item` keeps positions unique under a concurrency race;
  - ordinals stay contiguous after a removal;
  - only movie, season and series kinds are accepted.
- **Bulk Watchlist:** skips seen and saved titles, writes no `feed_events`, and the invariant
  still clears.
- **Moderation:** `report('list' | 'list_title')` works end to end. A hidden list is
  unreadable by non-owners, and its visibility is locked for the owner.
- **Lifecycle:** account deletion removes lists and web opens. Pruning keeps list-referenced
  `media_items`.
- **Grants:** `function-grants.test.mjs` is updated. Anon gets exactly `list_view`,
  `list_items_page`, `record_list_open`, `list_preview`, `list_by_id` and
  `list_items_by_list`. `_list_readable` is granted to nobody.

### Client (RNTL; local traps apply)

- ⋯ is present on movie, season and series titles whether ranked, logged or unwatched, and
  Add to list… comes first.
- Zero lists opens New list with the title preselected.
- Membership toggles, and Numbered on/off keeps the order.
- **`+ New list` stays pinned while the Add-to-list rows scroll**, and toggling a row off
  removes the title.
- **The confirmation names the destination list, and Undo removes the item again.**
- Move controls and their accessibility actions work.
- The private → link consent copy, including the private-profile line.
- "On your profile" is disabled for a private profile.
- Share visibility follows `shareable_by_viewer`.
- Limited-identity attribution shows its lock glyph.
- Progress renders for the **owner and the viewer**, is **suppressed on an empty list**,
  and bulk-add says **"my Watchlist"**; the unavailable stub renders.
- **`Add titles` renders below the progress/bulk block on the owner's list**, not above it.

**IA (the 2026-09-19 model):**

- The `My lists ›` action is present on Collection **on every segment and both mediums**,
  and it is a labelled text action, not a glyph.
- Collection posters and rows have **no long-press and no overflow**; `TitleActions` still
  has exactly three controls.
- My lists renders **zero, one and ~10** list states, with the right chip, `Numbered` only
  when ranked, and `Updated` ordering.
- **`Collection → My lists ›` and `Profile → LISTS → Manage ›` reach the same screen.**
- **Own profile shows public lists only** — an owner holding only private/link lists gets
  the "Nothing public yet" line, and **no private or link-only list is ever drawn on a
  profile shelf**.
- **Another profile renders no LISTS section at all** when it has no public lists, and
  renders none for an unviewable profile — the two must be indistinguishable.
- **See all is a push, not a sheet**, and a shelf card pushes the list screen directly.
  There is no sheet → push sequence anywhere in §I.
- `my_lists_opened` fires once per mount with the right `entry`.

### Web

- `listIdFromPath` accepts a uuid and rejects everything else.
- `appLinkFor(…,'lists',…)` works.
- An XSS title renders inert.
- Zero rows gives the generic page.
- Attribution is a link only when `profile_visible`.
- Install buttons for ios, android opt-in and other.
- The L5 Function falls back on every failure, and never names a private owner.

### Device (staging preview lane → production)

- iOS universal link and Android App Link, signed in and signed out.
- Logged-out Safari, Chrome Android and desktop.
- "Open in bingd." opens the app.
- A private-profile owner's link list opens for a logged-out phone.
- A private-profile owner's public-era list does not open on the web.
- Unfurls in iMessage, WhatsApp and Slack.

### Release

- **Every lane's fingerprint is unchanged**, measured relatively in two worktrees. There is
  no diff to `package.json`, the lock file, `eas.json` or `app.config.ts`.
- The migration goes to production before the OTA. Edge functions are untouched.

---

## O. Six-PR build sequence

| PR | Scope | Ships by | Depends on |
|---|---|---|---|
| **L1: Lists backend** | Migration: §E alters, `_list_readable`, redefined `list_by_id` / `list_items_by_list`, `hidden_at` in the select policies, writers (with the `profile_private` guard, the 100 ceiling, `in_app_count_before`), readers (incl. **`my_lists`**, **`profile_lists` public-only**, `list_preview`), `list_web_opens` + `record_list_open`, `app_config` keys and the `base_free_limit` re-comment. SQL tests (§N). Runbook §2d hide/unhide. `data-model.md` §6 corrected | Staging → production DB (inert without a client) | — |
| **L2: Make and edit lists** | Real `app/lists/[id].tsx` **and new `app/lists/index.tsx` (My lists)**. **The `My lists ›` action on the Collection title row.** ⋯ on every title with **Add to list…** (pinned `+ New list`, named-destination toast with Undo, and the zero-list path straight to New list). New-list sheet with the consent copy and the private-profile rules. Add-titles sheet, edit mode with move controls, delete. Share with the private → link prompt. The Settings → Privacy one-line addition. Events **`my_lists_opened` (with `entry`)**, `list_created` (with `would_have_exceeded_3_lists`), `list_item_added`, `list_visibility_changed`, `list_shared`, `list_opened`, `list_limit_reached`. **No Profile work and no See-all sheet** — both move to L3 | OTA: iOS prod + Android beta | L1 in production |
| **L3: Reading other people's lists** | **The Profile `LISTS` shelf, public-only, on own and other profiles**, with `Manage ›` on the own profile, the "nothing public yet" line, and the **pushed** See-all screen (no sheet). Attribution states (full / limited identity → locked shell). Seen marks and "You've seen X of N" for viewer and owner. Row bookmarks. Add all unseen ("my Watchlist"). Report list. `list_watchlist_bulk_added` | OTA (same release as L2) | L2 |
| **L4: Public list web page** | `listIdFromPath`, `appLinkFor` + `lists`, page render with the attribution rule, `record_list_open`, router tests | Cloudflare Pages (preview URL first) | L1 in production; deploy with the L2/L3 OTA |
| **L5: Link previews** | Pages Function on `/lists/*` using `list_preview`: title, count, `@handle` only for public owners, generic fallback, 5-minute cache, generic image | Cloudflare Pages | L4 |
| **L6: Measurement and doc truth** | PostHog tiles for §M, including the hypothetical-cap readout **and the `my_lists_opened.entry` discoverability split** (the event itself ships in L2). PRD §8/§20 corrected and **§7 confirmed as built**, deferred-roadmap §50 status, audit §P1.2 note, `web-deployment.md` AASA note, `analytics.md` event rows | Docs + dashboard | L2–L5 live |

**Release:** L1 (production DB) → L2 + L3 on staging preview → device QA (§N) → one OTA
to both lanes → L4 deployed the same day → L5 once L4 is verified → L6.

**Not yet scheduled.** Implementation is parked behind Watch History T1–T4 and the
post-foundation hardening/scalability pass (founder, 2026-09-19). L1 does not start until
that is cleared.

**Later:** v1.1 adds drag, **long-press manipulation inside a list screen**, per-item
notes, Group Picks → list, "Start from my ranking", and Letterboxd list import. v2 adds
save/copy, "In N lists", featured/editorial, the collage OG image, pretty public URLs,
revocable link tokens and collaboration.

---

## P. Decision record, 2026-09-19

1. **No three-list free limit in v1.** The only limit is 100 owned in-app lists, as a
   sanity ceiling. `would_have_exceeded_3_lists` is instrumented on `list_created` and never
   shown to the user.
2. **Link-only lists work on private profiles.** This is an explicit object-level share.
   It is not discoverable and unlocks nothing else. Attribution is limited identity and not
   a path into private content. Public lists require a public profile. The consent copy is
   "Anyone with this link can view this list."
3. **Link previews: yes** for public and link-only lists, with the list title, safe
   metadata, and posters later. Private lists get the generic card. *Implementation
   refinement:* the owner's handle appears in a preview only for public-profile owners.
4. **Title-page ⋯: yes**, on every movie, season and series, with **Add to list…**. With no
   lists, it offers Create new list. No permanent list button. The #123 layout is otherwise
   preserved.
5. **Hybrid IA (added by the navigation review later the same day; see §Q).** Collection
   owns list management through a `My lists ›` text action on the existing title row; the
   Profile carries a **read-only shelf of public lists only**. No Collection segment, no
   new control row, no bottom-nav item, no icon-only entry.

Also approved: mixed media kinds; optional numbering, off by default; list order
independent of the Collection ordinal; **progress for the viewer and the owner alike**,
plain text only; Private as default; three modes; the two entry points; and every §D
non-goal.

### Defaults chosen here, not blocking (the founder can reverse any without reshaping a PR)

- A signed-in blocked viewer cannot open link or public lists. Logged-out bypass is
  accepted and documented (§F.7).
- A profile made private later leaves existing public lists follower-only, not converted
  (§F.4).
- In the app, private-owner attribution opens the existing locked shell (identity + follow
  request). On the web it is plain text (§F.2).
- A non-owner gets a Share button on public lists only, not on link-only lists.

---

## Q. IA review and the Hybrid model, 2026-09-19

A navigation and information-architecture review was run before any Lists implementation
began, because the earlier draft of this PRD put **management** on the Profile and the
founder was not convinced. **The review's recommendation was approved in full.** This
section is the decision and its reasoning; every other section above has been rewritten to
match it.

### Q.0 What changed

| | Earlier draft | **Approved** |
|---|---|---|
| Manage my lists | Profile → Lists row → See-all **sheet** | **Collection → `My lists ›` → pushed screen** |
| Create | Profile Lists row → `+` tile | **My lists → `+ New list`** (unchanged second point: title ⋯) |
| Own profile shows | every list, with visibility chips | **public lists only, read-only, `Manage ›`** |
| See all | a sheet, closed before a push | **a pushed screen** |
| `profile_lists` | owner sees all | **public-only for everyone** |
| Discoverability data | — | **`my_lists_opened.entry`, built in L2** |

### Q.1 Why not Profile-first

The earlier draft was modelled on Letterboxd and Beli, where lists live on the profile. The
review's central finding is that **those products put lists on the profile because their
profile *is* the library** — neither has a separate collection tab. bingd deliberately
split **Collection** (the working surface) from **Profile** (public identity), and in that
split, copying the *placement* without the *structure* is the error.

- Spotify is the only researched product with bingd's split, and it puts management in
  **Your Library** and display on the profile.
- bingd already has this rule written down, in `ProfileWatchlist.tsx`: *"There is no
  separate Watchlist profile screen for beta — **Collection is where the full list is, for
  the account that owns it**"*, and profile shelves carry **no editing controls** by
  design. A `+ New list` tile and a Delete path two taps deep would have been the opposite
  rule on the same screen.
- `PRD.md` §7 and `app/(tabs)/_layout.tsx` both already said Collection holds Lists. The
  earlier draft listed §7 as a document to *correct*; it was this PRD that had diverged.
- The sheet → push sequence the draft required is a known dead-end class in this codebase.

### Q.2 Why not a Collection segment

Right instinct, wrong mechanism.

**Collection is organised by medium.** `MediumSelector` is the screen's *title*, and
Watched, Watchlist and Unranked are all slices of `Movies` or `TV seasons`. A list mixes
movies, seasons and whole series by design (§C), so a Lists segment would sit under a
`Movies ▾` title it had to ignore — the same disagreement as the Unranked-tab bug, which
the code now guards against explicitly. A permanent fourth segment also fails the existing
conditional-segment rule (*"a tab that is empty for most users is a permanent reminder of a
chore nobody agreed to"*), and Lists will be empty for most users for a long time.

And a Collection-only feature would kill the half deferred-roadmap §50 says matters most:
a public list is the one artifact useful to somebody with **no friends on bingd yet**. That
argument dies if lists never appear on a profile.

### Q.3 Why this particular entry

`My lists ›` on the **trailing edge of the existing title row**:

- **zero added height** — no third control row, no segment, no tab;
- **outside the medium axis**, so it cannot desynchronise from `MediumSelector`;
- **not the `AppHeader` right corner**, which is the bell's on every root tab and where a
  text button was already tried and rejected (`app/(tabs)/profile.tsx`);
- **labelled, not a glyph** — `TitleActions`' own rule;
- it reuses `SectionHeader`'s existing maroon trailing-action idiom, the same "go to a
  related place" affordance as Top Ranked's *See all*.

**The honest cost is discoverability**, and it is accepted rather than bought with a
permanent segment. §M's `my_lists_opened.entry` is the tripwire, and it ships in L2 for
exactly that reason.

### Q.4 Why the Profile shelf is public-only

The own-profile shelf **shows what a visitor would see**. An owner holding four private
lists gets "Nothing public yet" and learns the privacy model by looking at it, and no
private or link-only list is ever drawn on an identity surface. `Manage ›` is always there,
so nothing is unreachable. `See all` is a **push**, which removes the sheet-sequencing
hazard and lets a shelf card open a list directly.

### Q.5 Why progress stays

One line, no control, and the read path already computes it (`viewer_seen` is on
`list_items_page`). It is the whole utility half: without it a list is a poster grid you
read, with it, it is a plan you are partway through. Beli ships exactly this line on its
Featured Lists (*"You've been to 0 of 15"*) in the nearest comparable product shape. It is
kept **for the owner too**, because the headline utility list — Oscar catch-up, horror
month — is the one they made for themselves, and it is the reason to reopen it. **Plain
text only**: a bar, ring, percentage or checklist would read as a chore tracker, and that
is the visual noise the concern was about.

### Q.6 Founder decisions recorded here

1. **Collection entry:** text + chevron `My lists ›` on the Movies/TV title row. **Not** a
   fourth segment, a new control row, a bottom-nav item, or an icon-only entry. Outside the
   medium axis.
2. **Own profile:** public lists only, reflecting the public identity a visitor sees.
   `LISTS … Manage ›` opens the same My lists screen as Collection. Private and link-only
   are never exposed in the shelf.
3. **Other-profile order:** Top Ranked → Watchlist → **Lists** → Recent activity. Lists are
   **not** promoted above Watchlist in v1.
4. **Progress:** "You've seen X of N" for owner and viewer, plain text. No bar, no
   completion state, no checkboxes, no unseen-only filter.
5. **Long-press:** none in v1, anywhere. Revisit in v1.1 alongside drag.
6. **Discoverability analytics:** `my_lists_opened { entry: collection | profile_manage }`
   is instrumented in **L2**, not deferred to L6. It is how the question "is `My lists ›`
   discoverable enough" gets answered before a Collection segment is ever reconsidered.

### Q.7 Preserved unchanged by this review

`Title ⋯ → Add to list…`; every movie, season and whole series eligible; zero lists →
create with the title preselected; **no Collection row long-press**; **no Collection row
overflow**; **no fourth `TitleActions` button**; and every §D non-goal.

### Q.8 Research base

Letterboxd, Goodreads, Serializd, Spotify, Pinterest, Instagram, TikTok, Beli and TV Time,
reviewed 2026-09-19 against current product behaviour. The two findings that decided it:
**every product that puts lists on the profile has no separate library tab**, and
**Spotify — the one product that shares bingd's split — manages in Library and displays on
the profile.**

---

## R. Founder delta QA, 2026-09-21 — what changed, and the Feed direction

### R.1 Decisions that supersede earlier sections

These reverse or amend §G, §H, §I and §Q.6 for the #196 candidate. Where they disagree,
this section wins.

1. **Collection entry (supersedes §Q.6.1, §Q.2).** Lists is the third option of
   Collection's selector — **Movies / TV / Lists** — and a first-class mode, remembered
   under the same device preference as Movies/TV. It is still not a segment and not a
   bottom tab: in Lists mode the Watched/Watchlist/Unranked tabs are not drawn, because a
   list mixes media. The `My lists ›` link is gone. Profile keeps its public Lists shelf
   and `Manage ›` still pushes `/lists`. `my_lists_opened.entry = collection` now means
   the mode was opened.
2. **Covers (supersedes the always-2×2 rule).** No posters → neutral placeholder with a
   list glyph; 1–3 → the first poster, full cover; 4+ → the 2×2 mosaic of the first four.
   One component (`ListCover`) for My lists, the Profile shelf and all-lists-by.
3. **List page (supersedes §H's header and §Q.6.4's progress line).** Primary **Share
   list**, secondary **Add titles**. One metadata line: owner `3/3 watched · Only you ·
   Updated today`; viewer `X/N watched · Public | Anyone with the link · Updated …`. The
   viewer's word is derived from `shareable_by_viewer`, which is true for a viewer exactly
   when the list is public, so it discloses nothing the Share control did not. The
   "You've seen X of N" line is removed. Tapping the owner's visibility opens settings.
4. **Privacy words.** Only you / Anyone with the link / Public, identical in the chip,
   the picker and the metadata.
5. **Visibility dialogs.** A question as the title, the consequence as the body, the act
   as the button — *Make this list link-only?* / *Make this list public?* / *Make this
   list private?* (`visibilityChangeDialog`). Used by Share-on-private and by saving a
   changed visibility in settings.
6. **Owner ⋯:** Edit list settings (title, description, Numbered, privacy — no ordering,
   no delete), Share, Delete list (its own confirmation).
7. **Reorder (supersedes §Q.6.5 "no long-press" for the list page only).** Long-press a
   row on the list's own page to lift it, drag, drop. The rows between make room as the
   lifted row crosses their middle; the drop commits one `move_list_item` (one title, its
   new index; last-move-wins, as before). Core RN responder system + `Animated`; no new
   dependency, no new binary. The same moves are accessibility actions on each row.
   Collection rows still have no long-press (§Q.7 unchanged).
8. **Numbers** on a numbered list follow the drawn order, on the main page, the public
   page and the link page, and update the moment a drop lands.
9. **Remove a title:** per-row ⋯ → *Remove from list* (owner only).

### R.2 Future list Feed events — direction only, NOT built

Nothing here is implemented; `list_created` / `list_added` stay writer-less (§D). When
lists ever reach the Feed, the rules are:

- **Private (Only you): never** produces a Feed event, of any kind, at any time.
- **Link-only: never automatically.** A link is a share the owner handed to specific
  people; broadcasting it would turn every link into a public list.
- **Public: exactly one event, when the list first becomes public** (created public, or
  changed to public for the first time). Not again on a later private → public flip, and
  never retracted-and-reposted by toggling.
- **No per-title posts.** Adding titles to a list never writes an event; a list is one
  thing in the Feed, not a stream of additions.
- **Later, an explicit "Share to Feed"** action may let the owner post a public list
  deliberately (for example after adding a batch). It would be a user act with its own
  button, never a side effect of an edit.
- The Feed card would carry only what the public list page shows (title, cover, count,
  owner) and would follow `can_i_view` like every other event.

### R.3 Final polish, 2026-09-21 (second delta pass)

- **Add to List is one tap on the title page's action row** (Rank · Watchlist · Add to
  List · Share), replacing the `⋯ → Add to list…` row; the ⋯ is drawn only when the title is
  ranked or logged. Supersedes §P.4's "the ⋯ is on every title".
- **Remove from list is a swipe** on an owned list's row (then a tap on Remove), not a
  permanent ⋯; it stays an accessibility action. Long-press remains the drag.
- **List rows use the shared compact-row actions** (`TitleRowActions`): the reader's own
  score when ranked, else Rank/log + Watchlist.
- **The list page opens on its first title's artwork** with the title page's collapsing
  header, and Add titles / Share list sit side by side.
- **Covers:** the 2×2 mosaic is two flex rows of two cells; the earlier tile arithmetic
  wrapped inside the cover's border and drew two half-width strips on device.
