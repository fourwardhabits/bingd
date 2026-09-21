-- The #196 founder-QA pass, 2026-09-21. Forward-only, additive, staging first.
--
-- `20261013000100` belongs to #197 (Refine) and is deliberately skipped: this file was
-- numbered after checking every open PR, every remote branch, staging (head
-- 20261012000100) and production (head 20261002000100).
--
-- Three things, each of which an installed client neither reads nor is broken by:
--
--   1. **Goals could not load at all on the new client** — the release blocker.
--   2. **A watch gets its own details**: a note and who it was watched with.
--   3. **A historical feed post keeps the score of its own watch**, rather than every post
--      about a title turning into the latest score the moment it is re-ranked.

-- ===========================================================================
-- 1. THE RELEASE BLOCKER: "Could not load your goals"
--
-- The T4 client reads the goal from `watch_events` with an embed:
--
--     watch_events?select=id,media_item_id,watched_on,media_items!inner(kind,title,poster_path)
--
-- PostgREST can only embed along a foreign key, and `watch_events` has one — the composite
-- key to `user_media` — but none to `media_items`. Staging answered every such read with
--
--     400 PGRST200 "Could not find a relationship between 'watch_events' and 'media_items'"
--
-- which the screen correctly reported as a failure. It had nothing to do with the goal
-- flag: the new client reads `watch_events` whatever the flag says. Installed clients read
-- `user_media` and were never affected. The unit tests mock Supabase and so could not see a
-- missing relationship; `supabase/tests/client-embeds.test.mjs` now checks every embed the
-- client source makes against the schema.
--
-- Every existing row already satisfies the key (a watch event references a `user_media`
-- row, which references `media_items`), so it validates. `on delete cascade` matches the
-- path the row already takes through `user_media`, and the index is the referencing-side
-- index every cascade in this schema is given (20261011000100's lesson).
-- ===========================================================================

alter table watch_events
  add constraint watch_events_media_item_fk
  foreign key (media_item_id) references media_items (id) on delete cascade;

create index if not exists watch_events_media_item on watch_events (media_item_id);

-- ===========================================================================
-- 2. A WATCH GETS ITS OWN DETAILS
--
-- Founder QA: each viewing should carry its own date, who it was watched with, and a note,
-- beside the placement it led to.
--
-- **Private, like the date.** `watch_events` is owner-only at every profile visibility
-- (PRD §22 — a public profile publishes a ranking, never a diary), and a viewing's note and
-- companions are part of the same diary. So they are readable by the owner and nobody else,
-- including the companions themselves, and they reach no feed, profile or web surface.
--
-- **The title-level note is not moved.** `user_media.note` is the review — it can be
-- public, it has spoiler and helpful semantics, and nothing proves which viewing a note
-- written months ago belongs to. It stays exactly where it is, the first-log sheet keeps
-- writing it, and an installed client keeps reading it. Likewise `watch_tags` keeps its
-- social meaning (the tagged person is told, the feed says "with …"). These columns are new
-- facts about new viewings; nothing old is re-attributed.
-- ===========================================================================

alter table watch_events
  add column if not exists note text;

alter table watch_events
  drop constraint if exists watch_events_note_length;
alter table watch_events
  add constraint watch_events_note_length
  check (note is null or char_length(note) <= 1000);

create table if not exists watch_event_companions (
  watch_event_id uuid not null references watch_events (id) on delete cascade,
  companion_id   uuid not null references profiles (id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (watch_event_id, companion_id)
);

-- The referencing side of the profile cascade, so deleting an account does not scan this
-- table per row.
create index if not exists watch_event_companions_companion
  on watch_event_companions (companion_id);

alter table watch_event_companions enable row level security;

-- Owner-only, through the viewing it belongs to. No write policy: the writers below are the
-- only way in, as for `watch_events` itself.
drop policy if exists watch_event_companions_own on watch_event_companions;
create policy watch_event_companions_own on watch_event_companions for select
  using (exists (
    select 1 from watch_events we
     where we.id = watch_event_id and we.user_id = auth.uid()
  ));

revoke insert, update, delete on watch_event_companions from anon, authenticated;
grant select on watch_event_companions to authenticated;

/**
 * Replaces one viewing's note and companions. Internal: both public writers below have
 * already established that the caller owns the viewing.
 *
 * Companions follow the tagging rule `set_watch_tags` has used since 20260817001300 — a
 * person may be added only if `_can_tag` (a mutual follow, no block), and one already on
 * this viewing stays, so a narrowed rule cannot strand an existing list — with the same
 * pair locks in uuid order and the same `watch_tags.max_per_watch` ceiling. Unlike a title
 * tag it tells nobody: this is a private diary line, not an announcement.
 */
create or replace function _apply_watch_details(
  p_watch_event_id uuid,
  p_note           text,
  p_companion_ids  uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wanted uuid[];
  v_max    integer;
  v_target uuid;
  v_bad    uuid;
begin
  update watch_events
     set note = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at = now()
   where id = p_watch_event_id;

  -- Null means "leave the companions alone"; an empty array clears them.
  if p_companion_ids is null then
    return;
  end if;

  select coalesce(array_agg(distinct w.uid), '{}') into v_wanted
    from unnest(p_companion_ids) as w(uid)
   where w.uid is not null and w.uid <> auth.uid();

  select coalesce((select (value)::integer from app_config
                    where key = 'watch_tags.max_per_watch'), 10)
    into v_max;

  if coalesce(array_length(v_wanted, 1), 0) > v_max then
    raise exception 'you can add up to % people to one watch', v_max using errcode = '22023';
  end if;

  for v_target in select u from unnest(v_wanted) as t(u) order by u loop
    perform _lock_pair(auth.uid(), v_target);
  end loop;

  select w.uid into v_bad
    from unnest(v_wanted) as w(uid)
   where not _can_tag(w.uid)
     and not exists (
       select 1 from watch_event_companions c
        where c.watch_event_id = p_watch_event_id and c.companion_id = w.uid
     )
   limit 1;

  if v_bad is not null then
    raise exception 'you can only add people who follow you back' using errcode = '42501';
  end if;

  delete from watch_event_companions
   where watch_event_id = p_watch_event_id
     and companion_id <> all (v_wanted);

  insert into watch_event_companions (watch_event_id, companion_id)
  select p_watch_event_id, u from unnest(v_wanted) as t(u)
  on conflict do nothing;
end;
$$;

revoke execute on function _apply_watch_details(uuid, text, uuid[]) from public, anon, authenticated;

/**
 * *Log another watch*, with the viewing's own details, in one transaction.
 *
 * `log_rewatch` does everything it always did — the event, its basis, the cache, the feed
 * post for a contemporaneous viewing — and this adds the note and companions to the event
 * it returns. One call, so a viewing is never saved without the details the reader typed.
 * A replay with the same operation id is answered by `log_rewatch`'s own ledger and the
 * details are re-applied idempotently.
 */
create or replace function log_rewatch_with_details(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_watched_on    date,
  p_basis         watch_date_basis,
  p_note          text default null,
  p_companion_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_event  uuid;
begin
  -- log_rewatch calls the guard too; calling it here as well keeps this writer honest on
  -- its own (moderation.test.mjs reads each client-callable body for it).
  perform assert_can_write();
  v_result := log_rewatch(p_operation_id, p_media_item_id, p_watched_on, p_basis);
  v_event := nullif(v_result ->> 'watch_event_id', '')::uuid;

  if v_event is not null
     and exists (select 1 from watch_events we
                  where we.id = v_event and we.user_id = auth.uid()) then
    perform _apply_watch_details(v_event, p_note, p_companion_ids);
  end if;

  return v_result;
end;
$$;

grant execute on function log_rewatch_with_details(uuid, uuid, date, watch_date_basis, text, uuid[])
  to authenticated;

/** The edit pencil on a Watch History row: one viewing's note and companions. */
create or replace function set_watch_details(
  p_operation_id   uuid,
  p_watch_event_id uuid,
  p_note           text,
  p_companion_ids  uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_watch_details') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if not exists (select 1 from watch_events we
                  where we.id = p_watch_event_id and we.user_id = auth.uid()) then
    raise exception 'no such watch' using errcode = 'P0002';
  end if;

  perform _apply_watch_details(p_watch_event_id, p_note, p_companion_ids);
  return jsonb_build_object('status', 'ok');
end;
$$;

grant execute on function set_watch_details(uuid, uuid, text, uuid[]) to authenticated;

-- ===========================================================================
-- 3. A HISTORICAL POST KEEPS ITS OWN WATCH'S SCORE
--
-- 20261002000100 made a feed card show the score its owner holds *now*, which is right for
-- one viewing: a correction should reflow. It is wrong for two. Watch Heat (8.0), watch it
-- again and re-rank it (8.5), and both posts read 8.5 — the first one now claims a score
-- that did not exist when it was posted.
--
-- The placement ledger already records the score shown at every placement and, for a
-- rewatch, which viewing it came from. So a post's score is the latest placement **of its
-- own viewing's span** — its viewing's placements, and any correction made before the next
-- viewing was logged (a correction with no watch of its own amends the latest viewing, which
-- is the founder's rule for Watch History too):
--
--   rewatch post (payload.watch_event_id = W)
--       the latest placement tied to W, or made after W and before the next viewing; if W
--       was never re-ranked, the placement it carried forward.
--   first / legacy post (no watch id)
--       the latest placement made before the NEXT viewing was logged.
--
-- Only a SUPERSEDED viewing's post is frozen. The latest viewing's post keeps the live score
-- (score and bucket come back null and the client keeps what `public_scores` drew), so a
-- correction still reflows the current card exactly as 20261002000100 decided; it is the
-- older cards that stop moving. `watch_number` comes back for every mapped post so the card
-- can say "2nd watch".
--
-- Rows come back only for titles with two or more viewings and a post that maps to one; a
-- single-viewing title's live score IS its viewing's score, and a legacy post that maps to
-- nothing keeps the live score the client already draws — the safe fallback. Only the score
-- and band leave the function: no position, no movement, nothing from the ledger that §K
-- keeps private. Visibility is the feed's own (`can_i_view` on the actor).
-- ===========================================================================

create or replace function _watch_span_placement(
  p_user     uuid,
  p_item     uuid,
  p_watch    uuid,
  p_from     timestamptz,
  p_until    timestamptz
)
returns table (score numeric, bucket taste_bucket)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select sp.score, sp.bucket
    from (
      -- The viewing's own span.
      select p.score, p.bucket, p.created_at, 1 as preference
        from ranking_placements p
       where p.user_id = p_user and p.media_item_id = p_item
         and (
           (p_watch is not null and p.watch_event_id = p_watch)
           or (p.watch_event_id is null
               and p.created_at >= coalesce(p_from, '-infinity'::timestamptz)
               and p.created_at <  coalesce(p_until, 'infinity'::timestamptz))
         )
      union all
      -- Carried forward: the placement it inherited when it was logged.
      select p.score, p.bucket, p.created_at, 2
        from ranking_placements p
       where p.user_id = p_user and p.media_item_id = p_item
         and p.created_at < coalesce(p_from, '-infinity'::timestamptz)
    ) sp
   order by sp.preference, sp.created_at desc
   limit 1;
$$;

revoke execute on function _watch_span_placement(uuid, uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;

create or replace function feed_watch_scores(p_event_ids uuid[])
returns table (
  event_id     uuid,
  score        numeric,
  bucket       taste_bucket,
  watch_number integer
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if p_event_ids is null then
    raise exception 'feed_watch_scores requires event ids' using errcode = '22023';
  end if;
  if coalesce(array_length(p_event_ids, 1), 0) > 50 then
    raise exception 'feed_watch_scores accepts at most 50 ids' using errcode = '22023';
  end if;

  return query
    with ev as (
      select fe.id, fe.actor_id, fe.media_item_id, fe.created_at,
             case when (fe.payload ->> 'watch_event_id') ~* '^[0-9a-f-]{36}$'
                  then (fe.payload ->> 'watch_event_id')::uuid end as payload_watch
        from feed_events fe
       where fe.id = any (p_event_ids)
         and fe.type = 'title_ranked'
         and fe.media_item_id is not null
         and can_i_view(fe.actor_id)
         and (select count(*) from watch_events w
               where w.user_id = fe.actor_id and w.media_item_id = fe.media_item_id) >= 2
    ),
    anchored as (
      select ev.*,
             w.id          as watch_id,
             w.recorded_at as watch_at,
             -- The next viewing logged after this post's viewing (or after the post, for a
             -- post that names no viewing).
             (select min(w2.recorded_at) from watch_events w2
               where w2.user_id = ev.actor_id and w2.media_item_id = ev.media_item_id
                 and w2.recorded_at > coalesce(w.recorded_at, ev.created_at)) as next_at
        from ev
        left join watch_events w
          on w.id = ev.payload_watch and w.user_id = ev.actor_id
    )
    select a.id,
           -- Frozen only once a later viewing exists; the latest viewing stays live.
           case when a.next_at is not null then sp.score end,
           case when a.next_at is not null then sp.bucket end,
           -- The viewing's ordinal in Watch History's own order (undated first, then by
           -- date, then by recording), so "2nd watch" on a card and on the history screen
           -- are the same number. Null for a post that names no viewing.
           (select o.n
              from (select w3.id,
                           row_number() over (
                             order by w3.watched_on nulls first, w3.recorded_at, w3.id
                           )::integer as n
                      from watch_events w3
                     where w3.user_id = a.actor_id and w3.media_item_id = a.media_item_id) o
             where o.id = a.watch_id)
      from anchored a
      left join lateral _watch_span_placement(
       a.actor_id, a.media_item_id, a.watch_id, a.watch_at, a.next_at) sp on true
     -- A post that names no viewing and has no later one keeps the live score: nothing
     -- has superseded its viewing, so the live score is its score.
     where a.watch_id is not null or a.next_at is not null;
end;
$$;

comment on function feed_watch_scores(uuid[]) is
  'For watch-backed title_ranked posts on titles with two or more viewings: the watch number, and — once a later viewing supersedes it — the score and band of the post''s OWN viewing, from the placement ledger (its placements, plus corrections made before the next viewing). The latest viewing''s score and band are null so the client keeps the live score. Returns no position or movement. Visibility is the feed''s own can_i_view.';

grant execute on function feed_watch_scores(uuid[]) to authenticated;

-- PostgREST learns about the new relationship and functions without a restart.
notify pgrst, 'reload schema';
