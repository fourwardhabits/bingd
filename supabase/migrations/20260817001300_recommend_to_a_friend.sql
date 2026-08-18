-- Recommending a title to somebody, and the social rule that decides who "somebody" is.
-- Specification: PRD §13 (For You stays algorithmic) · PRD §14 (tagging) · PRD §15
-- (inbox) · PRD §17 (invitations) · PRD §22 (blocks) · founder tranche, 2026-08-17.
--
-- ===========================================================================
-- THE ONE RULE THIS MIGRATION IS ABOUT
--
-- A recommendation may only be sent to a **mutual follow**: both edges present, both
-- `approved`. Not a stranger, not a one-way follow, not a blocked or suspended
-- account, not an account that does not exist.
--
-- There is no friendship table and there will not be one. A mutual follow *is* the
-- friendship in this schema, and a second table expressing the same fact is a second
-- table to keep in step with `follow`, `unfollow`, `block` and `respond_follow_request`
-- -- four writers that already maintain the edges correctly. The rule is a predicate
-- over `follows`, written once, in `_is_mutual_follow`.
--
-- **This tightens `Who I watched with` as well.** `_can_tag` has admitted a follow in
-- *either* direction since 20260816000300, which was PRD §14 as written at the time.
-- The founder's rule for this tranche is one social rule across both features, and the
-- narrower one wins: putting your name on somebody's watch and putting a title in
-- their inbox are the same kind of act, and a person who followed you once without
-- your following back has not agreed to either.
--
-- Narrowing an authorization is only safe if it cannot strand existing data, and the
-- careful part is below in `set_watch_tags`: the eligibility test now applies to people
-- being *added*, and anybody already tagged on that watch stays taggable. Without that,
-- a user with one lapsed one-way companion could never save the picker again -- the
-- call refuses as a whole rather than partially applying, which is correct and which
-- would have turned a narrowing into a trap.
--
-- ===========================================================================
-- WHY THE RULE IS NOT `can_view_profile`
--
-- `can_view_profile` is true for every public account, which is most of them. It is the
-- *reading* rule and this is a *writing into somebody's inbox* rule; they are not the
-- same question, and 20260817000200 records the mirror image of this reasoning for
-- `follow`, which must be permitted where `can_view_profile` is false.
--
-- ===========================================================================
-- WHAT A REFUSAL MAY SAY
--
-- Missing, suspended and blocked all raise the same P0002 through `_assert_reachable`,
-- for the reason that function records: a caller must not be able to tell "you are
-- blocked" from "no such account".
--
-- Not-mutual is different and gets its own 42501. It discloses nothing the caller could
-- not already read: `follows_read` admits every row the caller is a party to, in both
-- directions, so "do they follow me back" is already a select away. Collapsing it into
-- P0002 would only make a legitimate refusal unexplainable in the UI.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The record
--
-- The smallest thing that is still correct. One row per (sender, recipient, exact
-- media item), which is what makes the duplicate rule expressible as a constraint
-- rather than as a convention.
--
-- `recommended_at` as well as `created_at`: they differ the moment somebody
-- recommends the same title twice, and the list is ordered by the second one.
-- `created_at` preserves when the recommendation first happened, which is the thing a
-- conversion analysis has to measure from.
--
-- `opened_at` rather than a boolean, for the same reason `read_at` is a timestamp on
-- `notifications`: "when" answers "did they look at this before or after they
-- watchlisted it", and a boolean does not.
--
-- **The exact object, never the series.** PRD §10 makes the season the rankable TV
-- unit, so a recommendation names a movie or a season. The kind lives on
-- `media_items` rather than here, so the rule is enforced in `recommend_title` and
-- asserted by a test rather than by a check constraint.
-- ---------------------------------------------------------------------------

create table title_recommendations (
  id             uuid primary key default gen_random_uuid(),
  sender_id      uuid not null references profiles(id) on delete cascade,
  recipient_id   uuid not null references profiles(id) on delete cascade,
  media_item_id  uuid not null references media_items(id) on delete cascade,
  created_at     timestamptz not null default now(),
  recommended_at timestamptz not null default now(),
  opened_at      timestamptz,
  unique (sender_id, recipient_id, media_item_id),
  constraint no_self_recommendation check (sender_id <> recipient_id)
);

-- Serves `Sent to you`: unopened first, then newest, for one recipient.
create index title_recommendations_inbox
  on title_recommendations (recipient_id, recommended_at desc);

-- Serves the conversion derivation in docs/product/growth-instrumentation.md, which
-- asks "what happened to the things this person sent".
create index title_recommendations_sender
  on title_recommendations (sender_id, recommended_at desc);

comment on table title_recommendations is
  'One person recommending one exact title to one mutual follow. Human recommendations, deliberately separate from recommendations/recommendation_generations, which are the algorithmic For You slate: merging them would make the engine assert a friend''s opinion as its own reasoning, which PRD §13 forbids.';

comment on column title_recommendations.recommended_at is
  'When it was most recently sent. Re-sending the same title to the same person moves this and does not create a row -- see recommend_title. created_at stays at the first send, which is what a conversion measurement counts from.';

comment on column title_recommendations.opened_at is
  'When the recipient opened it. Never cleared: a re-send does not make an already-seen recommendation unread again, or a sender could re-badge somebody''s inbox by tapping twice.';

alter table title_recommendations enable row level security;

-- Both parties, and nobody else. The sender needs to know they sent it -- the sheet
-- marks people it has already gone to -- and the recipient is the whole point.
create policy title_recommendations_read on title_recommendations for select
  using (sender_id = auth.uid() or recipient_id = auth.uid());

-- Stated rather than inherited. 20260813001400 revokes insert/update/delete from anon
-- and authenticated by default privileges but leaves select to whatever the project's
-- defaults happen to be, and review 17j is the standing reminder that a privilege the
-- schema does not state is a privilege nobody can check. `anon` is explicitly not
-- granted: every row here is about two named accounts.
revoke all on title_recommendations from anon;
grant select on title_recommendations to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The predicate
--
-- Takes the other party only, so the perspective is always `auth.uid()`'s and this
-- cannot be turned into a "do these two strangers follow each other" oracle. The same
-- shape, and the same reason, as `_can_tag`.
--
-- Blocks go through `blocked_between` rather than an inline select, because
-- `blocks_read` hides a block from the person it was made against -- an inline
-- subquery returns false for exactly the caller who must be refused. `block` also
-- deletes both follow rows, so the follow test alone would usually be enough; usually
-- is not a security argument.
-- ---------------------------------------------------------------------------

create or replace function _is_mutual_follow(p_other uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_other is not null
     and p_other <> auth.uid()
     and exists (select 1 from profiles p where p.id = p_other and p.status = 'active')
     and not blocked_between(p_other, auth.uid())
     and exists (
       select 1 from follows f
        where f.follower_id = auth.uid() and f.followee_id = p_other
          and f.state = 'approved'
     )
     and exists (
       select 1 from follows f
        where f.follower_id = p_other and f.followee_id = auth.uid()
          and f.state = 'approved'
     );
$$;

comment on function _is_mutual_follow(uuid) is
  'True when the caller and the named account follow each other, both approved, neither blocked, and the other account is active. The one place the V1 "friend" rule is written. Internal: it answers a question about another account''s follow graph, and takes only the other party so it can never be asked about two third parties.';

-- ---------------------------------------------------------------------------
-- 3. Sending one
--
-- DUPLICATE SEMANTICS, stated here because they are a product decision and not an
-- implementation detail:
--
--   Recommending the same title to the same person again **updates the existing row**.
--   `recommended_at` moves to now, so it returns to the top of their list.
--   `opened_at` is left exactly as it was.
--   **No second notification is filed.**
--
-- One row per (sender, recipient, title), for good. The alternative -- a row per send
-- -- turns "Sent to you" into a list with the same poster in it four times, and makes
-- the conversion question ("did this recommendation lead to a watch") ambiguous about
-- which of the four to credit.
--
-- Not re-notifying is the anti-ping half of the same decision, and it is the rule
-- 20260816000700 already reached for watch tags after review found the alternative: a
-- notice that can be re-fired at will is a way to reach somebody who cannot stop it.
-- The cost is that a genuine "no really, watch it" is quiet; the recommendation moves
-- back to the top of their list, where they will see it.
--
-- RATE LIMITING uses `_assert_operation_rate` and nothing else -- there is no second
-- framework here. Two windows over the same kind, which is one existing function
-- called twice:
--
--   * per hour, which is what stops a burst. A script that sends four hundred in a
--     minute is the flooding case, and a daily ceiling it fits inside is not a limit.
--   * per day, which bounds the total.
--
-- It counts `processed_operations` rows of kind `recommend_title`, so it counts
-- *attempts* and is indifferent to which title or which recipient each one named --
-- which is what closes the "bypass through multiple title requests" route. A
-- send-and-resend loop is counted too, because a claim is never withdrawn.
-- ---------------------------------------------------------------------------

create or replace function recommend_title(
  p_operation_id  uuid,
  p_recipient_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind    media_kind;
  v_id      uuid;
  v_created boolean;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'recommend_title') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- Burst first, then the daily ceiling. Both count the same kind; the hour is the
  -- one that catches a script and the day is the one that bounds a person.
  perform _assert_operation_rate('recommend_title', 'recommendations.max_per_hour', 20, interval '1 hour');
  perform _assert_operation_rate('recommend_title', 'recommendations.max_per_day', 50, interval '1 day');

  -- Before the eligibility check, because the check is what reads `follows` and
  -- `blocks`, and a block committing between the check and the insert is the race.
  -- Same ordering and same lock as `follow` and `block` (20260817000200). It is also
  -- what makes the read-then-write below safe without an upsert.
  perform _lock_pair(auth.uid(), p_recipient_id);

  -- Missing, suspended, blocked, or yourself. One error for the first three.
  perform _assert_reachable(p_recipient_id);

  if not _is_mutual_follow(p_recipient_id) then
    raise exception 'you can only recommend to people who follow you back'
      using errcode = '42501';
  end if;

  select m.kind into v_kind from media_items m where m.id = p_media_item_id;

  if v_kind is null then
    raise exception 'no such title' using errcode = 'P0002';
  end if;

  -- PRD §10. A series is not a thing anybody watched, so it is not a thing anybody can
  -- be told to watch -- the same refusal the collection writers make, for the same
  -- reason.
  if rankable_category(v_kind) is null then
    raise exception 'recommend a film or a season, not a whole series'
      using errcode = '22023';
  end if;

  select r.id into v_id
    from title_recommendations r
   where r.sender_id = auth.uid()
     and r.recipient_id = p_recipient_id
     and r.media_item_id = p_media_item_id;

  v_created := v_id is null;

  if v_created then
    insert into title_recommendations (sender_id, recipient_id, media_item_id)
    values (auth.uid(), p_recipient_id, p_media_item_id)
    returning id into v_id;

    -- Only on a genuinely new recommendation. See the header: a notice that can be
    -- re-fired by re-sending is a ping vector, and re-sending already moves the row
    -- back to the top of their list.
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (p_recipient_id, 'recommendation', auth.uid(), 'media_item', p_media_item_id,
            jsonb_build_object('recommendation_id', v_id));
  else
    -- `opened_at` is deliberately absent from this SET list, and its absence is
    -- load-bearing: see the comment on the column.
    update title_recommendations
       set recommended_at = now()
     where id = v_id;
  end if;

  return jsonb_build_object('status', 'ok', 'created', v_created, 'id', v_id);
end;
$$;

comment on function recommend_title(uuid, uuid, uuid) is
  'Recommends one exact title to one mutual follow. Refuses a stranger, a one-way follow, a block, a suspension and a series. Re-sending the same title to the same person moves recommended_at and files no second notification -- one row per (sender, recipient, title), for good. Rate-limited per hour and per day over processed_operations, so the ceiling is on attempts and cannot be widened by naming different titles.';

-- ---------------------------------------------------------------------------
-- 4. Reading them back
--
-- `security invoker`, and that is the whole authorization story for this function.
-- The join to `profiles` is filtered by `profiles_read`, which is `can_view_profile`
-- -- so a sender who has since blocked the recipient, or gone private and been
-- unfollowed, drops out of the list without this function knowing anything about
-- blocks. `media_items_read` is `using (true)`, and `title_recommendations_read`
-- already limits the rows to the caller's own.
--
-- An inner join, so a row whose sender cannot be named disappears rather than being
-- drawn anonymously -- the same rule `my_notifications` follows and for the same
-- reason: "somebody recommended this to you" with no somebody is not a thing to show.
--
-- `p.status = 'active'` on the join, because a suspended account's name should stop
-- appearing everywhere at once, and `can_view_profile` deliberately does not test
-- status.
--
-- The series title comes back separately rather than pre-joined into `media_title`,
-- because `fullTitle` on the client is the one place that decides how a season is
-- named, and a second opinion in SQL is how the feed came to read "ranked Season 2".
-- ---------------------------------------------------------------------------

create or replace function recommendations_to_me(p_limit integer default 100)
returns table (
  id                  uuid,
  sender_id           uuid,
  sender_username     text,
  sender_display_name text,
  sender_avatar_path  text,
  media_item_id       uuid,
  media_kind          media_kind,
  media_title         text,
  series_title        text,
  poster_path         text,
  release_date        date,
  genres              text[],
  original_language   text,
  runtime_minutes     integer,
  recommended_at      timestamptz,
  opened_at           timestamptz
)
language sql stable security invoker
set search_path = public
as $$
  select r.id,
         r.sender_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         m.id,
         m.kind,
         m.title,
         parent.title,
         m.poster_path,
         m.release_date,
         m.genres,
         m.original_language,
         m.runtime_minutes,
         r.recommended_at,
         r.opened_at
    from title_recommendations r
    join profiles p    on p.id = r.sender_id and p.status = 'active'
    join media_items m on m.id = r.media_item_id
    left join media_items parent on parent.id = m.parent_id
   where r.recipient_id = auth.uid()
   -- Unopened first, then newest. The founder's order, and the one that matches what
   -- the list is for: the new thing somebody sent you is the reason you opened it.
   order by (r.opened_at is not null), r.recommended_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 200);
$$;

comment on function recommendations_to_me(integer) is
  'The caller''s "Sent to you" list, unopened first and newest within that. security invoker on purpose: profiles_read is what makes a blocked or newly private sender disappear, so this function contains no visibility logic of its own and cannot get it wrong. Cannot be asked about another account -- the filter is recipient_id = auth.uid() and is not a parameter.';

create or replace function mark_recommendation_opened(p_recommendation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  perform assert_can_write();

  -- Only the caller's own, only forwards, and only once. `opened_at is null` makes a
  -- second call a no-op rather than a way to keep moving the timestamp, which is what
  -- lets a conversion measurement trust the interval between sent and opened.
  update title_recommendations
     set opened_at = now()
   where id = p_recommendation_id
     and recipient_id = auth.uid()
     and opened_at is null;

  get diagnostics v_updated = row_count;

  -- Not an error when there was nothing to mark: already-opened is the state the
  -- caller asked for, and a recommendation that is not theirs reports the same way,
  -- because "that exists but is not yours" is a fact about somebody else's inbox.
  return jsonb_build_object('status', 'ok', 'opened', v_updated > 0);
end;
$$;

comment on function mark_recommendation_opened(uuid) is
  'Marks one of the caller''s own recommendations opened, once. Idempotent and silent about rows that are not the caller''s. No operation id: it is idempotent by construction and writes nothing anybody else can see.';

-- ---------------------------------------------------------------------------
-- 5. Who I watched with, narrowed to the same rule
--
-- `_can_tag` becomes `_is_mutual_follow` plus nothing. Every condition it used to test
-- -- exists, active, not blocked, not yourself -- is in the predicate already, which
-- is the point of having written it once.
-- ---------------------------------------------------------------------------

create or replace function _can_tag(p_tagged uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select _is_mutual_follow(p_tagged);
$$;

comment on function _can_tag(uuid) is
  'A taggable person is a mutual follow: both edges approved, neither blocked, the account active. Narrowed from "either direction" (20260816000300) by the founder tranche of 2026-08-17, so that tagging and recommending share one social rule. Internal to set_watch_tags. Existing tags are grandfathered there rather than here -- a predicate that lies about history is worse than a longer function.';

-- ---------------------------------------------------------------------------
-- 6. set_watch_tags, with the narrowing made safe
--
-- Rebuilt in full rather than patched, for the reason 20260817000200 gives: a
-- `create or replace` assembled from the wrong ancestor is how `_assert_operation_rate`
-- silently lost its advisory lock, and it is invisible in a diff.
--
-- **The only behavioural change is the eligibility test.** It was
--
--     every person in the list must pass _can_tag
--
-- and it is now
--
--     every person in the list must pass _can_tag, unless they already hold a live
--     tag on this watch
--
-- Because `set_watch_tags` takes the complete set and refuses as a whole, the old form
-- would mean that anybody whose companion list contains a person who is no longer a
-- mutual follow -- which the narrowing above creates on the day it is applied -- could
-- never save that picker again, for any change, including removing that very person.
-- The narrowing would have locked people out of their own records.
--
-- Grandfathering is not a hole. It permits nothing new: the row is already there and
-- already visible, `watch_tag_visible` still resolves blocks and removal on every
-- read, and the tagged person's `hide_watch_tag` is untouched. It only declines to
-- retroactively invalidate a record that was legitimate when it was made -- which is
-- the founder's "do not break old valid companion records", enforced rather than
-- hoped for.
--
-- Note the shape of the survivor test: `not removed_by_tagger`. A tag the tagger took
-- off is not live, so re-adding somebody after the narrowing goes through `_can_tag`
-- like anybody else.
-- ---------------------------------------------------------------------------

create or replace function set_watch_tags(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_tagged_ids    uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max      integer;
  v_wanted   uuid[];
  v_bad      uuid;
  v_added    uuid[];
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_watch_tags') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_watch_tags', 'watch_tags.max_calls_per_day', 100);

  if p_tagged_ids is null then
    raise exception 'the companion list is required; send an empty array to clear it'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from user_media
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) then
    raise exception 'log the watch before saying who you watched it with'
      using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct w.uid), '{}') into v_wanted
    from unnest(p_tagged_ids) as w(uid)
   where w.uid is not null;

  select coalesce((select (value)::integer from app_config where key = 'watch_tags.max_per_watch'), 10)
    into v_max;

  if coalesce(array_length(v_wanted, 1), 0) > v_max then
    raise exception 'you can tag up to % people on one watch', v_max using errcode = '22023';
  end if;

  -- The narrowing, and its grandfather clause. See the header.
  select w.uid into v_bad
    from unnest(v_wanted) as w(uid)
   where not _can_tag(w.uid)
     and not exists (
       select 1 from watch_tags t
        where t.tagger_id = auth.uid()
          and t.tagged_id = w.uid
          and t.media_item_id = p_media_item_id
          and not t.removed_by_tagger
     )
   limit 1;

  if v_bad is not null then
    raise exception 'you can only tag people who follow you back'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(w.uid), '{}') into v_added
    from unnest(v_wanted) as w(uid)
   where not exists (
     select 1 from watch_tags t
      where t.tagger_id = auth.uid()
        and t.tagged_id = w.uid
        and t.media_item_id = p_media_item_id
        and not t.removed_by_tagger
   );

  update watch_tags
     set removed_by_tagger = true
   where tagger_id = auth.uid()
     and media_item_id = p_media_item_id
     and tagged_id <> all (v_wanted);

  insert into watch_tags (tagger_id, tagged_id, media_item_id)
  select auth.uid(), w.uid, p_media_item_id from unnest(v_wanted) as w(uid)
  on conflict (tagger_id, tagged_id, media_item_id) do update
    set removed_by_tagger = false;

  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
  select w.uid, 'watch_tag', auth.uid(), 'media_item', p_media_item_id, '{}'::jsonb
    from unnest(v_added) as w(uid)
  on conflict (recipient_id, actor_id, subject_id, type) where type = 'watch_tag'
    do nothing;

  return jsonb_build_object('status', 'ok', 'tagged', coalesce(array_length(v_wanted, 1), 0));
end;
$$;

comment on function set_watch_tags(uuid, uuid, uuid[]) is
  'Replaces the caller''s companion list for one of their own watches (PRD §14). A person may be added only if they are a mutual follow; a person already tagged on this watch stays, so narrowing the rule on 2026-08-17 could not strand an existing list. Refuses as a whole rather than partially applying. Removal is a soft delete, so the tagged person''s own removal survives an untag and re-tag. The inbox notice is once per (tagger, tagged, title) for good.';

-- ---------------------------------------------------------------------------
-- 7. The inbox learns what kind of thing it is pointing at
--
-- `my_notifications` already resolves the subject title. A recommendation row needs
-- two more facts to render: whether the title is a film or a season, so the sentence
-- can say which, and the parent series' name, so a season is not announced as
-- "Season 2".
--
-- The return type changes, so this is a drop and a create rather than a replace. The
-- revoke and the grant are both restated because a dropped function takes its
-- privileges with it -- the `drop view` lesson of 20260817001200, in its other form.
-- ---------------------------------------------------------------------------

drop function if exists my_notifications(integer);

create function my_notifications(p_limit integer default 50)
returns table (
  id                 uuid,
  kind               text,
  created_at         timestamptz,
  read_at            timestamptz,
  actor_id           uuid,
  actor_username     text,
  actor_display_name text,
  actor_avatar_path  text,
  subject_type       text,
  subject_id         uuid,
  media_item_id      uuid,
  media_kind         media_kind,
  media_title        text,
  series_title       text
)
language sql stable security definer
set search_path = public
as $$
  select n.id,
         n.type,
         n.created_at,
         n.read_at,
         n.actor_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         n.subject_type,
         n.subject_id,
         m.id,
         m.kind,
         m.title,
         parent.title
    from notifications n
    -- Left, because actor_id is nullable: a notification with no actor is a system
    -- notice and must not be dropped by the join that exists to name a person.
    left join profiles p
           on p.id = n.actor_id
          and p.status = 'active'
    -- The recipient's own feed event, and only ever theirs.
    left join feed_events fe
           on n.subject_type = 'feed_event'
          and fe.id = n.subject_id
          and fe.actor_id = auth.uid()
    left join media_items m
           on m.id = case
                       when n.subject_type = 'media_item' then n.subject_id
                       else fe.media_item_id
                     end
    -- A season's own title is "Season 2" and names nothing on its own. The client's
    -- `fullTitle` joins the two; this supplies the half it did not have.
    left join media_items parent
           on parent.id = m.parent_id
   where n.recipient_id = auth.uid()
     -- A row whose actor has been suspended stops appearing, rather than being drawn
     -- without a name. Consistent with public_profiles, search_users and the feed.
     and (n.actor_id is null or p.id is not null)
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function my_notifications(integer) is
  'The caller''s own inbox, with the actor named and the subject title resolved -- now including the title''s kind and its parent series, so a recommendation can say "recommended a season" and name the show. Definer for the same reason my_blocks is: a private account requesting to follow another private account fails can_view_profile, so an invoker query could not draw the one row whose whole purpose is to be answered. Takes no recipient and cannot be asked about anybody else.';

revoke execute on function my_notifications(integer) from public, anon;

-- ---------------------------------------------------------------------------
-- 8. Invitations: the foundation, and only the part that is honest
--
-- The founder wants to know which users eventually bring in new users. The honest
-- version of that, with the infrastructure that exists today:
--
--   CREATED    -- reliable. Somebody asked for their link. This migration records it.
--   OPENED     -- **not measurable.** There is no web property, no link resolver and
--                 no deep-link handler; https://bingd.app/i/<token> resolves to
--                 nothing today. Opening the OS share sheet is *not* an open, and is
--                 not an invitation sent either -- the sheet may be dismissed, and
--                 nothing here would ever know.
--   REDEEMED   -- schema exists (`invite_attributions.accepted_at`) and has no writer,
--                 because a redemption that nothing can deliver a token to cannot be
--                 recorded without inventing it.
--   ACTIVATED  -- schema exists (`invite_attributions.activated_at`), same.
--
-- So this migration builds the two things that are real -- a personal link somebody
-- can actually be given, and a durable record of each time one was created and for
-- which title -- and writes the exact remaining wiring down in
-- docs/product/growth-instrumentation.md rather than approximating it.
--
-- `invite_tokens` already enforces PRD §17's one live personal link per user through a
-- partial unique index. `create_invite_link` reuses the live one rather than rotating:
-- a personal link that changes every time it is shared is not reusable, and everybody
-- who was given the old one is silently detached from the inviter.
--
-- The media context therefore cannot live on the token -- the token outlives any one
-- share. It lives on the creation record, which is one row per act of sharing.
--
-- **Nothing here is exposed as a count, a leaderboard, a badge or a reward.** The
-- founder asked for the instrumentation without the promise, and a visible number is
-- the promise.
-- ---------------------------------------------------------------------------

create table invite_link_creations (
  id            uuid primary key default gen_random_uuid(),
  inviter_id    uuid not null references profiles(id) on delete cascade,
  token_id      uuid references invite_tokens(id) on delete set null,
  -- What they were looking at when they shared. Null when the link was created from
  -- somewhere with no title in view.
  media_item_id uuid references media_items(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index invite_link_creations_inviter
  on invite_link_creations (inviter_id, created_at desc);

comment on table invite_link_creations is
  'One row each time somebody asked for their invite link, with the title they were looking at. The only invite metric this build can measure honestly: an open, a redemption and an activation all need the link resolver that does not exist yet. Deliberately not named invite_sent -- an OS share sheet may be dismissed, and nothing here would know.';

alter table invite_link_creations enable row level security;

create policy invite_link_creations_own on invite_link_creations for select
  using (inviter_id = auth.uid());

revoke all on invite_link_creations from anon;
grant select on invite_link_creations to authenticated;

-- ---------------------------------------------------------------------------
-- The link itself
--
-- `env` is on the token because PRD §17 requires a nonprod token not to resolve in
-- production. It is read from `app_config` rather than passed by the caller: a client
-- that can name its own environment can mint a production-looking token from a
-- development build.
--
-- The token is 32 hex characters drawn from `gen_random_uuid()`, which is core
-- Postgres and CSPRNG-backed. `gen_random_bytes` would be the more natural call and
-- is deliberately not used: it belongs to pgcrypto, which this schema does not
-- install (20260813000100 installs citext and nothing else), so it would work on a
-- Supabase project and fail on the local harness -- the "the file is not the database"
-- failure mode in its cheapest form.
-- ---------------------------------------------------------------------------

insert into app_config (key, value)
values ('env.name', '"nonprod"'::jsonb)
on conflict (key) do nothing;

create or replace function create_invite_link(
  p_operation_id  uuid,
  p_media_item_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token    text;
  v_short    text;
  v_token_id uuid;
  v_env      text;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'create_invite_link') then
    -- The link is stable, so a replayed operation can still answer with it rather
    -- than with a status the caller has nothing to share.
    select t.token, t.short_code into v_token, v_short
      from invite_tokens t
     where t.owner_id = auth.uid() and t.revoked_at is null;

    return jsonb_build_object('status', 'already_applied', 'token', v_token, 'short_code', v_short);
  end if;

  perform _assert_operation_rate('create_invite_link', 'invite.max_links_per_day', 30);

  select t.token, t.short_code, t.id into v_token, v_short, v_token_id
    from invite_tokens t
   where t.owner_id = auth.uid() and t.revoked_at is null;

  if v_token is null then
    v_token := replace(gen_random_uuid()::text, '-', '');
    -- Drawn separately rather than sliced off the token, so holding a short code is
    -- never a head start on guessing the token it belongs to.
    v_short := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

    select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod')
      into v_env;

    insert into invite_tokens (owner_id, token, short_code, env)
    values (auth.uid(), v_token, v_short, v_env)
    returning id into v_token_id;
  end if;

  insert into invite_link_creations (inviter_id, token_id, media_item_id)
  values (auth.uid(), v_token_id,
          -- Recorded only when it names a real title, so a stale client cannot make
          -- the foreign key the thing that fails somebody's share.
          (select m.id from media_items m where m.id = p_media_item_id));

  return jsonb_build_object('status', 'ok', 'token', v_token, 'short_code', v_short);
end;
$$;

comment on function create_invite_link(uuid, uuid) is
  'Returns the caller''s one reusable personal invite link (PRD §17), minting it on first use, and records that it was created and which title was in view. Never rotates: a personal link that changes on every share detaches everybody who already holds the old one. Rate-limited over processed_operations like every other social writer.';

-- ---------------------------------------------------------------------------
-- 9. Configuration and privileges
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  ('recommendations.max_per_hour', '20'::jsonb),
  ('recommendations.max_per_day',  '50'::jsonb),
  ('invite.max_links_per_day',     '30'::jsonb)
on conflict (key) do nothing;

grant execute on function recommend_title(uuid, uuid, uuid)  to authenticated;
grant execute on function recommendations_to_me(integer)     to authenticated;
grant execute on function mark_recommendation_opened(uuid)   to authenticated;
grant execute on function create_invite_link(uuid, uuid)     to authenticated;
grant execute on function my_notifications(integer)          to authenticated;

-- Internal, and said out loud rather than left to the default-privileges revoke in
-- 20260813001800 -- both answer questions about another account's follow graph.
revoke execute on function _is_mutual_follow(uuid) from public, anon, authenticated;
revoke execute on function _can_tag(uuid)          from public, anon, authenticated;
