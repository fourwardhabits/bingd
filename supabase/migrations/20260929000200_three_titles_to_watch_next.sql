-- Three titles to watch next.
-- Specification: docs/product/recommendation-note-and-watch-next.md Part B (founder-approved
-- 2026-09-19: private in v1, exactly three, a separate table rather than a Watchlist column).
--
-- ===========================================================================
-- THE PROBLEM
--
-- A Watchlist that has grown past a screenful stops answering "what am I actually going to
-- watch next?". The answer is not a ranked queue of the whole list, and not a second list:
-- it is a mark on at most three of the titles already on it, drawn above the rest.
--
-- ===========================================================================
-- WHY A TABLE OF ITS OWN, AND WHY IT HANGS OFF `watchlist`
--
-- `watchlist` is profile content: `watchlist_read` is `can_i_view(user_id)` since
-- 20260820000200, so anybody who can see a profile can read every column of it. A private
-- flag there would mean narrowing the table's select grant to a column list — on a table the
-- profile shelf, Group Picks (an invoker RPC), the Feed's saved sets and the importer all
-- read. A separate owner-only table touches none of that.
--
-- The foreign key is the other half of the reason. Watch next is a subset of the Watchlist
-- **by construction**: `(user_id, media_item_id) references watchlist ... on delete cascade`.
-- Every path that removes a Watchlist row therefore removes its pin, in the same statement,
-- with no trigger to maintain and nothing for a future writer to remember:
--
--   * `set_watchlist(present => false)` — unsaving;
--   * `_leave_watchlist` (20260815040000) — the title was watched or ranked;
--   * `_leave_series_watchlist` (20260906000100) — every released season is done;
--   * account deletion and catalogue deletion — `watchlist`'s own cascades.
--
-- Referential actions run as the table owner and are not subject to RLS, so the cascade
-- fires whoever deleted the Watchlist row. That is the behaviour wanted, not a hole: the
-- only rows it can reach are the pins on the row being deleted.
--
-- The reverse direction does not exist: unlogging does not restore a Watchlist row
-- (20260815040000's deliberate one-way rule), so it does not restore a pin either.
--
-- ===========================================================================
-- THE CAP IS STRUCTURAL
--
-- `slot between 1 and 3` and `unique (user_id, slot)` together mean a fourth row cannot
-- exist, whichever writer tries. One account's calls are also serialised, so that two
-- simultaneous pins get clean answers — one `ok`, one `full` — rather than a 23505; see
-- LOCKS below for which lock does it. The constraints are what hold if a future writer
-- forgets every lock.
--
-- The number three is written into the check on purpose. It is the width of the poster
-- wall — one full row — and a founder decision, not a tuning value.
--
-- ===========================================================================
-- WHAT IS DELIBERATELY NOT HERE
--
-- No feed event, no notification, no award, and no read by anybody but the owner. No
-- manual reordering: a pin takes the lowest free slot and a replacement takes the slot of
-- what it replaced. Nothing here is visible on a profile — that would be a policy change
-- (`can_i_view(user_id)`) and a separate decision.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table watch_next (
  user_id       uuid        not null,
  media_item_id uuid        not null,
  slot          smallint    not null,
  created_at    timestamptz not null default now(),

  constraint watch_next_pkey primary key (user_id, media_item_id),
  constraint watch_next_slot_range check (slot between 1 and 3),
  constraint watch_next_one_per_slot unique (user_id, slot),
  constraint watch_next_on_watchlist foreign key (user_id, media_item_id)
    references watchlist (user_id, media_item_id) on delete cascade
);

comment on table watch_next is
  'At most three of an account''s own Watchlist titles, marked to watch next (20260929000200). Private to the owner. A subset of watchlist by foreign key, so every path that removes a Watchlist row removes its pin. The cap is structural: slot is 1..3 and unique per account. Written only by set_watch_next; no feed event, no notification.';

comment on column watch_next.slot is
  'Display order, 1 first. A new pin takes the lowest free slot; a replacement takes the slot of the title it replaced. Gaps are allowed and are filled by the next pin.';

alter table watch_next enable row level security;

create policy watch_next_own on watch_next for select
  using (user_id = auth.uid());

-- Stated rather than inherited: no client role writes this table (AD-4), anon reads
-- nothing, and the owner reads their own rows through the policy above.
revoke all on watch_next from anon, authenticated;
grant select on watch_next to authenticated;


-- ---------------------------------------------------------------------------
-- 2. The one writer
--
--   set_watch_next(op, title, present)                → pin or unpin
--   set_watch_next(op, title, true, replacing)        → swap, keeping the slot
--
-- Returns `{status: 'ok', pinned: [ids in slot order]}`, so the client can set its cache
-- from the reply, or a refusal:
--
--   not_on_watchlist   the title is not (or is no longer) on the caller's Watchlist
--   full               three are pinned and no replacement was named; carries `pinned`,
--                      so a client whose cache was stale can still draw the picker
--
-- Refusals are returned rather than raised, for the reason every writer here does it
-- (20260817001300): a raise would roll back the operation claim and make refused attempts
-- free against the rate limit.
--
-- IDEMPOTENCY
--
-- The operation ledger makes a replay `already_applied`. Beyond that the writer is
-- idempotent by state: pinning a pinned title and unpinning an unpinned one are both `ok`
-- and change nothing, so a lost reply retried under a fresh id is harmless too.
--
-- LOCKS, AND WHY THIS CANNOT DEADLOCK WITH THE WATCHLIST WRITERS
--
-- In order: `_assert_operation_rate`'s per-account key for `set_watch_next`, then the
-- account's own `watch-next:` key, then `for key share` on the Watchlist row being pinned,
-- then row locks on `watch_next`.
--
-- The first of those is what actually serialises one account's calls today: the rate
-- limiter takes an advisory lock per (account, kind) and holds it to commit, so a second
-- call waits there before it reaches anything else (`races/watch-next.mjs` WN1 observes
-- exactly that, as `races/recommendation.mjs` C1 does for sends). The `watch-next:` key
-- is kept anyway, so the right answer does not depend on how another function is
-- implemented; neither key is taken by anything that also locks a Watchlist row.
--
-- `for key share` is what makes the membership test and the insert
-- one fact: a concurrent delete of that Watchlist row either commits first (and this
-- finds nothing, and refuses) or waits for this to commit (and then cascades this very
-- pin away) — the row cannot vanish between the check and the foreign-key test.
--
-- A Watchlist writer holds, at most, row locks on Watchlist rows and — in the series
-- trigger — the `series-watchlist:` key, and its cascade then wants row locks on
-- `watch_next`. This function waits on a Watchlist row only *before* it has locked any
-- `watch_next` row, and never wants the series key, so no cycle can form.
-- `concurrency/races/watch-next.mjs` holds the line.
-- ---------------------------------------------------------------------------

-- The pins, in slot order, as the jsonb array every reply carries.
create or replace function _watch_next_pinned(p_user uuid)
returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(w.media_item_id order by w.slot), '[]'::jsonb)
    from public.watch_next w
   where w.user_id = p_user;
$$;

comment on function _watch_next_pinned(uuid) is
  'One account''s Watch next titles in slot order, as a jsonb array. Internal to set_watch_next, which only ever passes auth.uid() (20260929000200).';

revoke execute on function _watch_next_pinned(uuid) from public, anon, authenticated;

insert into app_config (key, value)
values ('watch_next.max_per_day', '200'::jsonb)
on conflict (key) do nothing;

create or replace function set_watch_next(
  p_operation_id          uuid,
  p_media_item_id         uuid,
  p_present               boolean,
  p_replace_media_item_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_slot     smallint;
  v_replaced boolean := false;
begin
  perform assert_can_write();

  if p_present is null or p_media_item_id is null then
    raise exception 'a title and present are required' using errcode = '22023';
  end if;

  if not _claim_operation(p_operation_id, 'set_watch_next') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_watch_next', 'watch_next.max_per_day', 200);

  perform pg_advisory_xact_lock(hashtextextended('watch-next:' || v_user::text, 0));

  if not p_present then
    delete from public.watch_next
     where user_id = v_user and media_item_id = p_media_item_id;

    return jsonb_build_object('status', 'ok', 'pinned', _watch_next_pinned(v_user));
  end if;

  -- Already pinned: nothing to do, and a replacement named alongside it is ignored rather
  -- than obeyed — unpinning something because the title the caller asked for was already
  -- there would be a write nobody asked for.
  if exists (
    select 1 from public.watch_next
     where user_id = v_user and media_item_id = p_media_item_id
  ) then
    return jsonb_build_object('status', 'ok', 'pinned', _watch_next_pinned(v_user));
  end if;

  -- Membership, locked. See LOCKS above: this is what stops the Watchlist row vanishing
  -- between here and the insert.
  perform 1 from public.watchlist
   where user_id = v_user and media_item_id = p_media_item_id
     for key share;

  if not found then
    return jsonb_build_object('status', 'refused', 'reason', 'not_on_watchlist');
  end if;

  if p_replace_media_item_id is not null then
    delete from public.watch_next
     where user_id = v_user and media_item_id = p_replace_media_item_id
    returning slot into v_slot;
    v_replaced := v_slot is not null;
  end if;

  if v_slot is null then
    select s.n into v_slot
      from generate_series(1, 3) as s(n)
     where not exists (
       select 1 from public.watch_next w where w.user_id = v_user and w.slot = s.n
     )
     order by s.n
     limit 1;
  end if;

  if v_slot is null then
    return jsonb_build_object(
      'status', 'refused',
      'reason', 'full',
      'pinned', _watch_next_pinned(v_user)
    );
  end if;

  insert into public.watch_next (user_id, media_item_id, slot)
  values (v_user, p_media_item_id, v_slot);

  return jsonb_build_object(
    'status', 'ok',
    'replaced', v_replaced,
    'pinned', _watch_next_pinned(v_user)
  );
end;
$$;

comment on function set_watch_next(uuid, uuid, boolean, uuid) is
  'Pins or unpins one of the caller''s own Watchlist titles as Watch next, or swaps one pin for another keeping its slot (20260929000200). At most three, structurally. Refuses a title not on the Watchlist (not_on_watchlist) and a fourth pin with no replacement named (full, carrying the current pins). Refusals are returned so they still cost a rate-limit slot. Serialised per account on the watch-next advisory key and holds the Watchlist row with for key share, so a concurrent unsave either wins outright or cascades the new pin away. Writes no feed event and no notification. Idempotent by the operation ledger and by state.';

revoke execute on function set_watch_next(uuid, uuid, boolean, uuid) from public, anon;
grant execute on function set_watch_next(uuid, uuid, boolean, uuid) to authenticated;
