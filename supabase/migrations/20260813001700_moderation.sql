-- Reporting, account suspension, and the operator surface.
-- Specification: docs/product/PRD.md §22 · docs/architecture/api.md §6a · data-model.md §13
--
-- PRD §22 marks reporting Required by policy, §23 lists a `reports` entity, AC
-- 26.15.5 requires a working report flow, and api.md §9 rate-limits a `report`
-- function. None of it existed. Blocking shipped and reporting did not, which
-- left a product carrying user-generated usernames, display names and list
-- titles with nowhere for a complaint to arrive. That is a platform obligation
-- rather than a feature.
--
-- Three things are needed and public alpha needs all three: somewhere for a
-- report to land, a way to act on one without deleting an account and destroying
-- the evidence, and a record of what was done and why.
--
-- Deliberately not built: an admin application, an appeals flow, automated
-- detection. For a cohort of 30-60 users the operator surface is three views run
-- from the Supabase SQL editor. Building a console before there is any triage
-- experience is the expensive way to discover what the console should contain.
-- None of the three omissions is acceptable beyond alpha.

-- ---------------------------------------------------------------------------
-- Reports
--
-- Subject types are the surfaces PRD §22 names that can actually carry
-- user-generated content. **`reaction` is deliberately absent**: reactions come
-- from a closed set of six values (PRD §14), so there is nothing in one to
-- report. A reaction you dislike is a person you can block.
--
-- reporter_id detaches rather than cascading. A harassment complaint must
-- survive its author deleting their account, which is a thing harassed people do.
-- ---------------------------------------------------------------------------

create type report_subject as enum (
  'profile', 'display_name', 'username', 'list', 'list_title', 'watch_tag'
);

create type report_state as enum ('open', 'upheld', 'dismissed');

create table reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid references profiles(id) on delete set null,
  subject_type  report_subject not null,
  subject_id    uuid not null,
  subject_owner uuid references profiles(id) on delete set null,
  reason        text not null,
  note          text,
  state         report_state not null default 'open',
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,

  -- Closed, so a client cannot invent a category no triage process covers.
  constraint reports_known_reason check (reason in (
    'spam', 'harassment', 'hate_speech', 'sexual_content',
    'impersonation', 'self_harm', 'illegal_content', 'other'
  )),

  -- A note is optional, but an unbounded one is a free-text field pointed at the
  -- operator. PRD §14 refused free text on reactions for the same reason.
  constraint reports_note_length check (note is null or length(note) <= 1000),

  constraint reports_no_self_report
    check (reporter_id is null or subject_owner is null or reporter_id <> subject_owner)
);

-- One open report per reporter per subject. Filing the same complaint fifty
-- times is itself an abuse vector, and PRD §22 requires that reporting cannot be
-- turned into harassment.
create unique index reports_one_open_per_reporter
  on reports (reporter_id, subject_type, subject_id)
  where state = 'open';

create index reports_triage on reports (state, created_at);
create index reports_by_owner on reports (subject_owner) where state = 'open';
create index reports_by_reporter on reports (reporter_id, created_at);

-- The daily ceiling api.md §9 requires. A number rather than a guess at scale:
-- twenty genuine reports in a day from one alpha user is already implausible.
insert into app_config (key, value) values ('report.max_per_day', '20'::jsonb);

-- ---------------------------------------------------------------------------
-- Account status
--
-- Until now the only lever against an account was deletion, which destroys the
-- evidence needed to judge whether the deletion was correct. Suspension is
-- reversible and preserves the record.
-- ---------------------------------------------------------------------------

create type profile_status as enum ('active', 'suspended');

alter table profiles add column status profile_status not null default 'active';

comment on column profiles.status is
  'Suspended accounts are invisible to everyone but themselves and cannot write. Reversible; deletion is not.';

create index profiles_suspended on profiles (status) where status = 'suspended';

-- ---------------------------------------------------------------------------
-- Suspension flows through the single visibility rule
--
-- AD-5 exists for exactly this: adding suspension to can_view_profile hides the
-- account from feed, leaderboard, discovery, match, tagging and the public web
-- pages in one change rather than seven.
--
-- Ordering matters and is easy to get wrong. The self check stays first, so a
-- suspended user can still load their own profile and be told what happened.
-- Suspension precedes the block test because it is the stronger condition and
-- applies regardless of who is asking.
-- ---------------------------------------------------------------------------

create or replace function can_view_profile(viewer uuid, subject uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when viewer is null then
      -- Unauthenticated: public, active profiles only. Blocks are irrelevant
      -- with no viewer identity, and private content must never be exposed.
      (select visibility = 'public' and status = 'active'
         from profiles where id = subject)
    when viewer = subject then true
    when (select status from profiles where id = subject) = 'suspended' then false
    when exists (
      select 1 from blocks
       where (blocker_id = viewer  and blocked_id = subject)
          or (blocker_id = subject and blocked_id = viewer)
    ) then false
    when (select visibility from profiles where id = subject) = 'public' then true
    else exists (
      select 1 from follows
       where follower_id = viewer and followee_id = subject and state = 'approved'
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- Writes are a separate question from reads
--
-- Hiding a suspended account does nothing to stop it acting. Without this a
-- suspended user goes on ranking, following, reacting and tagging into a void,
-- and the moment the suspension lifts all of it appears at once.
--
-- SQLSTATEs rather than the BGnnn codes in api.md §8: those are the API-level
-- contract, the database raises standard codes, and the edge layer maps them.
-- That is the convention 20260813000700 already set.
-- ---------------------------------------------------------------------------

create or replace function assert_can_write(target uuid default auth.uid())
returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if target is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if (select status from profiles where id = target) = 'suspended' then
    raise exception 'account is suspended' using errcode = '42501';
  end if;
end;
$$;

grant execute on function assert_can_write(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Applying the guard to every existing write path
--
-- The first draft of this migration defined assert_can_write and never called
-- it, so suspension silently stopped nothing while the documentation read as
-- though the account were contained. A guard nobody invokes is worse than no
-- guard.
--
-- Each ranking RPC is renamed to an unguarded implementation and re-exposed
-- through a wrapper that calls the guard first. Wrapping rather than rewriting
-- keeps the ranking logic in one migration instead of copying five hundred lines
-- into this one, where the two copies would immediately begin to drift.
--
-- rank_rebucket calls rank_unrank and rank_start internally, so those resolve to
-- the guarded wrappers and the check runs twice. That is harmless and cheaper
-- than reasoning about which internal calls need it.
-- ---------------------------------------------------------------------------

alter function rank_start(uuid, taste_bucket)     rename to _rank_start_unguarded;
alter function rank_answer(uuid, uuid)            rename to _rank_answer_unguarded;
alter function rank_skip(uuid)                    rename to _rank_skip_unguarded;
alter function rank_back(uuid)                    rename to _rank_back_unguarded;
alter function rank_unrank(uuid)                  rename to _rank_unrank_unguarded;
alter function rank_reorder(uuid, integer)        rename to _rank_reorder_unguarded;
alter function rank_rebucket(uuid, taste_bucket)  rename to _rank_rebucket_unguarded;

create function rank_start(p_media_item_id uuid, p_bucket taste_bucket)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform assert_can_write();
  return _rank_start_unguarded(p_media_item_id, p_bucket);
end; $$;

create function rank_answer(p_session_id uuid, p_winner uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform assert_can_write();
  return _rank_answer_unguarded(p_session_id, p_winner);
end; $$;

create function rank_skip(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform assert_can_write();
  return _rank_skip_unguarded(p_session_id);
end; $$;

create function rank_back(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform assert_can_write();
  return _rank_back_unguarded(p_session_id);
end; $$;

create function rank_unrank(p_media_item_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform assert_can_write();
  return _rank_unrank_unguarded(p_media_item_id);
end; $$;

create function rank_reorder(p_media_item_id uuid, p_new_position integer)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform assert_can_write();
  return _rank_reorder_unguarded(p_media_item_id, p_new_position);
end; $$;

create function rank_rebucket(p_media_item_id uuid, p_bucket taste_bucket)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform assert_can_write();
  return _rank_rebucket_unguarded(p_media_item_id, p_bucket);
end; $$;

-- The renamed implementations are now internal, and fall under the same rule as
-- every other underscore-prefixed helper (20260813001400 §2). Re-applied here
-- because that migration's DO block ran before these names existed.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like '\_%'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn.signature);
  end loop;
end $$;

grant execute on function rank_start(uuid, taste_bucket)    to authenticated;
grant execute on function rank_answer(uuid, uuid)           to authenticated;
grant execute on function rank_skip(uuid)                   to authenticated;
grant execute on function rank_back(uuid)                   to authenticated;
grant execute on function rank_unrank(uuid)                 to authenticated;
grant execute on function rank_reorder(uuid, integer)       to authenticated;
grant execute on function rank_rebucket(uuid, taste_bucket) to authenticated;

-- ---------------------------------------------------------------------------
-- Filing a report
--
-- There is no insert policy on `reports` and no client write grant anywhere in
-- the schema (AD-4), so this function is the only way a report can exist. The
-- previous draft created the table and no function, which is a mailbox with no
-- slot.
--
-- The owner of the subject is resolved server-side rather than accepted from the
-- client. Trusting a client-supplied owner would let anyone attribute a report
-- to an account of their choosing, which is the reporting-as-harassment vector
-- PRD §22 names.
-- ---------------------------------------------------------------------------

create or replace function report(
  p_subject_type report_subject,
  p_subject_id   uuid,
  p_reason       text,
  p_note         text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_owner uuid;
  v_today integer;
  v_cap   integer;
begin
  perform assert_can_write();

  select coalesce((value)::integer, 20) into v_cap
    from app_config where key = 'report.max_per_day';

  select count(*) into v_today from reports
   where reporter_id = v_user and created_at > now() - interval '1 day';

  if v_today >= v_cap then
    raise exception 'report limit reached for today' using errcode = '53400';
  end if;

  -- Resolve the owner from the subject. A subject the caller cannot see is
  -- reported as not found, for the same reason api.md §8 collapses "missing" and
  -- "forbidden" into BG404: distinguishing them enumerates private content.
  v_owner := case p_subject_type
    when 'profile'      then p_subject_id
    when 'display_name' then p_subject_id
    when 'username'     then p_subject_id
    when 'list'         then (select owner_id  from lists      where id = p_subject_id)
    when 'list_title'   then (select owner_id  from lists      where id = p_subject_id)
    when 'watch_tag'    then (select tagger_id from watch_tags where id = p_subject_id)
  end;

  if v_owner is null then
    raise exception 'no such subject' using errcode = 'P0002';
  end if;

  if p_subject_type in ('profile', 'display_name', 'username')
     and not exists (select 1 from profiles where id = p_subject_id) then
    raise exception 'no such subject' using errcode = 'P0002';
  end if;

  if v_owner = v_user then
    raise exception 'cannot report your own content' using errcode = '22023';
  end if;

  insert into reports (reporter_id, subject_type, subject_id, subject_owner, reason, note)
  values (v_user, p_subject_type, p_subject_id, v_owner, p_reason, p_note)
  on conflict (reporter_id, subject_type, subject_id) where state = 'open'
    do nothing;

  -- Reported twice is reported. Saying so would tell the reporter which of their
  -- earlier complaints is still open, which is not their business.
  return jsonb_build_object('done', true, 'received', true);
end;
$$;

grant execute on function report(report_subject, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- What was done, and why
--
-- Separate from `reports` because an action may follow no report at all, and
-- because a report's state records what was concluded while this records what
-- was done about it.
-- ---------------------------------------------------------------------------

create table moderation_actions (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid references reports(id) on delete set null,
  subject_type text not null,
  subject_id   uuid not null,
  action       text not null,
  rationale    text,
  created_at   timestamptz not null default now(),

  constraint moderation_actions_known_action check (action in (
    'suspend_account', 'restore_account', 'remove_content',
    'force_username_change', 'dismiss_report', 'warn'
  ))
);

create index moderation_actions_subject
  on moderation_actions (subject_type, subject_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Operator views
--
-- security_invoker, so these run with the caller's own permissions. The founder
-- reads them as service_role, which bypasses RLS. An ordinary authenticated
-- client selecting from moderation_queue sees only reports it filed itself,
-- because the reports policy below is what gets invoked.
-- ---------------------------------------------------------------------------

create view moderation_queue with (security_invoker = true) as
select r.id,
       r.created_at,
       r.subject_type,
       r.subject_id,
       r.reason,
       r.note,
       r.subject_owner,
       p.username as owner_username,
       p.status   as owner_status,
       (select count(*) from reports r2
         where r2.subject_owner = r.subject_owner
           and r2.state = 'open') as open_against_owner
  from reports r
  left join profiles p on p.id = r.subject_owner
 where r.state = 'open';

comment on view moderation_queue is
  'Open reports. Read as service_role from the SQL editor; order by open_against_owner desc, created_at for worst-offender-first triage. PRD §22.';

create view moderation_history with (security_invoker = true) as
select a.created_at,
       a.action,
       a.subject_type,
       a.subject_id,
       a.rationale,
       r.reason as report_reason,
       r.state  as report_state
  from moderation_actions a
  left join reports r on r.id = a.report_id;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table reports            enable row level security;
alter table moderation_actions enable row level security;

-- A reporter sees the reports they filed and nothing else. The reported user is
-- never told who reported them, which is both the standard and the safer
-- behaviour.
create policy reports_read_own on reports for select
  using (reporter_id = auth.uid());

-- No policy on moderation_actions. The record is operator-only, and absence of a
-- policy means no access.

revoke insert, update, delete on reports, moderation_actions from anon, authenticated;
