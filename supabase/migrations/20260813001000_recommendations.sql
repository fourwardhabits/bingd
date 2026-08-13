-- Recommendations: generations, slates, impressions, feedback.
-- Specification: docs/architecture/data-model.md §8 · AD-8 · PRD §13

-- config_version makes a slate reproducible after tuning values change, which is
-- what allows a quality regression to be diagnosed rather than guessed at.
create table recommendation_generations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles(id) on delete cascade,
  created_at     timestamptz not null default now(),
  config_version text not null
);

create index recommendation_generations_user
  on recommendation_generations (user_id, created_at desc);

-- evidence is the explanation-integrity mechanism. PRD §13 requires every reason
-- to be reproducible from stored signals and forbids invented social proof, so
-- the row stores the actual evidence — which users endorsed it, their match
-- scores, which content features matched — and the client renders a sentence
-- from that structure.
--
-- The client has no path to compose a reason of its own, because it is never
-- given the raw candidate pool.
create table recommendations (
  generation_id uuid not null references recommendation_generations(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  rank          integer not null,
  score         real not null,
  source_family text not null,
  evidence      jsonb not null,
  primary key (generation_id, media_item_id),
  constraint evidence_not_empty check (evidence <> '{}'::jsonb)
);

create index recommendations_order on recommendations (generation_id, rank);

create table recommendation_impressions (
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  shown_at      timestamptz not null default now(),
  primary key (user_id, media_item_id, shown_at)
);

-- Serves the cooldown check during re-ranking.
create index recommendation_impressions_cooldown
  on recommendation_impressions (user_id, media_item_id, shown_at desc);

create table recommendation_feedback (
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  kind          text not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, media_item_id, kind),
  constraint feedback_known_kind
    check (kind in ('dismiss', 'already_seen', 'saved', 'opened'))
);

alter table recommendation_generations  enable row level security;
alter table recommendations             enable row level security;
alter table recommendation_impressions  enable row level security;
alter table recommendation_feedback     enable row level security;

create policy recommendation_generations_own on recommendation_generations for select
  using (user_id = auth.uid());

create policy recommendations_own on recommendations for select
  using (exists (
    select 1 from recommendation_generations g
     where g.id = generation_id and g.user_id = auth.uid()
  ));

create policy recommendation_feedback_own on recommendation_feedback for select
  using (user_id = auth.uid());

-- No read policy on impressions. It is a server-side signal, not user content.
