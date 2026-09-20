# vc12 QA triage — the two release blockers, answered

**Build:** 1.0.1 (12), EAS `d96ade7e-362a-4e86-ad07-59b1e1a2ae54`, from
`6d2f8455458afabc42d1cfd0a0bd68f5bd2ae343`. **Date:** 2026-09-20.

Two candidate blockers were raised after founder device QA. Neither survived measurement.
No client change was made and **vc12 remains the valid artifact**. Non-blocking UX
follow-ups are in [`../product/qa-follow-ups-2026-09-20.md`](../product/qa-follow-ups-2026-09-20.md).

---

## A. Push delivery — NOT a blocker. Working, with a bounded latency.

### `push.delivery_enabled` is not a kill switch. It is read by nothing.

Seeded `false` in `20260813000100` and never wired. A whole-repo search finds the seed row
and two comments *about* the row, and no reader anywhere — no migration, no function, no
edge function, no client. `20260917000800` records the history in passing: *"`push.delivery_enabled`
existed as a row nothing read, which meant the answer to 'stop sending' was a deploy."*
`20260923000100` dates it: *"existed for two weeks without being read by the code it was
meant to gate; PR #119."* PR #119 was never merged — its migration number,
`20260911000200`, is taken by the Helpful-reviews sort.

So, to the questions as asked:

| | |
|---|---|
| Is it the global delivery kill switch? | **No.** Inert. |
| Does `false` suppress recommendation or social pushes? | **No.** Nothing consults it. |
| Is `release.push_enabled` independent? | **Yes** — a separate key, on the Release Awareness path only. |
| Can normal push run while Release Awareness cannot send? | **That is already the state.** |
| Why is it `false`? | It is the seeded default of a switch that was never implemented. |
| Intentional, or a launch omission? | A known, documented omission — and **not** the cause of anything observed. |

**Nothing was enabled.** Flipping this key would have been a placebo: it would have
changed no behaviour and would have created a false belief that a kill switch exists.

**But a working stop does exist — it is just not this key.** `unschedule_push_drain()`
(`20260826000300`, `service_role` only) removes the `bingd-push-drain` cron job, and its
own comment is the operator's instruction: *"the first thing to reach for if the sender is
misbehaving — notifications keep arriving in-app, only the phone stops buzzing."*
`schedule_push_drain('* * * * *')` puts it back. So the lever the config key was meant to
provide is already there under a different name, which lowers the priority of wiring
`push.delivery_enabled` to roughly zero: the honest fix may be to **delete the misleading
row** rather than implement it.

### The pipeline is healthy end to end, proven on production

A synthetic probe — two throwaway accounts, a syntactically valid Expo token registered to
no device, one real `recommend_title` — walked every link:

```
recommend_title delivered          -> {"status":"ok","created":true,"delivered":true}
notification filed                 -> 1 row
_enqueue_push wrote push_outbox    -> state pending
push-sender claimed and sent       -> {"claimed":1,"sent":1,"failed":0,"revoked":1}
Expo answered                      -> DeviceNotRegistered (correct for a fake token)
queue row settled and left
```

Supporting facts: `push-sender` is deployed and ACTIVE (v5); the drain is a cron job
(`jobid 3`, `* * * * *`, active, last run succeeded, `healthy: true`, vault available);
20 device tokens are registered (13 Android, 7 iOS).

A real push to the operator's own Android device returned **ticket ok and receipt ok** —
Expo handed it to FCM successfully. So Expo credentials are correct on both legs.

### The observed delay is the drain interval, measured

With **no** client nudge, on production:

- **enqueued 261 ms** after the write (the trigger is synchronous, inside the transaction);
- **drained after 48.2 s** — the scheduled drain, which runs every minute.

So the worst case is bounded at roughly a minute plus provider time, and that is the
architecture rather than a fault.

**Why a follow felt instant and a recommendation felt late.** Both paths call
`nudgePushDelivery()` — `use-social.ts` and `use-recommend.ts` respectively. The nudge is
debounced in module state at **`NUDGE_INTERVAL_MS = 10_000`**: two nudges inside ten
seconds are one nudge. In a QA sequence where a follow and a recommendation are seconds
apart, the second nudge is swallowed and that push waits for the cron. Nothing about the
*type* differs — the divergence is the timing of the test, and the fallback behaved
exactly as designed.

Founder has since confirmed recommendation pushes arrive on Android with the app closed or
backgrounded, and that deep links route correctly. **Status: PASS.**

### Release Awareness cannot send, independently and structurally

Three separate reasons, any one of which is sufficient:

1. `release.push_enabled = false` on production (verified after the migration deploy);
2. **no release type is in `_push_eligible`** — the eligible list is `follow`,
   `follow_request`, `comment`, `mention`, `reaction`, `watch_tag`, `recommendation`,
   `recommendation_ranked`, `invite_activated`, `invite_joined`, `award_earned`,
   `goal_completed`, `import_started`, `import_completed`, `import_failed`. An unmapped
   type is *not* eligible, deliberately;
3. no function writes `notifications` or `push_outbox` on the release path — it is
   shadow-only by construction (`20260930000200`), and real sending needs a new migration
   plus founder approval.

Production evidence: the last 179 notifications contain **zero** release types, and
`release.shadow_enabled = true` / `release.push_enabled = false` are unchanged by this
work.

### The one real gap: there is no send record

`push_outbox` rows are deleted on settle and `notifications` has no `pushed_at`, so a push
that Expo accepted and failed to deliver leaves **no trace anywhere**. That is why the
earlier unobserved iPhone push can be neither confirmed nor refuted. `push-sender`'s own
header records the decision not to poll `/push/getReceipts`.

**P2 follow-up:** persist a minimal delivery outcome (ticket id, receipt status, settled
at) so "did it send?" is answerable without a live reproduction. Not a launch blocker.

---

## B. Performance — NOT a blocker. Not a scaling regression, and not PR #189.

Measured against production, three runs each (cold, warm, warm), for the operator's own
account. Account size: **96 rankings, 96 collection rows, 29 watchlist, 16 following, 18
followers, 150 own activities** — modest, not large.

| Read | cold | warm | warm | payload |
|---|---|---|---|---|
| Feed page (20 events, full projection) | 658 ms | 118 ms | 77 ms | 15 KB |
| Collection — ranked | 53 ms | 45 ms | 44 ms | 11 KB |
| Collection — band sizes | 45 ms | 44 ms | 44 ms | 5 KB |
| Collection — watched rows | 48 ms | 64 ms | 61 ms | 14 KB |
| Profile stats | 94 ms | 40 ms | 40 ms | — |
| Top Rated (For You input) | 162 ms | 103 ms | 103 ms | 2 KB |
| **`public_scores` (3 people × 20 titles, ONE call)** | **90 ms** | **60 ms** | **60 ms** | **5 KB** |

**Conclusion: the server is not what the founder was waiting on.** Total server time for a
Feed screen is well under a second, and most of the enrichment runs in parallel. A 3–6
second screen is cold app start, React Query's empty cache, three serial round trips
(follows → events → enrichment) at mobile RTT, and — dominant — poster images fetched per
row into a non-virtualised list. The small test account is faster because it has fewer
posters to fetch and fewer rows to lay out, not because a query scales badly.

**PR #189 is exonerated, specifically.** `public_scores` is **one** call per page, 60 ms
warm, 5 KB, running inside the existing `Promise.all` beside the notes and companions — so
it adds no round trip the feed was not already waiting on. The unit suite pins this: *"asks
once for the whole page, not once per card"* and *"asks about the page that just landed,
and never about the ones before it"* (10 assertions, passing). The server does one
`band_bounds` per distinct (person, category, band) named by the page, never one per row.

**Classification: P2**, cold-start and client-side rendering. No safe server-only fix
exists because there is no server-side problem to fix. **No client change is justified**,
so vc13 is not warranted on performance grounds.

The honest caveat: these numbers are from a desktop on a fixed line against a 96-title
account. They disprove a *server* scaling problem and disprove a PR #189 regression; they
do not characterise a 1,000-title account on mobile data. That remains the separate
scalability pass already on the roadmap.

---

## Verdict

Neither candidate is a release blocker. No backend change was made in this tranche beyond
the already-deployed `20261002000100`, no client code was changed, and **vc12
(`d96ade7e`, from `6d2f845`) remains the valid artifact.**
