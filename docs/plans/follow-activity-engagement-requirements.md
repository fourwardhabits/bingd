# Workstream C: reactions and comments on follow stories (requirements)

Repo: `/home/user/bingd` @ `f010b51f`. Read-only audit. Staging (`fjxhcbowoxuzulwirzyr`) was queried read-only: its migration head is `20261128000100`, the same as the repo head, so the definitions quoted below are the ones staging runs.

---

## 0. TL;DR

- **The database already accepts reactions and comments on `follow_added` events.** Every social writer and reader keys on `feed_event_id` and never checks `type`. Staging confirms this: there are no type references in `set_reaction`, `_add_comment`, `activity_comments`, `activity_comment_counts`, `_can_read_comment`, `_can_mention` or `set_comment_reaction`, and the only check constraints on `reactions` and `comments` are `kind` and body ones. The exclusion is a **client-only** design choice, documented in three places.
- **The client already fetches the data.** Reactions and comment counts are read for every event id on the page, follow stories included. Turning the feature on needs no extra round trip on the Feed.
- **One client path blocks it.** The comment-thread page (`/activity/[id]`) loads events with `PROFILE_ACTIVITY_TYPES`, which excludes `follow_added`. Every reaction, comment or mention notification on a follow story would therefore land on "This conversation is no longer available." The actor never sees their own follow story in the Feed, so that notification is the only way they could reach the conversation.
- **One backend change is needed for safety.** Story membership is never pruned. When the actor unfollows a member, or a block ends the edge in either direction, the story still names that person to third parties for as long as it exists. That is tolerable for a one-line row that ages away. It is not tolerable once the row carries a lasting public conversation about the relationship. The fix is a reader-side `create or replace` of `follow_activity_people` with the same signature, so it only names members whose actor-to-member edge is still `approved`. Nothing is deleted.
- **Everything else is optional or a product decision:** notification copy, whether the story keeps growing after people engage with it, the award impact, the followee's view, and the spoiler toggle.

---

## 1. Current design

### 1.1 Producer
- **Event type.** `follow_added` was added to `feed_events_known_type` in `supabase/migrations/20260912000100_a_signup_that_becomes_a_connection.sql:128-142`. The constraint was last rebuilt, with `follow_added` kept, in `20261023000100_a_sitting_nobody_watches_you_have.sql:43`.
- **Payload.** It is always `'{}'` and carries no count either (`20260912000100:146-161`, `:333`). Membership lives in `feed_follow_targets (event_id, followed_id, created_at)`, PK `(event_id, followed_id)`, with cascade from both `feed_events` and `profiles` (`20260912000100:167-172`). That table has RLS on, **no policy**, and `select` revoked from `anon` and `authenticated` (`:178-184`).
- **Writer.** The current writer is `_post_follow_activity(p_actor, p_target)` at `20260912000500_a_ceiling_on_the_ceiling_and_a_tie_that_holds.sql:55-148`. It is internal and revoked from clients.
  - **Locks.** It takes `_lock_pair(actor, target)`, then `pg_advisory_xact_lock('follow_story:'||actor)`, before reading anything (`:71-74`). The header at `20260912000100:240-280` explains why `for update` alone could not stop the phantom insert.
  - **Window.** It aggregates into one mutable row per actor per `feed.follow_aggregation_minutes` (60). The window is measured from `causal_at`, which is set once and never bumped (`:76-112`).
  - **Reciprocal suppression (§A11).** If the reverse story is still open, it writes nothing (`:82-93`).
  - **Membership cap.** `feed.follow_story_max_people`, default 50, clamped to 1..200 (`:113-137`).
- **Callers.**
  - `follow()`: only on a newly `approved` edge. A request or a no-op posts nothing (`20260912000100:494-527`).
  - `redeem_invite` / `accept_invite`: one story, with the **inviter** as actor (§A14) (`20260912000200`, `20261024000100`).
  - Approvals of requests post nothing (`20260912000100:60-66`).

### 1.2 Reader
- **`follow_activity_people(p_event_ids uuid[])`** (`20260912000500:160-198`) is a security definer function and the only read path into the membership. It checks four things:
  - `can_view_profile(me, actor)` on the event, restated because a definer bypasses `feed_events_read` (`:180`);
  - `p.id <> me.id`: the reader is never listed in a story about them (`:191`);
  - `p.status='active'`;
  - `can_identify_profile(me, member)`: a private member appears as identity only, and a member blocked in either direction, or suspended, is absent (`:193`).
  It has no limit, so the count the client draws is the whole visible story.
- **Client.**
  - `useFeed` requests `FEED_ACTIVITY_TYPES`, which includes `follow_added`, and drops the **reader's own** follow stories (`src/features/feed/use-feed.ts:612-626`).
  - `hydrate` → `attachFollowPeople` (`use-feed.ts:907`, `:937`, `:1183-1245`) fills `event.followed`.
  - A story with zero visible members is **dropped** (`use-feed.ts:944-957`).
  - Profiles use `PROFILE_ACTIVITY_TYPES`, which excludes follow stories (`src/features/feed/activity.ts:74-92`).
- **Row and sheet.**
  - `FollowStoryRow` (`src/features/feed/FollowStoryRow.tsx`) is an `sm` avatar, one sentence ("Abi followed Ravi and 4 others") and a time label. It is about a third of an `ActivityRow`'s height.
  - The text column opens `FollowStorySheet` only when the story names more than one person. The names open profiles.
  - `FollowStorySheet` lists `event.followed` with `FollowControl`s and reads nothing beyond `follow_state_with`.

### 1.3 Documented reason for the exclusion
- `FollowStoryRow.tsx:61-63`: "No reactions and no comments. §A9's instruction is that follow activity is social discovery content and not an audit log, and a follow you can react to and comment under is neither."
- `app/(tabs)/feed.tsx:951-957` adds: "it is a post about somebody's relationship, on which the two people best placed to feel strange about a thread are the ones named in it."
- `docs/design/screens.md:1284-1289` gives the spec: "no poster, no score, no note, **no reactions and no comments**. That lightness is the frequency rule expressed as composition."
- `use-feed.ts:716-717` (the thread loader): "a follow story carries no comments to open one from."
- The backend was **never** made to exclude them. `docs/architecture/data-model.md:690` states: "`reactions_read`, `add_comment` and `set_reaction` all key on the event id and never on `type`, so a new type inherits the social controls by construction."

This is a reversal of a written founder rule (§A9 as interpreted in 2026-09). The docs and code comments listed above must be updated in the same change.

---

## 2. Backend support

| Object | Where (current definition) | Type restriction? |
|---|---|---|
| `reactions` table, PK `(feed_event_id, user_id)`, FK cascade to `feed_events` | `20260813000600_feed.sql:39-45` | none; only `reactions_known_kind` check |
| `reactions_read` policy: `can_i_view(user_id) AND exists(event where can_i_view(actor_id))` | `20260813000600:66-74` (staging: same) | none |
| `set_reaction(op, event, kind)` | `20261115000100_a_reaction_from_anyone.sql:50-123` | none. Checks `can_view_profile(caller, actor)`, then the pair lock, then a re-check. Rate limit `reactions.max_per_day` 200. Self-reactions allowed (founder, 2026-11-11) |
| `comments` table, FK cascade to `feed_events` | `20260817000100_comments.sql:78-107` | none; body checks only |
| `comments_read` policy: `can_i_view(author_id) AND exists(event where can_i_view(actor_id))` | `20260817000100:150-158` (staging: same) | none |
| `_add_comment` (behind `add_comment`) | `20261021000100_the_author_answering_without_replying.sql:35-205` | none. Same visibility pattern. Rate limit `comments.max_per_day` 100 |
| `activity_comments`, `activity_comment_counts` | `20260909000100`, `20260826000600_a_conversation_you_can_open.sql:1022-1055` | none |
| `_can_read_comment`, `_set_comment_reaction`, `comment_reactions` | `20261101000100:33-47`, `20261115000100:125-170` | none |
| `_can_mention` | `20260909000100_a_name_you_could_already_look_up.sql:142-157` | none |
| `_unpresent_on_reference` triggers (`comments_unpresent`, `reactions_unpresent`) | `20261128000100:1183-1310` | no-op for follow stories (`presented_in` is always null for them) |
| `award_on_reaction`, `award_on_comment` triggers | `20260828000100` and later | count follow-story engagement too (see §5) |

**Conclusion: no migration is required for the feature to work.** A follower can call `set_reaction` and `add_comment` on a follow story today. Staging has 15 follow stories, 22 members, and 0 reactions or comments on them.

**Migration recommended as a must, for safety (see §3.3 and §6):** "a follow story names only edges that still exist". It is a `create or replace function follow_activity_people(uuid[])` with the same signature and return type, adding one predicate:

```sql
and exists (select 1 from follows f
             where f.follower_id = e.actor_id      -- the event's actor
               and f.followee_id = p.id
               and f.state = 'approved')
```

- The `events` CTE must carry `actor_id`.
- Restate the comment and grants, following the house convention.
- It is reader-side only. It deletes nothing, so comments and reactions survive and a re-follow restores the name.
- Reciprocal suppression reads `feed_follow_targets` directly in the writer, so it is unaffected.
- Existing tests that must still pass: "says nothing twice about a re-follow" (`supabase/tests/follow-activity.test.mjs:272`) and "still mentions somebody already in a full story exactly once" (`:689`). Both re-follow before asserting.
- Staging currently has 0 stale members and 0 blocked pairs, so applying it changes nothing visible today.

**Optional migration (hardening, not needed for v1):** gate reads and writes on a follow story to viewers who can identify at least one member, or who are the actor. This would touch `set_reaction`, `_add_comment`, `comments_read`, `reactions_read`, `activity_comments`, `activity_comment_counts`, `_can_read_comment` and `my_notifications`, which is too wide for "smallest". §3.4 explains why the residual risk is the same class that already exists on every other post type.

---

## 3. Privacy

### 3.1 Who can see a follow story
- **Feed.** The actor's approved followers. The Feed's actor set is self plus follow set, and the reader's **own** follow stories are removed (`use-feed.ts:612-626`).
- **Row level.** `feed_events_read = can_i_view(actor_id) AND presented_in IS NULL` (staging). Any authenticated user who can view a **public** actor can select that actor's `follow_added` rows by id through PostgREST, but those rows carry `{}` and no membership. For a private actor, only approved followers can.
- **Members.** Resolved per viewer by `can_identify_profile`. A private member is shown as identity only to anyone not blocked, by design (§A4/§A12, `20260912000100:355-366`). A blocked member (either direction) and a suspended member are absent.
- **The followee (B).** B sees A's story only if B follows A. B is always excluded from the list (`20260912000100:368-372`). If B is the only member B could see, the row is dropped for B.
- **The actor (A).** A never sees the story in their own Feed (`use-feed.ts:612-626`), and it is not on A's profile (`activity.ts:89-91`). A currently has no surface showing it.

### 3.2 Would reactions or comments leak a private followee's identity or the relationship?
- **Reactions.** No new disclosure. A reaction is a glyph from a closed set and is readable by exactly the people who can already see the event (`reactions_read`). The member names on the row are already resolved per viewer.
- **Notifications.**
  - The actor's inbox row and push for a follow-story reaction or comment carry **no member names**. `media_title` is null, so the copy falls back to "reacted to your activity" / "commented on your activity" (`src/features/notifications/use-notifications.ts:679-682`; `supabase/functions/push-sender/copy.ts:259-263`, `:221-232`).
  - A comment push may quote the excerpt, which is written to the actor. That is acceptable.
- **Mentions.** `_can_mention` requires the **mentioned** person to be able to see the actor's activity (`20260909000100:156`). So a mention cannot tell anyone about a private actor's follow activity they cannot already see.
- **Comments are free text.** A commenter can type the name of a member that a given reader cannot identify (for example, a member who blocked that reader). Comments *by* the blocker are hidden from the reader (`comments_read` uses `can_i_view(author_id)`), but other people's text naming them is not. This is the **same class of exposure** that already exists on every ranking post: anyone can write "C would love this". It is accepted product-wide and is not specific to follow stories. Flag it to the founder anyway, because the subject of a follow story *is* a person (§7, decision D6).

### 3.3 The real gap: stale and severed relationships (pre-existing, amplified by comments)
- `unfollow` deletes the edge and notifications but never touches `feed_follow_targets` (`20260817000200_social_writers.sql:273-306`).
- `block` deletes the follows in both directions but not the membership (`20260826000400_a_recommendation_that_waits_for_you.sql:1061-1110`).
- `follow_activity_people` does not check that the edge still exists (`20260912000500:183-197`).

So after **B blocks A**, A's followers who can still identify B keep seeing "A followed B" until the story ages off their screen. With comments it never ages off: notifications deep-link back to it, and a thread of third-party remarks about A and B persists. That is a harassment vector ("lol B blocked A"). The reader-side predicate in §2 closes it in both block directions, because `block` deletes the edge, and it also covers a plain unfollow. **Must.**

### 3.4 Suspension
`can_view_profile` returns false for a suspended subject (`20260813001700_moderation.sql:110-131`). So:
- a suspended actor's stories, comments and reactions disappear from every read;
- a suspended member is absent from the story;
- a suspended account cannot write, because `assert_can_write` runs in `set_reaction` and `_add_comment`.

No change needed.

---

## 4. Moderation

- **Comments** are reportable through `report('comment', id, …)`, owner resolved from `comments.author_id` (`20260825000100_a_report_that_names_the_writing.sql:138-222`, `:188`). It is type-agnostic. `CommentThread` already wires `ReportSheet` (`src/features/feed/CommentThread.tsx:7`, `:476`, `:679`). Authors soft-delete their own comments through `delete_comment`. Block and suspension hide comments through `comments_read`.
- **Reactions** have no text, so there is no report surface. That is deliberate (`20260813000600:34-38`).
- **The follow story itself** contains no user-authored text, so there is nothing to report. There is also no "hide event" path for any feed event type, and none is needed here.
- **Fit.** Follow stories fit every existing flow unchanged. `report` deliberately does not require visibility (`20260825000100`, header of `report`), so a blocked user's abusive comment on a follow story stays reportable.

---

## 5. Notifications

### 5.1 What happens today for any feed event (and would happen for follow stories with no change)

| Trigger | Recipient | Source |
|---|---|---|
| reaction | event **actor**, unless self. Deduped once per (reactor, event) by `on conflict … where type='reaction'` | `20261115000100:105-112` |
| top-level comment | event **actor**, unless self or mentioned | `20261021000100:148-154` |
| reply | parent comment's author | `:156-163` |
| actor's own top-level comment | prior commenters (`participant`) | `:184-194` |
| `@mention` | mentioned user, subject to `_can_mention` and `mentions.max_per_comment` (10) | `_apply_comment_mentions`, `20260830000100` |
| comment reaction | nobody | `20261115000100` header |

- **Routing.** Every `feed_event` notification routes to `/activity/[id]` (`src/features/notifications/routing.ts:134-135`, `:208-210`).
- **Blocker.** That page loads the event through `oneActivity`, which filters `.in('type', PROFILE_ACTIVITY_TYPES)` (`use-feed.ts:711-723`), so a follow story is never found and the page says "This conversation is no longer available." (`app/activity/[id].tsx:248-264`). This is a **must-fix**.

### 5.2 What should happen for follow stories (recommendation)
- **Actor (A): notify, as today.** No code change. A has no other surface where they would ever see the story (§3.1). Optionally improve the copy to "reacted to your follow activity", keyed off `subjectActivityType === 'follow_added'` in `use-notifications.ts` and `subject_activity_type` in push copy.
- **Followee(s) (B…): do not notify.** B already received a `follow` notification (`20260912000100:503-507`). B may not follow A and so cannot see the story. A notification would publish the existence of a conversation about B, and it would multiply notifications by the size of the group. This needs no change, because nothing notifies members today.
- **Mentions: unchanged.** The edge case: mentioning B on a story where B is the only member B could see sends B to a page that hydrates to zero visible members, and B gets the "no longer available" state (§6.4, decision D5).

### 5.3 Spam and abuse
- **Reacting to stories about strangers.** Organic reach is limited to the actor's followers. Out-of-band reach, meaning a public actor's event id fetched from PostgREST, is possible but rate-limited (200 reactions/day, 100 comments/day) and identical to every other post type.
- **Volume.** At most about one story per actor per hour. Each reactor files at most one reaction notification per story.
- **Award farming.** `heart-magnet` counts **all** other-people reactions on the user's events (`20261114000200_a_show_ranked_on_its_own.sql:305-311`). `comment-gremlin` counts all comments authored. Follow stories become cheap, high-frequency reaction targets that the actor never sees. Decision D4: exclude `follow_added` from `heart-magnet`, or accept it.
- **Mention spam on a public actor's story.** It reaches anyone the commenter can discover (the `20260909000100` widening). This is unchanged and bounded at 10 per comment.

---

## 6. Grouped follow stories

1. **Where reactions and comments attach.** To the **single** `feed_events` row, the story id. There is exactly one conversation per story, never per member. `ReactionDetail` and `CommentSheet` already key on event id.
2. **When the group grows after people react.** Appends continue until 60 minutes after `causal_at` or 50 members, whichever comes first. `causal_at` never moves, so the row does not jump in the keyset. A reaction to "A followed B" becomes a reaction on "A followed B and 3 others".
   - **Precedent.** Watchlist groups keep growing with their conversation attached (`20261125000100_a_watchlist_session_is_one_post.sql:11-14`). The alternative "stop appending once it has reactions or comments", proposed in `docs/release/cinematic-feed.md:73-75`, was **not** adopted there.
   - **Recommendation for v1.** Keep growing, with no change. The window is only an hour.
   - **Option.** Freeze on first engagement by calling the existing `_feed_event_referenced(v_event)` (`20261128000100:61-71`) in `_post_follow_activity` before appending, and opening a new story instead. The cost is that §A13's "one per actor per hour" cap becomes "one per hour unless engaged". This is decision D3.
3. **Members differ per viewer.** Two viewers can see different member lists under the same shared conversation. Accept this as a consequence of §A12. Comments must not render member names server-side; they do not.
4. **When one member unfollows, blocks, is suspended or deletes their account.**
   - **Today:** an unfollow or block leaves the member named; suspension hides them; deletion cascades the membership row away.
   - **With the §2 migration:** an unfollow or a block in either direction removes the member from every viewer's sentence and sheet, and the count shrinks.
   - **If no visible member remains:** the row is dropped from the Feed (`use-feed.ts:957`) and the thread page shows "no longer available". Comments and reactions are kept, orphaned but intact, and reappear on a re-follow. This matches the existing "nothing about a member the viewer may not identify reaches the screen" rule.
5. **Interaction with `FollowStorySheet`.** Keep the sheet as the member list with Follow controls and nothing else. Comments open `CommentSheet`, a separate, mutually exclusive sheet that is already mounted in `feed.tsx:1286-1298`. `followStoryFor` and `commentsFor` are independent state.
   - The new controls must sit **outside** the copy `Pressable` that opens the sheet (`FollowStoryRow.tsx:107-137`). Otherwise React Native would treat them as nested responders and screen readers would merge their labels.
   - A one-person story's text stays inert, as today.

---

## 7. UI

### 7.1 Existing grammar to reuse
- **`ActivityRow`** (`src/ui/components/ActivityRow.tsx`).
  - It renders reactions in three parts: a `ReactionSummary` line when the count is above zero (`:447-459`), the picker above the actions (`:464-466`), and an actions strip (`:468-525`).
  - The strip holds a `ReactionControl` with `showSummary={false}`, then a comments `IconAction` with the badge count (`:505-517`).
  - Every action is `minHeight: theme.layout.minTapTarget` (44) (`:726-731`). `IconAction` is file-private (`:590-625`).
- **`FeedCard`** (`src/features/feed/FeedCard.tsx:308-380`) uses a summary line, then Like / Comment buttons, each with minimum width and height of 44 (`:554-555`).
- **`ReactionControl`** (`src/ui/components/ReactionControl.tsx:133-230`) is exported from `@/ui/components`. It holds a 20×24 slot with `slotSlop` (`:395-399`) to reach 44pt, and an optional count cluster that opens the detail sheet.
- **Android caveat.** Touches outside a parent's bounds are dropped (`ActivityRow.tsx:274-281`, `:668-672`). A 44pt target must be a real layout box, or must lie within a parent at least 44pt tall. It must not rely on `hitSlop` spilling outside its parent.
- **Feed wiring.** `reactionFor(event.id)` (`feed.tsx:1301-1317`) and `commentCounts.data?.get(event.id)` already cover follow stories, because `useReactions(eventIds)` and `useCommentCounts(eventIds)` include them (`feed.tsx:470-472`).

### 7.2 Smallest compact affordance (recommended: option A)

Option A adds a **trailing cluster** to `FollowStoryRow`, so the layout becomes avatar, then copy, then actions:

```
 (A)  Abi followed Ravi and 4 others          ♡ 3   💬 2
      12m ago
```

- **Heart.** `ReactionControl` with `showSummary` showing **count only**, not the glyph cluster, so the width stays at about 34pt.
  - Tap toggles the heart. Long-press opens `ReactionPill`, rendered as a full-width line under the row content and above the hairline, the way `ActivityRow` places it.
  - Tapping the count opens `ReactionDetail`.
  - No `ReactionSummary` sentence line: that is what keeps the row compact.
- **Comment.** A chatbubble icon with a count badge, which opens `CommentSheet`. It is shown even at zero comments, because the control is wired to a real sheet; that is the "never a control that does nothing" rule at `ActivityRow.tsx:498-505`.
- **Targets.** Each control box is `minWidth: 44, minHeight: 44`, in an actions `View` with `minHeight: 44` and `alignItems: 'center'`. The row's content height goes from about 37 to 44pt, and the row from about 61 to about 68pt. It stays well under a third of an activity row.
- **Width at 360pt.** 360 − 32 gutters − 32 avatar − 2×12 gaps ≈ 272pt; less about 100pt of actions ≈ 172pt for the sentence, which is still capped at 3 lines. A render test at 360pt is required. If long names wrap badly, fall back to option B.
- **Option B (fallback).** Put the actions on the time line, right-aligned, as `ActivityRow` does (`styles.time`, `:732`). The sentence keeps full width and the row grows to about 88pt. The time label must then move out of the sheet-opening `Pressable`.
- **Extraction.** Move `IconAction` out of `ActivityRow.tsx` into `src/ui/components/IconAction.tsx`, or copy its about 20 lines. Extracting it is preferred: two rows sharing one icon-action is the design-system way.
- **Self.** The actor never sees their own story in the Feed, so the canReact and self rules only matter on the thread page, where self-reaction is allowed (founder, 2026-11-11).

### 7.3 Accessibility
- **Labels** are person-centred, not film-centred. The current labels interpolate `filmName`, which does not exist here.
  - Heart, inactive: "React to Abi's follow activity. Long press for more reactions."
  - Heart, active: "{Liked}. You reacted to Abi's follow activity. Tap to remove, long press to change."
  - Count: "3 reactions. See who reacted."
  - Comments: "2 comments on Abi's follow activity. Open them." or "Comment on Abi's follow activity".
- **Separate elements.** The controls are their own accessibility elements, siblings of the copy `Pressable`. The copy keeps its existing `accessibilityLabel` and "Opens everyone in this" hint (`FollowStoryRow.tsx:107-115`).
- **Hints and state.** `accessibilityHint` for long-press only where a picker is wired (`ReactionControl.tsx:166-171`). `accessibilityState.selected` on the heart.
- **Dynamic type.** Emoji `allowFontScaling={false}` already applies. Check that the sentence still wraps sensibly at the largest text size with the trailing cluster.

---

## 8. Recommendation

### 8.1 MUST

**Backend (one migration)**
1. Create `supabase/migrations/2026112x000100_a_follow_story_names_who_is_still_followed.sql`. It replaces `follow_activity_people(uuid[])` with the same signature, adding `exists approved follows(actor → member)`. Restate the comment and grants. Include a header covering why (block and unfollow; comments make a story durable) and why it is reader-side (keeps the conversation; a re-follow restores it).
   - **Rehearsal.** Apply it to staging before production. Staging currently has 0 affected rows.
   - **Compatibility.** Installed binaries call this function with the same signature, so it is safe for them.

**Client**
2. **`FollowStoryRow.tsx`.** Add optional props `reaction?: ActivityReaction`, `onPressComments?: () => void` and `commentCount?: number`, plus a picker slot via `reaction.picker`. Render the trailing cluster described in §7.2 outside the copy `Pressable`, with real 44pt boxes. Rewrite the header's "No reactions and no comments" paragraph.
3. **`app/(tabs)/feed.tsx:964-979`.** Pass `reaction={reactionFor(event.id)}`, `onPressComments={() => setCommentsFor(event.id)}` and `commentCount={commentCounts.data?.get(event.id) ?? 0}`. Update the comment block at `:940-957`. `openComments` already resolves the follow event, and `CommentSheet` receives `mediaItemId: null, title: null`. That works: `shouldMask` masks a spoiler-flagged comment for everyone but its author when there is no media (`src/features/collection/use-watched.ts:98-101`).
4. **`use-feed.ts:711-723` (`oneActivity`).** Allow `follow_added`, using `FEED_ACTIVITY_TYPES` or `[...PROFILE_ACTIVITY_TYPES, 'follow_added']`. `hydrate` already attaches `followed` and drops an empty story, so a story the reader may not identify anyone in still shows "no longer available". Update the comment at `:716-717`.
5. **`app/activity/[id].tsx:268-...`.** Branch on `event.type === 'follow_added'` and render `FollowStoryRow` with no actions as the header, because the `CommentThread` under it carries the conversation. Mount `FollowStorySheet` for the list. Without this, the actor's notifications open a dead end, or a broken `ActivityRow` with an empty title.
6. **Docs.** Update `docs/design/screens.md:1284-1289`, `docs/architecture/data-model.md` (the follow section and the new predicate), and the PRD entry for §A9 to record the founder's reversal with its date.

**Tests**
7. **DB** (`supabase/tests/follow-activity.test.mjs` and new cases in `reactions.test.mjs` / `comments.test.mjs`):
   - a follower can `set_reaction` and `add_comment` on a follow story;
   - a viewer who cannot see a private actor gets P0002 on both;
   - the actor is notified once per reactor and the followee is never notified;
   - a mention of the followee obeys `_can_mention`;
   - `follow_activity_people` drops a member after the actor unfollows them, after A blocks B, and after B blocks A, and restores the member on re-follow;
   - the existing re-follow and full-story tests still pass;
   - comments by a blocked author are hidden on a follow story.
8. **Client** (`src/features/feed/FollowStory.test.tsx`):
   - the heart and comment controls render with person-centred labels and measure 44pt or more;
   - tap toggles, long-press opens the picker, the count opens detail, and the comment opens the sheet;
   - pressing a control does **not** open `FollowStorySheet`;
   - a single-person story's text stays inert;
   - the list still opens on an aggregated story;
   - layout at 360pt width.

   Also:
   - `use-feed.test.ts`: `useActivityEvent` returns a follow story by id, and returns null when the story has zero visible members.
   - An activity-page test: a follow story renders the row and the thread.
   - Notification routing: a reaction on a follow story opens `/activity/[id]` and resolves.
9. **Release order.** Ship the migration and the client together in one OTA. The thread-page fix (4–5) must not lag the Feed controls (2–3), or the first reaction notification opens a dead end. Binaries on an older fingerprint will keep showing follow rows without controls, which is harmless. On those binaries, however, a reaction notification for a follow story still opens "no longer available". That is acceptable, but note it in the release notes.

### 8.2 OPTIONAL
- **O1.** Notification copy "reacted to / commented on your follow activity", keyed on `subject_activity_type='follow_added'` in `use-notifications.ts` (`sentenceFor` and `verbFor`) and in push `copy.ts`. This is client and edge-function only.
- **O2.** Hide the "Contains spoilers" toggle in `CommentThread` when `mediaItemId` is null, since there is no title to spoil (`CommentThread.tsx:631-651`).
- **O3.** Exclude `follow_added` from `heart-magnet` in `_award_metric` (a migration). See D4.
- **O4.** Freeze a follow story on first engagement, via `_feed_event_referenced` in `_post_follow_activity` (a migration). See D3.
- **O5.** Server gate: allow engagement only when the viewer can identify at least one member, or is the actor (wide; see §2).
- **O6.** Analytics: add a `surface: 'follow_story'` or `activity_type` prop to any reaction or comment events.
- **O7.** Extract `IconAction` into `src/ui/components`, if it is not done as part of must 2.

### 8.3 Risks
- **Reversal of a written founder rule.** §A9 as written ("social discovery, not audit log") needs a recorded decision.
- **Free-text comments** can name members a particular reader may not identify. This is the same as on other posts, but the subject here is a person.
- **The group grows after people react.** Reactions then apply to a larger set than the reactor saw.
- **The actor cannot see their own story or its engagement** except through notifications. This may feel odd. See D1.
- **Award inflation** from cheap reactions (D4).
- **Old binaries** hit a notification dead end (must 9).
- **Width at 360pt** with long display names (§7.2, option B as fallback).

### 8.4 Open product decisions for the founder
- **D1.** Should the actor see their own follow stories, with their reactions and comments, anywhere besides notifications? Recommendation: no for v1; notifications are enough.
- **D2.** Should followees be notified of reactions or comments on a story about them? Recommendation: **no**.
- **D3.** When someone has reacted or commented, should the story keep absorbing new follows within the hour, or freeze and start a new story? Recommendation: keep growing (watchlist precedent); freezing is O4.
- **D4.** Should reactions on follow stories count toward Heart Magnet? Recommendation: exclude (O3), or accept and revisit.
- **D5.** Should a followee who is the only visible member of a story be able to open the thread they were mentioned in? Today they get "no longer available". Recommendation: accept for v1. The alternative needs a server signal that "you are in this story" and a "followed you" sentence.
- **D6.** Is the free-text exposure in §3.2 acceptable on person-subject posts? Recommendation: yes, consistent with other posts. Reactions-only for v1 is the most conservative alternative: drop the comment parts of must 2, 3, 5 and 8.
- **D7.** Should an unfollow or block remove a person from an already-posted story (must 1)? Recommendation: **yes**. It is the one behavioural change to existing stories.
- **D8.** Layout: option A (trailing cluster, about 68pt row) or option B (actions on the time line, about 88pt row).
