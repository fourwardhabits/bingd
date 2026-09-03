import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Pins the function-privilege model established by 20260813001800.
 *
 * The bug this guards against is not subtle once seen, and was invisible for
 * four migrations: Postgres grants EXECUTE on a new function to PUBLIC, so
 *
 *     grant execute on function f() to authenticated;
 *
 * adds a role to a set that already contains everyone. It reads as a restriction
 * and is an expansion. Six functions were reachable by `anon` on the deployed
 * database before this was caught.
 *
 * The test is written as a whole-schema sweep against an allow-list rather than
 * as one assertion per function, because the failure mode is *a function nobody
 * remembered to check*. A per-function test only covers the functions someone
 * thought of, which is the same set that was already thought about.
 */

/** Every function a client role may execute, and which roles may execute it. */
const ALLOWED = {
  // Called from inside RLS policies, which are evaluated as the querying role, so
  // these grants are unavoidable. What matters is the *signature*: neither takes
  // an identity to check, so a caller can only ask about themselves or about a row
  // that already exists. The two-argument forms they replaced — can_view_profile
  // and blocked_between — were social-graph oracles for exactly that reason, and
  // are now server-side only. See 20260813001900 and oracles.test.mjs.
  'can_i_view(uuid)': ['anon', 'authenticated'],
  'watch_tag_visible(uuid)': ['anon', 'authenticated'],

  // Retrieval by identifier: a shared link has to resolve without an account.
  'list_by_id(uuid)': ['anon', 'authenticated'],
  'list_items_by_list(uuid)': ['anon', 'authenticated'],

  // Signed-in reads.
  'my_capabilities()': ['authenticated'],
  'unranked_queue(integer)': ['authenticated'],
  // Not anon: it answers which usernames exist, and a signed-out client has no
  // account to create, so the grant would buy enumeration and nothing else.
  'username_available(text)': ['authenticated'],
  // Not anon either, per PRD §26.2 AC 1, which gives search to a signed-in user.
  'search_titles(text,integer)': ['authenticated'],
  // Only because search_titles runs as the caller and folds the query text through it. A
  // security invoker function cannot call what the caller may not. It is a pure function
  // of a string and knows nothing about anybody. media_search and media_sort_key are
  // deliberately absent: they exist to generate columns, not to be called.
  'media_fold(text)': ['authenticated'],

  // Account creation. Authenticated because a session exists before a profile
  // does — the user has completed a sign-in method and has no profile row yet.
  'create_profile(text,text,date)': ['authenticated'],

  // Signed-in writes.
  //
  // The ranking family gained a trailing `p_operation_id` on 2026-08-25
  // (20260825000200), so that a `rank_answer` which commits and loses its reply can be
  // replayed instead of guessed at. Trailing and optional, not leading and required:
  // a friend-beta client is installed on real devices and calls these by the arguments
  // it has, and one function with a defaulted tail is the only shape that keeps
  // working for it without leaving a second overload for PostgREST to resolve
  // ambiguously — the finding `log_watched` records below.
  //
  // The old arities are dropped rather than kept, because an old public signature that
  // still worked would be a route around the claim. So are the seven
  // `_rank_x_unguarded` implementations 20260813001700 created: each public name was a
  // two-line wrapper around one, and an entry point that now has to claim an operation
  // and take a lock has nothing left to delegate. They are absent from this list
  // because they are absent from the schema.
  'rank_start(uuid,taste_bucket,uuid)': ['authenticated'],
  'rank_answer(uuid,uuid,uuid)': ['authenticated'],
  'rank_skip(uuid,uuid)': ['authenticated'],
  'rank_back(uuid,uuid)': ['authenticated'],
  'rank_unrank(uuid,uuid)': ['authenticated'],
  // Added 2026-08-14 with the comparison screen, which needed a way out of a session.
  'rank_cancel(uuid)': ['authenticated'],
  'rank_reorder(uuid,integer,uuid)': ['authenticated'],
  'rank_rebucket(uuid,taste_bucket,uuid)': ['authenticated'],
  // New in 20260825000200, and re-signed in 20260826000500. The same-band re-rank the
  // client used to perform as an unrank followed by a start. It no longer unranks at
  // all: the session runs over the position the title already has, and only a completed
  // placement replaces it. The trailing `p_new_watch` is what separates Rank again —
  // another viewing, and one feed activity — from Change your rating, which is a
  // correction and writes none. It defaults to false, so the friend-beta build calling
  // the three-argument form gets the conservative answer.
  'rank_again(uuid,taste_bucket,uuid,boolean)': ['authenticated'],
  'report(report_subject,uuid,text,text)': ['authenticated'],

  // The collection writes (api.md §1). Their helpers are absent on purpose:
  // _media_kind and _assert_unranked answer questions about a row, _claim_operation
  // called directly would let a client burn an operation id so that a later genuine
  // write returns success without happening.
  //
  // log_watched and save_note gained note_visibility and a spoiler flag on
  // 2026-08-16. The old four- and three-argument forms were dropped rather than
  // left as overloads: PostgREST resolves an RPC by the argument names present in
  // the body, and two candidates whose argument sets nest resolve ambiguously.
  'log_watched(uuid,uuid,date,text,note_visibility,boolean)': ['authenticated'],
  'set_bucket(uuid,uuid,taste_bucket)': ['authenticated'],
  'unlog(uuid,uuid)': ['authenticated'],
  'set_watchlist(uuid,uuid,boolean)': ['authenticated'],
  'set_season_progress(uuid,uuid,season_progress)': ['authenticated'],
  'save_note(uuid,uuid,text,timestamp with time zone,note_visibility,boolean)': ['authenticated'],
  // Added 2026-08-24 (20260824000100). The one writer that can put a null into
  // watched_on: every other path coalesces, which is what protects a recorded date
  // from a date-less re-log and is also why "I don't remember when" had no route.
  // Own-row only through auth.uid(), like the rest of this group.
  'clear_watch_date(uuid,uuid)': ['authenticated'],

  // Added 2026-08-16 with social notes. Both are definer reads, and both take a
  // subject rather than a viewer, so neither can be pointed at someone else's
  // perspective the way 20260813001900 describes. public_notes projects only the
  // note columns, because the row it reads also carries the watch date, which PRD
  // §22 keeps private at every visibility level. Not anon: the public web pages do
  // not render notes yet, and a grant should follow a surface rather than precede it.
  'public_notes(uuid[],uuid[],integer)': ['authenticated'],
  'community_score(uuid)': ['authenticated'],

  // Added 2026-08-16 with the Following score (20260816001100). A definer read taking
  // a title rather than a viewer: the population is `auth.uid()`'s own approved
  // followees, so it cannot be pointed at somebody else's perspective, which is
  // 20260813001900's rule. Not anon — `auth.uid()` is the whole population filter, so
  // an anon caller could only ever get the empty answer.
  'following_score(uuid)': ['authenticated'],

  // Added 2026-08-16 with reactions (PRD §14). The only writer for a table that has
  // a select policy and, deliberately, no insert policy: a policy cannot express
  // "and only on an event you are allowed to see", which is the check that stops a
  // leaked event id becoming a way to put your name against a private account's
  // activity.
  'set_reaction(uuid,uuid,text)': ['authenticated'],

  // Added 2026-08-17 with Comments V1 (20260817000100). Same shape as set_reaction
  // and for the same reason: `comments` has a select policy and no insert policy,
  // because a policy cannot express "and only on an event you are allowed to see".
  //
  // All three refuse with P0002 for a row that is missing *and* for one the caller
  // may not touch, so a comment id or an event id learned from a screenshot or a
  // crash report confirms nothing. `_assert_comment_length` is deliberately absent:
  // nothing outside these three needs it.
  // `add_comment` gained a fifth argument on 2026-08-26 (20260826000600) and the
  // four-argument form was **dropped** in the same migration rather than left beside it.
  // A defaulted parameter added by `create or replace` creates a second function, and
  // PostgREST resolving a four-key body against two candidates answers with an ambiguity
  // error rather than a choice — so the overload would have broken the writer it was
  // meant to extend. Its absence from this list is the assertion that it is gone.
  'add_comment(uuid,uuid,text,boolean,uuid)': ['authenticated'],
  'edit_comment(uuid,uuid,text,boolean)': ['authenticated'],
  'delete_comment(uuid,uuid)': ['authenticated'],

  // The mention-carrying signatures (20260830000100), and **both pairs stay granted on
  // purpose** — the same reasoning `set_comment_reaction`'s two forms record, arrived at
  // from the opposite direction.
  //
  // 20260826000600 had to *drop* the four-argument `add_comment` because it added a
  // **defaulted** parameter, and PostgREST resolving a four-key body against two
  // candidates is an ambiguity error rather than a choice. `p_mention_ids` is therefore
  // deliberately **not** defaulted: a five-key body can only satisfy the old signature
  // and a six-key body can only satisfy the new one, so the pair is unambiguous and a
  // phone that has not taken this bundle goes on posting comments without mentions.
  //
  // Their shared bodies, `_add_comment` and `_edit_comment`, are deliberately absent and
  // revoked — the same split as `_set_comment_reaction`. The published wrappers call
  // `assert_can_write()` in their own bodies rather than relying on the callee's, which
  // is what keeps `moderation.test.mjs`' delegating-writer invariant true by
  // construction.
  'add_comment(uuid,uuid,text,boolean,uuid,uuid[])': ['authenticated'],
  'edit_comment(uuid,uuid,text,boolean,uuid[])': ['authenticated'],

  // The composer's @-mention suggestions (20260830000100). Definer and takes no viewer,
  // like the two comment reads below: the population is the caller's own approved
  // follows plus the participants of a conversation the caller can already see, each
  // passed through `_can_mention`. It is emphatically **not** `search_users` — an
  // arbitrary account is not a low-ranked row here, it is not a row — and it answers
  // nothing at all to a caller who cannot see the activity. `_can_mention` itself is
  // revoked, because it names a third party and answers questions about their follow
  // graph and their visibility.
  'mention_candidates(uuid,text,integer)': ['authenticated'],

  // Added 2026-08-26 with threads (20260826000600).
  //
  // `set_comment_reaction` is the same shape as the three above: `comment_reactions` has
  // a read policy and no insert policy, because the authorisation is "and only on a
  // comment you can see", which is two joins a row policy cannot express without
  // repeating them in the writer anyway. It takes the state wanted rather than "toggle",
  // so a replay after a lost reply converges instead of undoing itself.
  'set_comment_reaction(uuid,uuid,boolean)': ['authenticated'],

  // The canonical signature since 20260827000500, when a comment gained the same six
  // meanings an activity carries. Same shape and same authorisation as the boolean one
  // above; it takes a `kind` (or null to take the reaction back) instead of a flag.
  //
  // **Both stay granted, on purpose.** The boolean one is what every phone published
  // before that migration calls, and an over-the-air update reaches a device on its next
  // launch while the migration lands first — so dropping it would break the heart on a
  // comment for every tester who had not relaunched. PostgREST resolves the pair by
  // argument name (`p_on` versus `p_kind`), so they are never ambiguous.
  //
  // The shared body, `_set_comment_reaction`, is deliberately *not* here: it neither
  // claims an operation nor spends a rate slot, so it is revoked from every client role.
  'set_comment_reaction(uuid,uuid,text)': ['authenticated'],

  // The two reads that replaced a PostgREST select and its embed. Definer, and they take
  // no viewer (20260813001900) — the perspective is always auth.uid()'s own, so neither
  // can be pointed at somebody else's feed. They exist because the per-row cost of
  // `comments_read` was measured at 25x the same read without it: they state the same
  // rule and evaluate it once per event and once per distinct author instead of once per
  // comment. Not granted to `anon`, for the reason `comments` revokes it: no signed-out
  // surface in this app renders user-authored text.
  'activity_comments(uuid)': ['authenticated'],
  'activity_comment_counts(uuid[])': ['authenticated'],

  // Followers and Following as lists (20260826000600 §5).
  //
  // **`security invoker`, alone among the reads added that day**, and that is the whole
  // of their privacy rather than a detail: `follows_read` already says a viewer may see
  // an approved edge only when they can view both ends of it, and `profiles_read` says
  // whether the other end can be named. A definer version would have had to restate both
  // and would have been the copy that got one wrong. They therefore hold no privilege
  // the caller does not, and `anon` is excluded because these surfaces do not exist
  // signed out.
  'followers_of(uuid,text,integer,integer)': ['authenticated'],
  'following_of(uuid,text,integer,integer)': ['authenticated'],

  // Added 2026-08-17 with the social graph writers (20260817000200). `follows` and
  // `blocks` had read policies and no writers at all until this migration, so the
  // whole visibility architecture rested on edges no user could create.
  //
  // `follow` is the one writer in this schema that deliberately does **not** gate on
  // can_view_profile — a private account fails it by definition, and gating would make
  // the pending state unreachable. `_assert_reachable` is its gate instead, and it is
  // deliberately absent from this list: it answers "does this account exist, is it
  // active, is there a block" about a named third party, which is exactly what
  // 20260813001900 revoked can_view_profile for.
  'follow(uuid,uuid)': ['authenticated'],
  'unfollow(uuid,uuid)': ['authenticated'],
  'respond_follow_request(uuid,uuid,boolean)': ['authenticated'],
  'remove_follower(uuid,uuid)': ['authenticated'],
  'block(uuid,uuid)': ['authenticated'],
  'unblock(uuid,uuid)': ['authenticated'],

  // security invoker, so it can only report what follows_read and blocks_read already
  // admit — the caller's own edges. It cannot be pointed at a pair the caller is not
  // part of, which is why a function that takes a list of user ids is safe here.
  'follow_state_with(uuid[])': ['authenticated'],

  // Added 2026-08-17 with user discovery (20260817000300). Definer, and takes no
  // viewer: the perspective is always auth.uid()'s own. Not anon — there is no
  // signed-out surface that lists people, and a grant should follow a surface rather
  // than precede it, which is the rule public_notes set.
  'search_users(text,integer)': ['authenticated'],
  // 20260819000100. Identity-only, behind the discovery predicate. It cannot reach a
  // private account's content: `can_view_profile` is untouched and still gates every
  // content read in the schema.
  //
  // `can_discover_profile` is deliberately **absent** from this list. It was granted by
  // 20260819000100 and revoked by 20260819000200: a definer helper that takes a viewer
  // as an argument answers questions about other people, and given two ids known to be
  // active a `false` means a block between them. 20260813001900 is the same finding
  // about two other functions. Both callers are definer and need no grant.
  'profile_identity(text)': ['authenticated'],

  // Added 2026-08-17 with the social graph writers. Definer, and it must be: blocking
  // makes the profile unreadable to the blocker as well, so naming the account
  // requires reading past profiles_read. It takes no argument at all, which is the
  // strongest form of 20260813001900's rule — there is nothing to point elsewhere.
  'my_blocks()': ['authenticated'],

  // Added 2026-08-17 with Taste Match (20260817000400). A definer read taking a
  // subject rather than a viewer: one half of the pair is always auth.uid(). Every
  // ranking it folds in belongs to an account rankings_read already lets the caller
  // select individually, which is the same safety argument following_score records.
  'taste_match(uuid)': ['authenticated'],

  // Added 2026-08-26 with People discovery (20260826000500). Two definer reads taking
  // no subject at all — only a limit — so 20260813001900's rule holds in its strongest
  // form: the single perspective either can answer from is auth.uid()'s own.
  //
  // `people_mutuals` counts, and never names, edges that follows_read would admit to
  // the caller one at a time: both parties to every counted edge must pass
  // can_view_profile. `people_taste_matches` calls taste_match itself rather than
  // reimplementing it, so it inherits that function's refusals along with its
  // arithmetic and cannot show a number the profile would decline to.
  'people_mutuals(integer)': ['authenticated'],
  'people_taste_matches(integer)': ['authenticated'],

  // Added 2026-08-27 with the ranking/taste tranche (20260827000700–000900).
  //
  // `dismiss_for_you` is the first writer for `recommendation_feedback`, a table
  // that had a select policy and no insert path at all: the same
  // writer-not-policy shape as every social writer above, with the operation
  // ledger and a rate limit an INSERT policy could not carry.
  //
  // `following_ratings` returns the rows behind `following_score` under that
  // aggregate's own population predicate — approved follow plus viewable
  // profile, which is rankings_read's — so it can only name rows the caller
  // could already select one at a time. Match per row comes from taste_match
  // itself, inheriting its refusals.
  //
  // `comment_reactors` names the set `activity_comments` already counted, under
  // the same three gates (viewable event actor, viewable author, viewable
  // reactor); an unviewable thread yields the same empty list an unreacted
  // comment does.
  'dismiss_for_you(uuid,uuid)': ['authenticated'],
  'following_ratings(uuid)': ['authenticated'],
  'comment_reactors(uuid)': ['authenticated'],

  // Added 2026-08-27 (20260827001100), the mutuals move one day later: the
  // aggregation released, the rows still two-party. One integer, gated on
  // can_i_view — a visitor entitled to the profile sees the same Invite
  // Instigator count the owner does, and nothing that could name an invitee.
  'invited_signup_count(uuid)': ['authenticated'],

  // Added 2026-08-27 (20260827000100). The list behind people_mutuals' count for one
  // subject: same predicates, so it can only name edges the count already included and
  // follows_read would admit to the caller one at a time.
  'mutuals_with(uuid)': ['authenticated'],

  // Added 2026-08-28 with the monthly leaderboard (20260828000300).
  //
  // Both are definer over `user_media`, which is owner-only by policy — that is the
  // whole reason they exist, since an invoker board would have one entrant. Neither
  // takes a viewer: `auth.uid()` is the perspective and the only argument is which of
  // four metrics to count, so there is no third-party question to pose (20260813001900).
  // The population is filtered by `can_view_profile`, so an unapproved private account
  // is absent from the board rather than listed with a number (founder §26), and the
  // rows carry counts only — never a title, never a date.
  //
  // `_leaderboard_counts`, `_leaderboard_metric` and `_leaderboard_month_start` are
  // deliberately absent. The first is the one that actually reads `user_media` across
  // accounts, and a client holding it would get the same rows without the ordering that
  // makes them a board — which changes nothing about safety, but the allow-list's rule
  // is that internal helpers stay internal so the reachable surface is the smallest set
  // that answers the product's questions.
  'monthly_leaderboard(text,integer)': ['authenticated'],

  // Added 2026-08-29 (20260829000100). The board gained a timeframe, so it gained a name
  // that does not claim to be monthly — and the old signature stays above as a delegating
  // wrapper, for phones still on the 2026-08-28 OTA (the 20260827000900 rule about
  // un-relaunched clients).
  //
  // Same argument as the wrapper: definer over owner-only `user_media`, no viewer
  // argument, population filtered by `can_view_profile` in both timeframes. The Match
  // columns are decided by `taste_match` itself, which refuses the caller and anyone
  // `can_view_profile` does not admit, so the row cannot disclose what the population
  // filter already refuses.
  //
  // `_leaderboard_timeframe` is absent for the reason `_leaderboard_metric` is: a
  // validator with no product surface of its own stays internal.
  'leaderboard(text,text,integer)': ['authenticated'],
  'my_leaderboard_standing(text,text)': ['authenticated'],

  // Added 2026-08-28 with For You rotation (20260828000500).
  //
  // `note_recommendations_shown` writes `recommendation_impressions`, a table with RLS
  // and deliberately no policy at all — the same shape `dismiss_for_you` gave
  // `recommendation_feedback`. It writes `auth.uid()` and takes only title ids, so it
  // cannot record an impression for anybody else; the hour-truncated primary key makes
  // it idempotent, which is why it needs no operation ledger.
  //
  // `recommendation_exposure` is the read side of the same table and takes no arguments
  // at all, so it can only aggregate the caller's own rows.
  //
  // `social_candidates` is the one that touches other people's `rankings`, and it is the
  // reason the grant is worth arguing: it returns **media item ids and a count**, never
  // a person and never a per-endorser fact. Every endorser passes `can_view_profile`, so
  // every row it aggregates is one `rankings_read` would admit to the caller one at a
  // time — the same argument `people_mutuals` and `following_score` record. It takes no
  // viewer.
  'note_recommendations_shown(uuid[])': ['authenticated'],
  'recommendation_exposure()': ['authenticated'],
  'social_candidates(integer)': ['authenticated'],

  // Added 2026-09-03 (20260907000100). Group Picks. **Security invoker**, which is the
  // argument for the grant in one word: it runs as the caller, so every cross-member
  // read is one RLS already admits to that caller row by row — visible watchlists,
  // visible rankings — and the private tables answer empty by construction. Members
  // are re-checked through `can_i_view` from the caller's own side; the answer is
  // aggregates (counts, flags, scores) and never a member id, an anchor, or anybody's
  // ranking. Takes member ids, but they can only *narrow* what the caller may already
  // read — an id the caller does not follow contributes nothing — so it is not the
  // viewer-argument oracle 20260813001900 forbids.
  'group_picks(uuid[],text,integer)': ['authenticated'],

  // Added 2026-08-17 with Settings (20260817000600). Every one of these is about the
  // caller's own account and none takes a target, which is 20260813001900's rule in
  // its strongest form: there is nothing to point at anybody else.
  //
  // `save_profile` and `set_profile_visibility` write columns `profiles` has no
  // update policy for by design (20260813000200: writes go through definer functions),
  // so definer is the mechanism rather than an escalation.
  //
  // `save_profile` replaced `update_profile` and `change_username` on 2026-08-17. One
  // transaction, because a screen with two saves can leave the name written and the
  // handle refused; the two it replaced are **dropped** rather than overloaded, since
  // PostgREST resolves by argument name and nesting argument sets resolve ambiguously.
  // It carries the 90-day redirect machinery's only entry point with it, and the
  // cooldown fires only when the handle actually changes — a rename is a scarcity
  // limit, not a rate limit, because every one retires a handle permanently.
  //
  // `my_notifications` is definer for the reason `my_blocks` is, and the reason is
  // sharper here — a private account requesting to follow another private account
  // fails can_view_profile, so an invoker query could not name the one person whose
  // request the caller has to answer. The filter is `recipient_id = auth.uid()` and it
  // is not a parameter.
  //
  // `delete_account` takes only a confirmation string. It deletes `auth.uid()` and
  // there is no signature by which it could delete anybody else.
  'save_profile(uuid,text,text,text)': ['authenticated'],
  'set_profile_visibility(uuid,profile_visibility)': ['authenticated'],
  'my_notifications(integer)': ['authenticated'],
  'mark_notifications_read()': ['authenticated'],
  'delete_account(text)': ['authenticated'],

  // Added 2026-08-17 with friend recommendations (20260817001300).
  //
  // `recommend_title` names a recipient, which is the reason to look hard at it — and
  // the reason it is safe is that it decides nothing from what the caller sends. The
  // recipient must be somebody the caller approvedly follows, which is a fact about the
  // caller's own edges, and every disqualifying case comes back as one `not_following`.
  //
  // `recommendations_to_me` and `mark_recommendation_opened` take no recipient at all:
  // both filter on `recipient_id = auth.uid()`, and the filter is not a parameter.
  // `recommendations_to_me` is additionally `security invoker`, so it can return only
  // rows `title_recommendations_recipient` already admits.
  //
  // `create_invite_link` returns the caller's own reusable personal link (PRD §17) and
  // records that it was created. It exposes no count and no other account.
  //
  // `_is_mutual_follow` is deliberately absent, for the reason `_can_tag` is: it
  // answers a question about somebody else's follow graph, which is what
  // 20260813001900 exists to prevent.
  'recommend_title(uuid,uuid,uuid)': ['authenticated'],
  'recommendations_to_me(integer)': ['authenticated'],
  'mark_recommendation_opened(uuid)': ['authenticated'],
  'create_invite_link(uuid,uuid)': ['authenticated'],

  // Added 2026-08-26 with recommendation requests (20260826000400).
  //
  // All four are the recipient's own side of the feature and none of them takes an
  // account. `recommendation_requests` filters on `recipient_id = auth.uid()` and
  // `dismiss_all_recommendation_requests` writes on the same filter — neither is a
  // parameter and neither can be made one. The two single-row writers take a
  // recommendation id and check `recipient_id = auth.uid()` in the `where`, so a
  // stolen id from somebody else's screen updates nothing and reports the same
  // `false` as an id that was already decided: "that exists but is not yours" is a
  // fact about another inbox.
  //
  // `recommendation_requests` is `security definer`, which is the one thing here worth
  // arguing. It must be: a *private* sender who follows the caller without being
  // followed back fails `can_view_profile`, so an invoker query would return a request
  // with nobody attached to it and the screen that exists to decide about that person
  // could not draw them. Same shape and same justification as `my_notifications`.
  //
  // `_may_recommend_to`, `_delivers_directly_to` and `_release_recommendations` are
  // deliberately absent, for the reason `_is_mutual_follow` is. The third would be the
  // worst of the three to expose: it takes *two* accounts and writes into one of their
  // lists.
  'recommendation_requests(integer)': ['authenticated'],
  'add_recommendation(uuid)': ['authenticated'],
  'dismiss_recommendation(uuid)': ['authenticated'],
  'dismiss_all_recommendation_requests(uuid)': ['authenticated'],

  // Added 2026-08-17 with Bingd Reviews (20260817000800). Definer, and it reuses
  // `public_notes`' own visibility predicate rather than a second copy of it — getting
  // that wrong is how a private account's writing leaks, and there is exactly one
  // correct expression of it in this schema. Not anon, following the rule public_notes
  // set: a grant follows a surface, and there is no signed-out title page.
  'title_reviews(uuid,text,integer)': ['authenticated'],

  // Added 2026-08-17. The first writer and the first reader for a table that has
  // existed since 20260813000900 with nothing consulting it. Both are about the
  // caller's own settings and neither takes a target.
  //
  // `_notifies` and `_apply_notification_preference` are deliberately absent. The first
  // answers whether a *named third party* has muted you, which is exactly what
  // 20260813001900 revoked can_view_profile for; the second is a trigger function and a
  // client holding it could suppress anybody's inbox row.
  // `set_notification_preferences` (plural) was added 2026-08-19 with the taxonomy.
  // It is what a section master switch calls: one transaction over several
  // categories, because five sequential single-category writes can end up half
  // applied and leave a master switch disagreeing with its own children.
  //
  // `_notification_categories` and `_notification_default` join the internal side.
  // Both are pure and disclose nothing about anybody, but the allow-list is the
  // artefact that gets reviewed and an entry here should follow a surface -- no
  // client calls either, so no client may.
  'set_notification_preference(text,boolean)': ['authenticated'],
  'set_notification_preferences(text[],boolean)': ['authenticated'],
  'my_notification_preferences()': ['authenticated'],

  // Added 2026-08-26 with the production bootstrap. Answers `prod` or `nonprod` and
  // nothing else.
  //
  // `anon` is the point of it rather than an oversight. `remote-smoke.mjs` runs against a
  // deployed project holding nothing but the anon key, and the check it has to be able to
  // make -- "is this release pointed at the database it says it is" -- is worthless if it
  // needs a credential the release gate does not have. What it discloses is already in the
  // URL compiled into every binary and in `config/backends.cjs`.
  //
  // `set_environment_name` is deliberately absent and is service_role only: it decides what
  // every invite token this database mints is stamped with.
  'environment_name()': ['anon', 'authenticated'],

  // Added 2026-08-16 with watch tagging (PRD §14). `set_watch_tags` replaces the
  // whole companion list for one of the caller's own watches; `hide_watch_tag` is
  // the tagged person's side of it.
  //
  // Their helpers are deliberately absent. `_can_tag` answers "may I tag this
  // person", which folds an approved follow in either direction together with a
  // block — granting it would answer questions about somebody else's follow graph,
  // which is what 20260813001900 exists to prevent. `_assert_operation_rate` would
  // report how much another account has been doing today.
  'set_watch_tags(uuid,uuid,uuid[])': ['authenticated'],
  'hide_watch_tag(uuid,uuid)': ['authenticated'],

  // Added 2026-08-15 with avatar upload. Writes only the caller's own
  // profiles.avatar_path, and only to a path under the caller's own uuid
  // folder, so the grant buys no reach over anybody else's row. Not anon: it
  // needs an auth.uid() to validate the path against.
  //
  // storage_public_url is deliberately absent — the URL is composed on the
  // client from the project it is already talking to, so no such function
  // exists to grant.
  'set_avatar(text)': ['authenticated'],

  // Added 2026-08-16 with yearly watch goals. The only writer for a table that has
  // a select policy and no write policies, for the usual reason: the clear path is
  // a delete and the set path is an upsert, and expressing "and only your own, and
  // only within the sane range" as three policies is three places to get it wrong.
  // Not anon — a goal needs an auth.uid() to belong to.
  'set_watch_goal(integer,ranking_category,integer)': ['authenticated'],

  // Added 2026-08-19 with the invitation resolver (20260819000500).
  //
  // `record_invite_open` is **the only writer in this schema granted to anon**, and
  // that grant is the thing to look hard at. The caller is the static page at
  // bingd.app/i/<token>, which has no session and never will — so the alternative to
  // an anon grant is not a safer grant, it is no open metric at all.
  //
  // Three properties make it safe to hold. It **returns void in every case**, so an
  // unknown, revoked or cross-environment token gets the same answer as a live one and
  // the function is not a token oracle. (The same *answer*: a live token counts and
  // inserts, so a residual timing difference remains for anybody willing to measure one
  // candidate repeatedly. Review 27's wording note — it is not enumeration against 32
  // hex characters, and it is not a thing a return value can close.) It reaches one
  // table, which has
  // no select policy and is revoked from both client roles, so nothing written
  // through it can be read back through it. And it is **capped per token per hour**,
  // because an anonymous caller has no identity to rate-limit — past the ceiling the
  // call still succeeds and simply stops writing.
  //
  // `redeem_invite` names no other account: the inviter is resolved from a token the
  // caller already holds, never from a parameter naming a person. Blocks in either
  // direction and a suspended inviter are refused, and the primary key on
  // `invitee_id` is what stops a replay moving an attribution somebody else already
  // holds. Not anon — an attribution needs an account to belong to, which is the
  // whole of PRD §17's "the recipient must have an account".
  //
  // `_maybe_activate_invite` is deliberately absent, and for the reason `_notifies`
  // is: it reads a third party's attribution and writes somebody else's inbox row. It
  // is reached only from `_rank_finalize`, which no client may call either.
  // `revoke_invite_link` takes no target at all and acts only on `owner_id =
  // auth.uid()`, so the grant buys no reach over anybody else's row. It is the safety
  // valve for a reusable, non-expiring link that has been pasted somewhere public, and
  // it exists because 20260819000500 is what made such a link worth anything.
  'record_invite_open(text,text)': ['anon', 'authenticated'],
  'redeem_invite(uuid,text)': ['authenticated'],
  'revoke_invite_link(uuid)': ['authenticated'],

  // Added 2026-08-24 with push delivery (20260825000300). Two writers for a table that
  // has had no writer and no read policy since 20260813000900.
  //
  // Neither names an account. `register_device_token` writes `auth.uid()` and takes only
  // a token and a platform; `revoke_device_token` acts on `user_id = auth.uid()` and
  // answers `ok` either way, so it cannot report whether a token exists or who holds it.
  // The device-to-account move that makes a shared phone safe happens inside the first
  // one, through the table's own unique key, rather than through anything a caller says.
  //
  // **`claim_push_batch` and `settle_push_batch` are deliberately absent, and they are
  // the two functions in this schema it would be worst to grant.** They resolve
  // recipients server-side and hand back device tokens; a client holding either could
  // read other people's tokens and settle other people's deliveries. Both are granted to
  // `service_role` alone, which this sweep does not cover — so `push.test.mjs` asserts
  // the refusal for `anon` and `authenticated` directly. An allow-list can only say what
  // is not on it.
  //
  // `_push_eligible` and `_enqueue_push` join the internal side for the reason
  // `_apply_notification_preference` does: the second writes the delivery queue, and a
  // client holding it could enqueue a push for anybody.
  'register_device_token(uuid,text,text)': ['authenticated'],
  'revoke_device_token(uuid,text)': ['authenticated'],
};

async function functionPrivileges(t) {
  const { rows } = await t.sql(`
    select p.oid::regprocedure::text as signature,
           has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid
            and d.classid = 'pg_proc'::regclass
            and d.deptype = 'e'
       )
     order by signature
  `);
  // regprocedure renders as public.name(args) with spaces after commas.
  return rows.map((r) => ({
    signature: r.signature.replace(/^public\./, '').replace(/,\s+/g, ','),
    anon: r.anon_exec,
    authenticated: r.auth_exec,
  }));
}

test('no function outside the allow-list is executable by a client role', async () => {
  const t = await createTestDb();
  try {
    const unexpected = [];
    for (const fn of await functionPrivileges(t)) {
      const allowed = ALLOWED[fn.signature] ?? [];
      if (fn.anon && !allowed.includes('anon')) unexpected.push(`anon can execute ${fn.signature}`);
      if (fn.authenticated && !allowed.includes('authenticated')) {
        unexpected.push(`authenticated can execute ${fn.signature}`);
      }
    }

    assert.deepEqual(
      unexpected,
      [],
      `Functions reachable by a client role but not in the allow-list.\n` +
        `If the new grant is intended, add it to ALLOWED in this file and say why.\n` +
        `Remember that "grant execute ... to authenticated" does not remove the\n` +
        `default PUBLIC grant — see 20260813001800.\n\n  ${unexpected.join('\n  ')}\n`,
    );
  } finally {
    await t.close();
  }
});

test('every function in the allow-list actually exists with that signature', async () => {
  const t = await createTestDb();
  try {
    // Catches the allow-list drifting out of date: a renamed or re-signatured
    // function would otherwise sit here forever, silently permitting nothing and
    // hiding the fact that the real function is unguarded under its new name.
    const present = new Set((await functionPrivileges(t)).map((f) => f.signature));
    const missing = Object.keys(ALLOWED).filter((sig) => !present.has(sig));
    assert.deepEqual(missing, [], `Allow-list names functions that do not exist: ${missing}`);
  } finally {
    await t.close();
  }
});

test('the helpers RLS policies depend on are executable, or every read breaks', async () => {
  const t = await createTestDb();
  try {
    // The failure this prevents is disproportionate: can_view_profile is named by
    // policies across eight migrations, and a policy that calls a function the
    // caller cannot execute fails the entire query rather than filtering it. The
    // symptom would be "permission denied for function" on an ordinary profile
    // read, which points nowhere near a grant.
    const alice = await t.createUser({ username: 'alice' });

    const visible = await t.asAnon(async () => {
      const { rows } = await t.sql(`select id from profiles where id = $1`, [alice]);
      return rows;
    });

    assert.equal(visible.length, 1, 'a signed-out reader should see a public profile');
  } finally {
    await t.close();
  }
});

test('capability reads are scoped to the caller, with no target argument exposed', async () => {
  const t = await createTestDb();
  try {
    const alice = await t.createUser({ username: 'alice' });
    const bob = await t.createUser({ username: 'bob' });

    // resolve_capabilities takes a target, which is exactly why it must not be
    // reachable: it would let anyone read anyone's entitlements.
    await t.asUser(alice, async () => {
      const err = await t.errorFrom(`select resolve_capabilities($1)`, [bob]);
      assert.ok(err, 'resolve_capabilities should not be callable by a client');
      assert.match(err.message, /permission denied/i);
    });

    // The sanctioned route answers only for whoever is asking.
    await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select my_capabilities() as caps`);
      assert.ok(rows[0].caps.includes('base_free'));
    });
  } finally {
    await t.close();
  }
});

test('a signed-out caller gets no answer from my_capabilities', async () => {
  const t = await createTestDb();
  try {
    // The one finding that was not merely defence in depth: before 001800 this
    // returned ["base_free"] to strangers on the deployed database.
    await t.asAnon(async () => {
      const err = await t.errorFrom(`select my_capabilities()`);
      assert.ok(err, 'my_capabilities should be refused for an anonymous caller');
      assert.match(err.message, /permission denied/i);
    });
  } finally {
    await t.close();
  }
});

test('write RPCs are refused on privilege, not merely on the suspension guard', async () => {
  const t = await createTestDb();
  try {
    // Before 001800 these were reachable by anon and stopped only by
    // assert_can_write raising 'unauthenticated'. That is containment inside the
    // function rather than at the door, and it does not survive someone adding a
    // function without the guard. Both layers are asserted, in the right order.
    await t.asAnon(async () => {
      for (const call of [
        `select rank_start('00000000-0000-0000-0000-000000000000', 'loved')`,
        `select rank_reorder('00000000-0000-0000-0000-000000000000', 1)`,
        `select report('profile', '00000000-0000-0000-0000-000000000000', 'spam', null)`,
      ]) {
        const err = await t.errorFrom(call);
        assert.ok(err, `${call} should be refused`);
        assert.match(err.message, /permission denied/i, `${call} should fail on privilege`);
      }
    });
  } finally {
    await t.close();
  }
});

test('assert_can_write is internal, and still runs inside the definer functions', async () => {
  const t = await createTestDb();
  try {
    // Revoking it is safe precisely because a security definer function executes
    // as its owner. This asserts both halves: a client cannot call the guard, and
    // the guard nonetheless fires for a suspended account going through the RPC.
    const alice = await t.createUser({ username: 'alice' });
    const movie = await t.createMovie('Heat', 949);

    await t.asUser(alice, async () => {
      const err = await t.errorFrom(`select assert_can_write($1)`, [alice]);
      assert.ok(err, 'assert_can_write should not be client-callable');
      assert.match(err.message, /permission denied/i);
    });

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [alice]);

    await t.asUser(alice, async () => {
      const err = await t.errorFrom(`select rank_start($1, 'loved')`, [movie]);
      assert.ok(err, 'a suspended account should not be able to rank');
      assert.match(err.message, /suspend/i, 'and should be told why, not given a privilege error');
    });
  } finally {
    await t.close();
  }
});
