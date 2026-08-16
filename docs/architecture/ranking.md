# Bingd — Ranking Mechanics

**Version:** v1 (public alpha)
**Specification:** [`../product/PRD.md`](../product/PRD.md) §10, §11 · [`data-model.md`](./data-model.md) §5

This is the core mechanic. It is also the part most likely to produce subtle, hard-to-notice corruption, so the invariants are stated first and everything else is written to preserve them.

---

## Invariants

For every `(user_id, category)` pair, at all times outside a transaction:

| # | Invariant | Enforced by |
|---|---|---|
| **I1** | Positions are exactly `1..n` with no gaps and no duplicates | Unique constraint plus the shift in every write path |
| **I2** | Every `loved` position precedes every `fine`, which precedes every `not_for_me` | Insertion is restricted to the target band |
| **I3** | Every `rankings` row has a matching `user_media` row with the same bucket | Ranking RPCs write both |
| **I4** | No two titles share a position | `unique (user_id, category, position)` |

I1 and I2 cannot be expressed as constraints. They hold because **every write goes through the functions in this document** (AD-4), and because `assert_ranking_valid()` in §8 checks them in tests and on a schedule.

---

## 1. Bands

A band is the contiguous run of positions belonging to one bucket. Boundaries are derived, never stored:

```sql
create or replace function band_bounds(
  target uuid, cat ranking_category, b taste_bucket
) returns table (lo integer, hi integer, size integer)
language sql stable as $$
  with counts as (
    select
      count(*) filter (where bucket = 'loved')       as loved,
      count(*) filter (where bucket = 'fine')        as fine,
      count(*) filter (where bucket = 'not_for_me')  as nfm
    from rankings where user_id = target and category = cat
  )
  select
    case b when 'loved' then 1
           when 'fine'  then loved + 1
           else               loved + fine + 1 end,
    case b when 'loved' then loved
           when 'fine'  then loved + fine
           else               loved + fine + nfm end,
    case b when 'loved' then loved
           when 'fine'  then fine
           else               nfm end
  from counts;
$$;
```

An empty band returns `lo > hi` with `size = 0`, which the insertion routine handles as the trivial case.

Deriving boundaries rather than storing them means there is no second source of truth to drift out of step with the rows themselves.

---

## 2. Insertion sessions

A comparison sequence spans several round trips. The user may background the app, lose connectivity, or come back an hour later, and PRD §12 requires the post-import anchor session to be resumable. So the search state lives on the server.

```sql
create table ranking_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  category      ranking_category not null,
  bucket        taste_bucket not null,
  lo            integer not null,   -- offset within the band, not a position
  hi            integer not null,   -- exclusive
  pivot         integer,            -- offset of the title currently displayed
  history       jsonb   not null default '[]',
  skips         smallint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, media_item_id)
);
```

`lo` and `hi` bound the **insertion point**, not the candidate range, and they are **offsets within the band rather than absolute positions**. Offset 0 is the top of the band wherever the band currently begins; the absolute position is `band.lo + offset`, derived when needed. The correct final position lies at some offset in `[lo, hi]`, and when `lo = hi` the search is over.

> **These were absolute positions until 2026-08-13, and that was a corruption bug.** A position only means something relative to a ranking that is not moving. Rank one more `loved` title while a `fine` session is open and every `fine` position shifts down by one — but the session's bounds did not, so answering it to completion inserted the title at coordinates that now belonged to the `loved` band. **Invariant I2 broken by using the interface exactly as designed.** An offset survives the band sliding, because nothing about it was expressed in terms that moved. Bounds are additionally clamped to the live band size on every read, which covers the band *shrinking* under an open session.

`pivot` records which title is currently being compared against, rather than recomputing it as the midpoint. **Storing it is what makes Skip work at all.** Skip re-anchors deliberately away from the midpoint, so a `rank_answer` that recomputed the midpoint rejected the very title Skip had just displayed — every skip led to a dead end where the only offered answer was refused. Nothing in the bisection requires the pivot to be the midpoint; any offset inside `[lo, hi)` narrows the range correctly, and the midpoint is only the fastest choice.

`history` is a stack of prior `(lo, hi, pivot)` states, which is what makes **Back** work. `skips` counts re-anchors for the 3-skip rule.

The unique constraint on `(user_id, media_item_id)` means starting a session for a title that already has one resumes it rather than restarting. That is the resumability requirement, satisfied by a constraint rather than by logic.

> **Sessions are not the outbox.** They are server state for an online-only operation. PRD §18 forbids queuing ranking mutations, and nothing here changes that: with no connectivity, a session can neither be created nor advanced.

---

## 3. Starting a session

```
rank_start(media_item_id, bucket) -> { session_id, pivot } | { position }
```

1. Resolve `category` from the media item's `kind`. Reject `series` — PRD §10 forbids ranking a whole series.
2. Upsert the `user_media` row with the chosen bucket. **The title is now Logged**, whatever happens next. If the user abandons the session, the bucket survives and the recommendation engine can use it.
3. Compute `band_bounds`.
4. If the band is empty, insert directly at `band.lo` and return the position. No comparison is asked, because there is nothing to compare against.
5. If a session already exists for this title **and carries the same bucket**, resume it. If the bucket differs, discard it and start again — see below.
6. Otherwise create the session with `lo = 0`, `hi = band.size`, `pivot = band.size / 2`, and return the first pivot.

`hi` starts at the band size rather than one less because the new title may belong after every existing member. The range of possible insertion points has one more element than the band has members.

> **Step 5 used to resume unconditionally, and that broke invariant I3.** Starting a session as `loved`, changing your mind, and starting again as `fine` updated `user_media.bucket` while the session kept the bucket it was created with — so finalizing wrote a `rankings` row disagreeing with the logged bucket. That is not an exotic sequence; it is what a user does when they reconsider halfway through placing a title. The answers already given were collected against a different band and mean nothing in the new one, so the session is discarded rather than translated.

Step 2 is the structural expression of PRD §11: bucketing and ranking are separate acts, and abandoning the second does not undo the first.

---

## 4. Answering a comparison

```
rank_answer(session_id, winner) -> { pivot } | { position }
```

Standard binary search over the insertion point:

```
band        = band_bounds(user, category, bucket)   # recomputed every time
hi          = min(hi, band.size)                    # the band may have shrunk
lo          = min(lo, hi)
pivot_title = title at band.lo + pivot              # stored offset, not the midpoint

if new title wins:                                  # ranks above the pivot
    hi = pivot
else:                                               # ranks below the pivot
    lo = pivot + 1

if lo >= hi:  finalize at band.lo + lo
else:         pivot = (lo + hi) / 2 and return that title
```

The band is recomputed on every answer rather than trusted from when the session opened, and `_rank_finalize` re-derives it once more inside its advisory lock and **refuses** a position outside the band. I2 cannot be expressed as a constraint, so a violation would otherwise be silent and surface weeks later as a ranking the user knows is wrong but cannot explain.

Each answer is also written to `comparisons` for analytics and future recalibration.

**Comparison count.** A band of *k* members resolves in at most `ceil(log2(k + 1))` comparisons:

| Band size | Worst case |
|---|---|
| 7 | 3 |
| 63 | 6 |
| 255 | 8 |
| 1,023 | 10 |

This is why bands matter beyond correctness. A user with 400 ranked movies split across three buckets searches one band of perhaps 150, not the full 400 — and the *Loved it* band, where users actually care about precision, is the smallest of the three.

---

## 5. Skip and Back

**Skip** re-anchors to a different pivot without narrowing the range (PRD §10):

```
skips = skips + 1
if skips >= 3:
    finalize at (lo + hi) / 2
    return { position, adjustable: true }
else:
    return a different pivot from [lo, hi)
```

The replacement pivot is chosen by stepping away from the midpoint — `mid + 1`, then `mid - 1`, then `mid + 2` — clamped to the range. Stepping outward rather than choosing randomly keeps the remaining search near-balanced, so a skip costs little.

After three skips the title is placed at the midpoint of the surviving range and **the response carries `adjustable: true`**, which the client uses to show PRD §10's "you can change this from Rankings" message. The flag comes from the server so the message cannot appear in the wrong circumstances.

**Back** pops `history`:

```
(lo, hi, pivot) = history.pop()
skips = max(skips - 1, 0)
return { pivot }
```

Back at the first comparison returns to the bucket choice and cancels the session. The `user_media` bucket remains — the title stays Logged.

---

## 6. Finalizing

Two statements in one transaction:

```sql
-- 1. Open the slot.
update rankings
   set position = position + 1
 where user_id = $user and category = $cat and position >= $pos;

-- 2. Fill it.
insert into rankings (user_id, media_item_id, category, bucket, position)
values ($user, $item, $cat, $bucket, $pos);

delete from ranking_sessions where id = $session;
```

The unique constraint on `(user_id, category, position)` is `deferrable initially deferred` (AD-2) precisely so statement 1 may transiently duplicate a position. Both statements run inside the RPC, so the constraint is checked once at commit, with I1 and I4 restored.

The shift touches every row below the insertion point. For a 400-title ranking that is at most 400 rows in one indexed range update — a fraction of a millisecond, against an operation the user just spent six comparisons on.

A `feed_events` row is written here, with the final position denormalized into `payload` (see [`data-model.md`](./data-model.md) §6).

---

## 7. Other mutations

### Changing a bucket

Removal followed by insertion, in one transaction:

1. Delete the `rankings` row and close the gap: `position = position - 1 where position > old_position`.
2. Update the bucket on `user_media`.
3. Recompute `band_bounds` for the **new** bucket — the bounds have shifted, because removing the row changed the band sizes.
4. Start a fresh session in the new band.

Step 3 is the easy mistake. Computing bounds before the removal places the title one position off whenever it moved from a higher band to a lower one.

PRD §10 requires that changing a bucket re-runs comparisons in the new band, so the title genuinely re-enters comparison rather than being dropped at an estimated position.

### Manual reordering

PRD §10 permits dragging a title within its band. Moving from `p_old` to `p_new`:

```sql
-- Moving up
update rankings set position = position + 1
 where user_id = $u and category = $c and position >= $new and position < $old;

-- Moving down
update rankings set position = position - 1
 where user_id = $u and category = $c and position > $old and position <= $new;

update rankings set position = $new
 where user_id = $u and media_item_id = $item;
```

`p_new` is clamped to the title's own band. A drag that would cross a band boundary is refused, because crossing means the bucket changed and that path re-runs comparisons.

### Unranking

Delete the `rankings` row, close the gap, leave `user_media` intact. The title reverts to Logged with its bucket. Watch history is never lost — PRD §10 requires that reranking and recalibration never delete viewing history.

---

## 8. Validation

```sql
create or replace function assert_ranking_valid(target uuid, cat ranking_category)
returns void language plpgsql as $$
declare bad integer;
begin
  -- I1: positions are exactly 1..n
  select count(*) into bad from (
    select position, row_number() over (order by position) as expected
      from rankings where user_id = target and category = cat
  ) t where t.position <> t.expected;
  if bad > 0 then
    raise exception 'ranking has % gap or duplicate positions', bad;
  end if;

  -- I2: bands are contiguous and correctly ordered
  select count(*) into bad from (
    select bucket, position,
           lag(bucket) over (order by position) as prev
      from rankings where user_id = target and category = cat
  ) t
  where prev is not null and prev <> bucket
    and array_position(array['loved','fine','not_for_me']::taste_bucket[], bucket)
      < array_position(array['loved','fine','not_for_me']::taste_bucket[], prev);
  if bad > 0 then
    raise exception 'band ordering violated at % boundaries', bad;
  end if;
end;
$$;
```

Called after every mutation in tests, and by a scheduled job across all users in nonprod. The I2 check catches out-of-order bands **and** interleaving, because any backward step in bucket order fails it.

---

## 9. Concurrency

Two ranking sessions finalizing at once for the same user would interleave their shifts and corrupt I1.

The finalize transaction takes an advisory lock on `(user_id, category)`:

```sql
select pg_advisory_xact_lock(hashtextextended(user_id::text || cat::text, 0));
```

Ranking is a single-user, single-device, deliberate act, so contention is close to nonexistent — but "close to nonexistent" is exactly the kind of race that surfaces once and is never reproducible. The lock costs nothing and removes the class of bug entirely.

Sessions themselves need no locking: `(user_id, media_item_id)` is unique, so a second attempt to rank the same title resumes the first session.

---

## 10. The unranked queue

PRD §11 requires a "Rank 5 more" prompt drawing from the highest bucket first, quieting at roughly 50 ranked titles.

```sql
select um.media_item_id
  from user_media um
  left join rankings r
    on r.user_id = um.user_id and r.media_item_id = um.media_item_id
 where um.user_id = $1
   and um.bucket is not null
   and r.media_item_id is null
 order by array_position(
   array['loved','fine','not_for_me']::taste_bucket[], um.bucket
 ), um.created_at
 limit 5;
```

Served by the partial index on `user_media (user_id, bucket)`.

Whether the card appears is a **client** decision based on the ranked count, not a server one. The endpoint always answers honestly; the interface decides whether to ask. That keeps the "never imply the collection is incomplete" rule (PRD §11) in the layer that renders copy.

---

## 11. The displayed score

PRD §10 was amended on 2026-08-15: the number a user sees is a 0–10 score with one decimal, not the ordinal. **Nothing above this section changes.** The score is a projection of `position`, computed where it is rendered, and no column stores it.

Each bucket owns a non-overlapping range:

| Bucket | High | Low |
|---|---|---|
| `loved` | 10.0 | 7.0 |
| `fine` | 6.9 | 3.5 |
| `not_for_me` | 3.4 | 0.0 |

Given a title at absolute `position` in a band whose bounds are `band_bounds(user, cat, bucket)`:

```
offset = position - band.lo          # 0-based rank within the band
score  = high - offset × (high - low) / max(band.size - 1, 1)
```

Rounded to one decimal. Three properties worth stating because each one is a plausible bug:

**A band of one scores the high.** The `max(size - 1, 1)` denominator is what prevents a division by zero, and returning the high rather than the midpoint is deliberate: the first title you ever call *Loved it* is, at that moment, genuinely the best thing in your list.

**The ranges are closed and non-overlapping**, so a bucket is always recoverable from a score. `7.0` is *Loved it* and `6.9` is *It was fine*, with nothing in between. This is what lets the feed show a friend's score without also shipping their bucket.

**Scores reflow.** Because `band.size` is in the denominator, ranking one new title changes the score of every title in that band. That is correct — the score always was a statement about relative position — but it means a score must never be cached anywhere it could be read after the band changed. The one exception is §6's `feed_events.payload`, which is a snapshot on purpose.

### Why it is not a generated column

A score depends on the *sizes of all three bands* for that user and category, not on anything in its own row. Expressed in SQL it would be a correlated subquery over `rankings`, which cannot be `stored` and would have to be recomputed on read anyway. Worse, `size` changes for rows the write never touched: inserting one `loved` title would have to rewrite the score of every other `loved` row, turning a single-row insert into a whole-band update and giving I1's position shift a second thing to stay consistent with. A derived value has no such failure mode, because there is nothing to keep in step.

### The feed exception

`_rank_finalize` denormalizes `position` into `feed_events.payload` (§6) and now writes `score` alongside it. A client cannot derive another user's score, because that needs the other user's band sizes and `rankings` is not readable across users. Writing it at finalize time also makes the feed item honest in a way a live value would not be: an activity item records what happened, and what happened was that this title landed at 8.7.

---

## 12. Conformance

| PRD requirement | Where |
|---|---|
| Three buckets before comparison | §3, step 2 |
| Comparisons only within a bucket | §1, §3 |
| Bands partition the ranking (INF-3) | I2, §1, §8 |
| Bucket change re-runs comparisons in the new band | §7 |
| Skip re-anchors | §5 |
| Three skips places at the midpoint and says so | §5 |
| Back restores the previous comparison | §5 |
| No ties | I4 |
| 0–10 score display, derived from position | `rankings.position` plus `band_bounds` are the only inputs; see §11 |
| No 0–100 value, percentile, or cross-user average | Nothing in this document computes one |
| A position is never derived from a rating | Positions are written only by §6, reachable only through a comparison session |
| Ranking is online-only, never queued | Sessions are server state; no ranking RPC is outbox-eligible |
| Reranking never deletes viewing history | §7, unranking |
| Manual reorder stays within the band | §7 |
