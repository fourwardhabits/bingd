# Reference Material

Source documents and external correspondence. **Nothing here is authoritative.** If a document in this folder disagrees with [`docs/product/PRD.md`](../product/PRD.md), the PRD wins.

---

## Source documents

These live outside the repository, in the founder's local Downloads folder. They are large binary PDFs and are deliberately not committed. Listed here so the lineage of the specification is traceable.

| Document | Role | Status |
|---|---|---|
| `Bingd_PRD_v0.5_Finalization_Draft_20260812.pdf` | Direct predecessor to the current PRD | **Superseded by `docs/product/PRD.md` v0.6** |
| `Bingd PRD Finalization Kickoff.pdf` | Process instructions governing the v0.5 → v0.6 finalization | Complete; governs that transition only |
| `Building and Operating Bingd: A Nontechnical Founder's Guide to a Production-Ready Mobile App.pdf` | Engineering practice, recommended stack, Git workflow, testing, security, founder operating model | **Written against PRD v0.4.** See the staleness note below |

### Founder's guide — staleness note

The guide predates PRD v0.5 and therefore v0.6.

- **Where it describes product scope, features, or stage boundaries: the PRD supersedes it.** Its feature lists are two versions out of date and do not include three buckets, the Logged/Ranked model, v1 Letterboxd import, reactions, tagging, or notifications.
- **Where it describes engineering practice: it remains authoritative.** Branching and pull-request discipline, testing layers, environment separation, independent review of high-risk changes, and limits on agent authority are all reflected in PRD §24 and §25.

An implementation agent resolving a conflict between the two documents must resolve it in favor of the PRD.

### Specific passages that will mislead an agent

The general rule above is not enough, because the guide's most dangerous content is in its *examples* rather than its scope lists — and an example that illustrates a sound engineering practice reads as instruction even when its subject matter is two versions stale. Each of these contradicts a v0.6 decision that PRD §25 tests for:

| The guide illustrates | v0.6 requires | Where |
|---|---|---|
| Queuing a **ranking change** while offline, as the worked example of an outbox | **No ranking mutation is ever queued.** This is one of the "explicitly not open" items | PRD §18, `open-questions.md` §7 |
| A **paywall on custom lists**, as the worked example of a capability gate | Lists ship in v1 with the three-list limit enforced for **everyone**, and nothing is purchasable. A gate renders *Coming soon* with no price | PRD §20 |
| **RevenueCat** in the recommended v1 stack | No RevenueCat SDK, no store product, no purchase or restore UI anywhere in the v1 build. Verified by AC 26.11.6 | PRD §21, AC 26.11.6 |
| Broad local replication as the shape of offline support | Offline-**resilient**, not offline-first. Seven queueable operations | PRD §18, `../architecture/offline-sync.md` |

An agent that copies any of the four has written code that a required test will reject. Listed explicitly because "the PRD wins on scope" does not obviously cover a passage whose stated subject is idempotency or capability architecture.

---

## Providers

| Document | Purpose | Status |
|---|---|---|
| [`tmdb-integration.md`](./tmdb-integration.md) | Licensing position, attribution requirements, caching rules | Researched 2026-08-13. **No blocker** |

TMDB was recorded as Hard Gate HG-1 on the assumption that commercial access needed a negotiated agreement. It does not — the commercial plan is a self-serve purchase at a published price. Connect on a free developer key now and buy the plan before charging anyone.

**The closure does not rest on Bingd being non-commercial, and nothing here should be cited for that.** It rests on the downside being bounded: if TMDB takes the other view, the remedy costs a published monthly fee and no waiting. `../product/decision-log.md` §10 is the authority on the position and on what would reopen it.

---

## Design references

Third-party UI screenshot archives used for design study are **not** stored here. They live in the git-ignored `design-references/` directory at the repository root, because they are large and not redistributable.

Only the specific screens actually being designed against are committed, resized, under `docs/design/references/` with attribution.

Per PRD §5: **Apple TV, Apple Wallet, and Open** inform visual and design language. **Beli, Spotify, Cash App, Strava, and Letterboxd** inform interaction flows only — their visual language is explicitly not a model for Bingd.
