# Security remediation: release order and manual steps

Written for: the founder, and the agent carrying out the release once it is approved.

This is the release plan for the fixes to the security audit of 2026-11-01. **It was released on 2026-11-03**, and the [release record](#release-record-2026-11-03) is at the end, with what is still open. No agent applies a production migration, merges, or publishes a production update without the founder's approval for that exact commit.

## Release order

**The migrations go first, and the merge comes after them.** B-1 closes at step 3, on every installed phone, with nothing else needed.

| # | Step | Who | What changes |
|---|---|---|---|
| 1 | Apply the five `20261024*` migrations to staging, from the PR's head commit, then run the checks below | Agent | Nothing in production |
| 2 | Publish a Preview OTA, then try one invitation on a phone | Agent, then founder | Nothing in production |
| 3 | Apply the same five to production, **still from the PR's head commit** | Agent, once approved | Closes B-1, M-1, M-2, M-3 and M-4 for every installed build |
| 4 | Run the checks below on production | Agent | Nothing |
| 5 | Merge the PR, as an ordinary merge commit | Agent, once approved | Cloudflare Pages deploys the website by itself |
| 6 | Publish the production OTA from the same commit, following [cloud-ota.md](cloud-ota.md) | Agent, once approved | Accept works again, and the M-5 code fix reaches 1.1.0 phones |
| 7 | Verify, and record the release in [production-state.md](production-state.md) | Agent | Nothing |

Nothing in "Other work" below blocks these steps.

### Why this order

**Merging is what deploys the website.** Cloudflare Pages publishes `main` by itself, and there is no deploy step to hold back. The live `router.mjs` matches `main` exactly, and the repository holds no other deployment route. So "migrate, then deploy the website" can only happen by migrating before merging.

**In either order, one thing changes for a few minutes: the name and picture on `/u/<handle>`.** The old site reads `profiles`, which the migration closes. The new site calls `public_profile_card`, which the migration creates. So the two need each other, and no order avoids the gap. Migrating first keeps the website from ever calling a function that does not exist.

| Website | Database | `/u/<public handle>` | Everything else |
|---|---|---|---|
| Old | Old | Name and picture | Works |
| New | Old (avoided by this order) | Generic page. `404 PGRST202`, measured on staging | Works |
| Old | New (steps 3 to 5) | Generic page. The read is refused | Works |
| New | New | Name and picture | Works |

"Everything else" means titles, seasons, lists, invitation opens and list opens, measured in all four states. The generic page still offers Open in bingd. and the store buttons. The gap ends once Pages finishes and the five-minute cache on `router.mjs` passes.

**The OTA does not wait for a new CI run.** The release gate accepts a pull request head once `main` contains it, as long as CI and `release-gate.yml` passed on that exact commit. Both are run before step 3. A squash merge makes a new commit and loses this, so it has to be a merge commit. The proactive branch depends on that too.

**Merging does not disturb the scheduled jobs.** After the merge they name an Environment. While that Environment is empty they still receive the repository secrets, which was measured on `nonprod`. So moving the secrets is a separate job, on its own timing.

### Between steps 3 and 6

Nobody can accept an invitation. An old build says "Update bingd to accept this invitation. Your invitation has been kept", keeps the link, and shows the invitation once the update arrives. Keep the gap short, but nothing is lost in it.

**1.0.1 phones do not get this OTA.** It targets the 1.1.0 runtimes only. Those phones are just as protected from step 3, and they keep showing that message until they take the 1.1.0 store update. M-5's code fix never reaches them, so the Sentry rule is their only fix.

### Checks after the migrations

Staging first, then production. All of it is agent work.

| Check | Expected |
|---|---|
| `npm run test:remote` | 136 of 136. That is a prediction: a local run reached 133, and the other three need a real project. On staging before the migrations it was 131, with 4 failures and 1 inconclusive, all of them things these migrations change. Production needs `--target production` |
| The website's own requests | Public profile answers, private and unknown handles answer zero rows, wildcards answer zero rows |
| An invitation opened and left | No follow in either direction |
| An invitation accepted | Both accounts follow each other |

### If something goes wrong

| What happens | What to do |
|---|---|
| Staging fails | Stop. Production and `main` have not moved |
| `db push` stops partway | Note the last version applied. Rerunning is safe: all five were applied twice over on a populated database, one statement at a time, with no error. Do not merge until all five are in |
| A signed-in build fails on `profiles` | Run `grant select on profiles to authenticated;` in the SQL editor. Whole-row reads come back, `invited_by` is readable by signed-in accounts again, and anon stays shut. Then fix the build and revoke it |
| The new app misbehaves | Roll back the OTA, per [safe-update-runbook.md](safe-update-runbook.md) §4. That needs its own approval. The database stays as it is |

Do not reverse `20261024000100`. That reopens B-1.

## Other branches

Merge the security PR before anything else that touches the database. Both staging and production are at `20261023000100`, so the security files run first as long as nothing else is applied before them.

| Branch | What to do |
|---|---|
| `feature/proactive-notifications` | **Do not apply it to any database as it stands.** It redefines `claim_push_batch` and `my_notifications` without the excerpt rule, and applying `20261028*` first would leave `20261024000300` recreating an old overload. Use `integration/proactive-after-security`, which contains both and passes both suites |
| PR #119 `fix/push-kill-switch` | **Do not merge as it stands.** It is 420 commits behind and redefines `claim_push_batch(integer)` without the excerpt rule. Rebuild it from the newest definition, or close it |

## Other work, founder only

None of this blocks the release, and none of it needs a value pasted into a chat.

### 1. Sentry rule (M-5)

In Sentry, open the `bingd-react-native` project, go to **Project Settings → Security & Privacy → Advanced Data Scrubbing**, and add these four rules:

```text
[Remove] [Anything] from [$span.data.'http.query']
[Remove] [Anything] from [$span.data.'http.fragment']
[Replace] [Regex Matches] \?.*$ from [$span.data.'http.url']
[Replace] [Regex Matches] \?.*$ from [$span.data.url]
```

Sentry's documentation defines `$span` and quoted keys but shows no span example, so this has not been proven on this project. If a selector is rejected, use the rule builder's suggestion for the same field.

**M-5 closes** when a transaction from after the rule has an `http.client` span with no `http.query` and no `?` in `http.url`. Looking at a transaction from before the rule also settles whether the finding was really happening in production.

### 2. GitHub secrets (M-6)

Both Environments exist, and only `main` can use them. A branch's attempt was refused by GitHub on `nonprod`. A workflow that names no Environment can still read the repository-level secrets, so M-6 stays open until they are gone.

**First, add them.** In the repository, go to **Settings → Environments**, open each Environment, and use **Add environment secret**. This can be done at any time.

`production`:

| Name | Value |
|---|---|
| `SUPABASE_URL_PRODUCTION` | `https://abheeqyjzekiowkztfxv.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` | Supabase, the project whose address contains `abheeqyjzekiowkztfxv`, **Project Settings → API Keys**, `service_role` |
| `RESEND_API_KEY_WELCOME` | Your saved copy. Resend shows a key only once, so if you have none, create one in **API Keys** with **Sending access** on the `bingd.app` domain. Keep the old key for now |
| `WELCOME_POSTAL_ADDRESS` | The postal address the welcome email carries |

`nonprod`:

| Name | Value |
|---|---|
| `SUPABASE_URL_NONPROD` | `https://fjxhcbowoxuzulwirzyr.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY_NONPROD` | Supabase, the project whose address contains `fjxhcbowoxuzulwirzyr`, **Project Settings → API Keys**, `service_role` |

Do not add the Resend key or the address to `nonprod`. A dry run needs neither.

**Then wait** until the security PR is merged and an agent confirms that a scheduled Welcome email run and a scheduled Trending refresh have passed. The schedules are not exact, and Welcome has been running about every four hours, so allow a day.

**Then delete the repository copies.** In **Settings → Secrets and variables → Actions**, delete all six: the four above, `SUPABASE_URL_NONPROD` and `SUPABASE_SERVICE_ROLE_KEY_NONPROD`. Leave the variable `BINGD_PRODUCTION_TRENDING`.

**M-6 closes** when both scheduled jobs have passed again after the deletion. If you made a new Resend key, delete the old one only then. If a job fails, add the missing secret to its Environment again.

This is not a rotation. The audit found no sign the key was exposed.

### 3. Old welcome-email logs (m-3)

The repository is public, so its Actions logs are too. The worker no longer logs handles, but nine past runs still show one or two. Deleting a log cannot be undone, and the run record stays either way.

For each run, open `https://github.com/fourwardhabits/bingd/actions/runs/<id>`, open the **⋯** menu and choose **Delete all logs**.

```text
35363614512
35364208000
35765305951
36047171011
37075746208
38973914723
39518374765
40241193636
40427285105
```

### 4. Read-only production audits

Run these in the Supabase SQL editor on the production project. Each is one `select`, so it cannot change anything. The results hold account ids, so keep them out of anything public.

**Past invitations, at any time.** Before this fix, an account could be connected to somebody by opening a link. This lists accounts attributed more than a day after they signed up, which is where that could have happened without the person choosing it:

```sql
select ia.invitee_id, ia.inviter_id, ia.accepted_at, p.created_at, p.visibility
  from invite_attributions ia
  join profiles p on p.id = ia.invitee_id
 where ia.accepted_at > p.created_at + interval '24 hours'
 order by ia.accepted_at desc;
```

A row here is not proof of anything, because most will be people who tapped Accept. Private accounts are the ones to look at. What to do about them is your decision: nothing here removes a follow.

**Letterboxd mappings, after step 3.** Paste the whole of [`letterboxd-matches.sql`](../../supabase/audits/letterboxd-matches.sql). [letterboxd-match-audit.md](../ops/letterboxd-match-audit.md) explains the result. The matcher is safe from step 3, and the audit is only about what may already be wrong.

## Release record, 2026-11-03

All times UTC. Approved by the founder for `eab83c9`, covering one publish.

| Step | Result |
|---|---|
| Preflight | Production said `prod`, 172 applied, head `20261023000100`. Seven daily physical backups, newest 2026-11-02 06:50, all completed. PITR off. The dry run listed exactly the five files |
| Migrations | Applied 00:35. 177 applied, head `20261024000500`. B-1 closed here for every installed build |
| Existing rows | One statement touched any: `20261024000500` revoked 8 device tokens beyond the ten newest on one account. Live tokens went from 30 to 22, and no account is over ten |
| Production checks | `test:remote --target production` 136 of 136. Public card, private and unknown handles, four wildcards, anon on `profiles` and `media_items`, invitation privileges, and `redeem_invite` inert all as expected |
| Against staging | Every function, table, grant and policy equal at the same commit, apart from `rls_auto_enable` |
| Merge | `bebfdfb` at 00:40, a two-parent merge commit containing `eab83c9`. CI and the race suite passed on it |
| Website | Pages was live within about a minute. `router.mjs` byte-identical to `main`. A public profile shows its name, a private one stays generic, and `/i/` opens the production app |
| OTA | EAS run `01a19eda-2bb6-74dc-911e-2ec448d48dc8`, published 00:46. Android update `01a19ede-f160-7e82-b8bf-ba815c2d47e3`, group `04afb993`, runtime `ec79e181`. iOS update `01a19ede-f160-7e0d-8c94-9e3cfe34ab31`, group `ffbb473c`, runtime `8ea562b7`. Published commit `eab83c9`, log scan clean, and the served manifests name production and not staging |
| Push | `push_drain_status()` healthy after the `claim_push_batch` rebuild, nothing queued over 15 minutes |

The `/u/` card was generic for about six minutes, from 00:35 to about 00:41. Invitations could not be accepted from 00:35 until the OTA reaches each phone.

### What differed from the plan

- **The two invitation checks were not run on production.** Both would create accounts there, and the approval did not cover that. They stand on the staging scenarios, on three Android phone runs on the same commit, and on production's functions matching staging's.
- **So no real invitation has been accepted on production yet.** At release there were no `accept_invite` calls at all.
- **The phone test was Android only.** There is no iOS Preview binary on the current runtime.
- **No off-platform `db dump` was taken first**, which `founder-todo.md` suggests before a production migration. The approval did not cover copying production data to a laptop. Only one statement changed existing rows, as above.
- **The first run of the extra staging comparison failed**, reporting 132 functions different. 131 differed only in line endings, and the other was `rls_auto_enable`. The first website check also failed, on an account whose display name is part of its own handle: the handle appears in the page's deep link because it is in the address. The API answered zero rows, and the name did not appear. Both checks were corrected and rerun before going on, and the merge waited for the first.

### Still open

| Finding | State | Closes when |
|---|---|---|
| **M-5** Sentry query strings | Code fix live on 1.1.0 through the OTA. **1.0.1 has only the Sentry rule**, and nobody has confirmed it was added | A transaction from after the rule has an `http.client` span with no `http.query` and no `?` in `http.url` |
| **M-6** production key in repository secrets | `production` and `nonprod` exist, are `main`-only and are empty. All six repository secrets remain, and the jobs still use them | Secrets added to the Environments, both scheduled jobs pass, the six repository copies are deleted, and both pass again |
| **M-3 residual** | The anon key is closed. **A free signed-in account can still read every public account** through RLS, because the app has to, and nothing throttles the API | Its own piece of work: API rate limiting, not yet designed. `20261024000400` records this |
| **m-3** handles in old logs | Code fixed. Nine old public Actions logs still show one or two handles | The founder deletes them, section 3 above |
| Read-only production audits | Past invitations and Letterboxd matches have not been run | The founder runs them, section 4 above |

Steps for all of these except the M-3 residual are under [Other work, founder only](#other-work-founder-only).

Smaller items, none a security exposure:

- Accept stays on screen for up to 60 seconds after accepting, because the preview is cached and not invalidated. The server refuses the second press, and it writes only a ledger row.
- `qa-preview-invite-link.bingd.pages.dev` still answers. Its branch is gone, but Cloudflare keeps deployments. It has no Supabase config, and its invitations no longer exist.
- `feature/proactive-notifications` still must not go to any database as it stands. `integration/proactive-after-security`, #220, is the safe route.
