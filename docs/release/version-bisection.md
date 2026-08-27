# Finding the version where it broke

The founder's iPhone has now contradicted three automated diagnoses in a row. This is the
procedure for answering the question those diagnoses kept guessing at: **which version
was the last good one.**

Nothing here has been executed. It is written down so the choice of method is a decision
rather than an improvisation, and so the one genuinely destructive option is on the page as
a thing not to do.

---

## The timeline, from EAS rather than from memory

Read with `eas build:list --platform ios` and `eas update:view <group>`. Every field below
is quoted from those, not inferred.

| Binary | Source | Runtime | Distributed |
|---|---|---|---|
| TestFlight build 3 | `87c6dac8` (#31) | `eace5f82…` | 2026-08-21 |
| TestFlight build 4 | `266b38dc` (#49) | `d3b308f7…` | 2026-08-26 |

Build 4 exists because #49 added the push entitlement, which is native and moved the
fingerprint. **That is why build 3 cannot receive any update published since**, and why
build 4 could not receive any published before: an update is offered only to a binary whose
runtime matches it exactly.

Every iOS update published to build 4's runtime, oldest first:

| # | Update ID | Group | Source | What it changed |
|---|---|---|---|---|
| 1 | `01a03ca8` | `f920327b` | `2628b097` (#51) | onboarding recovery, account escape |
| 2 | `01a03f4b` | `cae14561` | `b1bd5619` (#52) | startup renders, exits stay put, skeletons end |
| 3 | `01a03fc3` | `8878d97f` | `7d5c10cf` (#53) | request deadline, session mirror, local sign-out |
| 4 | `01a04060` | `5ce7ae79` | `ce86c35e` (#54) | onboarding resume settles, icon-font reporting |

The last update build 3 could see is `01a038a2` / `4f9a8a63`, from `33de3f7b` (#47).

### Good / bad

| Version | Physical status |
|---|---|
| Build 3 + its OTAs | **GOOD** — founder's recollection, not a measurement |
| Build 4 embedded (`266b38dc`) | **UNKNOWN** |
| OTA 1 (`01a03ca8`) | **UNKNOWN** |
| OTA 2 (`01a03f4b`) | **UNKNOWN** |
| OTA 3 (`01a03fc3`) | **BAD** — observed |
| OTA 4 (`01a04060`) | **UNKNOWN** — published after the last device report |

No cell is filled by inference. In particular the three UNKNOWNs between the last good
binary and the first observed bad update are the whole search space, and nothing so far has
narrowed them.

---

## The methods, safest first

### 1. Install build 3 from TestFlight — recommended first step

TestFlight keeps previous builds; a tester can install an older one from the app's version
list. Build 3 runs `eace5f82…`, so it falls back to its own last compatible update rather
than to anything published this week.

- **Costs nothing and destroys nothing.** Build 4 can be reinstalled from the same list and
  will pick the `beta` branch head straight back up.
- **Answers one question well**: is the failure in the build-4 lineage at all, or was it
  already present before it. That is the single most valuable bit currently missing.
- **Does not narrow further.** It cannot separate the embedded build-4 source from OTAs 1–4,
  because those share a runtime and build 3 shares it with none of them.

### 2. A separate bisection channel — the only way to walk OTAs 1→4

Build 4's runtime is the only place OTA 1, 2 and 3 can run, so testing them means pointing
*something* at each in turn.

- Create a channel that does not exist today — `beta-bisect` — and publish historical
  sources to it with `eas update --branch beta-bisect`.
- Point a **second install** at it, so the founder's primary install stays on `beta` and
  stays reproducible.
- This is a setup task rather than a command: it needs the channel, a build pointed at it,
  and each historical source republished. It is the right answer if step 1 says the
  regression is inside the build-4 lineage.

### 3. What must not be done

**Do not roll `beta` back**, by `eas update:roll-back-to-embedded` or by republishing an
older source onto it. It would overwrite the currently-broken state on the founder's phone
and destroy the ability to reproduce the thing being investigated. A bisection that
consumes its own evidence has bought nothing.

---

## Why diagnostics come first anyway

Bisection tells you *when* something broke. It does not tell you *what* is broken, and on
this codebase the two have repeatedly turned out to be different questions — the onboarding
phase that traps an account was written weeks before the tranche that made it visible.

The Diagnostics sheet (`src/features/diagnostics/`) answers "what" directly on the device:
whether a query ran, whether its request left the client, which sign-out stage is
outstanding, and what the stored onboarding phase actually is. If it names the failing
boundary, bisection may not be needed at all — and if it does not, the bisection above is
still there, and still costs nothing to start with step 1.
