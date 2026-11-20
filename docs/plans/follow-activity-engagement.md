# Workstream C: reactions and comments on follow activity (reconciled plan)

**Status:** plan only, not built.

> **Status, 2026-11-20:** built as #322. It is on staging (migration `20261201000100`) and in Preview `5e5f55df`, awaiting founder device QA. **Not in production.** This document is the pre-build plan and is kept as written.

**Inputs:**
- the requirements audit (`workstream-c-requirements.md`, 2026-11-19, at `f010b51f`);
- the founder's product direction (2026-11-19).

This document reconciles the two and lists only the questions that remain consequential.

## 1. Founder direction → requirements, reconciled

| Founder direction | Requirements doc | Result |
| --- | --- | --- |
| Support reactions **and comments** | D6 asked whether to allow comments or reactions only | **Resolved: both.** |
| Keep the compact follow-event presentation | D8: option A (trailing cluster, row about 68pt) or B (about 88pt) | **Resolved: option A.** B is the fallback only if a 360pt render test shows long names wrapping badly. |
| Grouped follow events share **one** reaction/comment thread | §6.1: already one `feed_events` row per story | **Resolved, no change.** Growth after engagement is still open (Q1). |
| **Enforce visibility and blocking on reads and writes** | Must 1 (prune severed edges) plus O5 (a server gate on engagement), which the doc rated *optional, too wide* | **Changed: O5 becomes required.** The gate is one shared predicate wired into every read and write path (§3), not a client filter. |
| Notify the post author and appropriate participants, **not everyone named** | D2 recommended no notification to followees. Existing rules: reaction or top-level comment → actor; reply → parent author; actor's own comment → prior commenters; @mention → mentioned person | **Resolved: existing rules, plus the gate.** Members are never notified as members. Each recipient must pass the gate when the notification is filed (§3, item 6). That closes a mention reaching someone who can't open the story. |
| Preserve moderation and conversation integrity | §4: reporting is type-agnostic and already wired | **Resolved for moderation.** Integrity depends on Q1. |
| (implied) | D7: prune unfollowed or blocked members from posted stories | **Resolved: yes.** Required by "enforce blocking". |
| (implied) | D1: the actor sees their story only via notifications | **Default kept for v1.** Notifications open the activity page (must 4–5), so the actor can reach every conversation. No new Feed surface. |

## 2. Remaining consequential questions (founder)

1. **Q1. Does a story keep absorbing follows after someone reacts or comments?**
   - **Today:** a story absorbs follows for 60 minutes, up to 50 people. A reaction to "A followed B" becomes a reaction on "A followed B and 3 others". Watchlist groups already behave this way.
   - **Recommendation, given the emphasis on conversation integrity:** freeze on first engagement. The next follow opens a new story. This uses the existing `_feed_event_referenced` in `_post_follow_activity`.
   - **Cost:** the §A13 frequency rule becomes "one story per actor per hour, unless the current one has been engaged with".
2. **Q2. May a person *named* in a follow story read and join its thread?**
   - **Today:** a reader is never listed in a story about themselves. If they are its only member, the row is dropped for them.
   - **Recommendation for v1:** no. Named people are not given access as members. A mention of someone who fails the gate is not filed: the comment posts, but that person is not notified, so nobody lands on "no longer available".
   - **The alternative** is a "followed you" sentence plus treating the reader as a visible member. That is a new surface and a separate change.
3. **Q3. When every member has been pruned** (all unfollowed, blocked or suspended), the conversation becomes invisible to everyone, the actor included.
   - The comments and reactions are kept, not deleted. They reappear if a follow is restored.
   - **Recommendation:** accept, so blocking always wins.
   - Please confirm, because the actor loses access to replies on their own story.

Minor, with defaults unless you say otherwise:
- **Heart Magnet** excludes reactions on follow stories (O3).
- **Notification copy** reads "reacted to / commented on your follow activity" (O1).
- The **spoiler toggle** is hidden on follow-story comments (O2).

## 3. Implementation plan

### Backend: one migration, staged before production
1. **`follow_activity_people(uuid[])`.** It names only members whose actor-to-member follow is still `approved` (requirements must 1). It is reader-side and deletes nothing.
2. **A new internal predicate `_can_engage_event(reader, event_id)`.**
   - **For an ordinary event:** `can_view_profile(reader, actor)`.
   - **For `follow_added`:** `can_view_profile(reader, actor)` **and** at least one member exists with an approved actor-to-member edge, and the reader passes `can_identify_profile(reader, member)` for that member. Under Q2's v1 answer, the reader themselves never counts as that member.
   - It is revoked from clients. It is the single definition every path below calls.
3. **Writes.** Call the predicate in `set_reaction`, `_add_comment` (and so `add_comment`) and `_set_comment_reaction`.
   - Each function is rebuilt from its **true latest body** (the rebuild trap).
   - The check is placed after the existing pair lock, so a block landing mid-write is seen.
   - A refused write returns `P0002`, which is what the existing callers already handle.
4. **Reads.** Use the predicate in:
   - the `reactions_read`, `comments_read` and `comment_reactions_read` policies;
   - `activity_comments`, `activity_comment_counts` and `_can_read_comment`.

   `_can_read_comment` already gates every push and inbox excerpt, so those inherit it.
5. **Mentions.** `_can_mention` additionally requires `_can_engage_event(mentioned, event)` for the event the comment is on.
6. **Notification filing.** The participant fan-out and the reply notification skip recipients who fail the predicate. The reaction and top-level comment notifications go to the actor, who passes whenever any member is visible to them.
7. **Freeze on engagement** (only if Q1 is answered "freeze"): `_post_follow_activity` opens a new story when `_feed_event_referenced(current)` is true.
8. **Heart Magnet:** `_award_metric` excludes `follow_added` (default for O3).

Installed binaries keep working: every signature is unchanged, and a refused or hidden read degrades exactly as a block does today.

### Client: one OTA, shipped with the migration
1. **`FollowStoryRow`.** A trailing heart and comment cluster (option A) with real 44pt boxes, outside the copy `Pressable`, and person-centred accessibility labels. `IconAction` is extracted from `ActivityRow`.
2. **`feed.tsx`.** Pass the reaction, comment count and `onPressComments` to follow rows. The data is already fetched.
3. **`oneActivity` / `/activity/[id]`.** Load `follow_added`, and render the compact row with no actions above `CommentThread`, plus `FollowStorySheet`. This fixes the notification dead end.
4. **O1 copy and O2 spoiler toggle.** Client and the push-sender copy.
5. **Docs.** `screens.md`, `data-model.md` and the PRD §A9 entry, recording this decision with its date. Rewrite the "no reactions, no comments" comments in code.

### Tests
- **DB (PGlite).**
  - Follow-story reactions and comments are allowed for a follower.
  - They are refused (writes) and hidden (reads, counts, excerpts) for:
    - a viewer of a private actor;
    - a viewer blocked by every member;
    - any viewer after an unfollow or a block in either direction, with a re-follow restoring access;
    - a dead story (Q3).
  - Notifications: the actor is notified once per reactor; members are never notified; a participant or mention recipient who fails the gate is not notified.
  - Freeze on engagement (if chosen).
  - Heart Magnet ignores follow-story reactions.
  - The existing follow-activity, comments and reactions suites still pass.
- **Races (real PostgreSQL).**
  - A comment racing a block between the reader and the only member is refused or hidden, never left visible.
  - A reaction racing the actor's unfollow behaves the same way.
- **Client.**
  - Controls, labels and 44pt targets, including at 360pt width.
  - A control press never opens the list sheet.
  - The activity page renders a follow story.
  - A follow-story notification routes to it.

### Release
1. Staging migration, then staging smoke.
2. A Preview update with the client, after the #319 and #321 QA cycles, so the three tracks stay separate.
3. Device QA.
4. Founder go-ahead before production.

**Effort:** one migration rebuilding about 8 definer functions and 3 policies, plus a moderate client change. That is larger than the requirements doc's "smallest" estimate because the read/write gate is now required.
