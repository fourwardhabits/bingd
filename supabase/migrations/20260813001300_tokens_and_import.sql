-- Invitations, share tokens, and Letterboxd import staging.
-- Specification: docs/architecture/data-model.md §11 · PRD §12, §16, §17

-- env prevents a nonprod token resolving in production (PRD §17).
create table invite_tokens (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references profiles(id) on delete cascade,
  token      text not null unique,
  short_code text not null unique,
  env        text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Enforces PRD §17's one reusable personal link per user. Regenerating revokes
-- the old row and inserts a new one; the index permits any number of revoked rows
-- and exactly one live one.
create unique index invite_tokens_one_live on invite_tokens (owner_id)
  where revoked_at is null;

-- Keyed by invitee because a person is invited once. activated_at is set when the
-- invitee ranks their first title, which makes the invite-to-activation metric in
-- PRD §28 a single query — and would make any future reward farm-resistant.
create table invite_attributions (
  invitee_id   uuid primary key references profiles(id) on delete cascade,
  inviter_id   uuid not null references profiles(id) on delete cascade,
  token_id     uuid references invite_tokens(id) on delete set null,
  accepted_at  timestamptz,
  activated_at timestamptz,
  constraint no_self_invite check (invitee_id <> inviter_id)
);

create index invite_attributions_inviter on invite_attributions (inviter_id);

-- A share token resolves to an object reference and nothing more. The resolver
-- returns (object_type, object_id); the caller then applies normal visibility
-- rules to that object.
--
-- There is no code path where holding a token produces content, which is how PRD
-- §16's "a token is never authorization" becomes structural rather than
-- aspirational.
create table share_tokens (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  token       text not null unique,
  object_type text not null,
  object_id   uuid not null,
  env         text not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  constraint share_tokens_known_object
    check (object_type in ('top_set', 'profile', 'list', 'title_placement'))
);

create index share_tokens_owner on share_tokens (owner_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Import staging (PRD §12)
--
-- import_rows exists so the mandatory preview can be produced, reviewed, and
-- resolved *before* anything is written to the user's collection.
--
-- storage_path is nulled when the job completes, and the uploaded file deleted.
--
-- Idempotent re-upload comes from the apply step upserting into user_media on its
-- primary key: re-running an import changes nothing that is already correct.
-- ---------------------------------------------------------------------------

create table import_jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  status       text not null default 'pending',
  storage_path text,
  counts       jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  constraint import_jobs_known_status
    check (status in ('pending', 'parsing', 'matching', 'preview', 'applying', 'done', 'failed'))
);

create index import_jobs_user on import_jobs (user_id, created_at desc);

create table import_rows (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references import_jobs(id) on delete cascade,
  raw           jsonb not null,
  media_item_id uuid references media_items(id) on delete set null,
  status        text not null,
  candidates    jsonb,
  constraint import_rows_known_status
    check (status in ('matched', 'ambiguous', 'unmatched', 'duplicate', 'applied'))
);

create index import_rows_review on import_rows (job_id, status);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table invite_tokens       enable row level security;
alter table invite_attributions enable row level security;
alter table share_tokens        enable row level security;
alter table import_jobs         enable row level security;
alter table import_rows         enable row level security;

create policy invite_tokens_own on invite_tokens for select
  using (owner_id = auth.uid());

-- Both parties can see the attribution: the inviter needs their invite count, and
-- the invitee is entitled to know who they are attributed to.
create policy invite_attributions_read on invite_attributions for select
  using (inviter_id = auth.uid() or invitee_id = auth.uid());

create policy share_tokens_own on share_tokens for select
  using (owner_id = auth.uid());

create policy import_jobs_own on import_jobs for select
  using (user_id = auth.uid());

create policy import_rows_own on import_rows for select
  using (exists (
    select 1 from import_jobs j where j.id = job_id and j.user_id = auth.uid()
  ));
