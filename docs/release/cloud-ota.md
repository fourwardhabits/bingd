# Cloud OTA releases

How an over-the-air update reaches Preview and Production from EAS rather than from a laptop.

The production lane cannot resolve `app.config.ts` without `GOOGLE_SERVICES_JSON`, a file-typed
variable in the EAS `production` environment. A local `eas update` cannot read it. EAS Workflows
run where it already lives, so nothing is downloaded, copied into git or GitHub, or printed.

`scripts/release.mjs` is unchanged and remains the path for Beta, for `release/*` branches and
for local Preview updates. [`safe-update-runbook.md`](./safe-update-runbook.md) still governs
what may go over the air at all.

---

## The workflows

| | `.eas/workflows/ota-preview.yml` | `.eas/workflows/ota-production.yml` |
|---|---|---|
| **EAS environment** | `preview` | `production` |
| **EAS branch** | `preview` | `production` |
| **`APP_VARIANT` / `BINGD_LANE`** | `preview` / `preview` | `production` / `production` |
| **Started by** | `eas workflow:run` only | `eas workflow:run` only |
| **Release checks** | reported | **refuse** |
| **Runtime held to the live binary** | Android | **Android and iOS** |

Each runs the same four jobs in order: `preflight`, `fingerprint`, `runtimes`, `publish`. **Nothing
reads a production variable until `preflight` has admitted the commit**, because the fingerprint
job executes it. Each lane runs one publish at a time, so an overlapping run cannot land an older
commit last. That only covers overlap: dispatching an older commit after a newer one has finished
still publishes it, so check what is live first.

**Neither has a push trigger, so merging to `main` publishes nothing.** The branch, environment
and lane are written into each file, not taken as inputs. `config/ota-workflows.test.mjs` runs in
the pull request gate and fails if a trigger is added, if the files stop agreeing with `eas.json`,
or if the two stop being the same workflow apart from the lane.

### Running one

```
SHA=<full commit hash>
eas workflow:run .eas/workflows/ota-production.yml --ref $SHA \
  -F sha=$SHA -F message="what changed (${SHA:0:7})" --non-interactive --wait
```

**Always pass `--ref`.** It needs the EAS project linked to this GitHub repository, and the
workflow file present at that commit, so a commit from before these files existed cannot be
published this way. Without `--ref`, EAS uploads the local directory instead, which is not a
release path: the gate refuses anything but a clean checkout of `sha`.

---

## What the gate checks

`scripts/ota-gate.mjs` has two stages, both in the `development` environment, because they read
only the checkout and public GitHub data. Anything they cannot prove on Production is a refusal.

| Stage | Check | Came from | Production | Preview |
|---|---|---|---|---|
| both | The checkout is exactly `sha` | `release.mjs` (HEAD) | refuse | refuse |
| both | The checkout is clean, untracked files included | `release.mjs` | refuse | refuse |
| `preflight` | The commit is on `main` | `release.mjs`, narrowed from `main` or `release/*` | refuse | note |
| `preflight` | `ci.yml` passed on this exact commit | **new** | refuse | note |
| `preflight` | `release-gate.yml` passed on this exact commit | `release.mjs` | refuse | note |
| `runtimes` | The fingerprint is the live binary's runtime | **new** | refuse, both platforms | refuse, Android only |

`ota-production-check.yml` runs `preflight` too, with one difference: the commit need not be on
`main`, because it reads a reviewed pull request head before the founder decides.

The fingerprint job runs in the same environment and lane as the publish, so it hashes what will
ship. A commit is "on `main`" if `main` contains it, which is how a pull request head looks after
an ordinary merge commit. A squash merge creates a new commit, which needs its own gate run.

### The live runtimes

`config/live-runtimes.json` names the runtime of each binary an update is meant to reach. **Change
it in the same pull request that records a new store binary as live.** If it is stale, the gate
refuses, which is the safe direction.

The file is read at the exact commit being published, so an edit to it has to pass review like
anything else. EAS's `get-build` job is not used: it succeeded with empty outputs for this project,
even for a build that exists.

### What this does not stop

`eas update` and a modified workflow are still things anybody logged in to EAS can run. As with
`release.mjs`, these checks make a bad publish a deliberate act rather than an accident.

### Secrets in logs

EAS prints each job's variables at the top of its log, and **any variable not stored as `secret`
appears in full.** That happened to `SENTRY_AUTH_TOKEN` until it was replaced on 2026-11-01. Secret
variables print as `********`, and a file variable prints as a path. Keep every credential in EAS
at `secret` visibility; only `EXPO_PUBLIC_*` values belong at `plaintext`.

Do not grep these logs. Use the scanner, which prints only names and counts:

```
node scripts/ota-log-scan.mjs <workflow run id>
```

---

## The release model

1. An agent implements on a feature branch.
2. A fresh agent reviews it independently.
3. Pull request and CI.
4. Preview or staging deployment.
5. The founder tests.
6. The founder says: **"Approved to merge and release PR #X"**.
7. The agent verifies the exact SHA, CI, the review and the scope.
8. The agent merges, if the effective repository policy permits it.
9. `ota-production.yml` publishes the approved commit, when it is OTA-compatible.
10. The agent runs read-only production verification.
11. The founder runs no routine Git or EAS commands.

**A native change stops at step 7.** If the production fingerprint is not the live binary's, the
agent says a binary is required and stops. An OTA approval never covers building or submitting a
store binary.

### Status of this model

**Steps 8 and 9 are the intended model, not standing permission.** The decision log's "Agent
authority — hard limits" and the README's working agreement still say that no agent may deploy
and that no approval path exists. Until the founder changes those, an agent may trigger
`ota-production.yml` only on the founder's direct instruction for that specific release, and must
ask before merging. That instruction names one commit and covers one publish.

### Readiness, before any production publish

Report one line, then wait for the approval the policy requires:

- the `main` SHA,
- Android production runtime compatibility,
- iOS production runtime compatibility,
- release gate status,
- Preview workflow test status.

`.eas/workflows/ota-production-check.yml` reads the two runtimes in the cloud. It has no publish
job, so it cannot release anything. Compare them with `config/live-runtimes.json`, confirm the
stores still show those versions, and scan the run's logs.

### After a publish

Check with `eas update:view <group>` that each platform landed on the expected runtime and
branch, confirm the published commit, scan the run's logs, and update
[`production-state.md`](./production-state.md).

Rollback is unchanged: [`safe-update-runbook.md`](./safe-update-runbook.md) §4. A rollback is a
production change and needs its own founder authorization.
