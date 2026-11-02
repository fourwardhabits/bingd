# Security remediation: release order and manual steps

Written for: the founder, as the only person who can apply production changes.

This is the release plan for the fixes to the security audit of 2026-11-01. Nothing here has been applied to any environment. Agents do not apply production migrations, deploy, or publish production updates.

## Release order

Follow this order. The client calls functions that only exist after the migrations.

1. Merge the security PR.
2. Apply the five `20261024*` migrations to staging, then run the staging checks below.
3. Apply them to production.
4. Deploy the website.
5. Publish the app update.

| Step | Why it comes here |
|---|---|
| Migrations before the update | The update calls `accept_invite` and `invite_preview`. Without them, Accept fails |
| Migrations before the website | The website needs `public_profile_card`. The old website's profile read stops working when the migration lands, and it falls back to the generic page until step 4 |
| Installed apps | Safe from step 3, with no update. `redeem_invite` no longer connects anybody |

Between steps 3 and 5, an established account tapping Accept in an old build sees "This invitation is not valid". A brand-new account is attributed but not connected. Keep that gap short.

### After the migrations

Run these on staging first, then production.

| Check | Expected |
|---|---|
| `npm run test:remote` | Passes, including the anon checks |
| `bingd.app/u/<a public handle>` | Shows the name and picture |
| `bingd.app/u/<a private handle>` | Shows the generic page |
| Open an invite link, leave without tapping | No follow appears in either direction |
| Open an invite link, tap Accept | Both accounts follow each other |

## Manual steps

### 1. Sentry server-side scrub rule

The app fix only reaches phones that take the update, so this rule protects installed apps.

In Sentry, go to **Settings → Security & Privacy → Advanced Data Scrubbing** for the mobile project and add these rules:

```text
[Remove] [Anything] from [$span.data.'http.query']
[Remove] [Anything] from [$span.data.'http.fragment']
[Replace] [Regex Matches] \?.*$ from [$span.data.'http.url']
[Replace] [Regex Matches] \?.*$ from [$span.data.url]
```

Sentry's documentation confirms `$span`, quoted keys and these methods, but does not show this exact selector, and it has not been tried on this project. So check it: after saving, open a new production transaction, expand an `http.client` span and confirm `http.query` is gone and `http.url` has no `?`. If Sentry rejects a selector, use the rule builder's suggestions for the same field.

That same check on a transaction from before the rule also settles whether the audit's M-5 finding was happening in production.

### 2. GitHub production secrets

The `production` Environment exists and only `main` can deploy to it. Workflows on `main` still read the repository-level secrets until you move them, and until then a workflow pushed to any branch can read them too. GitHub never shows a secret's value, so this cannot be done for you.

In the repository, go to **Settings → Environments → production → Add environment secret** and add these. Copy the Supabase values from the Supabase dashboard:

- `SUPABASE_URL_PRODUCTION`
- `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION`
- `RESEND_API_KEY_WELCOME`
- `WELCOME_POSTAL_ADDRESS`

Run **Trending refresh** by hand with target `production`, and confirm it passes. Then delete `SUPABASE_URL_PRODUCTION` and `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` from **Settings → Secrets and variables → Actions**.

Keep `RESEND_API_KEY_WELCOME` and `WELCOME_POSTAL_ADDRESS` at repository level as well, because the nonprod welcome run reads them.

This is not a rotation. The audit found no sign the key was exposed.

### 3. Look back at past invitations

Before this fix, an account could be connected to somebody by opening a link. This read-only query lists accounts that were attributed more than a day after they signed up, which is where that could have happened without the person choosing it:

```sql
begin transaction read only;
select ia.invitee_id, ia.inviter_id, ia.accepted_at, p.created_at, p.visibility
  from invite_attributions ia
  join profiles p on p.id = ia.invitee_id
 where ia.accepted_at > p.created_at + interval '24 hours'
 order by ia.accepted_at desc;
rollback;
```

A row here is not proof of anything, because most will be people who tapped Accept. Private accounts are the ones to look at. What to do about them is your decision: nothing here removes a follow.

### 4. Letterboxd audit

See [letterboxd-match-audit.md](../ops/letterboxd-match-audit.md). The matcher is safe once the migration applies. The audit is only about what may already be wrong.

### 5. Old welcome-email logs

The repository is public, so its Actions logs are too. The worker no longer logs handles, but nine past runs of **Welcome email** still show one or two. Deleting a log cannot be undone, so this was left for you.

For each run below, open `https://github.com/fourwardhabits/bingd/actions/runs/<id>`, open the **⋯** menu and choose **Delete all logs**. The run record stays, and `welcome_emails` still holds who was written to.

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
