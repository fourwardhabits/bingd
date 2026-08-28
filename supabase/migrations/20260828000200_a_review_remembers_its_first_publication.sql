-- A review remembers when it was first published.
-- Founder tranche 2026-08-28 §8: the monthly Leaderboard needs a Reviews metric that
-- an edit cannot inflate and a re-share cannot buy twice.
--
-- ---------------------------------------------------------------------------
-- WHY `note_updated_at` COULD NOT BE THE SOURCE
--
-- A Bingd review is `user_media.note` with `note_visibility = 'public'`
-- (20260816000000), and the only timestamp the row carries about it is
-- `note_updated_at`, which `touch_note_version` (20260813002300) advances on **every
-- change to the text**. It is exactly right for what it was built for — the
-- offline-sync §5 conflict rule needs the *latest* version and nothing else — and
-- exactly wrong as a monthly fact:
--
--   * fixing a typo on the 1st moves a review written in July into August;
--   * so a leaderboard over it rewards editing rather than writing;
--   * and un-sharing then re-sharing rewrites it again, which is the cheap duplicate
--     point the founder ruled out by name.
--
-- `created_at` cannot stand in either: the row is created when the title is *logged*,
-- which is usually not when the note was written and is sometimes years off.
--
-- So this is the smallest server-owned fact that answers the question honestly: the
-- instant this account's note on this title **first became readable by anybody else**.
--
-- ---------------------------------------------------------------------------
-- THE THREE RULES, AND WHY EACH ONE IS LOAD-BEARING
--
--   1. **Stamped once.** Set only when the column is null and the row is, at that
--      moment, a published review. A second publication of the same review is not a
--      second review.
--   2. **Never cleared.** Un-sharing hides the text; it does not un-happen. Clearing
--      would restore the ability to earn the point again next month, which is rule 1
--      defeated by a round trip.
--   3. **Not moved by an edit.** Nothing in this trigger reads `note`'s text, only
--      whether the row currently *is* a published review. An edit to a review that has
--      already been stamped is invisible here.
--
-- Together those three make the count monotone per (user, title): a title contributes
-- at most one Review, forever, to the month it was first published in.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER AND NOT A LINE IN EACH WRITER
--
-- Three functions can make a note public — `log_watched`, `save_note`
-- (20260816000000), and any future one — and two of them reach the state through a
-- `case` expression that decides visibility from three inputs. A stamp added to each
-- would be three copies of one rule, in the three places most likely to gain a fourth.
-- The trigger reads the row *after* those expressions have resolved, so it cannot
-- disagree with them and a new writer inherits it without knowing it exists.
--
-- It runs `before` for the same reason `touch_note_version` does: assigning to `new`
-- is one write rather than a recursive `update`.
--
-- Ordering against `touch_note_version` does not matter — Postgres fires
-- before-triggers in name order, `user_media_stamp_review_published` after
-- `user_media_touch_note_version`, and neither reads what the other writes.
-- ---------------------------------------------------------------------------

alter table user_media
  add column note_first_published_at timestamptz;

comment on column user_media.note_first_published_at is
  'When this account''s note on this title first became a *published* review -- note not null and note_visibility = public. Stamped once, never cleared, never moved by an edit, which is what makes the monthly Reviews leaderboard uninflatable: an edit does not create a review, and un-sharing then re-sharing does not create a second one. Distinct from note_updated_at, which is the offline-sync conflict version and advances on every text change. Null on a private note and on a note that has never existed.';

-- Serves the monthly Reviews metric: one user's published reviews inside a month.
create index user_media_review_published
  on user_media (user_id, note_first_published_at)
  where note_first_published_at is not null;

create or replace function stamp_review_published()
returns trigger
language plpgsql
as $$
begin
  -- Rule 2 first, and the order is the rule rather than a formatting choice. An UPDATE
  -- that supplies null for a column already stamped -- a full-row rewrite, a future
  -- writer that does not know this column exists -- must get the *original* instant
  -- back. Running rule 1 first would see the null, find a currently-published review,
  -- and re-stamp it with `now()`: the fact would survive in the column and still move
  -- into this month, which is the inflation this file exists to refuse, arriving through
  -- the one door left open.
  if tg_op = 'UPDATE'
     and old.note_first_published_at is not null
     and new.note_first_published_at is null then
    new.note_first_published_at = old.note_first_published_at;
  end if;

  -- Rules 1 and 3: only ever null → now(), and only when the row as it will be committed
  -- is a published review. Nothing here compares text, so an edit cannot reach it, and
  -- after the branch above a null here means genuinely never published.
  if new.note_first_published_at is null
     and new.note is not null
     and new.note_visibility = 'public' then
    new.note_first_published_at = now();
  end if;

  return new;
end;
$$;

create trigger user_media_stamp_review_published
  before insert or update on user_media
  for each row execute function stamp_review_published();

-- ---------------------------------------------------------------------------
-- Backfill
--
-- Every note that is public *now* has been published, and the best available estimate
-- of when is `note_updated_at` -- correct for a review never edited, and an
-- overestimate (never an underestimate) for one that has been. An overestimate is the
-- safe direction: it can only move an old review forward into a month where it is
-- visible and countable, never invent one in a month it did not exist in.
--
-- A note that is private now but was public once is not recoverable and is not
-- stamped. That is the honest answer -- there is no record of it -- and it costs at
-- most a handful of rows on a friend beta.
-- ---------------------------------------------------------------------------

update user_media
   set note_first_published_at = note_updated_at
 where note is not null
   and note_visibility = 'public'
   and note_updated_at is not null
   and note_first_published_at is null;
