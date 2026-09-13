# emails/

One email lives here: the founder's welcome note. It is not sent to anybody, and the
automation that would send it is written, tested and switched off.

```
welcome/
  copy.json        ← EDIT THIS. Every sentence a reader sees, and note.status.
  targets.json     every link and in-app instruction, and the evidence behind each
  build.mjs        renders copy.json into dist/
  envelope.mjs     the one definition of the Resend request, used by both senders
  email.test.mjs   the message held to what the app actually does
  dist/
    preview.html   ← OPEN THIS. The email at three widths and in dark mode, the inbox
                   row, every destination, and what is still undecided.
    welcome.html   the email itself
    welcome.txt    the plain-text part, generated from the same copy
    manifest.json  what dist/ was rendered from; the worker refuses a stale build
  send-test.mjs    sends one message to one address you type. Dry run by default.
  automation/      the scheduled job and its SQL. Written, tested, NOT ENABLED.
```

## Editing the copy

```
open emails/welcome/dist/preview.html
  → edit emails/welcome/copy.json
  → node emails/welcome/build.mjs
  → node --test emails/welcome/email.test.mjs
  → refresh the browser
```

No dependencies, nothing to install. The test refuses a link that is not on a path the
app claims, an instruction naming a label the app no longer renders ("Tap Profile, then
Invite friends" is checked against the source that draws those words), an exclamation
mark, an em dash, and a render that no longer matches its copy.

When the words are yours, set `note.status` to `"APPROVED"`. That field is the approval:
the worker mails nobody except a canary until it says so.

## Sending yourself a test

```
node emails/welcome/build.mjs
node emails/welcome/send-test.mjs --to you@example.com --out /tmp/welcome-test
RESEND_API_KEY=re_xxx node emails/welcome/send-test.mjs --to you@example.com --send \
  --from "Suraj from bingd. <suraj@auth.bingd.app>"
```

The first run prints the exact envelope (From, Reply-To, subject, List-Unsubscribe, every
link, sizes, image count) and, with `--out`, writes the request body and both parts to
disk. Nothing is sent without `--send`.

- **One address per run, typed by you.** No default, no list, no cc or bcc, and the script
  cannot read a user list: it never touches a database (a test fails if it ever does).
  For a second inbox, run it again with the other address.
- **`--from` until `bingd.app` is verified in Resend.** The default From is
  `suraj@bingd.app`, which Resend refuses until that domain is added. `auth.bingd.app` is
  the only verified domain today. Reply-To is `suraj@bingd.app` either way.
- **Make a Resend key for this email.** Never reuse the key named `Supabase`: it relays
  every sign-in code.
- **Test the reply from a different inbox** than the Gmail `suraj@bingd.app` forwards to.
  Gmail hides a message that loops back to its own sender, which looks exactly like a
  broken route.

## Why a script, not React Email or a Resend template

One email, no email framework in the project, and a React Native client with no React DOM
build. The copy is already JSON, so a port costs nothing if more emails ever exist.
Resend's visual template editor stores its own document model and would drop the Outlook
conditional block, the dark-mode rules, the hidden preheader and the two-layer buttons.
`copy.json` is the editable surface instead.
