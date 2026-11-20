# Feed query latency, 2026-11-20

**What the Feed page costs, where the time goes, and what to change.** This follows up finding 4
of [reliability-2026-11-20.md](reliability-2026-11-20.md). It is evidence-driven: every claim
below names a measurement, and the tables say where each one was taken.

How it was measured:

- **Production** (`abheeqyjzekiowkztfxv`) was read only: `pg_stat_statements` (recording since
  2026-08-13), catalog views, aggregate counts and plain `EXPLAIN`. Nothing below identifies an
  account.
- **Staging** (`fjxhcbowoxuzulwirzyr`) took the `EXPLAIN (ANALYZE, BUFFERS)` runs and the
  timings. Every benchmark ran inside **one transaction that was always rolled back**. It
  seeded the accounts, follows and events, ran the measurements, and then raised, discarding
  everything. Afterwards staging had no benchmark profiles, no extra events, and none of the
  scratch functions or indexes (checked). Each query ran as `authenticated`, with
  `request.jwt.claims` set to the seeded reader, and was the statement PostgREST builds for
  the client, embeds included. Timings are medians of 2 to 7 runs after a warm-up.

---

## 1. The query

`useFeed` (`src/features/feed/use-feed.ts`) reads the reader's approved follows. It then calls
`activityPage` and `activityRows`, which send:

```
feed_events?select=id,type,actor_id,media_item_id,created_at,causal_at,causal_step,payload,
    media_items:media_item_id(kind,title,…,backdrop_path,…,parent:parent_id(title,…)),
    profiles:actor_id(username,display_name,avatar_path)
  &actor_id=in.(<reader>,<each followed account>)
  &type=in.(<the 8 Feed types>)
  [&or=(causal_at.lt.X,and(causal_at.eq.X,causal_step.lt.S),and(causal_at.eq.X,causal_step.eq.S,id.gt.I))]
  &order=causal_at.desc,causal_step.desc,id.asc&limit=20
```

- **Pagination is already keyset**, not offset. The `or` is the cursor after the last raw row
  of the previous page.
- **Three embeds:** the media item, its parent, and the actor's profile. The profile embed is
  policed too, because `profiles_read` is `can_i_view(id)`.
- **A profile's Recent activity** (`useActorActivity`) sends the same statement with one
  actor.
- **Authorisation is only the row policy:** `feed_events_read` is
  `can_i_view(actor_id) and presented_in is null`. The actor list is a filter.

### Production, `pg_stat_statements`, authenticated role

| Statement (same shape, different bundles) | Calls | Mean | Stddev | Max | Buffer hits per call |
|---|---|---|---|---|---|
| first page, without artwork columns (older bundles) | 6,752 | 154 ms | 184 ms | 3.1 s | 2,114 |
| first page, with `backdrop_path` (current bundle) | 1,422 | 365 ms | 367 ms | 3.2 s | 4,353 |
| keyset page, without artwork | 1,251 | 141 ms | 128 ms | 1.2 s | 2,478 |
| keyset page, with artwork | 101 | 331 ms | 316 ms | 1.8 s | 4,270 |

Together these are about 1,767 s of execution time. The rows include profile reads, which use
the same statement. The current bundle's statement is slower than the old one, though its
extra columns are cheap. The likely reason is that its calls are more recent, when followed
histories were longer.

Production's shape (aggregates): 53 profiles, 2,295 feed events (1,634 visible; the rest are
hidden behind a group post), 116 approved follows, no blocks.

| Candidate events per reader (visible events by the reader or an account they follow) | |
|---|---|
| median | 241 |
| p90 | 483 |
| max | 1,422 |

The plain production `EXPLAIN` for the reader with the most candidates has this shape: a scan
of `feed_events` for the 23 actors (estimated 1,568 rows), both embeds joined to every row
(Memoize on media item and actor), then a `Sort`, then `Limit 20`.

---

## 2. Where the time goes

### 2.1 The row policy, about 0.35 ms per row, and why

The cost is `can_i_view` itself. It is not the rule it checks. It costs about eight times what
the rule costs when called directly.

Staging, 470 events, as `authenticated`, `select count(*) from feed_events where <predicate>`,
second pass:

| Predicate | Time | Per row |
|---|---|---|
| `can_i_view(actor_id)` (today: SQL, `security definer`, calls `can_view_profile`) | 160 ms | 340 µs |
| `can_view_profile(auth.uid(), actor_id)`, called directly | 18 ms | 38 µs |
| the same body, as a copy that is invoker, without `SET` (inlined) | 17 ms | 36 µs |
| a SQL `security definer` wrapper **without** `SET` around an inlinable copy | 171 ms | 360 µs |
| a trivial SQL `security definer` + `SET search_path` function | 2 ms | 4 µs |
| **`can_i_view` as plpgsql, same expression, same callee** | **21 ms** | **44 µs** |
| `can_i_view` as SQL with `can_view_profile`'s body copied in | 32 ms | 69 µs |

So neither `security definer` nor `SET search_path` is the cost (the trivial function shows
that). The cost is **one SQL function calling another**. On PostgreSQL 17, a SQL function that
is not inlined plans its body again on every call, and a function called from inside it is set
up again, parse and plan included, on every outer call. Every `can_i_view` therefore pays to
prepare `can_view_profile` from scratch. A plpgsql wrapper keeps its compiled body and the
inner call's state for the session, which is why the same expression in plpgsql costs what the
rule costs.

`can_i_view` is behind most read policies (`feed_events_read`, `profiles_read`, `follows_read`,
comments, reactions and others), so this overhead is not specific to the Feed.

### 2.2 No index has the Feed's order, so the policy runs on the whole followed history

`feed_events_actor` is `(actor_id, created_at desc)`, which is not the Feed's sort. The only
plan is to read every candidate event, run the policy on each, build the embeds for each, sort,
and keep 20.

Staging, a reader following 25 accounts × 75 events (1,423 visible candidates, production's
largest reader), today's schema, `EXPLAIN (ANALYZE, BUFFERS)`, page 1. Total 622 ms, 13,305
buffer hits:

| Node | Time | |
|---|---|---|
| `feed_events` scan with the policy filter | 551 ms | `can_i_view` on 1,423 rows, 0.39 ms each |
| media embed (Memoize, 1,123 misses) | 21 ms | built for every candidate, not for 20 |
| profile embed (Memoize, 26 misses, `profiles_read` per actor) | ≈10 ms | plus join overhead |
| top-N sort | 2 ms | |

**About 89% is the policy on the feed rows.** The embed fan-out is real (1,123 media lookups
for a 20-row page) but small. Sorting is negligible. Pagination is not the problem: a keyset
page costs the same as page 1, because each one still reads the whole history.

### 2.3 Growth

The same reader at 10× (250 followed × 75, 14,214 candidates, 29,260 events in the table):
page 1 takes **6.4 s**. The cost is linear in the followed accounts' total history, as
finding 4 said.

---

## 3. Options, ranked, measured on staging

PostgREST statement as `authenticated`, medians. Each configuration was applied in the same
rolled-back transaction. "1×" is the 1,423-candidate reader and "10×" the 14,214-candidate one.
The quiet-follows rows are the same reader following three accounts with ten old events each,
or three ordinary accounts.

| Configuration | page 1, 1× | page 1, 10× | keyset page 6, 10× | deep keyset, 10× | one actor (profile), 10× | 3 quiet follows, 10× |
|---|---|---|---|---|---|---|
| today | 628 ms | 6,263 ms | 6,254 ms | 5,359 ms | 52 ms | 30 ms |
| **A. Feed-order index** | **15.7 ms** | **18.4 ms** | **19.4 ms** | **23.0 ms** | 51 ms | 27 ms |
| B. `can_i_view` in plpgsql only | 139 ms | 1,298 ms | 1,285 ms | — | 10 ms | 9 ms |
| A + B | 4.8 ms | 5.7 ms | 6.9 ms | 9.9 ms | 11 ms | 6.5 ms |

**A. An index on the Feed's sort key: `feed_events (causal_at desc, causal_step desc, id)`. Done
in this PR (20261130000600).** It gives 40× at 1× and 340× at 10×. It has no effect on what
anyone sees.

- The planner walks events newest first and stops at the 20th visible row. The leakproof
  filters (`actor_id = any`, `type = any`, the keyset comparisons) run before the policy, so
  `can_i_view` runs only on followed accounts' rows, about 40 at either scale. The embeds are
  built for those rows only (20 media lookups instead of 1,123).
- It's not partial. A partial index on `presented_in is null` measured the same, but it would
  be used only while the policy states that predicate.
- Where the walk would be long (followed accounts with only old events), the planner keeps the
  `feed_events_actor` plan. Forced onto the index for that reader, the worst walk (the whole
  29,260-row index) took 37 ms.
- Cost: one more btree on a table with a low write rate.

**B. `can_i_view` as plpgsql. Recommended next, not done here.**

- It cuts the per-row policy cost 7.7×, on every surface that uses `can_i_view`, not only the
  Feed. On top of A, it takes the Feed from about 18 ms to about 6 ms at 10×, and the profile
  page from 51 ms to 11 ms.
- The change:

  ```sql
  create or replace function public.can_i_view(subject uuid) returns boolean
    language plpgsql stable security definer set search_path = public
  as $$ begin
    return coalesce(subject = auth.uid(), false) or can_view_profile(auth.uid(), subject);
  end $$;
  ```

- It is the same expression calling the same function, so the visibility rule is unchanged by
  construction. It is still a change to a security function on every policy, so it gets its
  own PR: an equivalence test over every (viewer, subject) kind (self, public, private
  followed, private pending, private unfollowed, blocked either way, suspended, no session),
  plus the full PGlite suite.
- Rewriting `can_view_profile` in plpgsql as well measured no better (23 ms against 21 ms).
- Copying its body into `can_i_view` measured worse (32 ms) and would make a second copy of
  the rule.

**C. Bound the keyset with the cursor's instant. Optional client change, small gain.** The
keyset `or(...)` is a filter, not an index bound, so with A a deep page walks down from the top.
Adding the redundant `causal_at=lte.<cursor>`, which the `or` already implies, makes it an index
bound. Page 101 at 10× goes from 23.0 ms to 19.2 ms with A, and from 9.9 ms to 6.0 ms with
A + B. It is worth doing only when the Feed is next touched, since it needs a bundle.

**D. A `security definer` Feed RPC. Not needed now.**

- A function that takes the follow set, checks visibility once per actor and merges each
  actor's newest rows would make a page's cost independent of history, follow count and walk
  length.
- With A (and B) a page is 6 to 23 ms at 10× production, and the planner already avoids the
  long-walk case. The RPC is worth its review cost when the event table is around 100× today
  or a reader follows thousands of accounts.
- It duplicates the visibility rule in a second place, so it needs the same equivalence tests
  as B.

**Not useful:**

- **A per-actor ordered index `(actor_id, causal_at desc, causal_step desc, id)` for profile
  pages.** The planner kept `feed_events_actor` and a sort of the actor's rows. A profile page
  is policy-bound (B fixes it), not order-bound.
- **Offset to keyset.** It is already keyset.

---

## 4. What was done

The `perf/feed-ordered-index` PR adds:

- **`supabase/migrations/20261130000600_a_feed_read_in_its_own_order.sql`:** the index and its
  comment, nothing else. Rollback is `drop index if exists public.feed_events_feed_order`. On
  production it builds in the migration's transaction over 2,295 rows.
- **`supabase/tests/feed-order-index.test.mjs`**, 7 cases:
  - the index key equals the client's `.order()` chain, read from `use-feed.ts`;
  - the planner serves the Feed statement and a keyset page from it with no `Sort`, under the
    policy, as `authenticated`;
  - the Feed paged to the end gives the same rows, in the same order, with the index preferred
    and with it dropped, and both match what the visibility rules allow. This is checked for
    three readers: a signed-in reader, the account that reader blocked, and a private account.
    The fixture covers an approved follow of a public account and of a private account, a
    pending follow, a private stranger, a public stranger, a block in each direction, a
    suspended account, a deleted account, a hidden (grouped) event, and ties in time and step.
    The actor list names every account, so only the policy decides.

  Two mutants turn the test red: the index with `causal_step` ascending (3 of 7 fail), and no
  migration (6 of 7 fail).
- **Staging:** applied only after CI and review, with a one-transaction script whose dry run
  refuses unless the pending set is exactly `20261130000600`. Before and after timings are in
  §5.

Not done: production (the coordinator applies and records it), option B (its own PR), and the
client.

---

## 5. Staging after the migration

Filled in after the staging apply, below.
