# emails/

One email lives here. It is not sent to anybody.

```
welcome/
  copy.json        ← EDIT THIS. Every sentence a reader sees.
  targets.json     where each button goes, and the evidence that it goes there
  build.mjs        renders copy.json into dist/
  dist/
    preview.html   ← OPEN THIS. The email at three widths, plus what is still undecided.
    welcome.html   the email itself
    welcome.txt    the plain-text alternative, generated from the same copy
  send-test.mjs    sends one message to one address you name. Dry run by default.
  automation/      the scheduled job. Designed, written, and not enabled.
```

## The loop

```
open emails/welcome/dist/preview.html
  → edit emails/welcome/copy.json
  → node emails/welcome/build.mjs
  → refresh the browser
```

Nothing else needs running and nothing else needs installing. `build.mjs` has no
dependencies.

## Sending yourself a test

```
node emails/welcome/build.mjs
RESEND_API_KEY=re_xxx node emails/welcome/send-test.mjs --to you@example.com --send
```

Without `--send` it prints the envelope and stops. Without `--to` it refuses, because
nothing in this repository knows which address you actually read and a script that
guessed would eventually guess wrong.

**Make a new Resend key for this.** The account has one key, named `Supabase`, and it
belongs to the relay that sends every sign-in code. Do not reuse it.

## Why this is a script and not React Email, or a Resend template

React Email earns its keep at a dozen templates with a shared design system. There is one
email, no email framework in the project, and a React Native client with no React DOM
build. The copy is already JSON, so the port costs nothing if a second and third email
ever exist.

**Resend's visual template editor was considered and rejected**, and it is worth saying
why, because it is the obvious answer to "I want to edit this myself". The editor stores
its own document model and re-emits the HTML. What it would re-emit does not include the
Outlook conditional block, the `prefers-color-scheme` overrides, the `mso-hide` preheader,
or the two-layer buttons that survive Word's rendering engine. Round-tripping through it
would quietly cost the things that make this email render correctly in the clients that
are hardest to render in, and the loss would be invisible until somebody on Outlook
mentioned it.

`copy.json` is the editable surface instead. It holds the subject, the preheader, the
note, the three cards and the footer, and nothing else in the directory contains a
sentence a reader will see.
