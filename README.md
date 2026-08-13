# bingd.

A social collection and discovery app for movies and TV seasons. Log what you watch, sort it into three buckets, then build an exact personal ranking through head-to-head comparisons. That ranking powers taste matching, recommendations, a social feed, and shareable identity.

**Keep what you watch. Know what you love. Find what's next.**

---

## Status

**Pre-implementation.** The product specification is finalized and ready for architecture. No application code exists yet.

| Milestone | State |
|---|---|
| PRD finalized (v0.6) | Complete |
| Architecture | Not started |
| Implementation | Not started |

---

## Documentation

Read these in order.

| Document | Purpose |
|---|---|
| [`docs/product/PRD.md`](docs/product/PRD.md) | The specification. Features, flows, constraints, and acceptance criteria |
| [`docs/product/decision-log.md`](docs/product/decision-log.md) | What has been decided, on whose authority, and what would revisit it |
| [`docs/product/open-questions.md`](docs/product/open-questions.md) | What is deliberately unresolved, and who resolves it |
| [`docs/product/change-log-v0.6.md`](docs/product/change-log-v0.6.md) | What changed from v0.5 and why |

**Precedence:** the decision log outranks the PRD, and the PRD outranks anything in `docs/reference/`.

---

## For implementation agents

Before writing code:

1. Read `docs/product/PRD.md` §26 for the acceptance criteria your work must satisfy.
2. Check `docs/product/open-questions.md`. Anything marked **Open** or **Provisional** must not be resolved by picking a plausible answer. Stop and ask.
3. Anything marked **Required** is driven by safety, privacy, platform policy, or law. It is not a preference and may not be traded away for simplicity.

Hard constraints that are easy to violate by accident:

- No 0–10 score, 0–100 score, or percentile is ever displayed. Ordinal position only.
- No ranking position is ever derived from an imported rating.
- No ranking mutation is ever queued offline.
- No billing code, store product, price, or "Pro" indicator exists in v1.
- No capability limit ever deletes or hides existing user data. Read-only, never destructive.
- No share or invite token grants access. It routes and attributes only.
- No provider credential ships in the client bundle.
- No recommendation explanation is generated rather than derived from stored signals.

Agents may not autonomously merge, deploy, run a production migration, delete production data, configure payment products, or access production secrets.

---

## Planned stack

Expo · React Native · TypeScript · Supabase · TMDB (behind a Bingd-owned adapter) · EAS Build and Update · Sentry · RevenueCat (paid beta only)

See PRD §23 and §24.

---

## Repository layout

```
docs/
  product/      Specification, decisions, open questions, change log
  reference/    Source documents, provider correspondence
Brand SVGs/     Wordmark and film-frame explorations (see PRD §5 — not yet production-ready)
```

`design-references/` is git-ignored. It holds third-party UI screenshot archives used for design study, which are not redistributable.

---

## Working agreement

One coherent change, one branch, one pull request. `main` is protected and requires passing checks. Changes to authentication, row-level security, payments, sharing, invitations, offline sync, or database migrations require an independent review before merge.
