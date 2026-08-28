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

**Rewritten 2026-08-19.** Every stage below had "No" in the second column until
`20260819000500`. The table now says what each stage measures and, just as importantly,
what it misses.

| Stage | Reliable today | Where it lives |
|---|---|---|
| **Link created** | **Yes** | `invite_link_creations`, one row per `create_invite_link` call |
| **Link opened** | **Yes, for the web page only** | `invite_link_opens`, one row per load of `bingd.app/i/<token>` for a live token. A tap that opened the *app* directly is not an open — the page was never loaded — so this measures the uninstalled half of the funnel and nothing else |
| **Redeemed / signup attributed** | **Yes, with a named hole** | `invite_attributions.accepted_at`, written by `redeem_invite` |
| **Activated** | **Yes** | `invite_attributions.activated_at`, written by `_maybe_activate_invite` at ten ranked titles |

### The named hole, and it is the biggest number on this page

**A token does not survive a store install.** Universal Links and App Links carry one only
when the app is already installed. Bingd has no Play Install Referrer path and no deferred
deep-link vendor, and will not get one built on fingerprinting, probabilistic matching or
clipboard reading — that was decided in PRD §17 and is not being revisited for a beta.

So the invitation flow has two shapes, and only one of them is measured end to end:

| Recipient | What happens | Attributed? |
|---|---|---|
| **Already has Bingd** | the link opens the app, the token reaches `app/i/[token].tsx`, they tap Accept | **Yes** |
| **Signed out, has Bingd** | the token is held on the device across sign-in and profile creation, then redeemed | **Yes** |
| **No Bingd, returns to the page after installing** | taps *I already have Bingd*, the custom scheme opens the app with the token | **Yes** |
| **No Bingd, launches from TestFlight or the home screen** | arrives with no token | **No, and permanently** |

The last row is not recoverable and is not detected. There is no signal anywhere that says
"this person was invited and we lost it". **Every invite number is a floor**, and the gap
is largest exactly where the mechanic matters most — new installs. Report them that way.
Do not scale them up by a guessed factor: the honest response to an unmeasured population
is to name it, not to model it.

The landing page tells the visitor this before they leave it, in as many words. That is
the only mitigation there is, and it is a real one: the mechanism costs the person one tap
and no typing.

### The award that now counts people

**Bingd Awards' Invite Instigator** reads

```sql
select count(*) from invite_attributions
 where inviter_id = auth.uid() and activated_at is not null;
```

which is **unchanged from the day it was written** and has stopped being structurally
zero. That is the outcome the deliberate choice on 2026-08-18 was made for: the metric was
moved to the honest stage while it still read zero, rather than being left wrong until the
backend caught up, so nothing about it had to be rewritten when the backend arrived. Its
tiers — 3, 15, 50 — were set on the assumption that they were being counted honestly, and
now they are.

Links created do not count. Links opened do not count. A redemption without activation
does not count. The owner's drill-down shows only genuinely activated invitees, through
`invite_attributions_read`, which admits only the two parties to a row.

**The count is public; the people are not (founder decision, 2026-08-27).**
`invited_signup_count` (`20260827001100`) publishes the aggregate: a definer scalar
gated on `can_i_view`, counting the owner's own predicate — attributed **and**
activated — verbatim, so a visitor entitled to the profile sees the same `2 / 3` the
owner does, equal by construction rather than by synchronisation. It returns one
integer or null; it cannot name an invitee, a token or a timestamp, and
`invite_attributions_read` still admits only the two parties to a row — a visitor's
drill-down is one aggregate line naming nobody: *N people brought to bingd. / Who they
are is theirs to share.* The decision is scoped: Hype Courier's sent-recommendation
count stays withheld, and one aggregate becoming public is a founder decision about
that aggregate, not a precedent that widens every two-party fact.

### What each writer will and will not do

**`create_invite_link(operation_id, media_item_id)`** returns the caller's **one reusable
personal link** (PRD §17), minting it on first use and never rotating it, and records one
`invite_link_creations` row per call with the title that was on screen. It is deliberately
*not* called a send.

**`record_invite_open(token, platform)`** is anonymous, because the page that calls it is.
It **returns void in every case**, so no value and no error distinguishes an unknown,
revoked or cross-environment token from a live one. It stores no address, no user agent
and no identifier; `platform` is the one thing the page states about itself. Nobody may
read the table.

Two limits on that, both named by independent review 26 and both worth stating rather than
discovering. A live token causes strictly more work — a count, and usually an insert — so
repeated measurement can separate live from invented **statistically**. That is not an
enumeration path: separating one candidate from another is worth nothing against 2^122 of
them, and anybody holding a specific token can establish its validity for certain by
redeeming it from an account they create. And the hourly cap is a check followed by an
insert with no lock, so simultaneous loads can overshoot it by roughly the concurrency —
it is a bound that keeps a publicly-posted link from filling the table, not an exact
ceiling.

**`redeem_invite(operation_id, token)`** writes the attribution and `profiles.invited_by`,
creates PRD §17's one-way follow — a *request* when the inviter is private — and files the
inviter's notification. The primary key on `invitee_id` is the rule that matters: **a
person is invited once, and no replay, no second token and no second device can move it.**
Refusals are *returned* rather than raised, so a wrong token spends a slot against the
ceiling — this is the one writer in the schema where a refused attempt is what an attack
looks like.

The token row is read `for share`, so a revocation cannot commit inside the call.
`for share` and not `for update`, because a personal link is meant to be claimed by many
people and an exclusive lock would serialise every invitee of one link against every
other.

**One consequence for the numbers, and it is worth knowing before reading them.** A
refusal spends its operation id — `_claim_operation` commits for every settled answer — so
the client releases the id before retrying a recoverable one. Without that release the
retry is answered `already_applied` and nothing is reconsidered, which is a redemption
that never happens and therefore an arrival never counted. Independent review 26b.

**`_maybe_activate_invite(user)`** runs from `_rank_finalize`, the single place a
`rankings` row is created, and sets `activated_at` the first time an attributed invitee
has ten. The transition is once, from a row lock rather than an ordering argument, and the
inviter's `invite_activated` notification hangs off that transition. The activation is
recorded even when the inviter has gone, been suspended, or blocked the invitee; the
notification is not.

**`revoke_invite_link(operation_id)`** revokes the caller's live link and mints its
replacement in one transaction, which is the only sequence `invite_tokens_one_live` allows
that never leaves an account without a link. Attributions already accepted against the old
token are untouched — revoking withdraws the invitation, it does not un-invite anybody —
and the old link then answers `invalid`, the same answer a token that never existed gets.
Rate-limited tightly, because rotating detaches everybody holding the old one.

**`block` voids only unaccepted attributions** and deliberately leaves accepted ones alone
(`20260817000200`), because an accepted attribution is historical fact about how somebody
joined. Unchanged by this work.

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
