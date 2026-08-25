# Push operations

**Written 2026-08-26.** How a Bingd notification gets to a phone once nobody is holding one,
what can go wrong with it, and what to do about each thing.

Architecture — the schema, the preference gate, why the sender takes no input — is
[`../architecture/push.md`](../architecture/push.md). This is the operational half.

---

## 1. What changed, and why it had to

Until `20260826000300` the answer to *"what makes `push-sender` run"* was: **a client**.
`src/features/notifications/push.ts` nudges the function after the person causes something,
and that was defensible for a friend beta — the actor is holding a phone at that moment.

It does not survive a public launch, and the failure is the quiet kind: **the notification
arrives in the app and the phone never buzzes.** Nobody reports it, because nobody knows a
push was due. Three ordinary cases, none exotic:

- the actor's app is killed by the OS between the write and the nudge — the nudge is a `fetch`
  after a round trip, not part of the transaction;
- a notification with no client behind it. `invite_welcome` is written when a token is
  redeemed;
- a retry. `settle_push_batch` putting a row back to `pending` waits for somebody, somewhere,
  to happen to cause another notification.

Without a server-owned drain the retry path is decorative.

## 2. The mechanism

```
notifications INSERT
  └─ _apply_notification_preference   BEFORE, returns null if the category is off
       └─ _enqueue_push               AFTER, so a suppressed row never gets here
            └─ push_outbox

pg_cron  every minute
  └─ _drain_push_outbox()             no-op if the queue is empty
       ├─ app_config['functions.base_url']
       ├─ vault.decrypted_secrets → 'service_role_key'
       └─ net.http_post → /functions/v1/push-sender
            ├─ claim_push_batch(50)   for update skip locked, 5-minute lease
            ├─ Expo Push Service
            └─ settle_push_batch
```

`pg_cron` and `pg_net`, both first-party Supabase extensions, calling the Edge Function that
already exists. Deliberately **not** a queue platform, **not** a second Edge Function, and
**not** client polling.

Once a minute. Delivery is not real-time by construction — the lease is five minutes and a
retry is a drain later — so a minute of tail latency costs nothing and keeps the invocation
count readable.

**The tick does nothing when the queue is empty.** One count against a table that is empty
almost always, rather than 1,440 Edge Function invocations a day to be told there is no work.

### Security

- The service-role key is **not** in any migration, config table, or repository file. It is a
  Supabase Vault secret read by one `security definer` function no client role may execute.
- `functions.base_url` is *not* a secret and is deliberately not in the Vault — it is the
  project's own public URL. Putting a non-secret in a secret store makes the store's contents
  stop meaning anything. It is an `app_config` key, and `app_config`'s read policy is
  `key like 'public.%'`, so clients cannot read it either.
- `_drain_push_outbox` is granted to **nobody**. `pg_cron` runs it as the job owner, which owns
  it. A client that could call it could make the database post a service-role credential.
- Overlapping runs need no lock. `net.http_post` is asynchronous, and `claim_push_batch` is
  `for update skip locked` with a lease, so two senders claim disjoint work. That property
  belongs to the outbox, not the scheduler, which is why the scheduler holds no state.

## 3. Installing it

`20260826000300` attempts the whole thing during the replay and degrades to a notice if the
extensions are unavailable — the local harness has neither. On a real project:

1. Dashboard → Database → Extensions → enable **`pg_cron`** and **`pg_net`**.
2. `node scripts/bootstrap-production.mjs --target production --apply`
3. SQL editor, once:

```sql
select vault.create_secret('<service role key>', 'service_role_key');
```

Step 3 is not automated on purpose. A script that can install a service-role key is a script
that has to be trusted with where it puts it.

**Verify:**

```sql
select push_drain_status();
```

```json
{
  "environment": "prod",
  "job": { "jobid": 2, "schedule": "* * * * *", "active": true },
  "last_run": { "status": "succeeded", "ended": "…" },
  "queued": 0,
  "older_than_15m": 0,
  "base_url_set": true,
  "vault_available": true,
  "vault_secret_set": true,
  "problems": [],
  "healthy": true
}
```

**`healthy` is the field to read.** Everything else is there to say *why* when it is false;
see §4. It is `false` on any database where the drain is not fully installed — the harness
included — because a check that cannot confirm has to say no. That is the lesson of §11.

*Verified on `bingd-nonprod`, 2026-08-25 02:09 UTC: job #2, `last_run.status = "succeeded"`
— and see §11 for why that verification was not worth what it looked like.*

## 4. Reading the status

| Field | Healthy | What it means otherwise |
|---|---|---|
| **`healthy`** | **`true`** | **the only field to branch on.** False ⇒ read `problems` |
| **`problems`** | `[]` | each string is one reason nothing can be sent — see below |
| `job` | present, `active: true` | `null` ⇒ nothing is draining. `schedule_push_drain()` |
| `last_run.status` | `succeeded` | `failed` ⇒ read `message` |
| `queued` | small, moving | — |
| `older_than_15m` | **0** | rows arriving and nothing taking them |
| `base_url_set` | `true` | `false` ⇒ re-run the bootstrap script |
| **`vault_available`** | `true` | `false` ⇒ the Vault extension is not enabled on this project |
| **`vault_secret_set`** | `true` | `false` ⇒ store the key. **This is the one that was missing** |

`problems` uses stable strings, and they are matched on by
`supabase/tests/push-drain-acceptance.mjs`: `scheduler_not_installed`,
`scheduler_inactive`, `base_url_missing`, `vault_unavailable`,
`vault_service_role_key_missing`, `last_run_not_succeeded`, `outbox_stalled`.

> **`vault_secret_set` is a boolean and never a length or a prefix.** Both are fingerprints
> of which key is stored. Nothing in this pipeline returns the value to anybody.

### The live check

```
node supabase/tests/push-drain-acceptance.mjs            # health only, read-only
node supabase/tests/push-drain-acceptance.mjs --probe    # also enqueues one real push
```

Not an `npm run` script on purpose: `package.json`'s `scripts` block is an
`@expo/fingerprint` input, and adding a line to it moves the beta lane's runtime version
and strands the published friend beta. It **fails** on a project that predates
`20260826000700`, rather than falling back to the older, weaker check.

`--probe` creates two throwaway accounts, registers a deliberately invalid Expo token,
triggers one follow, and watches the row without ever calling `push-sender` itself. It
tears both accounts down afterwards. A revoked token and `sent: 1` is a pass: the claim is
what is being proved, not delivery to a real handset.

## 5. Failure modes

**Nothing is delivered while `last_run` says `succeeded`.** *This was possible until
`20260826000700` and is not any more* — it is the incident in §11. A tick that has work and
cannot send now **raises**, so `last_run.status` reads `failed` and its `message` names
which input is missing. If you are looking at a project where this still happens, that
project has not had `20260826000700` applied, and
`push_drain_status().healthy` will be absent rather than `false`.

**`last_run` is `null` and the job exists.** `pg_cron` has not fired yet; it runs at the top of
the next minute. If it stays null past two minutes, `pg_cron` is installed but not running
jobs — check the extension is enabled in the `postgres` database.

**Rows accumulate with `failures` climbing.** Delivery is failing at Expo. `last_error` carries
the redacted message. Three failures and the row is deleted — the in-app notification is the
record and it already arrived.

**A device stops receiving.** Expo reported `DeviceNotRegistered`; `settle_push_batch` revoked
the token rather than deleting it, so the next `register_device_token` un-revokes it. Signing
out and back in fixes it.

## 6. Stopping it

```sql
select unschedule_push_drain();
```

Notifications keep arriving in-app. Only the phone stops buzzing. This is the first thing to
reach for if the sender is misbehaving — it is reversible with `schedule_push_drain()` and
costs nothing but delivery latency, because the outbox keeps the work.

To also stop *enqueueing*, drop the trigger — but prefer the above: an outbox that fills while
the drain is off drains when it comes back, and a missing enqueue is a notification that never
becomes a push at all.

## 7. Retry semantics — `20260826000200`

The old schema counted one thing and used it for two. `attempts` incremented **on claim** and
was then read as "how many times delivery has failed":

```sql
claim:  where o.attempts < 3
settle: delete ... where delivered or o.attempts >= 3
```

Those agree until a sender dies. Claimed for the third time → `attempts = 3` → the function is
killed before `settle` → the lease expires → **`attempts < 3` is false, so no sender ever
claims it again, and `settle_push_batch` is the only thing that deletes.** The row is
undeliverable *and* undeletable, in a table documented as a queue that stays bounded with no
pruner. It did not need the third *failure* either: a row that never failed at all, claimed
twice by senders that died, was on its last life.

Now:

| | Counts | Ceiling | On reaching it |
|---|---|---|---|
| `failures` | settled delivery failures | 3 | deleted by `settle_push_batch` |
| `attempts` | claims, including by senders that died | 6 | deleted by the reaper in `claim_push_batch` |

Six is three deliveries' worth of failure plus three senders dying. The reaper only takes rows
nothing is holding — `pending`, or `claimed` with an expired lease — so a sender is never
reaped out from under itself.

### A late reply lands on nothing

`settle_push_batch` matched on `notification_id` alone, which is one identifier short. A sender
that stalls past its five-minute lease has already had the row taken by the next drain, and its
late reply would then land on the **replacement's** in-flight row: back to `pending`,
`claimed_at` cleared, a failure charged to a delivery still running — and a third drain claims
it immediately and sends the same notification alongside the sender that never lost it.

Two predicates now, and the first is not enough on its own. The lease must be live *and* the
result must echo the claim generation — `attempts`, which is incremented on every claim and so
already is one, handed back by `claim_push_batch` as `attempt`. The lease alone cannot tell the
stalled sender from its replacement, because the replacement's lease is live too.

A result with **no** `attempt` is still accepted, on the lease alone. That is the deploy window
and nothing else: migrations land before functions, so for a few minutes a sender built before
this change talks to a database built after it, and refusing those results would mean every push
in that window retried to the ceiling — duplicate notifications to real people.

`settle_push_batch` returns `stale`: results that matched no live claim. Non-zero is the one
number that says a sender is slower than its own lease.

Delivery is still **at least once**, bounded, and `push-sender` gained one field it echoes back
and chooses nothing about.

## 8. Accepted, not fixed

**A registration in flight past sign-out can attach a device to the account that left.**
`releaseDeviceOnSignOut` moves an epoch, waits up to three seconds for every dispatched write,
then revokes. A registration RPC that lands *after* that window writes `device_tokens.user_id`
for the departing account, and its compensating revoke fails because the session is gone.

**Accepted for public v1.** It needs a registration in flight at the exact moment of sign-out,
an RPC slower than three seconds, *and* nobody signing in on that device afterwards — because
`register_device_token`'s `on conflict (token) do update` moves ownership atomically on the
next sign-in, in one statement, with no window in which the device belongs to both. Closing the
remaining sliver needs ownership epochs or a JWT held past sign-out, which is device-session
infrastructure for a case the next sign-in already repairs.

Recorded in [`public-launch-risk-register.md`](./public-launch-risk-register.md).

## 9. Receipts

Deliberately not polled. Expo answers a send with a *ticket*; the final outcome is a *receipt*
fetched later from `/push/getReceipts`. Polling them needs a second scheduled process and a
table of ticket ids — a queue-processing platform for the one thing receipts add over tickets:
catching a token that died between the send and the delivery. Send-time `DeviceNotRegistered`
already catches the ordinary case. Recorded in `../product/deferred-roadmap.md`.

---

## 10. Why the founder receives nothing outside the app — diagnosis, 2026-08-26

Traced end to end on `abheeqyjzekiowkztfxv` (nonprod) rather than reasoned about, because
every layer below is downstream of one fact.

### The measurement

```
device_tokens (live)        0
device_tokens (ios)         0
device_tokens (android)     0
notifications (total)      16
push_outbox (queued)        0
```

**Nothing downstream of that first line can be the cause.** Sixteen notifications have been
written and not one phone is registered to receive any of them. `claim_push_batch` drops a
job whose recipient has no live device — correctly, since a token arriving tomorrow should
not produce a buzz about a follow from today — so the empty outbox is the pipeline working
as designed on an empty registry, not evidence that it drained anything.

So the question is not "why did delivery fail" but **"why has no device ever registered"**,
and that has a different answer per platform.

### Android — classification **E: the current beta binary cannot receive push**

`config/push.cjs`:

```
declaresPushNatively('beta')  ->  false
googleServicesFileFor('beta') ->  null
```

No `google-services.json` is compiled into the beta binary, so the app has no FCM sender
id, `getDevicePushTokenAsync` fails, and `getExpoPushTokenAsync` throws. `acquirePushToken`
catches it and returns null, which is why this fails *silently* — the client is behaving
exactly as designed for a device that cannot mint a token.

This is a **native input**. It cannot be changed over the air. Works on the current beta:
**no**. New binary required: **yes**.

### iOS — classification **E**, by a different mechanism

`apnsEnvironmentFor('beta')` returns null, so the `expo-notifications` plugin writes its own
default and every binary this project has produced carries **`aps-environment: development`**
— the APNs *sandbox*. Beta is `distribution: store` in `eas.json`, i.e. TestFlight, where the
token a device is issued belongs to the **production** APNs environment.

`expo-application`'s `getIosPushNotificationServiceEnvironmentAsync()` reads that same
entitlement and `getExpoPushTokenAsync` defaults its `development` flag from it, so Expo
addresses the sandbox for a token that only production APNs will accept.

Also a native input. Works on the current beta: **no**. New binary required: **yes**, taking
`mode: 'production'` with it.

### And a second thing that would bite immediately afterwards — **D: missing server credential**

Even with a binary that can register, Expo Push Service needs the credentials held against
the EAS project: an **APNs `.p8`** and an **FCM V1 service account**. Neither could be
verified from this environment — it has no EAS token — so this is *unproven rather than
absent*, and the checklist to settle it is in
[`../../supabase/functions/push-sender/README.md`](../../supabase/functions/push-sender/README.md).

Do not treat the binary fix and the credential fix as one task. They fail identically from
the outside (nothing arrives) and are diagnosed in opposite places.

### What is **not** the cause

Ruled out, so nobody spends a day on them:

- **The client.** `usePush` registers on a ready session, follows a rolled token, routes a
  tap and nudges the drain. It is correct and it is the reason the failure is silent.
- **The backend dispatch.** The trigger, the outbox, the lease and the sender are all in
  place and tested; there is simply nothing addressed to send to.
- **`push.delivery_enabled`.** It reads `false` on nonprod and **nothing consumes it** — it
  is seeded by `20260813000100` and never read. A vestigial AD-10 flag, not a switch. Worth
  deleting or wiring, and it is neither today.

### Founder actions, in order

1. **APNs auth key** and **FCM V1 service account** into EAS credentials — the checklist in
   `push-sender/README.md` §Apple and §Android.
2. **Build a new binary** with `BINGD_LANE=beta` *after* `config/push.cjs` gives beta
   `mode: 'production'` and a `google-services.json`. That is a one-line change to
   `apnsEnvironmentFor` and a decision about the file, and it is deliberately not made here:
   it moves the beta lane's fingerprint, which strands every existing tester's over-the-air
   updates until they reinstall. It belongs in the change that builds the release candidate.
3. **Exercise it on a development build first.** iOS needs nothing extra — a development
   build already carries `aps-environment: development` and the same `.p8` serves the
   sandbox. Android needs `GOOGLE_SERVICES_JSON` set for one development build; `config/push.cjs`
   already supports exactly that opt-in.

Until step 2 ships, the onboarding notification step says so rather than claiming success —
see `features/onboarding/NotificationStep.tsx`, which reports what `registerThisDevice`
actually managed rather than what was asked for.

---

## 11. The drain was dead for a day and every observable said otherwise — 2026-08-26

The §10 diagnosis ended on two founder actions and one suspicion: that the Vault secret was
*stale*. Measured properly, it was worse and simpler.

### What was measured

| | |
|---|---|
| `vault.secrets` | **0 rows.** Queried as `postgres` with `select` privilege confirmed. The secret had never existed |
| `net._http_response` | **empty**, and the first row ever written to it has `id = 1` — see below |
| `cron.job` #2 | active, `* * * * *`, owner `postgres` |
| `cron.job_run_details` | **1,221 runs over twenty hours, every one `succeeded`**, `return_message` always the string `1 row` |
| `functions.base_url` | correct |
| `POST /functions/v1/push-sender` with the service key | `200 {"claimed":0,...}` |

### Classification: **A — the Vault secret was missing**, not stale

`_drain_push_outbox()` reads two inputs. The URL was right; the key was absent, so the
function took its `unconfigured` branch, raised a `warning` into a Postgres log nobody was
reading, and **returned normally**. pg_cron can only conclude "failed" from a function that
raises, so it wrote `succeeded` — 1,221 times, over a pipeline that had never made one
outbound request.

Nothing was wrong with pg_cron, pg_net, the base URL, the sender, its authentication, or the
outbox's claim semantics. Each of those was checked and each was fine.

### The fix, and the proof

The key was stored with `vault.create_secret(...)` under the name `service_role_key`. Then,
without anything invoking the sender by hand:

```
net._http_response  id=1  status_code=200  created=22:33:00.107+00
                    content={"claimed":1,"sent":1,"failed":0,"revoked":1}
```

`id = 1` is the whole story: that is pg_net's first-ever request from this database. The row
enqueued at 22:32 was claimed and gone by the 22:33 tick. `revoked: 1` is the probe's
deliberately invalid Expo token being retired, which is correct behaviour.

### What was actually the defect

**The missing secret was an operator action. A health check that could not see it is a code
defect**, and it is fixed in `20260826000700`:

- `_drain_push_outbox()` **raises** when it has work and cannot send, so the cron run
  records `failed` and `last_run` stops lying. It stays silent on an empty queue, so an
  un-bootstrapped project does not manufacture an alarm out of an idle scheduler.
- `push_drain_status()` gained `vault_available`, `vault_secret_set`, `problems[]` and one
  `healthy` boolean that is false if any dependency is missing — including on a database
  where the drain is not installed at all. Fail-closed means a check that cannot confirm
  says no.
- `supabase/tests/push-drain.test.mjs` runs in CI and asserts each of those failures.
- `supabase/tests/push-drain-acceptance.mjs` asks the same questions of a real project.

### The order to diagnose in, next time

1. `node supabase/tests/push-drain-acceptance.mjs` — one command, and `healthy` is the answer.
2. If it will not run: count `device_tokens` first. Zero means no phone is addressable and
   nothing below it can matter (§10).
3. Only then look at the drain.
