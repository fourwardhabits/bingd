# `push-sender`

The only thing that delivers a Bingd notification to a phone. Reads `push_outbox`, resolves
recipients and device tokens server-side, and posts to the Expo Push Service.

**Nothing in this directory holds a push credential.** The Apple key and the Firebase
service account live in EAS, and this function only ever handles the opaque
`ExponentPushToken[...]` the device already gave us. That is the same argument
[AD-8](../../../docs/architecture/README.md) makes for keeping the TMDB key in one place,
applied to two credentials instead of one.

---

## What it will not do

| | |
|---|---|
| Take a recipient | It takes **no input at all**. The request body is ignored. |
| Take a title or a body | Composed in `copy.ts` from the notification row. |
| Push something that was never written | `push_outbox`'s primary key **is** a notification id, `on delete cascade`. |
| Bypass a notification preference | There is no preference to bypass — see below. |
| Carry a private note | The query that feeds it has no column for one. |

### The preference axis, in one paragraph

`_apply_notification_preference` is a **before**-insert trigger that returns null for a
category the recipient switched off. A row a before-row trigger skips fires **no after-row
trigger**, and the enqueue is an after-insert trigger. So push is not "allowed by" the
preference; a suppressed notification does not exist to be pushed. One axis, enforced
structurally. ([`20260825000300`](../../migrations/20260825000300_a_notification_that_reaches_the_phone.sql))

The operating system's own permission remains independent, because it is the platform's to
hold.

---

## Who may invoke it

Any signed-in account, or `service_role`. `verify_jwt = true` in
[`config.toml`](../../config.toml), and `resolveCaller` additionally resolves the token to a
real user — the anon key is itself a valid JWT.

The gate is weak **because the caller chooses nothing**. An invocation is a nudge — "there
may be work" — and the reason an ordinary client is allowed to give one is that the person
who caused a notification is holding a phone at that moment, which makes their client the
cheapest scheduler available. A determined caller invoking in a loop buys a bounded query
against an empty queue.

### The scheduler, which used to be the one deliberate gap

`pg_cron` runs `_drain_push_outbox()` once a minute; it posts here through `pg_net` when — and
only when — `push_outbox` has something in it. `20260826000300`. Operations, failure modes and
the Vault secret it needs: [`docs/release/push-operations.md`](../../../docs/release/push-operations.md).

Nothing about *this function* changed. It still takes no input, still claims its own batch, and
still cannot be pointed at anybody — the scheduler is one more caller of the same weak gate.

The trigger still does no networking. A follow that rolled back because a notification service
was slow is the failure mode that argument was always about, and the scheduler sits outside the
write entirely: it reads a queue on a timer rather than being called from a transaction.

What it closed, quoted from what stood here before: *a notification created while nobody has the
app open waits until somebody does.* Usually milliseconds in a friend beta, where the person who
caused it is holding their phone. Never a guarantee, and three ordinary cases had no phone
behind them at all — an app killed between the write and the nudge, an `invite_welcome` written
when a token is redeemed, and every retry.

The client nudge remains, debounced to one call per ten seconds. It is now a latency
optimisation over the schedule rather than the mechanism.

---

## Delivery guarantee

**At least once, bounded at three settled failures and six claims.** `claim_push_batch` leases
rows for five minutes with `skip locked`, so a sender that dies between sending and settling
sends again when the lease expires. That is the right side to fail on for a notification.

The two ceilings are two different things and `20260826000200` exists because they used to be
one. `failures` counts sends the provider refused; `attempts` counts claims, including by
senders that died before sending anything. Conflating them stranded a row permanently: claimed
for the third time, killed before settling, and then `attempts < 3` excluded it from every
future claim while `settle_push_batch` — the only thing that deletes — never saw it again.
Undeliverable *and* undeletable, in a table documented as a queue that stays bounded with no
pruner. `claim_push_batch` now reaps rows past either ceiling that nothing is holding.

**Receipts are not polled.** Expo answers a send with a *ticket*; the final outcome is a
*receipt* fetched later from `/push/getReceipts`. Polling them needs a second scheduled
process and a table of ticket ids — a queue-processing platform for the one thing receipts
add over tickets, which is catching a token that died between the send and the delivery.
Send-time `DeviceNotRegistered` already catches the ordinary case, and the rest is caught on
that token's next send. Deferred deliberately.

---

## Founder checklist — Apple

Verify each step against Expo's current documentation before running it; the Apple console
moves things. None of this requires the engineering branch to build or test.

1. **App ID.** Apple Developer → Certificates, Identifiers & Profiles → Identifiers →
   `app.bingd`. Enable the **Push Notifications** capability. (EAS created this App ID
   during the first build; the capability is the part that has to be added.)
2. **APNs Auth Key.** Keys → **+** → tick **Apple Push Notifications service (APNs)** →
   Continue → Register. Download the `.p8`.
   - **It can be downloaded exactly once.** Keep it somewhere you will still have it in a
     year.
   - Note the **Key ID** shown beside it, and the **Team ID** from the membership page
     (`98729PG8GD`, per `eas.json`'s submit profile).
   - **One key serves both APNs environments.** A `.p8` is not sandbox-or-production, which
     is why a development build can be used to test iOS push before the release candidate
     exists.
3. **Give it to EAS.**
   ```powershell
   npx eas credentials --platform ios
   ```
   Choose the **production** profile, then *Push Notifications: Manage your Apple Push
   Notifications Key* → *Set up your project to use APNs*. EAS can also create the key for
   you if you let it sign in to Apple, which avoids the download-once problem entirely.
4. **Do not paste the `.p8` contents anywhere** — not a chat, not a ticket, not a
   screenshot. If it has been pasted, revoke it in the Keys list and make a new one.
5. **Expect the provisioning profile to be regenerated** on the next production build. The
   `aps-environment` entitlement changed from `development` to `production` in this branch,
   and a profile that does not grant it fails code signing. EAS handles this during the
   build; it is listed here so an unexpected credentials prompt is not a surprise.

## Founder checklist — Google

1. **Firebase project.** [console.firebase.google.com](https://console.firebase.google.com)
   → create or reuse a project for Bingd.
2. **Android app.** Add app → Android → package name **`app.bingd`** exactly. Download the
   generated **`google-services.json`**.
   - No SHA-1 fingerprint is needed for FCM. (It is needed for Google Sign-In, which this
     app does through Supabase rather than through Firebase.)
3. **Give the file to EAS**, as a file secret rather than a commit:
   ```powershell
   npx eas env:create --scope project --name GOOGLE_SERVICES_JSON `
     --type file --value ./google-services.json --environment production
   ```
   `app.config.ts` reads `GOOGLE_SERVICES_JSON` for the production lane and **refuses to
   resolve** without it, so a production build cannot be made that silently cannot receive
   a notification. `.gitignore` already names `google-services.json`; keep it that way.
4. **FCM V1 service account key.** Firebase → Project settings → **Service accounts** →
   *Generate new private key*. This downloads a JSON file. Then:
   ```powershell
   npx eas credentials --platform android
   ```
   → production → *Google Service Account* → *Manage your Google Service Account Key for
   Push Notifications (FCM V1)* → upload the JSON.
   - The legacy FCM server key is deprecated and no longer accepted; it must be the V1
     service account.
5. **Separate registrations for other lanes: only if you want push there.** A Firebase
   Android app is per package name, so `app.bingd.dev` would need its own app entry and its
   own `google-services.json`. **Production push does not need it.** It is worth doing once,
   before the release candidate, if you want to prove the Android path end to end — see
   below.

## Testing Android push before the release candidate

Android push cannot be exercised at all without `google-services.json` in *some* binary, and
a first exercise that happens inside the RC is an RC nobody can trust.

```powershell
# Register app.bingd.dev in the same Firebase project, download its google-services.json
$env:GOOGLE_SERVICES_JSON = "C:\path\to\dev-google-services.json"
npx eas build --profile development --platform android
```

`config/push.cjs` lets the **development** lane opt in through that variable and defaults to
not. With the variable unset — which is what every existing command does — the development
lane resolves to exactly the configuration that shipped before this branch, so nothing
changes for anybody who does not do this deliberately.

**iOS needs no equivalent.** A development build already carries `aps-environment:
development`, and the same `.p8` serves the sandbox, so step 3 of the Apple checklist is
enough to test iOS push on a development build today.

---

## Deploying

The migration has to be applied first, or every call answers "function does not exist":

```powershell
npx supabase db push --project-ref abheeqyjzekiowkztfxv
npx supabase functions deploy push-sender --project-ref abheeqyjzekiowkztfxv
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform and must not be
set by hand. **This function needs no secret of its own.**

## Checking it

```powershell
npx deno check --config supabase/functions/push-sender/deno.json supabase/functions/push-sender/index.ts
npx deno lint  --config supabase/functions/push-sender/deno.json supabase/functions/push-sender
npx deno test  --config supabase/functions/push-sender/deno.json --allow-net supabase/functions/push-sender
```

> The three `functions:*` npm scripts still name `tmdb-adapter` only, and this branch
> deliberately does not widen them. `package.json`'s `scripts` block is a **fingerprint
> source**: editing it moves the runtime version of every lane, including the published
> friend-beta binary, which would stop that binary receiving over-the-air updates. Widen
> them in the same change that builds the release candidate, when the fingerprint is moving
> anyway.

## Running it locally

```powershell
npx supabase functions serve push-sender
```

It will claim from whatever database `SUPABASE_URL` points at and really send. There is no
dry-run flag; a token in a nonprod database is a real phone.
