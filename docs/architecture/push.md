# Push notifications

**Status:** built, not deployed, not credentialed. Added 2026-08-24 on `public/push-v1`.

Specification: [PRD §15](../product/PRD.md) · AD-10 ·
[`deferred-roadmap.md` §4](../product/deferred-roadmap.md)

This document is the architecture. The founder-facing credential checklist and the deploy
commands are in [`supabase/functions/push-sender/README.md`](../../supabase/functions/push-sender/README.md).

---

## 1. The correction this tranche starts from

`deferred-roadmap.md` §4 concluded, twice, that **no new native binary would be needed** to
turn push on — because `expo-notifications` and its config plugin have been in every build
since the first one, which is exactly what PRD §15 bought them for.

That conclusion was wrong, and the proof is in the installed plugin
(`expo-notifications@57.0.10`, `plugin/build/withNotificationsIOS.js`):

```js
const withNotificationsIOS = (config, { mode = 'development', ... }) => {
  config = withEntitlementsPlist(config, (config) => {
    if (!config.modResults['aps-environment']) {
      config.modResults['aps-environment'] = mode;
    }
```

The plugin entry passed only `{ color }`. So **every binary this project has ever produced
carries `aps-environment: development`** — the APNs *sandbox*. A production binary with
that entitlement registers against a service the production sender never talks to, and
nothing about it looks wrong.

Android was the same conclusion by a different route: FCM needs `google-services.json`
compiled into the binary, and `android.googleServicesFile` was declared nowhere.

Both are native inputs. Neither can be changed over the air. **Push gates a new native
build**, and that is why the configuration lands before the release candidate rather than
after it.

## 2. The fingerprint, and why the config is shaped the way it is

The runtime version policy is `fingerprint`, so an update is offered only to builds whose
native fingerprint matches. Any movement in the `beta` lane's fingerprint strands the
published friend-beta binary: it stops seeing updates, silently, and the only fix is
redistributing a build.

Two facts were measured against this project with `@expo/fingerprint@0.20.7` rather than
assumed:

1. **The source of `app.config.ts` is not hashed.** Appending a comment to it moves no
   hash. What is hashed is the *resolved* config — so a value produced for one lane only is
   invisible to the others.
2. **A module `app.config.ts` requires *is* hashed.** `config/backends.cjs` appears in the
   source list as `expoConfigPlugins`, and adding a second required file moved all four
   lanes, beta included.

Hence `app.config.ts` requires `config/push.cjs` **from inside a branch** rather than at the
top of the file. A lane that never takes the branch never loads the module and never sees it
in its hash. That is not a style choice: moving the `require` to the top would strand the
friend beta while changing nothing whatsoever about the beta binary.

The same fact is why an unconfigured lane produces **no key** rather than the plugin's
default written out loud. `{ color, mode: 'development' }` and `{ color }` build identical
binaries and hash differently.

### Other fingerprint sources this branch therefore did not touch

`.gitignore`, `eas.json`, `package.json`'s `scripts` block, `package.json` dependencies, and
`config/backends.cjs` are all hashed. Editing any of them moves every lane. The three
`functions:*` npm scripts still name `tmdb-adapter` only for this reason; widening them
belongs in the same change that builds the release candidate.

### Measured result

| Lane | Before | After | |
|---|---|---|---|
| `development` | `228b22db` | `228b22db` | unchanged; opt-in only |
| `preview` | `c1ab2d82` | `c1ab2d82` | unchanged |
| `beta` | `b96812ac` | `b96812ac` | **unchanged** |
| `production` | `3cfe9626` | moves | **new binary required** |

Beta and preview are byte-identical **with and without `GOOGLE_SERVICES_JSON` set**, which
is the realistic accident — the founder configuring a secret for production and every other
lane quietly inheriting it. `config/push.test.mjs` asserts it.

> Absolute hashes are machine-dependent (they include `node_modules` paths); the
> before/after comparison within one checkout is the meaningful signal.

## 3. The native surface, frozen

After this merges, **no new native dependency, Expo plugin, `app.config.ts` iOS/Android/
plugin setting, entitlement, or Android service configuration** should be added before the
production release-candidate build without a founder decision. The purpose is to make the
next production binary the intentional RC rather than an intermediate one.

Files and settings inside the freeze:

- `app.config.ts` — `ios`, `android`, `plugins`, `updates`, `runtimeVersion`, `extra`
- `config/push.cjs`, `config/backends.cjs` — loaded during config resolution, hashed
- `package.json` — dependencies **and** the `scripts` block
- `package-lock.json`
- `eas.json`
- `.gitignore`
- `assets/brand/icon.png`, `icon-adaptive.png`, `splash.png`
- Every installed Expo config plugin, and the native modules autolinking picks up

## 4. The preference axis — one axis, enforced structurally

`20260819000300` left this open in writing: when push arrived it would have to decide
whether the eight notification categories governed delivery too, or whether delivery needed
its own axis.

**One axis.** A notification type that is switched off is never *created*, so there is
nothing to deliver.

The mechanism is not a second check, and that is the point:
`_apply_notification_preference` is a **before**-insert trigger that returns null for a
suppressed category, and a row a before-row trigger skips **fires no after-row trigger**.
The enqueue is an after-insert trigger. So push cannot observe a suppressed notification —
not by agreement, but by construction. There is no push preference to bypass because there
is no second axis.

No per-channel settings were added. The operating system's own permission remains
independent, because it is the platform's to hold.

**Eight of the ten types are pushed.** `follow_approved` is excluded by PRD §15's own event
table (Push: No), and `award_earned` has no writer. `_push_eligible` is the list, and an
unmapped type is **not** eligible — the opposite of the preference trigger's rule for an
unmapped category, because a missing notification is a bug somebody can see and an
unreviewed push is not.

## 5. Device tokens

`device_tokens` has existed since `20260813000900` with no writer on any client and no read
policy. The table shape is reused; it gained `updated_at` and a length constraint.

**The token is globally unique, and that is load-bearing.** A push token identifies a
physical installation, not a person. One phone that two people sign into in turn produces
one token, and that token must name whoever is signed in *now*. A per-user key would let
both hold live rows for the same device, and the sender would deliver A's notifications to a
screen B is holding — with a name and a film title on it, and nothing about the app looking
wrong.

| | |
|---|---|
| `register_device_token(uuid, text, text)` | `authenticated`. `assert_can_write`, `_claim_operation`, then an upsert on the token — which is what moves a device between accounts, in one statement. |
| `revoke_device_token(uuid, text)` | `authenticated`. Own rows only, and answers `ok` either way so it cannot report whether a token exists. **Deliberately skips `assert_can_write`** — see `moderation.test.mjs`. |
| Read | Nobody. No policy since 2026-08-13, including for the owner. |

The account-switch case is safe on both sides: sign-out revokes, and if that fails,
registering moves the row anyway.

**A sign-out during an in-flight registration is the third side**, and it was found by
review rather than by design. Registering is two network round trips; a sign-out during
either of them finds no token to revoke — because none has been written yet — and the write
then lands *after* the revoke, leaving the device addressed to an account that has gone.

Two mechanisms, because one was not enough:

- **`pushSessionEpoch`** moves on every sign-out and is compared either side of both
  awaits. A registration that has not written yet abandons itself; one that has **revokes
  what it wrote**.
- **`trackDispatchedWrite`** announces the write to sign-out, which waits for **every**
  one in flight — three paths can start a registration and they can overlap, so waiting on
  the newest and returning would leave an older, slower one to land unauthenticated. Bounded
  at three seconds, and only when one is genuinely in flight. Without this the compensating
  revoke races `supabase.auth.signOut()` for the session it needs, which a re-review was
  right to call the original hole merely narrowed. Only the *write* is announced, not the
  token acquisition before it: that can hang for a long time on a bad connection, sign-out
  must not, and a registration still at that stage has written nothing to release.

Past the three seconds the backstop is the server's move-on-conflict, as it always was.

## 6. Delivery

```
notification insert
  → _apply_notification_preference (BEFORE, may drop the row)
  → _enqueue_push               (AFTER, so a dropped row enqueues nothing)
  → push_outbox                 (PK = notification_id, ON DELETE CASCADE)
  → push-sender                 (claim → Expo Push → settle)
```

`push_outbox`'s primary key **is** the notification id, so a row cannot exist without a
notification and cannot survive one — which is what makes a fabricated push
unrepresentable, and what makes `block()` take its pending pushes with it. Settled rows are
deleted rather than marked, so the table is a queue and not a delivery log: nothing here
holds a second, weaker copy of somebody's inbox.

`claim_push_batch` and `settle_push_batch` are granted to `service_role` alone. They resolve
recipients and hand back tokens, which makes them the two functions in this schema it would
be worst to grant to a client.

**`claim_push_batch` applies `can_discover_profile`**, the same predicate
`my_notifications` applies and for the same reason: `block()` deletes the notifications that
exist when it runs, so a writer that passed its visibility check and committed afterwards
leaves a row behind. The inbox already refuses to draw that row; this refuses to push it.

**Delivery is at least once, bounded at three attempts.** Rows are leased for five minutes
with `skip locked`.

**A partial success is settled rather than retried.** The queue is keyed on the
notification, not on the (notification, token) pair, so a retry re-sends to *every* live
token the recipient has. Where one of two devices accepted and the other failed retryably,
retrying would buzz the first phone again on every attempt — up to three times for one
event. The second device misses that push instead, which is the failure the product can
absorb: the in-app row is the notification and it is already on both devices. The complete
fix is per-token attempt tracking, and it buys a second delivery of a message the account
has already received.

### Provider

Expo Push Service. Sending to APNs and FCM directly would mean this function holding two
more long-lived private credentials and the client handing up a *native* token, which is
different on every platform and variant. The credentials live in EAS instead, and
`push-sender` holds no secret at all. No vendor SDK: `expo-server-sdk` brings a retry
policy, a rate limiter and a receipts poller, and this needs about forty lines of it.

### What triggers a drain

**Two things now, and it used to be one.**

`pg_cron`, once a minute, calling this same function through `pg_net`. `20260826000300`, and
the operational half is [`../release/push-operations.md`](../release/push-operations.md). The
trigger still does no networking — a follow that rolled back because a notification service
was slow is exactly the failure mode this architecture refused, and the scheduler sits outside
the write entirely, reading a queue rather than being called from one. The tick does nothing at
all while `push_outbox` is empty, which it is almost always.

And the app still nudges: on session ready, on foreground, and after each write that can create
a notification (follow, follow-request response, comment, reaction, recommendation, watch tag).
Debounced to one call per ten seconds. **The client chooses nothing by nudging** —
`push-sender` takes no input at all — so the nudge is a latency optimisation over the schedule
rather than a second mechanism.

The gap this closed was stated plainly for as long as it existed: *a notification created while
nobody has the app open waits until somebody does.* Survivable for a friend beta, where the
person who caused it is holding their phone. Not survivable publicly, and the three cases were
ordinary rather than exotic — an app killed between the write and the nudge, an
`invite_welcome` with no client behind it at all, and a retry, which nobody is holding a phone
for by definition.

## 7. Permission timing

PRD §15: never at first launch; after the first follow or the first invite.

`usePush` runs on every launch of every session and **never asks**. It reads the OS state
and registers when permission already exists. Asking is `offerPushPermission`, called from
exactly two places: the `follow` success path in `use-social.ts`, and the
`invite_link_created` branch of `createInviteLink`.

A native alert precedes the OS dialog. Two dialogs is not a pattern to reach for lightly and
it is right here for one reason: **a "Not now" costs nothing and a "Don't Allow" costs
everything.** The OS answer is permanent in practice; ours is not, so the cheap question
goes first.

`push.offered` is written whichever button is pressed, so the question is asked **once
ever**. There is no path back from "Not now" inside the app today — a real gap, recorded in
§9 rather than hidden.

## 8. Foreground behaviour and routing

A push that arrives while Bingd is open shows **nothing**. The inbox row is the
notification; the push is transport for it, and a banner over an app already showing the
bell is the same fact told twice. What happens instead is that the inbox query is
invalidated, so the bell and the list update.

No badge. `setBadgeCountAsync` is never called, and a number that only ever goes up is worse
than no number.

A tap resolves through `hrefForPush`, which enters the **same** `targetChainFor` resolver
the inbox uses. The payload carries exactly the three fields that resolver reads, plus the
notification id. Staleness matters more here than in the inbox — the payload was composed
when the notification was written and may be tapped days later — so the chain ends at the
inbox itself rather than at "stay where you are": a tap from the notification centre has
nowhere to stay.

The payload is read defensively. An unrecognised kind resolves to the inbox rather than
throwing, because that code path is a cold start from a tap.

## 9. What is deliberately not built

- **A scheduler.** §6.
- **Receipt reconciliation.** Expo answers a send with a *ticket*; the final outcome is a
  *receipt* fetched later. Polling them needs a second scheduled process and a table of
  ticket ids. Send-time `DeviceNotRegistered` already catches the ordinary uninstall, and
  the rest is caught on that token's next send.

  The consequence, since a review raised it as a defect rather than a deferral: **a token
  that dies between the send and the delivery is reported only in the receipt**, so that
  send is recorded as delivered and the token stays active until its *next* send returns
  `DeviceNotRegistered` synchronously. It self-heals one notification late. That is the
  whole of what receipt polling would buy, and it is why it is not built.
- **Per-token retry accounting.** §6.
- **A way back from "Not now".** Settings → Notification Settings is where a "turn on push"
  row would go.
- **The scheduled nudge** (PRD §15). It ships with push in the PRD's plan and is not in this
  tranche.
- **Per-channel preferences.** §4 — deliberately, and reversibly.
- **Push for `follow_approved` and `award_earned`.** §4.
- **Analytics events.** Failures go to Sentry with a stage, a platform and a safe category.
  `lib/analytics.ts` is a closed vocabulary of thirteen product events, and "push
  registration failed" is operational rather than something anybody will build a funnel on.
  **No push token reaches any vendor**: `redactTokens` strips token-shaped and long opaque
  runs from every message before it leaves the device, and `push.test.ts` asserts it over
  every reported call rather than over one.

## 10. Deployment classification

| | |
|---|---|
| OTA candidate | **No.** The client half would ship over the air, but it cannot work without the native entitlement and FCM configuration. |
| New native RC build required | **Yes.** `aps-environment` and `googleServicesFile` are native inputs. |
| Can the current friend-beta binary receive this | **No**, and its fingerprint is deliberately unchanged so it keeps receiving everything else. |
| Migration deploy required | Yes — `supabase db push`. |
| Edge Function deploy required | Yes — `supabase functions deploy push-sender`. |
| Credentials required | APNs `.p8` + Key ID + Team ID; Firebase Android app `app.bingd` + `google-services.json` + FCM V1 service account. |
