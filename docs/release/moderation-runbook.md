# Moderation runbook

**Audience:** the founder, as the only operator.
**Surface:** the Supabase SQL editor, signed in as the project owner. There is no admin
application and this document is not a plan to build one.

---

## What this covers

The complete loop, once per report:

```
somebody taps Report in the app
        ↓
reports (state = 'open')
        ↓
moderation_queue                 ← you read this
        ↓
inspect the subject and the account
        ↓
act, or decide not to
        ↓
moderation_actions               ← you write this
reports.state = 'upheld' | 'dismissed'
```

Nothing in it is automated. There is no detection, no classifier, no queue that empties
itself, and no notification when a report arrives — **you have to look**. At 30–60 users
that is the correct amount of machinery; the day it stops being, the thing to build is a
read-only console over these same three tables, not a second moderation system.

---

## Before anything else: where you are

Every query here runs against **one** project. Check which before you act, because the
two databases hold different people and only one of them has users in it.

```sql
select current_database(), inet_server_addr();
```

The friend beta and every non-production lane are **`bingd-nonprod`**
(`abheeqyjzekiowkztfxv`). There is no production database yet. If a query in this document
ever returns rows on a project you did not expect, stop and work out why before running a
second one.

### The one rule about credentials

**The service role key is never written down, never pasted into a file in this repository,
and never put in an example.** The SQL editor is already authenticated as the owner; that
is the whole access story. Nothing in this document needs a key, and a runbook that
contained one would be the most valuable line in the repository to steal.

The same applies to `docs/`: if you ever find yourself about to paste a connection string
into a document to make a step reproducible, the step is wrong.

---

## 1. Open the queue

```sql
select *
  from moderation_queue
 order by open_against_owner desc, created_at;
```

`moderation_queue` is a view over open reports only. It is `security_invoker`, so it
returns everything **because you are the owner** — an ordinary signed-in client running
the same select sees only reports it filed itself, which is what the `reports_read_own`
policy allows.

Ordered worst-offender-first deliberately: `open_against_owner` counts every open report
against that account, so five complaints about one person sort above one complaint about
five people. Sorting by `created_at` alone would work the queue in the order it arrived,
which is the order that lets a single bad account stay hidden behind a week of noise.

### What each column is

| Column | What it is | What it is **not** |
|---|---|---|
| `id` | The report | |
| `created_at` | When it was filed | |
| `subject_type` | `profile`, `display_name`, `username`, `list`, `list_title`, `watch_tag`, `comment`, `review` | |
| `subject_id` | The thing reported. **Its meaning depends on `subject_type`** — see below | |
| `reason` | One of eight, chosen by the reporter | An assessment. It is what they picked, not what is true |
| `note` | Free text, or null | Today the client never sends one, so expect null |
| `subject_owner` | The account that published it, **resolved server-side** | Anything the reporter supplied |
| `owner_username` | Their handle | |
| `owner_status` | `active` or `suspended` | |
| `open_against_owner` | Open reports against this owner | A history. Resolved ones are not counted |

**`subject_id` is not one kind of thing**, and reading it as one is the mistake that
wastes the most time:

| `subject_type` | `subject_id` is | Read it with |
|---|---|---|
| `profile`, `display_name`, `username` | a `profiles.id` | §2a |
| `comment` | a `comments.id` | §2b |
| `review` | a **`user_media.id`** — the row a public note is written on | §2c |
| `list`, `list_title` | a `lists.id` | §2d |
| `watch_tag` | a `watch_tags.id` | §2d |

The reporter is deliberately **not** in this view. `reports.reporter_id` exists and you
can read it, but triage should not need to: who complained is not evidence about whether
the content breaks the rules, and looking changes how you read it.

---

## 2. Read the subject

Run the one that matches `subject_type`. Each takes the `subject_id` from the queue.

### 2a. A profile, display name, or handle

```sql
select id, username, display_name, bio, avatar_path, visibility, status, created_at
  from profiles
 where id = '<subject_id>';
```

`display_name` and `username` are separate subject types from `profile` because they are
separately fixable: a handle can be forced to change (§3d) without touching the account.

### 2b. A comment

```sql
select c.id, c.body, c.has_spoilers, c.created_at, c.edited_at,
       c.author_id, p.username as author, p.status as author_status,
       e.type as event_type, e.actor_id, e.media_item_id
  from comments c
  join profiles p on p.id = c.author_id
  join feed_events e on e.id = c.feed_event_id
 where c.id = '<subject_id>';
```

`author_id` is who wrote it. `actor_id` is whose activity it was written under, and they
are usually different people — the report is about the **author**, and `report()` resolves
`subject_owner` from `author_id` for exactly that reason.

### 2c. A review

A review is a public note on `user_media`, named by its own `id` since
`20260825000100`.

```sql
select um.id, um.user_id, p.username as author, p.status as author_status,
       um.note, um.note_has_spoilers, um.note_visibility, um.note_updated_at,
       m.title, m.kind
  from user_media um
  join profiles p on p.id = um.user_id
  join media_items m on m.id = um.media_item_id
 where um.id = '<subject_id>';
```

**Check `note_visibility` before acting.** If it reads `private`, the author has already
made it invisible to everybody but themselves and there is nothing left to remove — the
correct outcome is usually `dismiss_report` with a rationale saying so. A private note is
not reportable in the first place (`report()` will not resolve one), so this only arises
where the author changed it after the report was filed.

Do **not** select `um.*` here. That row also carries `watched_on`, which PRD §22 keeps
private at every visibility level, and it is not evidence about anything.

### 2d. A list or a watch tag

```sql
select id, owner_id, title, visibility, created_at from lists where id = '<subject_id>';

select w.id, w.tagger_id, w.tagged_id, w.media_item_id, w.created_at
  from watch_tags w where w.id = '<subject_id>';
```

---

## 3. Inspect the account, then act

### Before acting, look at the account rather than only the report

```sql
-- Everything open against them, and everything ever done about them.
select subject_type, subject_id, reason, created_at
  from reports where subject_owner = '<owner_id>' and state = 'open'
 order by created_at;

select created_at, action, subject_type, rationale, report_state
  from moderation_history
 where subject_id in (select subject_id from reports where subject_owner = '<owner_id>')
 order by created_at desc;
```

A first complaint about a borderline comment and a fifth complaint about the same person
are different situations, and the queue's `open_against_owner` is the number that tells
them apart.

### The five actions, and what each one actually does

`moderation_actions.action` accepts exactly six values —
`suspend_account`, `restore_account`, `remove_content`, `force_username_change`,
`dismiss_report`, `warn`. **There are no others**, and the Terms of Use describes these
and nothing more. If you find yourself wanting a seventh, that is a schema change and a
Terms change, in that order.

**Deleting an account is deliberately not one of them**, and the Terms does not offer
account removal as a response to a report. Suspension is the strong lever precisely
because it is reversible and keeps the evidence; `delete_account` exists as a *user's own*
action. A permanent closure imposed by the operator is reserved for a legal or safety
obligation — the Terms covers that under "Ending it" — and `moderation_actions` has no
value for it, which is a gap to close deliberately rather than in the moment.

### Run each action as one transaction

Every action below is two statements — the change, and the record — and **they have to
land together or not at all.** A suspension with no `moderation_actions` row is an
account that is off with no stated reason, which is the state you cannot defend later or
explain to the person; an audit row with no suspension is a record of something that did
not happen.

So each block below is one statement shaped like this:

```sql
with changed as (
  update ... where <the row, and the condition that makes the action meaningful>
  returning id
)
insert into moderation_actions (...)
select ..., id, ... from changed;
```

**The audit row is fed by the change, not written beside it.** That is the whole point of
the shape, and it replaces an earlier version of this document that told you to read the
"Rows affected" count and roll back by hand. Two reasons that was not good enough:

- **A pasted block runs to the end.** If `commit;` is in the text you pasted, you have
  committed before you have read anything.
- **The interesting failure does not report zero rows.** Clearing a note whose author
  already made it private still *matches* the `user_media` row — one row affected, and an
  audit record claiming a removal of something that was already gone.

With the CTE, the `where` clause decides both. If nothing matched, `changed` is empty,
the insert writes **no** audit row, and the editor tells you `INSERT 0 0`. That is your
signal that the content was already gone: `rollback;`, and record a `dismiss_report`
instead.

Each block still gets a `begin;` / `commit;` around it, so a mistake is recoverable.
**The editor does not roll back for you** — if anything looks wrong, type `rollback;`
rather than closing the tab.

#### 3a. Remove a review

There is no "remove content" RPC. Clear the note, which is the content:

```sql
begin;
with removed as (
  update user_media
     set note = null, note_visibility = 'private', note_updated_at = now()
   where id = '<subject_id>'
     -- Both halves matter. Without them this matches a row whose note the author has
     -- already deleted or made private, reports one row affected, and records a removal
     -- of something that was not there.
     and note is not null
     and note_visibility = 'public'
  returning id
)
insert into moderation_actions (report_id, subject_type, subject_id, action, rationale)
select '<report_id>', 'review', id, 'remove_content', '<why, in a sentence>' from removed;
commit;
```

`INSERT 0 0` means the note was already gone — `rollback;` and dismiss instead.

**Copy the note's text into the `rationale` before you run this** if the wording is the
reason. It is about to stop existing, and the record should still say what it said.

The `user_media` row itself stays either way. It carries the person's rating and watch
history for that title, which is not what was reported and is not yours to delete.

#### 3b. Remove a comment

```sql
begin;
with removed as (
  delete from comments where id = '<subject_id>'
  returning id
)
insert into moderation_actions (report_id, subject_type, subject_id, action, rationale)
select '<report_id>', 'comment', id, 'remove_content', '<why>' from removed;
commit;
```

`INSERT 0 0` means the author deleted it first — `rollback;` and dismiss instead.

A delete rather than a soft-hide, because `comments` has no hidden state and inventing one
here would be a schema change made in a hurry. Copy the body into the `rationale` if the
wording is the reason — the row is about to stop existing, and the record should still say
what it said.

#### 3c. Suspend an account

```sql
begin;
with suspended as (
  update profiles set status = 'suspended'
   -- `and status = 'active'` so that suspending an already-suspended account records
   -- nothing rather than adding a second identical row to their history.
   where id = '<owner_id>' and status = 'active'
  returning id
)
insert into moderation_actions (report_id, subject_type, subject_id, action, rationale)
select '<report_id>', 'profile', id, 'suspend_account', '<why>' from suspended;
commit;
```

`INSERT 0 0` means they were already suspended — `rollback;`, and close the report on its
own merits.

Suspension is the strong lever and it is **reversible, which is the point** — deletion
destroys the evidence needed to judge whether the deletion was right.

What it does, in one place: `can_view_profile` returns false for a suspended account to
everybody but themselves, so they leave the feed, search, discovery, leaderboards, tagging
and the public web pages at once. `assert_can_write` refuses every write. They can still
sign in and load their own profile, which is deliberate — an account that has been acted
on should be able to see that something happened.

#### 3d. Force a handle change

Bingd has no "rename this account" RPC, and this action value exists for the case where
the handle *is* the violation — impersonation, or a slur. Today it is a conversation:
write to them, and if they do not change it, suspend under §3c.

```sql
insert into moderation_actions (report_id, subject_type, subject_id, action, rationale)
values ('<report_id>', 'username', '<owner_id>', 'force_username_change', '<why, and what you asked for>');
```

**Record it even though the action was an email.** The record is what makes the next step
proportionate if there is one.

#### 3e. Warn, or dismiss

```sql
insert into moderation_actions (report_id, subject_type, subject_id, action, rationale)
values ('<report_id>', '<subject_type>', '<subject_id>', 'warn', '<what you said to them>');
```

`dismiss_report` is for a report that does not describe a breach. It is a real outcome and
it should be recorded rather than left as a closed report with no reason — six months
later "why is there nothing about this" is the question, and an empty history answers it
badly.

### Restoring an account

```sql
begin;
with restored as (
  update profiles set status = 'active'
   where id = '<owner_id>' and status = 'suspended'
  returning id
)
insert into moderation_actions (report_id, subject_type, subject_id, action, rationale)
select null, 'profile', id, 'restore_account', '<why>' from restored;
commit;
```

`report_id` is null here, because a restoration usually follows a conversation rather than
a report. `INSERT 0 0` means the account was never suspended.

---

## 4. Close the report

Nothing above closes it. Do this last, once, per report:

```sql
update reports
   set state = '<upheld|dismissed>', resolved_at = now()
 where id = '<report_id>';
```

`upheld` means the report described a real breach, whatever you did about it. `dismissed`
means it did not. Both remove it from `moderation_queue`; neither deletes it.

**Closing it re-opens the door for that reporter.** `reports_one_open_per_reporter` is
unique on `(reporter_id, subject_type, subject_id) where state = 'open'`, so while a report
is open the same person filing again is silently a no-op. That is the anti-pile-on rule
working as intended — but it also means a dismissed complaint can be filed again if the
behaviour continues, which is correct.

### Check the queue is actually empty

```sql
select count(*) from moderation_queue;
```

---

## 5. Things to keep straight

**A report is not a verdict.** `reason` is what the reporter picked from eight options.
Read the subject.

**The reported person is never told who reported them.** There is no path in the schema
that would let them find out, and there must not be one. Do not put a reporter's handle
in a `rationale`, and do not quote a report when you write to somebody.

**Blocking is not moderation.** Users block each other; that is between them and produces
no report. Conversely, `report()` deliberately does **not** check whether the reporter can
still see the subject — so somebody who was blocked *after* being harassed can still
report, and you will see reports about content the reporter can no longer view. That is
working correctly, not a bug.

**Reports survive their reporter.** `reporter_id` is `on delete set null`, so a harassment
complaint outlives the complainant deleting their account — which is a thing harassed
people do. A report with a null reporter is still a valid report.

**Private notes cannot be reported and should never appear here.** If a `review` subject
resolves to a row whose `note_visibility` is `private`, the author changed it after filing;
see §2c.

**There is no appeal process, and the Terms says so.** Somebody who disagrees writes to the
support address and a person reads it. Do not describe an appeals process to them that does
not exist.

---

## What is deliberately not here

- **An admin console.** Three views run from the SQL editor is the right amount of tooling
  for this cohort. Building a console before there is triage experience is the expensive
  way to find out what the console should contain.
- **Automated detection.** Nothing scans content. The Terms does not claim it does.
- **Appeals.** Not built, not described, not promised.
- **Notifications on a new report.** You look, or nobody does. This is the sharpest
  limitation in this document and the first thing to fix if reports ever arrive faster than
  you check.

None of the four is acceptable at a scale much beyond the current one.
