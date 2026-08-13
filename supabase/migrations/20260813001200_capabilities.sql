-- Capabilities.
-- Specification: docs/architecture/data-model.md §10 · AD-9 · PRD §20
--
-- Capabilities are named permissions decoupled from billing. v1 contains no
-- billing code, no store product, and no price: `base_free` is everyone, and
-- `alpha_early_access` is a time-boxed grant.

create table capability_grants (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  capability text not null,
  source     capability_source not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create index capability_grants_live on capability_grants (user_id)
  where revoked_at is null;

-- PRD §20's "grants cannot silently become permanent" requirement, made
-- structural: a grant of alpha_early_access without an expiry cannot be inserted.
alter table capability_grants add constraint early_access_must_expire
  check (source <> 'alpha_early_access' or expires_at is not null);

-- ---------------------------------------------------------------------------
-- Every insert-path RPC that guards a limit calls this.
--
-- Per AD-9, no delete path and no read policy calls it, which is what makes the
-- destructive over-limit case structurally impossible: a capability limit can
-- refuse a new row, but it has no reach over rows that already exist.
-- ---------------------------------------------------------------------------

create or replace function resolve_capabilities(target uuid)
returns text[]
language sql stable security definer
set search_path = public
as $$
  select array_agg(distinct capability) from (
    select 'base_free'::text as capability
    union
    select capability from capability_grants
     where user_id = target
       and revoked_at is null
       and (expires_at is null or expires_at > now())
  ) c;
$$;

alter table capability_grants enable row level security;

create policy capability_grants_own on capability_grants for select
  using (user_id = auth.uid());
