# Bingd — Offline and Synchronization

**Version:** v1 (public alpha)
**Specification:** [`../product/PRD.md`](../product/PRD.md) §18 · [`api.md`](./api.md)

Bingd is **offline-resilient, not offline-first**. The distinction is the whole design: reads of your own collection work offline, a narrow set of low-conflict writes queue, and everything else honestly refuses.

---

## 1. Why the queueable set is small

Every operation added to the outbox brings a conflict question with it: what happens when the queued version and the server version disagree? For membership-style writes the answer is trivial — the later one wins, and nobody notices. For ranking it is not, because a ranking is a global ordering and replaying a stale insertion against a changed list produces a position nobody chose.

So the allowlist contains only operations where "last one wins" is both correct and unsurprising. Seven in total: the six collection operations in [`api.md`](./api.md) §1, plus `set_list_item` from §4. Everything else requires connectivity and says so.

---

## 2. Device storage

| Store | Holds |
|---|---|
| **SQLite** (`expo-sqlite`) | The outbox, and the durable mirror of the user's own collection |
| **TanStack Query + persister** | Server reads, with staleness metadata |
| **Filesystem LRU** | Poster and backdrop images |
| **SecureStore** | Session tokens only |

Two stores rather than one is deliberate. The user's own collection must survive an app upgrade and a cold start with no network, which is a durability requirement. Feed and recommendation snapshots are conveniences that may be evicted freely. Conflating them would mean either over-persisting transient data or under-persisting the collection.

### Retention

Matches PRD §18. Every window is configuration, not a constant.

| Data | Kept |
|---|---|
| Own rankings, collection, buckets, watchlist, lists | Until logout |
| Recent feed | 100 items or 30 days |
| Recommendations | 50 items plus generation timestamp |
| Visited profiles and lists | LRU, 20–50 objects |
| Images | Bounded LRU disk cache |

> **Resolved 2026-08-13.** "Until logout" applies to Bingd's own data — positions, buckets, list membership, notes — without qualification. The **TMDB-derived title metadata attached to it** is capped under six months, which is what TMDB's terms require, so the separation below is load-bearing rather than precautionary: a durable Bingd row keyed by `media_item_id`, and a metadata record with its own expiry. Metadata expires and re-fetches on next connection while the user's collection stays intact. A user offline past the window sees their collection with placeholder artwork, never an empty list.

---

## 3. The outbox

```sql
-- Client-side SQLite
create table outbox (
  operation_id text primary key,        -- uuid, generated on the device
  kind         text not null,           -- must be in the allowlist
  payload      text not null,           -- json
  created_at   integer not null,
  attempts     integer not null default 0,
  next_attempt integer,
  status       text not null default 'pending',
  last_error   text
);
```

`operation_id` is generated **on the device at the moment of the user's action**, not at send time. That is what makes a retry idempotent: the same user action always carries the same id, however many times it is transmitted.

### Server-side guard

Every outbox-eligible RPC opens with:

```sql
if not _claim_operation(p_operation_id, 'log_watched') then
  return jsonb_build_object('status', 'already_applied');
end if;
```

A replay is therefore a no-op that returns success rather than an error, which matters because the common cause of a replay is a response lost on a flaky connection: the write did land, and the client simply never heard back.

**The ledger is keyed per account — corrected 2026-08-13.** This document previously specified `on conflict (operation_id)` against a globally unique key, and `20260813000100` built the table that way. The key is now `(user_id, operation_id)`. Under a global key, an id one account has already claimed silences the same id sent by another: the write is skipped, `already_applied` comes back, and the second client reports success because the response says so. The row simply never appears.

Being exact about what that needs, because the alarming version of the story does not hold up: for the *other* account to be the one silenced, its id must be burned before it sends it, which means knowing a v4 uuid generated on someone else's device — and no API, table policy or error surface exposes one. As a targeted attack it is not reachable. What is reachable is disclosure by accident: operation ids travel in crash reports and support screenshots, and an outbox surviving an account switch on a shared device carries one account's ids into another's session. The narrower key is worth it because it stops the question from needing an answer at all — idempotency only ever needs to hold within one device's queue, every queue belongs to one account, and scoping it that way gives up nothing.

### Ordering

Operations drain **in creation order**, one at a time. Parallel draining would be faster and wrong: `set_list_item(add)` followed by `set_list_item(remove)` must not arrive reversed.

Retries use exponential backoff with jitter, capped at roughly five minutes. After a configurable number of failures an operation moves to `failed` and surfaces in Settings.

**Note edits coalesce per title — Required.** `save_note` is the one queued write that carries a base version, and two queued edits to the same note share the base captured before either of them, so draining them in order makes the second conflict with the user's own first edit. A note is a draft and only its latest text matters, so the queue keeps **one** `save_note` per title: newest text, original base, and the `operation_id` of the entry it replaces so the id still corresponds to one user action. A client that would rather drain them separately can instead carry the `note_version` each call returns forward as the next base. Ordering above still holds; this is a rule about what goes into the queue, not about how it comes out.

### The allowlist is not sufficient on its own — Required

**Corrected 2026-08-13.** The allowlist in `api.md` reasons about function names, but two queueable functions can touch a **ranked** title, and for a ranked title both are ranking mutations that PRD §18 forbids queuing:

- `set_bucket` would need to move the title into a different band and renumber, which is `rank_rebucket` — an online-only operation whose consequence, the position changing, the user must actually see.
- `unlog` would delete a `rankings` row and close the gap, discarding ranking work built over dozens of comparisons, applied silently on reconnect.

Both now raise `BG409` when a `rankings` row exists, and the client routes ranked titles to the online-only path instead of the queue. The general rule: **a function is queueable only if it is queueable for every state its target row can be in.** Where that does not hold, the function rejects the unsafe state — the allowlist cannot express it, because the danger is in the row and not the name.

---

## 4. UI states

PRD §17 requires that local save, server sync, and completion never look alike. Four states, and the copy for each is fixed:

| State | Copy | Meaning |
|---|---|---|
| `pending` | *Saved on this device* | In the outbox, not yet sent |
| `syncing` | *Syncing…* | In flight |
| `synced` | *(no indicator)* | Server confirmed |
| `failed` | *Needs attention* | Exhausted retries |

The synced state shows nothing at all. A persistent green tick trains people to ignore the indicator, which defeats the point of having one.

**Required:** an optimistic update is never rendered in a way that implies server confirmation. The action appears immediately — that is the value of the outbox — but always carrying the `pending` marker until it clears.

---

## 5. Conflicts

| Data | Rule |
|---|---|
| Watched state, watchlist, list membership | Last valid operation wins |
| Note drafts | **Never silently overwritten.** Divergence is surfaced to the user |
| Rankings, entitlements, privacy, moderation | Server is authoritative, always |

Notes are the only free text a user writes, so losing one to a silent overwrite is a real loss rather than an inconvenience. When a note is edited offline and the server copy has also changed, both versions are kept and the user chooses.

**How that is detected — Required.** The rule above was unimplementable as written: nothing in a `save_note` call said which version the edit was based on, and `user_media.updated_at` was set once on insert and never advanced, so the server had no version to compare against and would have overwritten silently while this document promised it would not. Outbox replays of `save_note` now carry `p_base_updated_at` — the value the device held when the user typed — and a mismatch raises `BG409`. Online edits may omit the parameter, since divergence is only possible across a queue.

**The version belongs to the note, not the row — corrected 2026-08-13.** The first implementation compared against `user_media.updated_at`, which every write to the row advances. Under this document's own drain contract that is a guaranteed false conflict: §3 queues a bucket tap and a note edit in the order the user made them, `set_bucket` drains first and moves `updated_at`, and the note edit then arrives with a base that no longer matches. The prompt would appear on most offline sessions, about a note nothing else had touched. `user_media.note_updated_at` advances only when the note text changes, so unrelated writes no longer disturb a queued edit.

**What the client must do — Required.** Two consequences, both on the client side:

- **Coalesce note edits per title in the outbox.** Two queued edits to the same note share the base captured before either was written, so the second collides with the user's own first edit. A note is a draft and only the latest text matters, so the queue should keep one entry per title with the newest text and the original base. `save_note` also returns `note_version`, which a client that prefers to drain them separately can carry forward as the next base.
- **Read the note back on `BG409`.** The payload deliberately carries the server's version and not the server's text: Postgres logs an exception's `DETAIL`, and PRD §22 classifies a note as always-private, so putting it there would deposit private text into operator-visible logs on every conflict. The client owns the row and reads its own note to present the choice.

An operation targeting an object that has been deleted or has become inaccessible fails with `BG404`, is removed from the queue, and produces a plain-language explanation rather than an indefinite retry.

---

## 6. Refusing gracefully

For an online-only action with no connectivity, the client does **not** disable the control silently. It responds to the tap and explains:

> *Ranking needs a connection. We'll be ready when you're back online.*

The distinction matters because a greyed-out button with no explanation reads as a bug. This is the same reasoning as the state labels: the product tells the truth about what it can do right now.

Block and report are the exception in presentation. Both hide the target locally the instant the user taps, then submit when connected — because a safety action that appears not to have worked is worse than one that syncs a moment late. Neither enters the outbox (PRD §18); the local hide is a UI affordance over an unsent request.

---

## 7. Reconnection

On regaining connectivity the client, in order:

1. Drains the outbox, oldest first.
2. Refreshes the user's own collection, which is now authoritative over any local echo.
3. Refreshes capabilities, since a grant may have expired while offline.
4. Revalidates feed and recommendations in the background.

Step 2 follows step 1 so the refresh reflects the drained writes. Reversing them would briefly show the user their own changes disappearing.

---

## 8. Testing

Every row of the PRD §18 matrix is tested in both connectivity states. Beyond that:

- Submitting the same `operation_id` twice produces one record and a success response both times.
- Killing the app mid-drain loses nothing; the outbox survives the restart.
- Operations queued against an object deleted while offline fail with a clear message and leave the queue.
- No ranking, block, or report RPC can be enqueued — asserted against the allowlist itself, not against each function.
- A note edited both offline and on another device produces a user-visible choice, never a silent overwrite.
- The `pending` marker is present on every optimistic update until the server confirms.
- `set_bucket` and `unlog` against a **ranked** title are refused with `BG409` in both connectivity states, and the client offers the online-only path rather than the queue. Asserted per function, because the allowlist cannot express a row-state condition.
- A queued `save_note` whose `p_base_updated_at` is stale raises `BG409`. Asserted with a deliberate second edit between the base being read and the stale write arriving, and by checking that the superseding text survives — a test that fabricates staleness from an arbitrary timestamp passes while the version trigger is absent, which is how the first version of this test escaped the gap it was written to close.
- A bucket or watch-date write between a note being read and the queued edit draining does **not** raise. This is the same mechanism from the other side, and it fails against a row-level version, so it is what keeps §5's correction from regressing.
- A failed operation leaves no row in `processed_operations`, so the outbox entry stays retryable rather than answering `already_applied` for a write that never happened.
