# Bingd — Architecture Overview

**Version:** v1 (public alpha)
**Status:** Draft for review
**Date:** 2026-08-12
**Specification:** [`../product/PRD.md`](../product/PRD.md) v0.6

---

## How to read this

This directory describes **how** Bingd is built. The PRD describes **what** it does and why. If the two disagree, the PRD wins and this document must be corrected.

| Document | Covers |
|---|---|
| **README.md** (this file) | System shape, the ten decisions everything else follows from |
| [`data-model.md`](./data-model.md) | Postgres schema, indexes, row-level security |
| [`auth.md`](./auth.md) | Sign-in methods, credential linking, sessions |
| [`ranking.md`](./ranking.md) | Bucket bands, binary insertion, position maintenance |
| [`api.md`](./api.md) | The write and read surface |
| [`offline-sync.md`](./offline-sync.md) | Outbox, idempotency, conflict handling |
| [`recommendations.md`](./recommendations.md) | Candidate generation through delivery, and how each guardrail is enforced |
| [`client.md`](./client.md) | App structure, navigation, state, device cache |

Architecture decisions are recorded inline as **AD-n** with their rationale and what would reverse them. Anything an implementation agent may not decide alone is marked **Ask first**.

---

## System shape

```
┌─────────────────────────────────────────────────────────┐
│  Expo / React Native client (iOS, Android)              │
│  TanStack Query · SQLite device cache · outbox queue    │
└───────────────┬─────────────────────────────────────────┘
                │  HTTPS, user JWT on every request
┌───────────────▼─────────────────────────────────────────┐
│  Supabase                                                │
│  ├─ Auth ......... email OTP, Apple, Google              │
│  ├─ Postgres ..... all application data, RLS default-deny│
│  │   └─ RPC ...... every write, SECURITY DEFINER         │
│  └─ Edge Functions                                       │
│      ├─ tmdb-adapter ..... only holder of the TMDB key   │
│      ├─ import-worker .... Letterboxd export processing  │
│      ├─ recs-builder ..... scheduled recommendation gen  │
│      └─ notify-dispatch .. event fan-out, push flagged   │
└───────────────┬─────────────────────────────────────────┘
                │
      ┌─────────┴──────────┐
      │                    │
┌─────▼──────┐    ┌────────▼─────────┐
│ TMDB API   │    │ bingd.app (web)  │
│ server-side│    │ share + invite   │
│ only       │    │ landing pages    │
└────────────┘    └──────────────────┘
```

Nothing in the client holds a service credential. Every client request carries a user JWT, and Postgres decides what that user may see.

---

## The ten decisions

### AD-1 — One `media_items` table is the rankable unit

A movie and a TV season are both things you rank. Modeling them as separate tables forces a polymorphic reference into rankings, watchlist, lists, feed events, recommendations, tags, and impressions — nine places to get wrong.

Instead, one `media_items` row represents **either** a movie **or** a specific season, distinguished by `kind`. Series exist as their own rows for browsing and grouping, but are never rankable. Every other table holds a plain foreign key to `media_items`.

**Reverses if:** a third rankable kind appears with genuinely different attributes. Episodes would not qualify — they are explicitly never rankable (PRD §10).

### AD-2 — Ranking positions are dense integers maintained on write

The product always displays an exact ordinal (`#18 in Movies`, PRD §10). That constraint decides the storage model.

The alternative — storing a fractional sort key and computing `row_number()` at read — makes insertion O(1) but makes *reading a single title's position* require counting every row above it. Feed items, title detail pages, and share cards all display positions for individual titles, so that read path is the hot one.

Dense integers invert the cost. Reading a position is a column access. Inserting shifts the rows below it in a single indexed range update:

```sql
update rankings set position = position + 1
 where user_id = $1 and category = $2 and position >= $3;
```

For a 400-title ranking that is at most 400 rows in one statement — well under a millisecond. Ranking writes are rare, online-only, and user-initiated one at a time (PRD §18). Reads outnumber them by orders of magnitude.

The uniqueness constraint on `(user_id, category, position)` must be `DEFERRABLE INITIALLY DEFERRED`, because the shift transiently duplicates a position mid-statement.

**Reverses if:** a user's ranking regularly exceeds roughly 50,000 titles, which the catalog makes implausible.

### AD-3 — Bucket bands are contiguous position ranges

PRD §10 requires that every *Loved it* title rank above every *It was fine* title, which ranks above every *Not for me* title.

Rather than storing band boundaries, they are derived: sort by position, and the bands appear in order. A ranking row carries its `bucket`, and the insertion routine restricts its binary search to rows sharing that bucket. Changing a bucket removes the row from its current position and re-inserts it into the target band.

No database constraint can express "all rows of bucket A precede all rows of bucket B." The invariant is held by making the RPC the only write path (AD-4) and asserting it in tests via a validation function.

### AD-4 — Every write goes through a `SECURITY DEFINER` RPC

Row-level security is excellent at answering "may this user read this row." It is poor at answering "is this multi-row mutation internally consistent." Ranking insertion alone touches hundreds of rows and must preserve two invariants — dense positions and band ordering — that no `CHECK` constraint can express.

So RLS grants clients `select` only. Every mutation is a Postgres function that validates inputs, enforces capabilities, preserves invariants, and writes. Clients hold no direct write grant on any user table.

This also gives capability enforcement one place to live (PRD §20 requires server-side enforcement), makes every write auditable, and makes offline idempotency a matter of one `operation_id` check at the top of each function.

**Ask first** before adding a write path that bypasses this.

### AD-5 — RLS denies by default, and visibility lives in one function

Every user-owned table has RLS enabled with no permissive default. Read policies are written against a single helper, `can_view_profile(viewer, subject)`, which resolves public/private state, follow approval, and blocks in both directions.

Centralizing it matters because PRD §22 defines blocking as affecting feed, leaderboard, discovery, match, tagging, and public web pages simultaneously. Expressing that rule separately in each policy guarantees the copies drift, and a drifted copy is a privacy defect.

The decision paid for itself on 2026-08-13, when account suspension was added ([`data-model.md`](./data-model.md) §13): hiding a suspended account across all seven surfaces was one clause in one function rather than seven policy edits, six of which could have been forgotten quietly.

**Views need their own guard.** RLS protects tables; a Postgres view runs with its *owner's* permissions by default and hands out rows the caller could never select directly. Every view is therefore created `with (security_invoker = true)`. `visible_collection` is the case that matters — it exists because `user_media` is owner-only, and a default-owner view over it would publish every user's private notes while the table policy still read correctly.

### AD-6 — The feed is assembled on read

Two options: write each activity into every follower's inbox (fan-out on write), or query the union of followed users' activity at read time (fan-out on read).

Fan-out on write is what you need at social-network scale, where one user has millions of followers. Bingd's launch cohort is 30–60 people (PRD §28), the feed is strictly chronological with no ranking (PRD §14), and fan-out on write would multiply storage and make privacy changes require rewriting history.

Fan-out on read is a single indexed query against `feed_events` filtered by followed user IDs, ordered by `created_at`. It also means a privacy change or a block takes effect immediately, with no backfill.

**Reverses if:** median follow counts reach the low thousands, at which point the query degrades. Revisit before mass market.

One consequence worth stating plainly, because the PRD originally described the opposite: **the feed is a live query, not a historical record.** Unfollowing someone removes their events from your feed entirely, past ones included, because the query filters on the current follow set. PRD §14's claim that unfollowing "does not retroactively rewrite history" was true of a fan-out-on-write inbox and is not true here — and it was the more surprising promise anyway. Someone who unfollows expects that person gone from their feed, not their last three weeks preserved. Nothing is deleted; a re-follow restores visibility. §14 has been corrected to describe this.

### AD-7 — Match scores are computed on a schedule, not on demand

Comparing two users' rankings is O(shared titles). Rendering a leaderboard of 50 candidates on demand would mean 50 such comparisons per screen load.

Match scores are materialized into `match_scores` by a scheduled job for user pairs with meaningful overlap, and recomputed when either user's ranking changes materially. The stored row carries `shared_count` so the UI can display confidence (PRD §13) without a second query, and a `computed_at` so staleness is visible.

**Method:** pairwise agreement over commonly ranked titles, transformed to 0–100. PRD `open-questions.md` §4 leaves the exact method to this stage; the reasoning is in [`data-model.md`](./data-model.md).

### AD-8 — TMDB is reachable only through one Edge Function

`tmdb-adapter` is the sole holder of the API key and the sole caller of TMDB. It normalizes responses into Bingd's schema, writes through to `media_items` and `media_cache`, and returns Bingd-shaped data. No other component knows TMDB's response format.

This satisfies the credential requirement in PRD §19 and makes the provider replaceable, which matters because the catalog is a hard dependency and TMDB publishes no SLA.

**Cache retention is a runtime config value**, not a constant in a migration. TMDB's terms cap retention of TMDB-derived data at six months, so `tmdb-adapter` writes an expiry on every cached record and Bingd's own collection data lives in separate tables that no expiry touches ([`../reference/tmdb-integration.md`](../reference/tmdb-integration.md)).

That covered `media_cache` and missed `media_items`, which holds the larger share of provider data — title, overview, poster path, genres — with no expiry at all. `tmdb-adapter` also drains `media_refresh_due`, a view of rows past `tmdb.metadata_max_age_days` that a user collection still references; unreferenced stale rows are pruned instead. **This refresh consumes provider quota proportional to the total distinct titles the user base has ever touched**, not to current activity, which is a different growth curve from the one PRD §19's cost model describes.

### AD-9 — Capabilities resolve through one function, and limits never delete

`resolve_capabilities(user_id)` returns the user's active capability set from all grant sources, filtering expired grants. Every RPC that guards a limit calls it. The client calls it once per session for presentation only.

PRD §20's universal over-limit rule — data becomes read-only, never deleted — is enforced structurally: **no capability check ever appears in a `delete` or a visibility filter.** Capability checks appear only in `insert` paths. A user who loses a capability keeps every row they had; the next `insert` is refused. This makes the destructive case impossible to write by accident rather than merely forbidden by policy.

### AD-10 — Notification delivery is an abstraction with the push channel dark

PRD §15 requires the full system in v1 with push installed, credentialed, and flagged off, so that enabling it later needs no native build or store submission.

`notify-dispatch` receives an event, resolves recipients, checks per-category preferences, always writes an inbox row, and then consults a server-side flag for whether to also send push. The flag is a config row, not an environment variable, so flipping it takes effect without a deploy.

`expo-notifications` and both platforms' push credentials ship in the **first** development build regardless.

**The same reasoning applies to share destinations.** Direct "share to Instagram Stories" buttons need the destination URL schemes declared natively (`LSApplicationQueriesSchemes` on iOS, `<queries>` intents on Android). v1 ships the OS share sheet and does not use them, but the declarations go in the first build anyway (PRD §16), so adding those buttons later is a JavaScript change rather than a new binary and a store review.

The general rule: **anything that requires a native manifest entry is declared in the first build, even when the feature it enables is not yet used.** A JavaScript-only change can ship over the air via EAS Update; a manifest change cannot.

---

## Non-negotiables

Constraints from the PRD that are easy to violate accidentally. Each maps to a test in PRD §25.

| Constraint | Structural enforcement |
|---|---|
| No score or percentile is ever displayed | No API response carries a numeric ranking value other than `position` |
| No position is derived from an imported rating | The import path writes `bucket` and never touches `rankings` |
| No ranking mutation is queued offline | Ranking RPCs are absent from the outbox allowlist, **and** `set_bucket` and `unlog` refuse a ranked title |
| Block and report are never queued | Same allowlist |
| No capability limit deletes data | Capability checks appear only in insert paths (AD-9) |
| A share or invite token is never authorization | Token resolution returns an object id; the caller then applies normal visibility rules |
| No provider credential in the client | TMDB is reachable only from `tmdb-adapter` (AD-8) |
| Explanations are derived, never invented | Recommendation rows store the evidence they were built from; the client renders stored evidence and cannot compose new reasons |
| A view never leaks past RLS | Every view is `security_invoker`, asserted from a second user's session |
| A deleted account's username is never reusable | `username_history` primary key, written by a `before delete` trigger |
| Growth provenance is never destroyed | `invite_attributions.inviter_id` detaches rather than cascading |

The first row is the one that needed correcting. An allowlist of function *names* cannot express a constraint on the *state of the row* a function is aimed at, and two allowlisted functions — `set_bucket` and `unlog` — could both be pointed at a ranked title, which made each of them a queueable ranking mutation. The general rule: **a function is queueable only if it is queueable for every state its target row can be in.**

---

## Environments

Two Supabase projects, `bingd-nonprod` and `bingd-production`, with identical schemas applied by the same migrations. Three app variants (PRD §24) point at them: development and preview at nonprod, production at production.

Invite and share tokens carry an environment discriminator so a nonprod token cannot resolve in production (PRD §17).

---

## Open at this stage

Listed so they are not silently resolved.

| Item | Who decides |
|---|---|
| Analytics provider | Engineering; PostHog is the working recommendation |
| Rate-limit numeric thresholds | Engineering, from observed traffic |
| Letterboxd title-matching thresholds | Engineering, tuned against real exports |

> **Settled 2026-08-12.** Bucket bands partition the ranking (formerly INF-3). This document and [`ranking.md`](./ranking.md) both assume it, and it is now a founder decision rather than an assumption.
>
> **Settled 2026-08-13.** Navigation is Feed · Collection · + · Recommendations · Profile ([`client.md`](./client.md) §2). TMDB is no longer a gate: Bingd connects on a free developer key, caps TMDB-derived cache retention under six months, and buys the self-serve commercial plan before charging anyone ([`../reference/tmdb-integration.md`](../reference/tmdb-integration.md)).
>
> **Settled 2026-08-19, and it had been settled for five days without anybody writing it down.** `bingd.app` is on **Cloudflare Pages**, git-connected to `main`, and has been serving since 2026-08-14 — the working recommendation was already the deployment. What that means for a tapped link, which builds can open one, and what is still only config-verified rather than proven on hardware, is in [`web-deployment.md`](./web-deployment.md).
