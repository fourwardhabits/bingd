-- A yearly watch goal, per medium.
-- Specification: founder decision 2026-08-16 -- "one row per (user_id, year, medium);
-- movies and TV goals are independently optional/editable".
--
-- ---------------------------------------------------------------------------
-- 1. Why absence is the only way to say "no goal"
--
-- The decision asks for movie and TV goals that are *independently* optional. The
-- shape that gets this for free is a row per (user, year, medium): a goal exists or
-- it does not, and setting one has no opinion about the other.
--
-- The alternative -- one row per (user, year) with `movie_target` and `tv_target`
-- nullable -- looks smaller and is worse. Two nullable columns make "no goal" and
-- "a goal I cleared" and "a row that exists because the other medium has a goal"
-- the same state, and every read then has to know that null means unset rather than
-- zero. Here the primary key carries that meaning and no column has to.
--
-- WHY ranking_category AND NOT A NEW `medium` TYPE
--
-- ('movies', 'tv_seasons') already exists and is already what this app means by
-- medium: it is the split rankings are kept in, the split the collection screen
-- filters by, and the split `rankable_category` maps a media kind onto. A parallel
-- enum with the same two members would be a second vocabulary for one distinction,
-- and the first screen showing a goal beside a ranked list would have to translate
-- between them.
--
-- The name is 'tv_seasons' rather than 'tv' and reads slightly oddly on a goal.
-- That is the correct cost to pay: the alternative is two enums that must be kept
-- in step by hand.
--
-- WHY THERE IS NO DEFAULT ROW
--
-- Nothing seeds a goal, and signup does not create one. A person who has never set
-- a goal has no rows, which is distinguishable from a person who set 50 and then
-- cleared it only by the absence of both -- and those are the same thing to every
-- surface that will read this.
-- ---------------------------------------------------------------------------

create table watch_goals (
  user_id    uuid             not null references profiles(id) on delete cascade,
  year       integer          not null,
  category   ranking_category not null,
  target     integer          not null,
  created_at timestamptz      not null default now(),
  updated_at timestamptz      not null default now(),
  primary key (user_id, year, category),

  -- A goal is a year somebody could plausibly be watching in. The bounds are wide
  -- on purpose -- they exist so the column cannot hold 0 or 20260816 after a client
  -- sends a date where a year was wanted, not to express a product rule.
  constraint watch_goals_year_sane   check (year between 1950 and 2200),

  -- Above zero because a goal of none is the same as no goal, and there is already
  -- a way to say that. The ceiling is a guard against a fat finger reaching a
  -- progress bar, not a judgement about how much anybody watches.
  constraint watch_goals_target_sane check (target between 1 and 10000)
);

-- No secondary index. The only read is "this person's goals", for one year or for
-- all of them, and the primary key leads on user_id -- so it already serves both.
-- A separate index on (user_id) would be a prefix of the key and never chosen.

-- ---------------------------------------------------------------------------
-- 2. Reading them
--
-- Own-only, which matches `user_media` rather than `rankings`.
--
-- The two are split in 20260813000500 on whether the data is a shareable surface:
-- a ranked position is public information on a public profile, and a note or a
-- watched_on date is always-private under PRD §22. A goal is neither, because no
-- specification has placed it anywhere yet. Private is the half of that choice
-- that can be widened later without having published anything first, so a goal is
-- the caller's own until a decision says otherwise.
--
-- Concretely: adding `or can_view_profile(...)` to this policy later is a
-- migration. Removing it after a year-in-review screen has shipped is a
-- disclosure.
-- ---------------------------------------------------------------------------

alter table watch_goals enable row level security;

create policy watch_goals_own on watch_goals for select
  using (user_id = auth.uid());

-- No insert, update or delete policy. Writes go through set_watch_goal below,
-- which is the pattern every other collection table follows: the table is
-- readable by its owner and writable only by a definer function, so the
-- invariants live in one place instead of in each client that writes.

create trigger watch_goals_touch_updated_at
  before update on watch_goals
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Setting, changing and clearing one
--
-- One entry point for all three, shaped like `set_reaction`: a null target clears,
-- idempotently, and the function is safe to call twice with the same arguments.
-- Three RPCs would have been three grants, three signatures pinned by
-- function-grants.test.mjs, and three chances for a client to invent a fourth
-- state by calling them in an order nobody tested.
--
-- No operation id. `_claim_operation` exists for writes that are not naturally
-- idempotent -- logging a watch, publishing a note, sending a notification -- where
-- a retried request must not produce a second effect. Setting a goal to 50 twice
-- leaves the goal at 50 and notifies nobody, so an operation id would buy a row in
-- `processed_operations` and nothing else.
--
-- assert_can_write, though, because a suspended account writes nothing (the guard
-- from 20260813001700, and the lesson recorded there about defining it and then
-- not calling it).
-- ---------------------------------------------------------------------------

create or replace function set_watch_goal(
  p_year     integer,
  p_category ranking_category,
  p_target   integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  perform assert_can_write();

  if p_target is null then
    delete from watch_goals
     where user_id = v_user and year = p_year and category = p_category;

    -- 'cleared' whether or not a row was there. The caller asked for "no goal for
    -- this medium this year" and that is now true; reporting the difference would
    -- only tell them about a race they cannot act on.
    return jsonb_build_object('status', 'cleared', 'year', p_year, 'category', p_category);
  end if;

  -- The check constraint would catch this, as a 23514 the client has to parse. A
  -- named error is what the constraint is for, said where the caller can act on it.
  if p_target < 1 or p_target > 10000 then
    raise exception 'a goal must be between 1 and 10000 titles'
      using errcode = '22023';
  end if;

  insert into watch_goals (user_id, year, category, target)
  values (v_user, p_year, p_category, p_target)
  on conflict (user_id, year, category)
  do update set target = excluded.target;

  return jsonb_build_object(
    'status', 'ok', 'year', p_year, 'category', p_category, 'target', p_target
  );
end;
$$;

comment on function set_watch_goal(integer, ranking_category, integer) is
  'Sets, changes or clears the caller''s watch goal for one year and one medium. A null target clears, idempotently. Movies and tv_seasons are independent rows, so setting one never disturbs the other.';

comment on table watch_goals is
  'A yearly watch target, one row per (user, year, medium). Absence is the only representation of "no goal" -- there is no null target and no seeded row. Own-read only until a decision places goals on a shareable surface.';

-- 20260813001800 made execute default-deny and 20260813002100 issued the global
-- form, so this grant restricts rather than expands.
grant execute on function set_watch_goal(integer, ranking_category, integer) to authenticated;
