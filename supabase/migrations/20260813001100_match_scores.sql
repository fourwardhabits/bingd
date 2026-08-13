-- Match scores.
-- Specification: docs/architecture/data-model.md §9 · AD-7 · PRD §13
--
-- Method: for the set of titles both users have ranked, count the pairs both
-- ordered the same way and divide by the total comparable pairs — Kendall's tau-a
-- rescaled to 0–100.
--
-- Chosen over Spearman because it degrades more gracefully on small overlaps,
-- which is the common case in a young network, and because it answers exactly the
-- question the product asks: when we have both seen two films, how often do we
-- agree on which was better? That maps onto the pairwise mechanic users already
-- understand.
--
-- Computation is scheduled rather than on demand (AD-7), and only for pairs whose
-- overlap exceeds match.min_shared_titles. Below that floor no row exists, and
-- the UI shows no match rather than a meaningless number.

create table match_scores (
  user_a       uuid not null references profiles(id) on delete cascade,
  user_b       uuid not null references profiles(id) on delete cascade,
  score        smallint not null check (score between 0 and 100),
  shared_count integer  not null check (shared_count >= 0),
  computed_at  timestamptz not null default now(),
  primary key (user_a, user_b),

  -- Stores each pair exactly once.
  constraint ordered_pair check (user_a < user_b)
);

-- Both directions, because a lookup may arrive from either side.
create index match_scores_a on match_scores (user_a, score desc);
create index match_scores_b on match_scores (user_b, score desc);

alter table match_scores enable row level security;

-- Both users' visibility rules apply, per PRD §16's match card row.
create policy match_scores_read on match_scores for select
  using (
    (user_a = auth.uid() and can_view_profile(auth.uid(), user_b))
    or (user_b = auth.uid() and can_view_profile(auth.uid(), user_a))
  );
