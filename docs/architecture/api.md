# Bingd — API Surface

**Version:** v1 (public alpha)
**Specification:** [`../product/PRD.md`](../product/PRD.md) v0.6 · [`README.md`](./README.md)

The contract between client and server. Three surfaces, each with a different job.

| Surface | Used for | Auth |
|---|---|---|
| **RPC** — Postgres functions over PostgREST | Every write | User JWT |
| **Direct select** — PostgREST against tables and views | Every read | User JWT, filtered by RLS |
| **Edge Functions** | External calls, long-running work, scheduled jobs | User JWT or service role |

---

## Conventions

Functions are named `verb_noun`, lower snake case. Every one:

1. Resolves the caller as `auth.uid()`. **No function accepts a user id as a parameter** — that would make impersonation a matter of changing an argument.
2. Validates its inputs before touching a row.
3. Returns a typed result, never a bare boolean.
4. Raises a structured error using the codes in §8.

Outbox-eligible functions additionally take `p_operation_id uuid` as their first parameter and begin with the idempotency guard in [`offline-sync.md`](./offline-sync.md) §3.

> **The outbox allowlist is defined here and nowhere else.** A function is queueable offline if and only if it appears in the **Queueable** column below as `yes`. PRD §18 forbids queuing ranking, blocking, and reporting, and that prohibition is expressed by their absence from the allowlist rather than by a check inside them.

---

## 1. Collection

| Function | Purpose | Queueable |
|---|---|---|
| `log_watched(p_operation_id, media_item_id, watched_on?, note?)` | Mark watched. Creates or updates the `user_media` row | **yes** |
| `set_bucket(p_operation_id, media_item_id, bucket)` | Set or change the bucket **without** starting comparisons. **Unranked titles only** | **yes**, unranked only |
| `unlog(p_operation_id, media_item_id)` | Remove from the collection. **Unranked titles only** | **yes**, unranked only |
| `set_watchlist(p_operation_id, media_item_id, present bool)` | Add or remove from the watchlist | **yes** |
| `set_season_progress(p_operation_id, media_item_id, progress)` | Mark a season *watching* or *completed* | **yes** |
| `save_note(p_operation_id, media_item_id, note, p_base_updated_at?)` | Update the private note | **yes** |

**Implemented in `20260813002300_collection_writers.sql`.** Two behaviours the table above does not state, both settled while building it:

`set_bucket` creates the collection row when the title has not been logged. A bucket is a statement about something the user has watched, so bucketing implies logging, and making the client send two operations to express one tap would open a window in which a title is watched with no opinion attached — a state no screen asks for.

**A series can be watchlisted but not logged.** PRD §10 forbids ranking a whole series, and the collection is what feeds ranking. "I want to watch this show" is also a coherent statement where "I watched this show" is ambiguous about which seasons, so `set_watchlist` accepts any kind and the rest of §1 requires a movie or a season.

`set_bucket` and `rank_start` are deliberately separate. Setting a bucket is a low-conflict write that queues offline; starting a comparison session requires the server. A user who buckets a title offline gets a Logged title, and can rank it later when connected — which is precisely the two-state model in PRD §11.

### The unranked-only restriction — Required

**Corrected 2026-08-13.** `set_bucket` and `unlog` were both unrestricted and both queueable, and both act on titles that may be **ranked**. That is a hole straight through PRD §18's rule that no ranking mutation is ever queued, and the outbox allowlist could not catch it, because the allowlist reasons about function names while the danger depends on the *state of the row* the function is pointed at.

Concretely:

- `set_bucket` on a ranked title breaks invariant I3, which requires `rankings.bucket` and `user_media.bucket` to agree, and I2, which requires a position to sit inside its own bucket's band. Honouring the change means moving the title to a different band and renumbering — which is `rank_rebucket`, an online-only operation with a consequence the user must see, because their position changes.
- `unlog` on a ranked title deletes a `rankings` row, which requires closing the gap and renumbering every position below it. Queued, it destroys ranking work built over dozens of comparisons, with the deletion applied silently on reconnect and no way to get it back.

Both functions now raise `BG409` when a `rankings` row exists for the title. The client checks first and routes the user to the online-only path — **Change rating** for a ranked title opens `rank_rebucket`, and **Remove** opens `unrank` followed by `unlog` — both of which are refused offline with the graceful message in PRD §18 rather than queued.

The general rule this exposes, which matters for any RPC added later: **a function is queueable only if it is queueable for every state its target row can be in.** Where that is not true, the function must reject the unsafe state rather than the allowlist trying to describe it.

### Note conflict detection — Required

`save_note` takes an optional `p_base_updated_at`. `offline-sync.md` §5 promises that a note edited offline while the server copy also changed produces a user-visible choice rather than a silent overwrite, and there was no mechanism capable of keeping that promise: nothing in the request said which version the edit was based on, and `user_media.updated_at` was never advanced after insert.

**The version is `user_media.note_updated_at`, not `updated_at`.** The first implementation compared against the row's `updated_at`, which the `touch_updated_at` trigger advances on *every* write to the row. That turned the ordinary offline sequence into a guaranteed conflict: tap a bucket, then write a note on the same film, drain in that order, and `set_bucket` moves the version out from under the queued note edit — a "changed on another device" dialog about a note nothing had touched. A conflict prompt that fires on a routine session teaches people to dismiss it, which is precisely when it needs to be believed. `note_updated_at` is advanced only when the note text actually changes, on insert as well as update.

When the client supplies `p_base_updated_at` and it does not match, the function raises `BG409`. Online edits may omit the parameter; **outbox replays must include it**, since that is the only case where divergence is possible. Three details the client depends on:

- **The payload carries the server's version, not the server's text.** Postgres writes an exception's `DETAIL` into the database log at default settings, and a note is always-private under PRD §22. The client owns the row, so on `BG409` it reads its own note to present keep-mine or keep-theirs. `DETAIL` reaches the client as the `details` field of PostgREST's error body — the same forwarding caveat as the `53400` note in §8.
- **`save_note` and `log_watched` both return `note_version`.** A client draining two edits to the same note must carry that forward as the next base, or its second edit conflicts with its own first. Coalescing the edits per title in the outbox is the simpler answer and is what `offline-sync.md` §3 asks for. A base version must always be one the server issued for that note — never a locally invented timestamp, which reads as divergence.
- **A row that has never held a note has a null version**, and any base against it is accepted. There is no text to lose, so there is nothing to ask the user about.

`p_note` is capped at 2000 characters (`BG400`). Nothing in the PRD specifies a length; the cap exists because an uncapped text column is one a modified client can put a megabyte in, per title, the same reasoning that capped `reports.note`.

`p_watched_on` is refused beyond `current_date + 1`, not `current_date`. The server is UTC and the client sends a local date, so east of UTC the local date is a day ahead for the first hours of every day, and refusing tomorrow would reject a correct "watched tonight" depending on longitude.

---

## 2. Ranking — never queueable

| Function | Purpose |
|---|---|
| `rank_start(media_item_id, bucket)` | Open a session, or return a position directly if the band is empty |
| `rank_answer(session_id, winner_id)` | Record one comparison, return the next pivot or the final position |
| `rank_skip(session_id)` | Re-anchor. Places at the midpoint on the third skip |
| `rank_back(session_id)` | Step back one comparison |
| `rank_cancel(session_id)` | Abandon the session. The bucket survives; the title stays Logged |
| `rank_reorder(media_item_id, new_position)` | Manual reorder, clamped to the title's own band |
| `rank_unrank(media_item_id)` | Remove the position, keep the `user_media` row and its history |

Every one of these is **absent from the outbox allowlist**, which is how PRD §18's rule that no ranking mutation is ever queued is enforced. Offline, the client does not attempt them and says so.

> **Corrected 2026-08-14.** Two of these names were wrong here and one function did not exist. The table said `rank_move` and `unrank`; the implementations have always been `rank_reorder` and `rank_unrank`. And `rank_cancel` was specified from the beginning and never written — the gap survived because nothing called it, there being no comparison screen and therefore no close control. Building that screen is what found it. It exists now (`20260814050000`), because the alternatives were making a user unwind five answers with Back to escape a session, or leaving the row behind for `rank_start` to resume mid-search the next time that title came up.

Semantics are in [`ranking.md`](./ranking.md).

---

## 3. Social

| Function | Purpose | Queueable |
|---|---|---|
| `follow(target_id)` | Follow, or create a request if the target is private | no |
| `unfollow(target_id)` | Remove a follow or withdraw a request | no |
| `respond_follow_request(requester_id, approve bool)` | Approve or decline | no |
| `remove_follower(follower_id)` | Remove someone who follows you | no |
| `react(feed_event_id, kind)` | Add or change a reaction. Upsert on the primary key | no |
| `unreact(feed_event_id)` | Remove a reaction | no |
| `tag_watch(media_item_id, tagged_ids uuid[])` | Tag up to 10 people you follow or who follow you | no |
| `remove_tag(tag_id)` | Callable by the tagged user. Sets `removed_by_tagged` | no |
| `block(target_id)` | Block. Removes follows both ways, voids invitations, hides tags | no |
| `unblock(target_id)` | Remove a block. Does **not** restore prior follows | no |
| `report(subject_type, subject_id, reason, note?)` | File a report | no |

**`block` and `report` are not queueable**, per PRD §18. Both are safety actions where a stale queued state is dangerous — a user who blocks someone on a train should not discover an hour later that it never took effect. The client hides the target locally on tap and submits when connected, which is a UI affordance rather than an outbox entry.

`block` does substantial work in one transaction: delete both `follows` rows, void any `invite_attributions` between the pair that have not been accepted, and insert the `blocks` row. Everything else — feed, leaderboard, match, tagging, public pages — follows automatically, because they all read through `can_view_profile`.

`unblock` deliberately does not restore follows. Restoring a relationship the user severed would be surprising, and the follow is one tap to recreate.

---

## 4. Lists

| Function | Purpose | Queueable |
|---|---|---|
| `create_list(title, description?, visibility)` | Create. **Enforces the three-list limit** | no |
| `update_list(list_id, ...)` | Rename, re-describe, change visibility | no |
| `delete_list(list_id)` | Delete a list and its items | no |
| `set_list_item(p_operation_id, list_id, media_item_id, present bool)` | Add or remove a title | **yes** |
| `reorder_list(list_id, media_item_id, new_position)` | Move an item | no |

The limit check inside `create_list`:

```sql
if not ('unlimited_custom_lists' = any(resolve_capabilities(auth.uid()))) then
  if (select count(*) from lists
       where owner_id = auth.uid() and source = 'in_app') >= 3 then
    raise exception using errcode = 'BG403', message = 'capability_required';
  end if;
end if;
```

Two things about this are load-bearing. It counts `source = 'in_app'` only, so imported lists never block creation (PRD §12) and the ceiling metric stays clean (PRD §28). And it appears in a **create** path — per AD-9, no delete or read path calls `resolve_capabilities` at all, which is what makes the destructive over-limit case impossible to write.

`create_list` is not queueable because it is capability-gated, and a limit decision made on stale offline state would either wrongly refuse or wrongly permit.

---

## 5. Invitations and sharing

| Function | Purpose |
|---|---|
| `get_or_create_invite_token()` | Return the caller's live token, creating one if absent |
| `revoke_invite_token()` | Revoke the live token. The next call issues a new one |
| `resolve_invite_token(token)` | **Unauthenticated.** Returns public-safe inviter context only |
| `accept_invite(token)` | Explicit acceptance. See below |
| `create_share_token(object_type, object_id)` | Mint a share token for an object the caller owns |
| `resolve_share_token(token)` | **Unauthenticated.** Returns `(object_type, object_id)` and nothing else |

`resolve_invite_token` returns display name, avatar, and nothing more — never the inviter's email, collection, or private fields, and never any indication of who else holds the link. It is callable without a session because the recipient has not signed up yet.

`resolve_share_token` returns **only an object reference**. The caller then reads that object through the normal RLS-filtered path, which applies current visibility. This is the structural form of PRD §16's rule that a token is never authorization: there is no code path in which presenting a token yields content.

`accept_invite` implements the seven-step definition in PRD §17, in one transaction:

1. Resolve the token. Reject if revoked, malformed, or from another environment.
2. Reject if the caller is the inviter.
3. Reject if a block exists in either direction.
4. Reject with `BG409` if this token has already been accepted by this caller.
5. Insert a `follows` row from caller to inviter — `approved` if the inviter is public, `pending` if private.
6. Set `accepted_at` on the caller's `invite_attributions` row. **If a row already exists naming a different inviter, leave it alone** — the follow in step 5 still happens.
7. Emit a notification to the inviter, which carries the follow-back prompt.

The inviter is never auto-followed. Step 5 creates exactly one row, in one direction.

Step 6 is where the original wording was wrong, and the failure was silent. `invite_attributions` is keyed by `invitee_id`, so a person has exactly one attribution — and a second invite link, opened later from a different friend, would have collided on that primary key. Rejecting the whole call at step 4 would have meant a real person tapping a real friend's real invite and getting an error with no useful explanation, because the reason lives in a row about somebody else entirely.

So attribution and acceptance are separated. **First inviter wins the attribution; every subsequent accept still creates the follow.** Attribution answers "who brought this user to Bingd," which has exactly one true answer and is claimed at signup (see `data-model.md` §11). Acceptance is a social act that can happen any number of times with different people. Conflating them made the more common case fail to protect a number nobody sees.

---

## 6. Notifications, capabilities, account

| Function | Purpose |
|---|---|
| `mark_notifications_read(ids uuid[])` | Mark read. Empty array marks all |
| `set_notification_preference(category, enabled)` | Per-category toggle |
| `set_all_notifications(enabled)` | Master switch |
| `register_device_token(token, platform)` | Register for push. Called in v1 even though delivery is off |
| `my_capabilities()` | The caller's capability set, **for presentation only** |
| `update_profile(display_name?, visibility?)` | Profile edits |
| `set_avatar(object_path)` | Points `profiles.avatar_path` at an object in the public `avatars` bucket. Takes a path, not a URL |
| `change_username(new_username)` | Enforces the 30-day rule and writes `username_history` |
| `delete_account()` | Cascading delete, token invalidation, web-page removal |

`my_capabilities()` exists so the client can render a gate as *Coming soon* rather than as a broken button. **It is never the enforcement point.** Every guarded write re-resolves capabilities server-side, so a modified client that lies about its capability set still cannot create a fourth list.

`set_avatar` takes an object path rather than a URL for two reasons. Storing whatever URL a client sends would let any account point its avatar at an off-site address — a tracker that fires once per feed impression, or an image that is one thing during review and another after it. And the origin belongs to the deployment, not to the row, so a dump restored into a second project would otherwise leave every face pointing at the first. The path is validated to begin with the caller's own uuid folder, which is the same rule the storage policy applies to the upload; both are stated, because the two are enforced by different subsystems and neither can see the other. Resolve to a URL with `avatarUri` in `src/lib/images.ts`.

`delete_account()` deletes the caller's `auth.users` row and lets the cascade do the rest. Two things deliberately survive it, both by detaching rather than deleting: the **username reservation**, so the name cannot be claimed by an impersonator, and any **invite attribution** naming the caller as inviter, so growth provenance stays intact. Both are enforced in the schema rather than in this function, so a deletion performed from the Supabase console behaves identically (`data-model.md` §2, §11).

---

## 6a. Reporting and moderation

Added 2026-08-13. `report` appeared in the rate-limit table below but was defined nowhere, and no `reports` table existed — PRD §22 marks reporting **Required**, so this was a missing feature rather than a missing document.

| Function | Purpose | Queueable |
|---|---|---|
| `report(subject_type, subject_id, reason, note?)` | File a report. One open report per reporter per subject | **no** |

Not queueable, for the same reason `block` is not: PRD §22 makes safety actions online-only, and a queued report is a complaint the operator has not received while the user believes it was sent. The client hides the reported content locally on tap and submits when connected, so the *response* is immediate even though the *submission* is not.

Resolution has no client surface at all. The founder reads `moderation_queue`, acts, and records the action — see `data-model.md` §13. Suspension is applied by updating `profiles.status`, which takes effect across every read surface at once through `can_view_profile`, and blocks writes through `assert_can_write()`.

The subject's owner is resolved server-side rather than taken from the caller, since a client-supplied owner would let anyone attribute a report to an account of their choosing. A repeat report of the same subject is silently accepted and not duplicated, because confirming the earlier one discloses its state to the reporter.

---

## 7. Edge Functions

| Function | Trigger | Role |
|---|---|---|
| `tmdb-adapter` | User request, and an operator for the three maintenance actions | Search and detail. Sole holder of the TMDB key (AD-8). Writes through to `media_items`, `media_cache` and `provider_list_cache`. **Built 2026-08-15** |
| `import-worker` | Queue, after upload | Parse, match, build the preview, apply on confirmation, delete the source file |
| `recs-builder` | Schedule + on significant ranking change | Generate a slate per user. See [`recommendations.md`](./recommendations.md) |
| `match-builder` | Schedule | Materialize `match_scores` (AD-7) |
| `notify-dispatch` | Database trigger on notifiable events | Resolve recipients, check preferences, write inbox rows, consult the push flag |
| `nudge-scheduler` | Schedule, twice weekly | Evaluate whether a user has qualifying content. **Sends nothing when there is nothing to say** |
| `og-render` | Web request | Server-render Open Graph images for share and invite pages |

`nudge-scheduler` is worth calling out. PRD §15 makes the nudge conditional on real content, so the function's first action is a query for qualifying activity, and its most common outcome is to send nothing. That is the intended behavior, not a failure mode, and the metric to watch is the ratio of evaluations to sends.

### `tmdb-adapter` — the five actions

Built 2026-08-15. One `POST` endpoint taking `{ action, ... }`, split by who may call it.

| Action | Caller | Purpose |
|---|---|---|
| `search` | signed-in user | Searches TMDB, writes the results into `media_items`, returns them Bingd-shaped |
| `detail` | signed-in user | Fills one title in: runtime, overview, artwork, seasons, credits |
| `similar` | signed-in user | Caches what TMDB associates with one title as the `similar` facet. The candidate source behind For You. Added 2026-08-16 |
| `trending` | `service_role` | Refreshes the four `provider_list_cache` lists. Added 2026-08-16 |
| `enrich` | `service_role` | Drains `tmdb_enrich_due` — rows carrying a tmdb id that have never been fetched |
| `refresh` | `service_role` | Drains `media_refresh_due` — the retention window in §AD-8 |

**`similar` is a user action, and bounded on three sides.** It spends provider quota, which
normally argues for `service_role` — but what a slate needs depends on which titles *this*
person ranked highest, and no schedule knows that. The bounds are: the client asks about at
most six anchors; `tmdb_claim_facet` (`20260816001000`) lets exactly one caller in the world
refresh a given facet at a time, using `media_cache`'s own primary key as the lock; and every
provider request is charged to the caller's hourly ceiling.

**Every request, not every invocation.** The first version of this recorded one request and
made three — the recommendations call plus, on a cold isolate, both genre lists — so the
ceiling permitted three times the provider traffic it claimed to. `noteRequest` now takes a
count and `tmdb.genreRequestCost()` reports what the genre map is about to cost. `search` was
wrong in both directions and is fixed with it: it charged for a query shorter than two
characters, which spends nothing, and under-charged one that warms the genre map.

A read-then-write freshness check cannot do what the claim does. Two accounts opening For You
on the same anchor at the same moment both see it stale and both spend, and a *per-user*
ceiling is no help at all when the callers are different users — which is exactly the
population that shares an anchor.

It writes the facet even when TMDB returns nothing. An obscure title genuinely has no
recommendations, and caching that fact is what stops every slate rebuild asking again.

**`trending` has no read half.** It writes `provider_list_cache`, which is world-readable like
`media_items` and `media_cache`, so a client selects the list directly and joins the ids to
`media_items` rather than asking the adapter for it. That is the same split the facet cache
already uses, and it keeps a screen's read off the provider quota entirely. It is
`service_role` because it spends four provider requests and eighty upserts per call on a
schedule — not because the result is private.

**A search result is already a catalogue row by the time the client sees it.** The adapter
upserts before it answers and returns Bingd uuids, so there is no import step, no "add this
title" affordance, and no identifier in the client that means something only to TMDB. It is
also what lets the client merge local and remote results by `id`: a title in both really is
one row, because the second pass upserted onto the first.

**Writes go through SQL functions, not PostgREST.** `20260815000000` adds four, and the
reason is not stylistic: `media_items_tmdb` is a *partial* unique index and PostgREST's
`.upsert()` cannot name an index predicate, so the obvious client-side upsert fails to infer
it. `media_cache.expires_at` has the same problem from the other direction — AD-8 requires it
to be derived from `app_config`, and computing it in the adapter would put the retention
window in TypeScript, which is exactly where a change in TMDB's terms would fail to reach it.

**Enriching a Wikidata row flips its provenance to `tmdb`.** That is the compliance-relevant
line in the whole feature. A seeded row is CC0 and exempt from the six-month window; once it
carries TMDB's overview, poster path and genres it is not, and `media_refresh_due` filters on
`provenance` to decide. Leaving the column alone would exempt real provider data from PRD §19
by an accident of where the row originally came from.

---

## 8. Errors

One structured shape, so the client can respond to a class of failure rather than parse a message.

| Code | Meaning | Client behavior |
|---|---|---|
| `BG400` | Invalid input | Show a field-level message |
| `BG401` | Not authenticated | Route to sign-in |
| `BG403` | Not permitted | Show why. If `capability_required`, render the *Coming soon* gate |
| `BG404` | Not found, or not visible to the caller | Show a safe unavailable state |
| `BG409` | Conflict — already exists, already accepted, stale session | Refresh and retry |
| `BG422` | Would violate an invariant | Report as a bug. Should be unreachable |
| `BG429` | Rate limited | Back off, show a plain-language message |
| `BG500` | Unhandled server fault | Show a generic failure. Reported |
| `BG502` | An upstream provider failed or timed out | Say the catalogue is unavailable, keep local content on screen |

**`BG500` and `BG502` are Edge Function codes and cannot come from an RPC.** They were added
2026-08-15 with `tmdb-adapter`, which is the first surface with an upstream: every other
function in this document either succeeds or raises a SQLSTATE from the table below, and
neither case can produce "the thing we depend on did not answer". The distinction matters to
the client because the two want opposite handling — `BG500` is a bug and should be reported,
while `BG502` is TMDB being TMDB, which the position in
[`../reference/tmdb-integration.md`](../reference/tmdb-integration.md) explicitly expects
("there is no SLA") and which must never blank a screen that already has local results.

**`BG404` covers both "does not exist" and "exists but you may not see it."** Distinguishing them would let an attacker enumerate private profiles and lists by comparing responses.

### Where these codes come from — Required

`BGnnn` is the **API-level** contract. Postgres functions raise **standard SQLSTATEs**, which is the convention already set by the ranking migration, and one mapping layer translates. Writing `BGnnn` into a `raise exception` would put the client's error vocabulary inside the database, where the next caller may not be a client at all.

| SQLSTATE | Raised for | Surfaces as |
|---|---|---|
| `28000` | No authenticated caller | `BG401` |
| `42501` | Not permitted, including a suspended account | `BG403` |
| `P0002` | Row not found, or not visible to the caller | `BG404` |
| `23505` | Uniqueness conflict — already exists, already accepted | `BG409` |
| `55000` | Wrong state for the operation, e.g. `set_bucket` on a ranked title | `BG409` |
| `22023` | Invalid argument | `BG400` |
| `53400` | A configured per-user ceiling was reached, e.g. the daily report cap | `BG429` |
| `23514`, `P0001` | An invariant would be violated | `BG422` |
| `23503` | A referenced row does not exist, in practice a session with no profile yet | `BG422` |

Anything unmapped surfaces as a generic failure and is reported, rather than being guessed at.

Two of these mappings deserve a note, because the SQLSTATE alone does not get you there.

**`53400` only becomes a clean `BG429` behind the edge layer.** PostgREST maps it to HTTP **500** on its own. `53400` is `configuration_limit_exceeded`, which PostgREST treats as a server-side misconfiguration rather than as a per-user ceiling; most of the rest of class 53 is `insufficient_resources` and maps to 503. Either way, a client calling `rpc/report` directly is told the server broke when it had merely hit its daily limit. Since the mapping table above is applied at the edge, the behaviour is right as long as reporting goes through it — a constraint on the client, not a detail of the database.

**`23503` should be unreachable, which is why it maps to `BG422`.** A session that has authenticated but not yet completed `create_profile` passes `assert_can_write` — there is no profile row to be suspended — and then trips a foreign key on the first write, both in `processed_operations` and in `user_media`. A correct client never reaches a write from that state, so the honest surface is "report this as a bug" rather than a field error the user can act on.

**`23505` from `rank_start` is a product state, not a conflict to retry.** It means the title already has a position, and the database's own message names `rank_rebucket`, which is an internal function and not a sentence to show anyone. The client replaces it with "This already has a position. Move it from your collection instead." Recorded here because the first client written against this table missed the row: an unmapped SQLSTATE falls through to the generic branch, which passes the server's text straight to the screen — and for this one code the server's text is a function name.

**A pivot that stops being ranked mid-session makes `rank_answer` reject rather than re-prompt.** If a title is unranked in another session, or on another device, while it is on screen as a comparison, answering with it returns `BG409` and the client should restart the session. `rank_back` and `rank_skip` behave the same way. The alternative — silently substituting a different pivot — would attribute an answer to a comparison the user was never shown, and a ranking is only as trustworthy as the comparisons behind it.

---

## 9. Rate limits

Applied per user and per IP on the surfaces PRD §17 and §22 call out as abuse-prone. Numeric thresholds are configuration in `app_config`, tuned from observed traffic rather than guessed now.

| Surface | Limited on |
|---|---|
| `get_or_create_invite_token`, `revoke_invite_token` | Creation and regeneration frequency |
| `resolve_invite_token` | Opens per token per hour, to detect a leaked or scraped link |
| `follow` | Follows per hour, to blunt mass-follow spam |
| `react` | Reactions per minute, so reactions cannot be used to flood someone's inbox |
| `tag_watch` | Tags per hour, in addition to the hard limit of 10 per watch |
| `report` | Reports per day, so reporting cannot itself be used to harass |
| `tmdb-adapter` | Requests per user, protecting the provider quota and its cost |

---

## 10. Read surface

Reads go directly to PostgREST against tables and views, filtered by RLS. Views exist where a raw table would over-expose.

| View | Why it exists |
|---|---|
| `public_profiles` | Projects only the always-public fields from `profiles`. **Never exposes `date_of_birth`, `invited_by`, or `founding_member`** |
| `visible_rankings` | Rankings joined to media, filtered by `can_view_profile` |
| `visible_collection` | Another user's bucketed titles **without** notes, watch dates, or watchlist |
| `feed` | Followed users' events with reaction counts and the caller's own reaction |
| `unranked_queue` | The highest-bucket-first queue from [`ranking.md`](./ranking.md) §10 |
| `inbox` | Notifications joined to actor and subject |

### Title search

`search_titles(p_query text, p_limit integer default 20)` — added 2026-08-14. Returns `id, kind, title, release_date, poster_path, provenance`, films and series only, at most 50 rows. Signed-in callers only, per PRD §26.2 AC 1. A season is reached from its series page (AC 2); it would also be useless in a result list, since a season is titled "Season 4" and a page of bare ordinals says nothing about which show each belongs to. PRD §8's scope line says "movie, series, and season search", which contradicts §26.2 — see [open questions](../product/open-questions.md).

It is a function rather than a PostgREST filter because the matching is not expressible as one. `media_items` carries `search_vec`, a stored generated `tsvector`, with a GIN index on it, and every typed token becomes a prefix term ANDed with the rest — so "dar kni" finds The Dark Knight and "amelie" finds Amélie. The tsquery is assembled from tokens split on non-alphanumerics rather than passed to `to_tsquery` directly, which is what stops "Fast & Furious" raising a syntax error and stops a user writing query operators. The split is Unicode-aware (`[^[:alnum:]]+`): the ASCII form it replaced deleted every character the fold does not cover, so a Cyrillic or Japanese title was unreachable even when typed exactly and "Čapek" was searched for as "apek".

Ordering, in tiers: the title the query names exactly, then one starting with it, then `ts_rank`, `popularity`, the shorter title, `release_date`, `title`, `id`. The first tier stops a sequel leading — "the dark knight" used to return The Dark Knight Rises first, because both tie on rank exactly and the tiebreak was release date. `title` and `id` last make the order total, so repeating a query returns the same page rather than one of several. Both the exact and starting-with tiers compare against `sort_key`, a stored generated column holding the folded title reduced to words, so that "spider man no way home" is recognised as naming a film that is punctuated differently.

`p_limit` clamps to 0…50; zero returns nothing. Values above `int32` are rejected by Postgres as no such function, which a JSON client can provoke.

**No extension.** `pg_trgm` and `unaccent` would each be the obvious tool and neither exists in PGlite, which is the test harness — so an extension-based search would be exercised by nothing until it reached the hosted database. Full text search and GIN are core, and the accent fold is a fixed Latin table in `media_fold`. It folds Latin script only, so a Cyrillic or Japanese title keeps its own characters and is matched as it stands, and ligatures lose their second letter ("Æon Flux" answers to "aon", not "aeon"). Both are worth revisiting if `unaccent` ever becomes available on both sides.

Unusually for a read RPC this one is `security invoker`: the catalogue is world-readable, so it needs no elevated rights, and a definer function would go on returning rows if a policy ever hid some. The cost is that `media_fold` is granted to `authenticated`, since the function folds the query text as the caller. It is a pure function of a string; `media_search` and `media_sort_key` stay internal.

`visible_collection` is the one that earns its keep. `user_media` holds both public-safe data (the bucket) and always-private data (notes, watch dates) in the same row, and PRD §22 requires the split. Rather than trusting every future query to select the right columns, the raw table is owner-only and the view is the sole path to someone else's collection.

Per the founder decision of 2026-08-13, the **Logged collection inherits profile visibility** — public on a public profile, approved followers only on a private one. `visible_collection` filters on `can_view_profile` like every other visibility-bearing read, so that decision needs no separate rule.

> **Every one of these views must be created `with (security_invoker = true)`.** A Postgres view runs with its *owner's* permissions by default, which means a view over an RLS-protected table returns rows the caller could never select directly. `visible_collection` is where that would hurt most: it exists precisely because `user_media` is owner-only, and a default-owner view over it would publish every user's notes and watch dates to every caller — quietly, while the table policy still looked correct. The RLS test matrix in PRD §25 must assert this from a second user's session rather than trusting the definition.
