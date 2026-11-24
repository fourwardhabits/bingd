# Comments QA fixture (`comments-v1`)

Known conversations for testing comments, replies and their notifications on **staging**
(`fjxhcbowoxuzulwirzyr`). Plain SQL, no tooling. Both scripts refuse to run unless
`app_config['env.name']` is `nonprod`, so they cannot touch production.

| file | what it does |
| --- | --- |
| `comments-fixtures.sql` | Creates or reuses the accounts and **rebuilds** the fixture. Idempotent: running it again is the reset. |
| `comments-smoke.sql` | A two-account reply/notification smoke that **writes nothing**: one transaction, always rolled back. |

## What it creates

Three disposable accounts. They have fixed ids, no email, no password and no personal data,
so they cannot sign in. They exist to be the other people.

| account | username | role |
| --- | --- | --- |
| QA Alex | `qa_cmt_alex` | author of both posts |
| QA Blair | `qa_cmt_blair` | the default notification recipient |
| QA Casey | `qa_cmt_casey` | replies |

There are two title posts by Alex, marked `payload.qa_fixture = "comments-v1"`.

**Post 1** is reacted to, with ❤️ from Blair and 😮 from Casey. Its comments are, in order:
1. Blair's top-level comment. This notifies Alex: *commented on your …*.
2. **The recipient's** top-level comment.
3. Casey's reply to (2). This is a **notification about a reply**: the recipient is told *replied to your comment*.
4. Alex's reply to Casey's reply. This is a reply to a reply: it is stored under (2)'s root and Casey is told.
5. Alex's new top-level comment. This is a **notification about a root**: everyone who commented is told *also commented on their …*.

**Post 2** has a long conversation to scroll: one root and 12 more comments, mostly replies plus a few new top-level ones.

Every comment is written the way the app writes it, through `add_comment` as its author,
so the notifications are the real ones. The recipient's Comments notifications are switched
on, but only when the recipient is a QA account. A real account's switch is left as it is:
if it is disabled, it stays disabled.

## Run it

**Against staging, through the Management API.** The agent proxy supplies the token:

```sh
curl -s -X POST https://api.supabase.com/v1/projects/fjxhcbowoxuzulwirzyr/database/query \
  -H 'content-type: application/json' \
  --data-binary "$(jq -n --rawfile q scripts/qa-fixtures/comments/comments-fixtures.sql '{query:$q}')"
```

The result lists each fixture post with its comment and reaction counts, and each
notification: recipient, actor, whether it is about a root or a reply, and whether it
carries `reply_to` or `participant`.

**With psql**, using a staging connection string:

```sh
psql "$STAGING_DB_URL" -f scripts/qa-fixtures/comments/comments-fixtures.sql
```

### Getting the notifications on your own phone

You don't need to switch accounts. Name your **staging** username first, in the same
session, and the fixture's recipient becomes you instead of QA Blair:

```sql
select set_config('qa.notify_username', 'your_staging_username', false);
-- then the contents of comments-fixtures.sql
```

With the Management API, prepend that line to the query string. You then receive the reply
notification and the root notification for post 1 in your inbox, and as pushes if your
staging device is registered. Your account also gets one top-level comment on post 1,
which is the comment the reply answers. The next run deletes it along with the rest.

### Reset and replay

Run `comments-fixtures.sql` again. It deletes the fixture's posts and everything that
cascades from them: comments, reactions, and the notifications about those posts. It also
clears the QA accounts' daily rate ledger. Then it writes everything again. The accounts are
reused. Nothing outside the fixture is touched.

## The smoke

```sh
curl -s -X POST https://api.supabase.com/v1/projects/fjxhcbowoxuzulwirzyr/database/query \
  -H 'content-type: application/json' \
  --data-binary "$(jq -n --rawfile q scripts/qa-fixtures/comments/comments-smoke.sql '{query:$q}')"
```

The smoke runs these steps:
1. Casey replies to Blair's root.
2. Blair replies to Casey's reply.

It then checks:
- both replies are stored under Blair's root (one level);
- Blair is told about Casey's reply, with `reply_to` = her root;
- Casey, the author of the reply Blair tapped, is told, with `reply_to` = Casey's reply;
- nobody is told twice, and nobody about their own reply;
- the post's owner gets the generic row for each reply;
- `activity_comments` returns both replies under the root;
- Blair's `my_notifications` rows carry `comment_id`, which the app routes on.

The transaction always ends in an exception, so nothing is kept. The answer is the
exception's message:

```
SMOKE_RESULT {"pass": true, "reply_to_root_stored_under_root": true, ...}
```

`"pass": false` names the failing check.
