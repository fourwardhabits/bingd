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
  "base_url_set": true
}
```

*Verified on `bingd-nonprod`, 2026-08-25 02:09 UTC: job #2, `last_run.status = "succeeded"`.*

## 4. Reading the status

| Field | Healthy | What it means otherwise |
|---|---|---|
| `job` | present, `active: true` | `null` ⇒ nothing is draining. `schedule_push_drain()` |
| `last_run.status` | `succeeded` | `failed` ⇒ read `message`; usually the Vault secret or the URL |
| `queued` | small, moving | — |
| `older_than_15m` | **0** | **the number to alert on.** Rows arriving and nothing taking them |
| `base_url_set` | `true` | `false` ⇒ re-run the bootstrap script |

`older_than_15m` above zero for more than a drain interval is the symptom of every failure
mode below. Nothing else needs watching.

## 5. Failure modes

**Nothing is being delivered, `last_run` says `succeeded`, `older_than_15m` climbing.**
The tick is running and returning `unconfigured` — it raises a warning naming which of the two
inputs is missing and returns without posting. Check the Postgres logs for `push drain: not
configured`, then the Vault secret and `functions.base_url`.

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
