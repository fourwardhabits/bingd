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
| **Build required for** | Android | **Android and iOS** |

Each runs the same five jobs: `fingerprint`, `android_build`, `ios_build`, `gate`, `publish`.
`publish` needs `gate`, and `gate` needs the other three.

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

**Always pass `--ref`.** Without it, EAS uploads the local directory and the gate refuses,
because the run is not on the commit named in `sha`. `--ref` needs the workflow file at that
commit, so a commit from before these files existed cannot be published this way.

---

## What the gate checks

`scripts/ota-gate.mjs` runs on EAS before `publish`, in the `development` environment, because it
reads only public GitHub data. Anything it cannot prove on Production is a refusal.

| Check | Came from | Production | Preview |
|---|---|---|---|
| The run, the checkout and `sha` are one commit | `release.mjs` (HEAD) | refuse | refuse |
| The checkout is clean, untracked files included | `release.mjs` | refuse | refuse |
| The fingerprint belongs to a build of that lane | **new** | refuse, both platforms | refuse, Android only |
| The commit is on `main` | `release.mjs`, narrowed from `main` or `release/*` | refuse | note |
| `ci.yml` passed on this exact commit | **new** | refuse | note |
| `release-gate.yml` passed on this exact commit | `release.mjs` | refuse | note |

The fingerprint job runs in the same environment and lane as the publish, so it hashes what will
ship. A commit is "on `main`" if `main` contains it, which is how a pull request head looks after
an ordinary merge commit. A squash merge creates a new commit, which needs its own gate run.

**A matching build shows a binary with that runtime exists, not that it is the one in the
stores.** The readiness check below is what connects the two.

### What this does not stop

`eas update` and a modified workflow are still things anybody logged in to EAS can run. As with
`release.mjs`, these checks make a bad publish a deliberate act rather than an accident.

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

**A native change stops at step 7.** If the production fingerprint has no matching store build,
the agent says a binary is required and stops. An OTA approval never covers building or
submitting a store binary.

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
job, so it cannot release anything. Match the build IDs it returns against the versions the stores
show.

### After a publish

Check with `eas update:view <group>` that each platform landed on the expected runtime and
branch, confirm the published commit, and update
[`production-state.md`](./production-state.md).

Rollback is unchanged: [`safe-update-runbook.md`](./safe-update-runbook.md) §4. A rollback is a
production change and needs its own founder authorization.
