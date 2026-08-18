# Growth instrumentation — what is measurable, and what is not

Written 2026-08-17 with friend recommendations (`20260817001300`). The founder's question
is *which users eventually bring in new users*, and the honest answer today is a short
list plus a longer one of what would have to exist first.

The rule this document exists to enforce: **opening an OS share sheet is not an
invitation sent.** The sheet can be dismissed, the message can be deleted unsent, and
nothing in this app will ever know either way. Any metric named `invite_sent` that counts
share-sheet opens is a number that will be believed and is wrong.

---

## 1. The invite funnel

| Stage | Reliable today | Where it lives |
|---|---|---|
| **Link created** | **Yes** | `invite_link_creations`, one row per `create_invite_link` call |
| **Link opened** | **No** | nothing to write it |
| **Redeemed / signup attributed** | **No** | `invite_attributions.accepted_at`, column exists, no writer |
| **Activated** | **No** | `invite_attributions.activated_at`, column exists, no writer |

### The one place a stage of this funnel is now on screen

**Bingd Awards has an Invite Instigator track, and as of 2026-08-18 it reads the bottom
row of that table rather than the top one.** It counts

```sql
select count(*) from invite_attributions
 where inviter_id = auth.uid() and activated_at is not null;
```

which is **zero for every account and will stay zero until §1's wiring lands**. That is
the intended state, and it is the reason this section exists rather than a footnote.

The award previously counted `invite_link_creations`, which made it a badge for pressing
a button — exactly the confusion the rule at the top of this document exists to prevent,
promoted to a reward. The founder's instruction was that the award is for bringing people
to Bingd, so the metric was changed to the honest one immediately and the number left at
zero, rather than the semantic being left wrong until the backend caught up.

**`activated_at` rather than `accepted_at`**, of the two unwritten columns. Both mean a
real account with reliable attribution; activation additionally means the invitee did
something with it, which is what makes a reward farm-resistant — the reason
`20260813001300` put the column there in the first place. Moving the award to
`accepted_at` later is a one-line change in `use-awards.ts` and a product decision, not a
correction.

**What Beta Hardening owes this award** is nothing of its own: items 1–5 below are the
whole dependency. The day `redeem_invite` and the activation writer exist, Invite
Instigator starts counting with no client change, no migration and no threshold rewrite.
Its tiers — 3, 15, 50 — are set on the assumption that they are being counted honestly.

Until then the row shows `0 / 3` and `Next: Bring 3 people to Bingd`. It is deliberately
**not** rendered as unavailable: the read succeeds, the table is real, and the answer is
genuinely none. A row that said "could not load this one" would be claiming a failure
that did not happen.

### What "created" actually means

`create_invite_link(operation_id, media_item_id)` returns the caller's **one reusable
personal link** (PRD §17), minting it on first use and never rotating it. It writes one
row to `invite_link_creations` every time it is called, carrying the title that was on
screen when the reader tapped *Share with someone not on Bingd*.

So the metric is **"how many times did this person reach for their link, and about
what"**. That is a real intent signal and it is the strongest one available without a web
property. It is deliberately *not* called a send.

The count is not exposed anywhere in the app. No profile number, no leaderboard, no
badge, no reward. The founder asked for the instrumentation without the promise, and a
visible number is the promise.

```sql
-- Who reaches for their link, and how often.
select inviter_id, count(*) as links_created, max(created_at) as last
  from invite_link_creations
 group by inviter_id
 order by links_created desc;

-- Which titles people share off-platform.
select m.title, count(*) as shares
  from invite_link_creations c
  join media_items m on m.id = c.media_item_id
 group by m.title
 order by shares desc;
```

### The exact wiring Beta Hardening has to add

Nothing below is guessed at; each is a named missing piece.

1. **A link resolver at `https://bingd.app/i/<token>`.** There is no web property. The
   route `app/i/[token].tsx` exists inside the app and says invitations are not active in
   this build, which is true. A resolver has to serve a page, record the open, and hand
   the token to the store or to the app.

2. **`record_invite_open(token)`** — a new RPC or an edge function, called by that page.
   It needs to be callable by `anon`, must not confirm whether a token is valid (or it
   becomes a token oracle), and should write to a new `invite_link_opens` table rather
   than to `invite_tokens`, so one link opened by five people is five rows.

3. **Deferred deep linking, or nothing.** Android App Links and iOS Universal Links carry
   a token only if the app is *already installed*. For a fresh install the token has to
   survive the store round trip, which needs Play Install Referrer / a deferred deep-link
   provider. **Do not approximate this with fingerprinting** — IP-and-timestamp matching
   is both a privacy problem and wrong often enough to poison the metric it produces.
   If deferred attribution is not built, redemption is limited to people who already had
   the app, and that limit must be stated wherever the number is shown.

4. **`redeem_invite(operation_id, token)`** — called after profile creation, never
   before. It writes `invite_attributions (invitee_id, inviter_id, token_id,
   accepted_at)`. The table's primary key is `invitee_id`, so a person is invited once
   and a second call is a no-op rather than a second attribution. It must refuse a token
   whose `env` does not match the running environment (PRD §17), must refuse
   self-invitation (`no_self_invite` already does), and must refuse where a block exists
   in either direction.

5. **Activation** is already defined: PRD §28 says ten ranked titles. Set
   `activated_at` from the ranking writer, or derive it — see §3 on preferring derivation.

6. **`block` already voids unaccepted attributions between a pair** and deliberately
   leaves accepted ones alone, because an accepted attribution is historical fact about
   how somebody joined. That behaviour is in `20260817000200` and needs no change.

---

## 2. Recommendation conversion

`title_recommendations` carries `created_at`, `recommended_at` and `opened_at`.
Everything else in the funnel is already in canonical tables, so there are **no counters
and no analytics tables**. The four stages are one join.

| Stage | Where it comes from |
|---|---|
| **Created** | `title_recommendations.created_at` |
| **Opened** | `title_recommendations.opened_at`, written once by `mark_recommendation_opened` when the recipient taps through |
| **Watchlisted** | `watchlist.created_at` for the recipient and that media item, after `created_at` |
| **Ranked** | `rankings.created_at` for the recipient and that media item, after `created_at` |

```sql
select r.sender_id,
       count(*)                                          as sent,
       count(r.opened_at)                                as opened,
       count(w.created_at) filter (where w.created_at > r.created_at) as watchlisted,
       count(k.created_at) filter (where k.created_at > r.created_at) as ranked
  from title_recommendations r
  left join watchlist w
         on w.user_id = r.recipient_id and w.media_item_id = r.media_item_id
  left join rankings k
         on k.user_id = r.recipient_id and k.media_item_id = r.media_item_id
 group by r.sender_id;
```

**Why the `> created_at` filter matters.** Without it, a recipient who already had the
film on their watchlist would be counted as having been converted by a recommendation
that arrived afterwards. The filter is the difference between "this recommendation worked"
and "these two things are both true".

**What this cannot tell you**, and should not be reported as though it could:

- **A watch that did not go through Bingd.** Somebody may watch a recommendation and never
  log it. Conversion here means conversion *in the app*.
- **Who actually caused it.** If two people recommend the same film, both rows join to
  the same watchlist row and both get credit. There is no attribution model and V1 does
  not need one; if a number is ever published, say that it double-counts.
- **A re-send.** `recommended_at` moves on a re-send and `created_at` does not, which is
  why the funnel measures from `created_at`. Measuring from `recommended_at` would let a
  sender make their own conversion window look shorter by re-sending.

---

## 3. Standing rules

- **Derive rather than count.** Every counter is a second copy of a fact that can drift
  from the first. The queries above are slower than a counter and cannot be wrong.
- **Name the stage that is actually measured.** `invite_link_created`, not `invite_sent`.
  `opened`, not `read`.
- **A missing writer is not a missing column.** Three columns in `invite_attributions`
  have existed since `20260813001300` with nothing writing them. That is recorded here
  rather than filled in with something approximate.
- **No public counts until there is something to promise.** Awards shipped on 2026-08-18
  and the invite-derived badge went with them, so this rule now has one live case rather
  than none — and it held: the badge reads the stage that would be honest, sits at zero
  until that stage is written, and the *measurable* stage is still exposed nowhere. What
  the rule forbids is publishing `invite_link_creations` as though it were arrivals, and
  nothing does.
