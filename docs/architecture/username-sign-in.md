# Bingd — Username-or-email sign-in

**Status:** groundwork, **dark**. Client constant `USERNAME_SIGN_IN_ENABLED = false`
(`src/features/auth/username-sign-in-flag.ts`). The migration and the Edge Function are in
the repository and **not applied or deployed anywhere** but a local `supabase start` stack.
Turning it on is the founder-approved checklist in §9, ending in an OTA that flips the
constant.

**Decision:** AUTH-DIAGNOSIS §8, founder, 2026-11-12. An existing account may sign in with
its verified email **or** its username. New accounts still sign up with email only. Apple,
Google and user ids are unchanged.

**Read with:** [`auth.md`](./auth.md) (the identity model, the email contract, linking).

---

## 1. What changes, and what does not

| | Before | With the constant on |
|---|---|---|
| Sign-in field | "Email" | "Email or username" |
| Value containing `@` | email code (`signInWithOtp`, `shouldCreateUser: true`) → `verify.tsx` | **Identical.** Same call, same screen, same copy |
| Username | — | `username-sign-in` Edge Function → `verify-username.tsx` |
| Password sign-in | email + password | **Unchanged**, email only |
| Apple, Google | — | **Unchanged** |
| Sign-up | email code creates the account | **Unchanged.** The username path cannot create an account (`shouldCreateUser: false`, and it only resolves accounts that have a profile) |
| Password reset | none for users | **Unchanged.** The username path never sends reset mail |

`verify.tsx` is not modified at all. The username path has its own code screen, so the email
flow's tested behaviour cannot regress behind a branch.

---

## 2. Threat model

Usernames are public — profile URLs are `bingd.app/u/<name>` — so **whether a username
exists is not a secret**. What the design defends is everything that is:

| Threat | What an attacker wants | Mitigation | Proven by |
|---|---|---|---|
| **Email disclosure** | The address behind a public username | The email is resolved server-side in a `security definer` function that only the service role can execute, and is passed only to GoTrue. No response, error or log carries it. The client is given a random challenge id instead, and the code screen says "the email on your account" | `handler.test.ts` *send: every outcome…*, *verify: the right code returns the session tokens and nothing else*, *logs carry no…*; `UsernameSignInScreens.test.tsx` *never names an address*; `local-stack.test.ts` *a username signs in* (asserts no address in the response) |
| **Account enumeration** (beyond the public username) — e.g. "does this name have a confirmed email", "is this account banned" | A per-account signal | Hit, miss, unconfirmed, banned, deleted, suspended, anonymous, rate-limited, cooldown and a database error all return **the same 200 body** after the **same padded delay**. The GoTrue send, the one step whose cost depends on the account, runs *after* the response (`EdgeRuntime.waitUntil`). Verify gives one 400 for every code failure, padded too, and folds GoTrue's own refusals into it (a decoy never reaches GoTrue, so any GoTrue-specific answer would mark a real account) | `handler.test.ts` *send: every outcome…*, *timing: a hit, a miss, an unconfirmed and a banned send take the same time*, *timing: a decoy and a real challenge…*, *verify: decoy, unknown, expired, used, locked and wrong code are one answer*; `local-stack.test.ts` *timing at the real floors* (p50 hit 900.8 ms vs miss 901.1 ms on the local stack) |
| **Account takeover** | A session for somebody else's account | A challenge allows **5** guesses at one 6-digit code and expires in **10 minutes**; the attempt is spent *before* the code is checked, so parallel guesses cannot exceed it. Only one challenge per account is live: a new send supersedes the old one, and one inside the cooldown *inherits* the spent attempts, so repeated sends cannot multiply guesses. Single use. The session's user id must equal the challenge's, and a session that fails either check is revoked, not returned. Eligibility (confirmed, not banned, not deleted) is re-read at verify time | `username-sign-in.test.mjs` *a real challenge checks once per attempt and locks after five*, *finish is single use…*, *one email per account per minute…* (attempts carry over), *a ban between send and verify is honoured*; `handler.test.ts` *a session that cannot be finished is revoked*; `local-stack.test.ts` *five wrong codes lock…*, *a challenge is single use* |
| **Mail-bombing** | Flood a victim's inbox by typing their username | **3** admitted sends per normalised identifier per hour, **10** per IP per hour, and **one email per account per 60 s** (a send inside that minute shares the code already sent), on top of GoTrue's `smtp_max_frequency` (60 s) and `rate_limit_email_sent` (project-wide). Worst case for one victim: 3 emails an hour | `username-sign-in.test.mjs` *three admitted sends per identifier…*, *ten admitted sends per IP…*, *one email per account per minute…*; `local-stack.test.ts` *repeated sends for one name: one email…*, *ten sends per IP, then a real name from that IP sends nothing* |
| **Released names** | Sign in as whoever *used* to hold a name | **Current usernames only.** `username_history` is never read — not even inside `redirect_until`. A redirect is a courtesy to a link; a sign-in is a credential | `username-sign-in.test.mjs` *after a rename the old name never resolves…*; `local-stack.test.ts` *a renamed account* |
| **Account creation** | Mint accounts through the username path | `signInWithOtp({ options: { shouldCreateUser: false } })`, always, and only for an account that already has a profile | `handler.test.ts` *GoTrue: a code is always requested with shouldCreateUser false*; `local-stack.test.ts` *an unknown username… no account created* |
| **Log leakage** | Identifiers, addresses or codes in logs | The log type allows five keys: function, action, outcome class, a 12-hex prefix of a *hash*, and a lateness number. GoTrue errors are reduced to their snake_case code. Database rows hold only keyed HMACs and a SHA-256 of the challenge id | `handler.test.ts` *logs carry no identifier, address, code, challenge id or IP*; `local-stack.test.ts` *no log line names anybody*; `username-sign-in.test.mjs` *stores no identifier, address or IP in clear* |
| **Direct table access** | Read challenges or attempts through PostgREST | RLS on, no policy, every table privilege revoked from `anon`, `authenticated` **and** `service_role`; only the four functions touch the tables, executable by the service role alone | `username-sign-in.test.mjs` *who can reach the tables*, *who can call the functions* |

### Residual risks, accepted or held

- **A victim's username path can be locked for an hour** by anyone sending three requests
  for their name. That is the per-identifier limit doing its job; the victim's email path,
  Apple and Google are unaffected, and the code screen's way out is "Use your email instead".
- **A send supersedes an in-progress challenge.** Only one challenge per account is live, so
  somebody sending for a name while its owner is mid-sign-in kills the owner's challenge
  id (inside the cooldown the new one shares the code; outside it a new code is sent). That
  is the price of guesses not multiplying with sends. The owner sees "That code did not
  work" and can resend or use the email path.
- **The long-run guess bound.** At 3 codes an hour and 5 guesses each, a determined
  attacker gets 15 guesses an hour against one account: about 1 in 2,800 per day, roughly
  1 in 8 over a year of continuous effort. That is far tighter than the email path today
  (GoTrue's `rate_limit_verify` is 30 guesses per 5 minutes **per IP**, with no per-account
  cap), but it is not negligible. A per-account daily guess cap is held decision 4 (§7).
- **The project-wide email budget is shared.** Username sends count against GoTrue's
  `rate_limit_email_sent` (30/hour on production) exactly as email sends do. An attacker
  with many IPs can spend it — but they can already do that today by typing addresses into
  the email path, so this adds no new class of exposure. The per-IP limit bounds each source.
- **IP trust is unverified (held for staging).** `clientIp` prefers `cf-connecting-ip`,
  then the first `x-forwarded-for` hop. If the Supabase edge lets a client set either, the
  per-IP limits become per-request. The limits that protect a *specific person* — per
  identifier and per account — do not depend on the IP.
- **GoTrue's own per-IP limits will see the function, not the person.** `rate_limit_verify`
  and `rate_limit_otp` are per IP, and every username sign-in reaches GoTrue from the Edge
  Function's egress. At volume, username sign-ins could share one GoTrue bucket. Must be
  measured on staging before the constant is flipped; the fix, if needed, is a GoTrue-side
  setting (founder decision), not anything in this code.
- **The timing floor is a number, not a proof.** If the database is slower than the floor
  (900 ms send, 1200 ms verify), timing is no longer uniform for that request. Every such
  response logs `floor_exceeded` with the overrun, so the floor can be raised from evidence.
- **A fourth send in an hour is silent.** It is refused like a miss and its challenge id is
  dead. The code screen allows two resends (three sends) and then stops offering one; a
  person who leaves and comes back within the hour can be caught by it, and the way out is
  the email path.

---

## 3. Flows

### Send

```
client                          username-sign-in (anon key)             Postgres (service role)              GoTrue
  │ {action:send, identifier}  ─▶ normalise (trim, lower, ^[a-z0-9_]{3,24}$)
  │                              mint challengeId (256 bits)
  │                              h(challenge)=SHA-256, h(id), h(ip)=HMAC
  │                              ─────────────────────────────────────▶ username_sign_in_send
  │                                                                       purge > 24 h
  │                                                                       limits (identifier, ip)
  │                                                                       resolve CURRENT username
  │                                                                       → eligible account? 
  │                                                                       miss → decoy row
  │                                                                       cooldown → share code
  │                                                                       send → challenge row
  │                              ◀──────────────────── {outcome, email?}
  │                              outcome=send → waitUntil(signInWithOtp ──────────────────────────────▶ email
  │                                              shouldCreateUser:false)
  │                              pad to 900 ms + U(0,250)
  │ ◀─ 200 {challengeId, "If that account exists, we sent a code to its email."}
```

### Verify

```
client                          username-sign-in                         Postgres                             GoTrue
  │ {action:verify, challengeId, code} ─▶ shape check (43-char id, 6 digits) — else uniform 400
  │                              ─────────────────────────────────────▶ username_sign_in_verify_begin
  │                                                                       per-IP limit → limited
  │                                                                       attempts+1 if live, < 5
  │                                                                       decoy/expired/used/locked → invalid
  │                                                                       re-check eligibility
  │                              ◀────────────────── {check, email, user_id}
  │                              verifyOtp({email, token, type:'email'}) ────────────────────────────▶
  │                              ◀──────────────────────────────────────────────────────── session | error
  │                              session.user.id == user_id? and ──────▶ username_sign_in_verify_finish
  │                                                                       consumed_at = now() (once)
  │                              else revoke session, uniform 400
  │                              pad to 1200 ms + U(0,250)
  │ ◀─ 200 {session:{access_token, refresh_token, expires_in, expires_at, token_type}}
  │      | 400 {invalid_code, "That code did not work. Check it, or send a new one."}
  │      | 429 {rate_limited, "Too many attempts. Try again later."}
  │ supabase.auth.setSession({access_token, refresh_token})
```

On success the router does the rest, as after any sign-in (`useAuthRouting`): a username
always has a profile, so it goes to the feed.

---

## 4. Data

Migration `supabase/migrations/20261123000100_a_username_that_sends_a_code_and_tells_nobody.sql`.
Renumbered from `20261117000100` on 2026-11-14 (wave 2; it had never been applied anywhere) so
it sorts after staging's `20261121000300` and the reserved `20261121000400` and
`20261122000100`–`200`; `supabase/tests/username-sign-in.test.mjs` asserts the version is
unique and that no other migration defines its tables or functions.

`auth_username_challenges` — `id_hash` (SHA-256 hex, PK), `user_id` (null = decoy; FK to
`auth.users`, cascade), `created_at`, `sent_at`, `expires_at`, `attempts` (0–5),
`consumed_at` (used *or* superseded).

`auth_username_attempts` — `kind` (`send`/`verify`), `identifier_hash` (HMAC, send only),
`ip_hash` (HMAC), `at`. Only **admitted** attempts are recorded, so a refused flood cannot
grow the table.

Functions, all `security definer`, `search_path = public`, EXECUTE for `service_role` only:
`username_sign_in_send`, `username_sign_in_verify_begin`, `username_sign_in_verify_finish`,
`username_sign_in_purge`. `_username_sign_in_account` (the resolver) is executable by
nobody but its owner.

**Retention:** every send and verify deletes rows older than 24 hours first. No cron is
created; `username_sign_in_purge()` exists for one if a quiet period ever leaves rows behind.

**Secret:** `USERNAME_SIGN_IN_HASH_KEY` (≥ 32 random characters) keys the HMACs. It is not a
credential to anything; rotating it resets the hourly counters. Missing or short → every
request is a uniform 503.

---

## 5. Limits

| Limit | Value | Where | Response when hit |
|---|---|---|---|
| Sends per normalised identifier | 3 / hour (sliding) | SQL | the same 200 as any send |
| Sends per IP | 10 / hour | SQL | the same 200 |
| Emails per account | 1 / 60 s | SQL (cooldown shares the code) | the same 200 |
| Verifies per IP | 30 / hour | SQL | 429 "Too many attempts. Try again later." |
| Guesses per challenge | 5 | SQL | the uniform 400 |
| Challenge lifetime | 10 min | SQL | the uniform 400 |
| GoTrue per-address | `smtp_max_frequency` 60 s | GoTrue (unchanged) | — (behind the cooldown) |
| GoTrue project | `rate_limit_email_sent` | GoTrue (unchanged) | logged as `gotrue_over_email_send_rate_limit`; the client already had the same 200 |

The SQL constants, `limits.ts` and this table are checked against one another by
`handler.test.ts` *the limits stated here are the limits the migration enforces*. None of
GoTrue's settings, `supabase/auth-templates/templates.json` or `check-auth-config.mjs` is
changed by this work.

---

## 6. Client

- `src/features/auth/username-sign-in-flag.ts` — the constant, in a module with no imports.
- `src/features/auth/username-sign-in.ts` — `classifyIdentifier` (contains `@` → email,
  else `^[a-z0-9_]{3,24}$` after trim/lower → username), `sendUsernameCode`,
  `verifyUsernameCode`. The challenge id is held **in memory**, not in route params, so it
  never enters navigation state (which crash reporting breadcrumbs).
- `app/(auth)/sign-in.tsx` — every new branch reads the constant first; with it off the
  screen renders and behaves exactly as before (the unchanged pre-existing suites prove it,
  and `UsernameSignInDark.test.tsx` adds that a username typed into the dark build goes
  nowhere).
- `app/(auth)/verify-username.tsx` — "If that account exists, we sent a six-digit code to
  the email on your account." Two resends at most, 60 s apart. "Use your email instead".
  With the constant off it shows *Start again* to anyone who reaches it.
- Analytics: `sign_in_completed` gains `method: 'username_code'`.

---

## 7. Held decisions (the recommended default is what is built)

1. **Code only, or password by username too?** *Built: code only.* Username + password would
   mean proxying GoTrue's password grant through a function — a second, credential-stuffable
   endpoint keyed on public identifiers — for a capability ordinary accounts do not have
   (auth.md §1: no user passwords). Alternative: a `password` action on the same function,
   with its own per-identifier limits; not built.
2. **Which usernames resolve?** *Built: current only.* Alternative: also resolve names in
   `username_history` while `redirect_until` is open. Rejected by default because a released
   name is, by INF-2, never anybody else's — but it *was* a credential somebody else could
   have shared or written down, and the redirect window exists for links, not logins.
3. **Staging custom SMTP.** Staging uses the built-in sender (2 emails/hour, project-wide,
   and no editable templates — so no six-digit code). Real staging QA needs custom SMTP.
   Pending founder approval; nothing here changes it.
4. **A per-account daily guess cap?** *Not built* (the brief's limits are what is built).
   Recommended before the constant is flipped if the founder wants a tighter bound: e.g. 10
   failed guesses per account per 24 h cuts the long-run figure in §2 by ~36×, at the cost
   that an attacker can then close a victim's *username* path for a day rather than an hour
   (email, Apple and Google unaffected). One SQL change in `username_sign_in_verify_begin`.

---

## 8. Running the tests

```bash
# Database (PGlite, part of npm run test:db)
node --test supabase/tests/username-sign-in.test.mjs

# Function unit tests (no network)
npx deno test --config supabase/functions/username-sign-in/deno.json --allow-read \
  supabase/functions/username-sign-in/handler.test.ts

# Client
npx jest src/features/auth/UsernameSignIn src/features/auth/username-sign-in
```

**End to end, local stack only.** `local-stack.test.ts` refuses any host but localhost.

```bash
npx supabase start
eval "$(npx supabase status -o env | sed 's/^/export /')"
USERNAME_SIGN_IN_LOCAL_STACK=1 SUPABASE_URL=$API_URL SUPABASE_ANON_KEY=$ANON_KEY \
  SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY MAILPIT_URL=$MAILPIT_URL \
  npx deno test --config supabase/functions/username-sign-in/deno.json \
  --allow-net --allow-env --allow-read supabase/functions/username-sign-in/local-stack.test.ts
```

Two things a local stack needs that are not this feature's to fix, both recorded on
2026-11-13:

- **Current Supabase CLIs (2.122, 3.1) refuse `20260817001000_reviews_are_bingds.sql`**:
  it runs `lock table` and the CLI no longer wraps a migration in a transaction. The run
  above used a scratch copy of `supabase/` with that one file wrapped in `begin; … commit;`.
  The repository's file is unchanged; whether to wrap it in place is a separate decision
  (it is already applied everywhere that matters).
- **The CLI's default magic-link template has no `{{ .Token }}`**, so no code arrives. The
  scratch stack's config pointed `[auth.email.template.magic_link]` and `.confirmation` at
  `supabase/auth-templates/*.html` — the production templates — which also makes the local
  email match production.

Not CI-wired: the function's `deno check/lint/test` would need lines in
`.github/workflows/ci.yml` (spelled out there for the same fingerprint reason as
`push-sender`). Deliberately left for the deploy PR so CI changes are reviewed with it.

---

## 9. Deployment checklist — every step needs founder approval

Each step is independently reversible, and the constant stays `false` until the last one.

| # | Step | How | Verify | Rollback |
|---|---|---|---|---|
| 1 | **Staging custom SMTP** | Founder configures in the staging dashboard (not from this repo) | A staging email OTP arrives with six digits | Revert the SMTP setting |
| 2 | **Staging migration** | Normal reviewed path, `20261123000100` only, `--project-ref fjxhcbowoxuzulwirzyr` | `npm run test:db` green; the four functions exist; anon/authenticated cannot select the tables | New migration dropping the two tables and five functions (nothing else references them) |
| 3 | **Staging function + secret** | Set `USERNAME_SIGN_IN_HASH_KEY` (random ≥ 32 chars) and deploy `username-sign-in` through the normal CI path with a temporary, scoped credential | `supabase functions list` on staging; a `send` returns the generic 200 | `supabase functions delete username-sign-in --project-ref fjxhcbowoxuzulwirzyr` |
| 4 | **Staging QA** | Preview build with the constant flipped *locally*, never committed; rows below | All rows pass; logs show only outcome classes; confirm the IP header and GoTrue per-IP behaviour (§2) | Nothing to roll back; the shipped constant is still false |
| 5 | **Production migration** | Normal release path, `--project-ref abheeqyjzekiowkztfxv` | Same as 2 | Same as 2 |
| 6 | **Production function + secret** | Same as 3, production ref, its own hash key | Same as 3 | Delete the function; the client is still dark |
| 7 | **OTA flipping the constant** | One-line change to `USERNAME_SIGN_IN_ENABLED = true`, reviewed, OTA | Founder QA rows on production | OTA back to `false`. The function can stay; nothing calls it |

**Founder QA rows (staging, after step 3):**

- Sign in with a username: the screen says "If that account exists…", a code arrives, the
  sign-in works and lands on the feed.
- Unknown username: the same message; no email is sent anywhere (check the SMTP provider's
  log).
- Email, Google and Apple sign-in: unchanged.

**Rollback in one line:** keep the constant `false` (it is), and delete the function if it
was deployed. The tables are inert without it.
