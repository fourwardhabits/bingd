-- Data integrity corrections.
-- Specification: docs/architecture/data-model.md §15 · decision-log.md §5 · PRD §14
--
-- Five defects found by independent review on 2026-08-13. None changes product
-- behaviour the PRD defines; each makes the schema do what the PRD already said
-- it did. All are cheap now and range from expensive to impossible to correct
-- once real accounts exist.

-- ---------------------------------------------------------------------------
-- 1. A released username could be claimed by somebody else
--
-- Two separate failures reaching the same outcome, which is the impersonation
-- vector INF-2 exists to prevent.
--
-- The first: `username_history.profile_id` cascaded on delete, so deleting an
-- account destroyed its redirect rows *and* removed the live name from
-- `profiles`. The name was immediately free, and every `bingd.app/u/<name>` link
-- ever shared pointed at whoever took it next.
--
-- The second is the one that matters more, because the documentation claimed it
-- was already handled. `username_history` was described as blocking reuse
-- permanently via its primary key. **It does not.** That key is unique within
-- `username_history`; nothing connects it to `profiles.username`, so a new
-- account could take a retired name while the history row sat there
-- untouched. A guarantee asserted in a comment and enforced nowhere.
--
-- So: the name is reserved on delete, and reservation is enforced against
-- profile writes rather than merely recorded.
-- ---------------------------------------------------------------------------

alter table username_history alter column profile_id drop not null;

alter table username_history
  drop constraint username_history_profile_id_fkey;

alter table username_history
  add constraint username_history_profile_id_fkey
  foreign key (profile_id) references profiles(id) on delete set null;

comment on column username_history.profile_id is
  'Null means the owning account was deleted. The row is then a permanent reservation rather than a redirect, and carries no target.';

create or replace function reserve_username_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Stop redirecting this account's earlier names. A redirect to a profile that
  -- no longer exists is worse than a dead link.
  update username_history
     set redirect_until = now()
   where profile_id = old.id;

  -- Reserve the live name, with no redirect window: there is nothing to redirect
  -- to. The reservation is what stops reuse.
  insert into username_history (username, profile_id, released_at, redirect_until)
  values (old.username, null, now(), now())
  on conflict (username) do update
     set profile_id     = null,
         released_at    = now(),
         redirect_until = now();

  return old;
end;
$$;

-- BEFORE DELETE so old.username is still readable, and so it fires whether the
-- delete arrives through an account-deletion RPC or through the auth.users
-- cascade.
create trigger profiles_reserve_username_on_delete
  before delete on profiles
  for each row execute function reserve_username_on_profile_delete();

-- The enforcement the comment previously only promised. A username that belongs
-- to somebody else's history cannot be taken, whether by a new account or by an
-- existing one changing its name.
create or replace function assert_username_available()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from username_history h
     where h.username = new.username
       and (h.profile_id is null or h.profile_id <> new.id)
  ) then
    raise exception 'username % is reserved', new.username
      using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger profiles_username_not_reserved
  before insert or update of username on profiles
  for each row execute function assert_username_available();

-- ---------------------------------------------------------------------------
-- 2. Growth provenance was destroyed by the inviter leaving
--
-- `invite_attributions.inviter_id` cascaded on delete, so an inviter deleting
-- their account took the invitee's attribution row and its `activated_at` with
-- it. Decision log §5 marks growth provenance Required, "impossible to
-- reconstruct later", "Never remove" — so the cascade broke the one rule this
-- table exists to satisfy.
--
-- Detaching keeps the fact and the timestamp while dropping the departed
-- account's identity, which is also the better privacy answer.
-- `profiles.invited_by` already behaves this way, so this is a consistency fix
-- as much as a correctness one.
-- ---------------------------------------------------------------------------

alter table invite_attributions alter column inviter_id drop not null;

alter table invite_attributions
  drop constraint invite_attributions_inviter_id_fkey;

alter table invite_attributions
  add constraint invite_attributions_inviter_id_fkey
  foreign key (inviter_id) references profiles(id) on delete set null;

comment on column invite_attributions.inviter_id is
  'Null means the inviter deleted their account. The attribution and activation facts are retained; the identity is not.';

-- ---------------------------------------------------------------------------
-- 3. updated_at was set once and never advanced
--
-- `user_media` and `ranking_sessions` both default `updated_at` to now() on
-- insert and then never touch it. offline-sync.md §5 promises that a note edited
-- offline, when the server copy has also changed, produces a visible choice
-- rather than a silent overwrite — and that is undetectable without a
-- trustworthy server-side version. The documented behaviour was
-- unimplementable, which is a worse state than being unimplemented, because the
-- document reads as though it were done.
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger user_media_touch_updated_at
  before update on user_media
  for each row execute function touch_updated_at();

create trigger ranking_sessions_touch_updated_at
  before update on ranking_sessions
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. reactions.kind accepted any string
--
-- PRD §14's guarantee that reactions carry no moderation surface rests on the
-- column being closed. A `text` column accepting anything *is* a free-text
-- field, whatever a well-behaved client happens to send — and a modified client
-- is the case the guarantee exists for.
--
-- The set is a founder decision of 2026-08-13 (PRD §14). Values are stored as
-- meanings rather than glyph names — `agree`, not `thumbs_up` — for the same
-- reason `taste_bucket` stores `loved` rather than 'Loved it': which symbol
-- renders is a design decision, and swapping a thumb for a face should never be
-- a data migration.
--
-- `disagree` is included. An earlier inference left it out on the grounds that a
-- downvote counter is a pile-on mechanic, which is true of a public network and
-- not of a cohort of friends where arguing about a ranking is the point. The
-- safeguard lives in the read path instead: no query aggregates reactions onto a
-- profile, so `disagree` is countable on the activity item and nowhere else.
-- ---------------------------------------------------------------------------

alter table reactions
  add constraint reactions_known_kind
  check (kind in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved'));

-- ---------------------------------------------------------------------------
-- 5. Provider metadata had no expiry path
--
-- `media_cache` carries `expires_at` per facet, but `media_items` — title,
-- overview, poster path, genres, the bulk of the provider-derived data — carried
-- only `fetched_at`, with no index and nothing able to find stale rows. A title
-- sitting in somebody's ranking, untouched for seven months, was retained
-- provider data that no job could locate.
--
-- This is more than tidiness. Complying with the six-month limit is
-- load-bearing in the decision to connect on a free developer key rather than
-- treat provider licensing as a gate (docs/reference/tmdb-integration.md).
--
-- The view lists rows past the configured age that are *still referenced* by a
-- user's collection. Unreferenced rows need no refresh and can be pruned, which
-- reaches the same compliance more cheaply.
--
-- Two things about the view that will otherwise cost somebody an afternoon.
-- `security_invoker` is required: without it the view runs as its owner and
-- bypasses RLS on `user_media`, publishing which titles sit in whose collection
-- to anyone who selects from it. And because `app_config`'s read policy exposes
-- only `public.%` keys, the threshold subquery returns null for an ordinary
-- client and the view returns nothing at all. The refresh job runs as
-- `service_role`, which bypasses RLS and sees everything. That split is
-- intended.
-- ---------------------------------------------------------------------------

create index media_items_refresh on media_items (fetched_at);

create view media_refresh_due with (security_invoker = true) as
select mi.id,
       mi.kind,
       mi.tmdb_id,
       mi.parent_id,
       mi.fetched_at
  from media_items mi
 where mi.tmdb_id is not null
   and mi.fetched_at <
       now() - (((select value #>> '{}' from app_config
                   where key = 'tmdb.metadata_max_age_days')::integer)
                * interval '1 day')
   and (   exists (select 1 from user_media  um where um.media_item_id = mi.id)
        or exists (select 1 from rankings    r  where r.media_item_id  = mi.id)
        or exists (select 1 from watchlist   w  where w.media_item_id  = mi.id)
        or exists (select 1 from list_items  li where li.media_item_id = mi.id)
        or exists (select 1 from media_items s  where s.parent_id      = mi.id));

comment on view media_refresh_due is
  'Provider-derived rows past the retention window that a user collection still references. Drained by the tmdb-adapter refresh job, which runs as service_role.';
