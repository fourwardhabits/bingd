# bingd.

A social collection and discovery app for movies and TV seasons. Log what you watch, sort it into three buckets, then build an exact personal ranking through head-to-head comparisons. That ranking powers taste matching, recommendations, a social feed, and shareable identity.

**Keep what you watch. Know what you love. Find what's next.**

---

## Status

**Phase 0.** Specification, architecture, and design are written. The application scaffold builds, typechecks, lints, and tests clean; no product feature is implemented yet.

| Milestone | State |
|---|---|
| PRD finalized (v0.6) | Complete |
| Architecture | Complete, in review |
| Design system and screens | Complete, in review |
| Phase 0 scaffold | Complete, in review |
| Database schema, RLS, ranking engine | Complete, in review |
| Reporting, suspension, operator views | Complete, awaiting review |
| Phase 0 exit (Supabase projects, dev build on device, Sentry, analytics) | Blocked on account setup |
| Phase 1 onward (auth, catalog, import, social) | Not started |

---

## Documentation

Read these in order.

| Document | Purpose |
|---|---|
| [`docs/product/PRD.md`](docs/product/PRD.md) | The specification. Features, flows, constraints, and acceptance criteria |
| [`docs/product/decision-log.md`](docs/product/decision-log.md) | What has been decided, on whose authority, and what would revisit it |
| [`docs/product/open-questions.md`](docs/product/open-questions.md) | What is deliberately unresolved, and who resolves it |
| [`docs/product/change-log-v0.6.md`](docs/product/change-log-v0.6.md) | What changed from v0.5 and why |
| [`docs/architecture/README.md`](docs/architecture/README.md) | System shape and the ten decisions everything else follows from |
| [`docs/design/design-system.md`](docs/design/design-system.md) | Tokens, type, components, accessibility |
| [`docs/design/screens.md`](docs/design/screens.md) | What each screen is for and which states it must handle |
| [`docs/design/reference-notes.md`](docs/design/reference-notes.md) | What the design archives taught, and what was refused |

**Precedence:** the decision log outranks the PRD, the PRD outranks architecture and design, and all of them outrank anything in `docs/reference/`.

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
- No text is ever set in Antique Amber or Muted Sage on Parchment. Both measure below 2.2:1 and fail at every size.

Agents may not deploy, run a production migration, delete production data, configure payment products, or access production secrets. Merge authority is set out under [Working agreement](#working-agreement).

---

## Stack

Expo SDK 57 · React Native 0.86 · React 19 · TypeScript · Expo Router · TanStack Query · Supabase · TMDB (behind a Bingd-owned adapter) · EAS Build and Update · Sentry · PostHog · RevenueCat (paid beta only)

### Crash reporting and analytics

Both are **optional**. With no `EXPO_PUBLIC_SENTRY_DSN` or `EXPO_PUBLIC_POSTHOG_KEY` they become no-ops, so the project runs for someone with no accounts and no reason to want them. Reporting that forces credentials on every contributor gets switched off locally, and then nobody notices it is off in CI either.

Two decisions in there are load-bearing rather than incidental.

**PostHog autocapture is off, and stays off.** In a mobile app it records the text of whatever was tapped — which in this one means film titles out of somebody's private collection. Every event is instead declared in `src/lib/analytics.ts`, and **the type is the enforcement**: there is no `track(name, props)` overload to reach for, and no declared event accepts a title, a username, a note, or a media id. It cannot be sent in a hurry before a demo.

**Sentry is treated as hostile to privacy until configured otherwise.** `sendDefaultPii` is off, the user object is reduced to the internal UUID, console breadcrumbs are dropped, and query strings are stripped from URLs — route paths like `/title/<uuid>` name an identifier, but the search screen's query string is whatever the user typed. Knowing someone crashed on search does not require knowing what they searched for.

Source map upload needs `SENTRY_AUTH_TOKEN`, which is an **EAS secret and never committed**. Without it a crash report shows minified output instead of a filename and a line number.

See PRD §23 and §24.

---

## Running it

```bash
npm install
cp .env.example .env    # fill in the Supabase URL and anon key
npm start
```

| Command | Purpose |
|---|---|
| `npm start` | Expo dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the raw-colour ban |
| `npm test` | Jest, including the contrast assertions |
| `npm run test:db` | Applies every migration to real Postgres and tests the ranking engine |

`APP_VARIANT` selects the build variant — `development`, `preview`, or `production` — which sets the bundle identifier, the app name, and the backend. Non-production builds carry a visible environment badge.

### Two guardrails worth knowing about

Both exist because the design system found defects that would otherwise have shipped, and both fail the build rather than relying on discipline.

**Colour literals are banned** outside `src/ui/tokens/`. A hardcoded `#D4A64C` in a component is a lint error, because that is exactly how the contrast defect in `docs/design/design-system.md` §1 would come back.

**Contrast is asserted, not assumed.** `src/ui/tokens/contrast.test.ts` computes WCAG ratios for every permitted foreground and pins each to the value printed in the design system tables. It also asserts that Amber and Sage still *fail* on Parchment, so the rule that they are fills and never ink cannot be quietly undone. It has already caught two ratios that were rounded wrongly by hand.

### The database runs in tests without Docker

`npm run test:db` boots Postgres compiled to WebAssembly ([PGlite](https://pglite.dev)), applies every migration in `supabase/migrations/` in order, and exercises the ranking engine through its real RPCs.

That matters most for ranking, which is the component most likely to corrupt data in ways nobody notices for weeks. The tests assert the four invariants from `docs/architecture/ranking.md` **after every single mutation**, and one test drives sixty randomised operations — insertions, unrankings, reorderings — re-checking all four each time. Another gives each film a secret true ordering, answers every comparison from it, and asserts the finished ranking reproduces that order exactly, which verifies the insertion search is correct rather than merely self-consistent.

Two known limits of the WebAssembly build, neither consequential: `citext` is unavailable and is shimmed as `text`, and row-level security is not enforced against the owning role, so policy behaviour is tested by calling `can_view_profile` directly.

---

## Repository layout

```
app/                Expo Router routes. File-based, so a deep link and the
                    in-app screen are one definition and cannot drift
  (auth)/           Sign-in and onboarding
  (tabs)/           Feed · Collection · + · Recommendations · Profile
  title/ u/ lists/  Public deep-link destinations
  i/[token].tsx     Invitation acceptance
src/
  ui/tokens/        The only place a colour literal may appear
  ui/components/    Shared primitives
  lib/              Env, Supabase client, query keys
supabase/
  migrations/       Schema, RLS policies, and the ranking RPCs
  tests/            Run against Postgres-in-WebAssembly, no Docker needed
docs/
  product/          Specification, decisions, open questions, change log
  architecture/     Data model, ranking, API, offline sync, recommendations, client
  design/           Design system, screen specification, reference notes
    references/     The specific third-party screens cited, resized
  reference/        Source documents, provider correspondence
Brand SVGs/         Wordmark and film-frame explorations (see PRD §5 — not yet production-ready)
```

Source is organised by **feature** rather than by technical layer. A `components/` directory holding every component forces each change to touch several distant folders; grouping a screen with its hooks and its data access keeps a change local.

`design-references/` is git-ignored. It holds the full third-party UI screenshot archives used for design study, which are not redistributable. Only the individual screens actually cited in the design documents are committed, resized, under `docs/design/references/` — PRD §5.

---

## Working agreement

One coherent change, one branch, one pull request. `main` is protected and requires passing checks.

**Sensitive surfaces** are authentication, row-level security, payments, sharing, invitations, offline sync, database migrations, and moderation. An agent may merge documentation and ordinary code, and may merge a sensitive change once an independent review has passed — but always after asking first. Reviews go to the latest Fable for foundational work and the latest Codex for contained work. A reviewer reports findings; it does not write the fix, because a reviewer that patches its own findings is no longer an independent check. Deploying, running a production migration, deleting production data, configuring payment products, and touching production secrets are the founder's alone and have no approval path.

### Deciding whether to say yes — for the founder

Two questions settle almost every case.

**Does it touch anything on the sensitive list?** In plain terms, that means: logging in, who is allowed to see whose data, money, links that get shared or invite people in, anything that syncs while offline, any change to the database's shape, and anything to do with reports or suspensions. If the answer is no — copy, layout, a new screen, documentation — say yes and move on. That is most changes.

**If it does, has somebody other than the author actually checked it?** Not "the tests pass." Tests only find what someone thought to test, and the one class of bug that hurts here is data leaking between users, which is easy to have no test for at all.

So before you say yes to a sensitive change, ask for three things:

1. **Who reviewed it, and what did they find?** "A fresh Codex agent found four issues, all fixed" is an answer. "It looks correct" is not.
2. **What test would fail if this broke?** For a privacy change the honest answer names a test that logs in as the wrong user and confirms it gets nothing back. If no such test exists, the change is not ready regardless of how sound the reasoning sounds.
3. **Was the reviewer independent?** The author cannot review their own work, and a reviewer that wrote the fix has stopped being a reviewer.

Say no, or wait, when: the review has not happened yet; the reviewer and the author are the same agent; the change is described as urgent (nothing here is); or the explanation you get back is longer and more confident than you can follow. That last one is the most reliable signal there is — a change that cannot be explained simply is usually a change that is doing more than it claims.

You do not need to read the code. You need to know that a second pair of eyes looked, what it found, and what would catch the problem next time.
