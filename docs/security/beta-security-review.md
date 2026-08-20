# Bingd beta security review

An adversarial security pass run from the position of an attacker who has everything a
beta tester, a malicious client, or a reader of the now-public repository could have: a
valid anon key, their own authenticated JWT, the source code, and the live web surface.
The question was not "does the code look secure" but "using that access, can anyone cross
a Bingd security or privacy boundary." The short answer for the friend beta is **no
boundary was crossed**.

- **Date:** 2026-08-19 (review), against tree `6dcc1cc` (HEAD `be01145`, identical to
  `origin/main` `b67ea68`, PR #26).
- **Targets, all authorized:** the local repository; the real-PostgreSQL concurrency
  harness; **bingd-nonprod** Supabase (`abheeqyjzekiowkztfxv`) only; and the public
  `bingd.app` web surface with non-destructive probes.
- **Never touched:** any production backend (there is none), any third-party system,
  Cloudflare/Apple/Google infrastructure, TMDB, or founder data.
- **Method:** ~135 live adversarial assertions from disposable nonprod users with
  deliberately varied relationships (public, private, follower, approved, stranger,
  blocked), plus a full catalogue audit of grants, RLS policies and SECURITY DEFINER
  functions against real PostgreSQL, plus git-history and client-bundle secret scans and
  a web-surface pass.

## Verdict

**Bingd is security-ready to proceed to preview/release hardening for a controlled friend
beta.** No Blocker, Major, or Minor finding requires a code change before the beta. One
robustness observation and a set of pre-public items are recorded below. Two physical
device link tests remain as release-acceptance items, unchanged by this pass.

---

## Threat model, in one table

| Boundary | Asset | Attacker capability | Invariant | Control | Result |
|---|---|---|---|---|---|
| Client | anon/authenticated JWT, deep-link input | Call PostgREST directly, forge params/IDs, run a modified client | UI is never the control; the server decides | RLS + SECURITY DEFINER RPCs, `auth.uid()` identity | **Held** |
| Supabase | tables, RPCs, RLS, grants | Direct SELECT/INSERT/UPDATE/DELETE as anon/authenticated | No client direct writes; reads gated by relationship | 0 write grants, 43 tables RLS-on, 95 SD functions | **Held** |
| Social | public/private/follower/blocked | IDOR by known ID; ride another's approval | A relationship, not a guessable ID, decides access | `can_i_view`/`can_discover_profile` | **Held** |
| Content | rankings, notes, comments, notifications | Read/mutate another user's objects by ID | Owner-or-relationship only | SELECT-only policies keyed on `auth.uid()` | **Held** |
| Growth | invite tokens, attribution | Enumerate tokens, steal/replay attribution, self-refer | 128-bit tokens, one attribution, once | `redeem_invite`, `invite_tokens_one_live` | **Held** |
| Web | bingd.app, AASA, assetlinks | Traversal, open redirect, reflection, exposed files | Nothing the visitor sends decides where they go | Decode-then-validate allowlists, static router | **Held** |
| Ops | secrets, public git, telemetry | Read repo/bundle, mine telemetry | No secret leaves the server; no PII in telemetry | env split, allowlisted analytics, Sentry scrub | **Held** |

---

## What was tested, and what happened

### Direct table access / grant audit
Against real PostgreSQL with the migrations applied verbatim, and confirmed live: **zero
tables carry any INSERT/UPDATE/DELETE grant to `anon` or `authenticated`.** Every one of
the 43 tables has RLS enabled; 8 are deny-all (reachable only through SECURITY DEFINER
functions), and the rest carry SELECT-only policies keyed on `auth.uid()` or a
relationship predicate. The five relations readable with RLS "off" are all
`security_invoker` views, so base-table RLS still applies through them. Live INSERT/UPDATE/
DELETE attempts against 23 sensitive tables as an ordinary authenticated user and as anon
were all refused.

### IDOR / cross-user access
Replacing user, media, comment, recommendation, notification, invite and profile IDs never
returned another user's data. Every "denied" assertion was paired with a **positive
control** proving the same path works for the rightful owner — the Review 22 lesson that
absence only means denial when a comparable allowed query succeeds. No RPC accepts a
caller/actor ID; identity is always `auth.uid()`, so forging a target UUID does nothing.

### Private profiles
The product rule — private accounts are discoverable by identity, but their content is
protected — holds exactly. A stranger sees handle, display name, avatar and privacy state;
`rankings`, `user_media`, `watchlist`, `watch_goals`, notes, goals and awards are all
refused. `profile_private` (date of birth) is unreadable **even by its owner** — only
SECURITY DEFINER functions reach it.

### Block as a barrier
Tested decisively: two accounts made mutual followers (with passing positive controls that
the follower could comment, react, recommend and read before the block), then a block. After
the block, every write — comment, reaction, recommend, re-follow, watch-tag — failed to
commit, the pre-existing follow edges were severed both directions, and the blocked user
could no longer read the blocker's feed, comments, reactions, rankings or profile. An
unrelated follower still saw everything, proving the block is targeted, not a global hide.
The seven security mutants (remove the pair lock, drop the activation guard, weaken the
token upsert, etc.) are all detected by the race suite.

### Discovery is not a block oracle
The prior oracle class is closed: an unrelated third party sees identical discovery and
identity results whether or not two *other* people have blocked each other, and
`can_i_view` between two unrelated parties leaks nothing about a third-party block.

### Auth / JWT
No Authorization header, a malformed bearer, an `alg=none` forged-`sub` token, and a
service-role-shaped garbage token all returned 401 or no data. The Edge Function's
`claimsServiceRole` trusts an unverified payload, but only because `verify_jwt = true`
makes the platform validate every signature before the function runs — a forged unsigned
service_role JWT is rejected by Supabase before Bingd's code sees it (confirmed live).

### SECURITY DEFINER / search_path
95 SECURITY DEFINER functions; **all 95 set an explicit `search_path`** (94 `public`, one
`public, pg_temp`). None is writable by `anon` beyond the five intentionally-anonymous read
helpers (`record_invite_open`, list/discovery reads). No function accepts caller-controlled
dynamic SQL.

### RPC input fuzzing
Null, empty, 100k-character, Unicode/bidi, control-character, invalid-UUID, cross-user-UUID,
negative, enormous, invalid-enum, duplicate-array and oversized-array inputs across ~30 RPC
families produced controlled refusals with no SQL leakage and no partial mutation. SQL
injection strings in usernames, search queries and sort parameters were inert.

### Invite / referral
Tokens are 32 hex characters (128 bits) — enumeration is infeasible. Self-referral refused;
replay produces no second attribution; a second inviter cannot steal an existing
attribution; an invalid token reveals no inviter identity or status. `redeem_invite` is
capped at 10 attempts/day and invalid attempts consume that budget, which is the
anti-enumeration direction. The token never appears in analytics (the allowlist forbids
`token`/`invite_token`) or in logs.

### Rate-limit abuse
Every externally-reachable mutation is bounded: follow 60/hr, invite-mint 30/day, redeem
10/day, comments 100/day, reactions 200/day, recommend 50/day + 20/hr, profile 20 edits/day,
revocations 5/day, reports 20/day plus a one-open-report-per-subject index. Refused attempts
consume budget (they return `refused` rather than raising, so the operation claim the limiter
counts is not rolled back) — abuse cannot be made free by forcing a rejection. No
unlimited-mutation path was found.

### Storage / avatars
Cross-user overwrite, cross-user delete, and writes into another user's folder are all
refused by storage RLS. SVG and HTML uploads are rejected at the MIME gate (415). A traversal
object key hits the RLS policy. `set_avatar` rejects a foreign path, a traversal path and an
absolute URL. Avatars are intentionally world-readable and served as their real content type.

### User text / telemetry
Analytics is a **type-enforced allowlist**: there is no free-form `track(name, props)`, and
`sanitize()` drops any key not declared and any non-scalar value. A `FORBIDDEN_PROPERTY_KEYS`
list (email, note, bio, query, token, username, media ids, …) is asserted by test. Sentry
runs with `sendDefaultPii: false`, a `beforeSend` scrub and a separate transaction scrub. No
note, bio, search query, email or token can reach a vendor by construction.

### bingd.app web surface
Every route (`/`, `/i/*`, `/u/*`, `/title/*`, `/lists/*`) returns the same static page with
no reflection of any input. Path traversal (plain, encoded, double-encoded, backslash, nul),
malformed percent-encoding, 8 KB paths, and a battery of open-redirect and
destination-injection attempts (`?next=`, `?redirect=`, protocol-relative, `javascript:`,
backslash) produced no redirect and no reflected content. The client router decodes then
validates each identifier against a strict allowlist; all destinations are baked in at build
time. `.git`, `.env`, config files, source maps and directory listings are not exposed (the
static host serves the fallback page, not the file). Deployed `page.mjs`/`router.mjs` are
byte-identical (md5) to the reviewed tree. Security headers are present and deliberate:
`X-Frame-Options: DENY`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`,
HSTS, nosniff, `Referrer-Policy`. The absence of `script-src`/`default-src` is a documented
decision for a static install page with no inline-script risk.

### Deep-link input
`tokenFromPath`, `handleFromPath` and `titleIdFromPath` decode once (returning null on a
malformed escape) and match a strict shape (`[0-9a-f]{32}`, `[a-z0-9_]{3,24}`, a UUID). A
crafted destination in the URL cannot navigate outside the intended surfaces.

### Secret scans
- **Git history (141 commits):** no `.env` ever committed, no service-role JWT, no private
  key, no TMDB/Sentry/EAS token. Only `.env.example` (placeholders) is tracked.
- **Client bundle (fresh Android export):** no `service_role`, no `TMDB_*`, no
  `SENTRY_AUTH_TOKEN`, no private key, zero embedded JWTs. Only the intended public
  identifiers (Supabase anon/publishable key, Sentry DSN, PostHog project key) can ship, and
  `app.config.ts` only ever copies `EXPO_PUBLIC_*` values into `extra`.

### Dependencies
`npm audit` reports 17 findings (9 moderate, 8 high). **All root to two build-time-only
advisories** — `image-size` (Metro's bundler image parser) and `uuid` v3/v5/v6 (via the
`xcode` config plugin). Both are denial-of-service class, reachable only by the build host
processing hostile input; neither ships in the runtime app bundle or the server. Not
runtime-reachable, not a beta blocker. No `npm audit fix` was run (it would force breaking
Expo upgrades).

### Edge Function (tmdb-adapter)
Auth required (`verify_jwt = true`); an unauthenticated call is rejected by the platform, a
signed anon token is rejected in-function with `BG401`. The caller controls only a search
`query` (URL-encoded into a query parameter) and a clamped `limit` — the upstream path is a
fixed literal, so there is no SSRF or arbitrary-proxy behavior. The TMDB secret lives only in
`Deno.env` and never appears in a response.

### Account deletion / session
`delete_account` requires the caller's own handle, deletes the `auth.users` row, and cascades
the schema. Confirmed live: after deletion the profile is gone and undiscoverable, a **held
JWT is inert** (reads nothing, mutates nothing), the refresh token cannot mint a new session,
and the deleted user's private note does not leak.

### Account enumeration
Sign-in/OTP/signup responses are Supabase-GoTrue-controlled; OTP with `create_user:false`
returns a uniform `otp_disabled` and does not distinguish existing from non-existing
addresses. Username availability is a deliberate product feature. This surface is not
Bingd's to change and is acceptable for a friend beta.

---

## Findings

### Blocker — none
### Major — none
### Minor — none requiring a code change

### Nice (corroborated by the independent Codex review) — custom-scheme token interception
The web router offers `bingd://i/<token>` as the installed-app deep link
(`web/src/router.mjs:242`), and a custom scheme does not authenticate its recipient — another
installed app registering the `bingd` scheme could receive the token. This was raised and
**downgraded in Review 27b** and remains a Nice, not a security boundary: the invite token is a
*reusable referral identifier*, not an authentication credential. Attribution is keyed
per-invitee, so an intercepting attacker cannot steal another invitee's attribution; the worst
outcome is a false self-attribution and a spurious "someone joined" notification to the inviter,
both bounded by `redeem_invite`'s own rules (self-referral refused, one attribution per invitee,
replay-safe — all verified live). The mechanism is already written into `appLinkFor` in
`web/src/router.mjs`. No change needed for beta.

### Robustness note (not a security defect): validation raises that surface as HTTP 500
Several legitimate "not found / precondition" refusals raise SQLSTATE `P0002` (a deliberate,
app-wide convention, 39 uses), which this PostgREST version maps to **HTTP 500** rather than a
4xx — e.g. `set_bucket` on an unknown media id ("no such title"), `rank_reorder` on an
unranked title ("title is not ranked"), `set_watch_tags` before a log ("log the watch first").
This is **not** a security boundary crossing: the messages are curated, no SQL or internal
state leaks, PostgREST runs in production mode (no stack traces), and no partial mutation
occurs — verified against the concurrency harness and live. The only cost is that ordinary
precondition failures read as server faults in monitoring (Sentry noise) and are inconsistent
with the 65 sibling raises that correctly use `22023` (→ HTTP 400). Recommended, **post-beta**,
to reclassify these to a 4xx-mapping errcode. Not fixed in this pass: it is app-wide, touches
deployed SECURITY DEFINER functions, and clients key error handling off these codes, so it is a
scoped change for its own tranche rather than a security fix.

---

## Friend-beta residual security blockers

**None.** The beta may proceed on the security posture.

## Pre-public launch security work

Recommended before opening beyond a controlled friend group, in rough priority order:

1. **Reclassify P0002 validation raises to 4xx** (the robustness note above) — cleans
   monitoring and removes any future risk of a 500 path carrying unintended detail.
2. **Dependency hygiene:** land the Expo/Metro upgrade that clears the `image-size`/`uuid`
   build-time advisories once a compatible release is available; keep `npm audit` in CI as a
   report-only gate.
3. **Account-enumeration posture:** decide, at the product level, whether the
   Supabase-default email-existence behavior is acceptable at public scale, and document the
   decision.
4. **Web CSP:** with a real browser in the loop, add `default-src`/`script-src`/`style-src`
   to bingd.app once there is a test that proves the install page still renders (the current
   omission is deliberate and safe for the static page, but a public surface benefits from the
   full policy).
5. **Rotate the nonprod anon key** if it was ever pasted outside the repo during testing
   (it is publishable, so this is hygiene rather than remediation).
6. **A professional third-party penetration test** becomes worthwhile once native push,
   payments, or a production backend exist — none of which is in scope today. It is **not** a
   prerequisite for a small controlled friend beta on the current surface.

## What was NOT tested

- **Physical OS link dispatch** (see below) — a device-only acceptance test.
- **Supabase's own cryptography / JWT signing** — explicitly out of scope; only trust
  boundaries *above* the signature were tested.
- **Native push** — not implemented.
- **A production backend** — does not exist.
- **High-volume / DoS-scale abuse** — deliberately avoided; limiter *policy* was tested at
  the threshold, not by flooding.

## Physical link verification — still pending (release acceptance, unchanged)

- **iOS:** tap `bingd.app` profile/title/invite URLs from Notes/Messages and confirm an
  installed Bingd opens the exact route.
- **Android:** verify App Links with a suitable Preview signing identity.

These are device acceptance items and are **not** closed by bingd.app being live.

---

## Test verification at this checkpoint (tree `6dcc1cc`)

```
tsc --noEmit                      clean
eslint .                          0 errors · 1 pre-existing no-console warning
jest                              1414 / 1414
test:db (node --test)             782 / 782
test:race (real PostgreSQL 17)    74 / 74
test:race:mutants                 7 / 7 security defects detected
test:web                          47 / 47
test:web:mutants                  7 / 7 defects detected
adversarial live probes           ~135 assertions, every genuine control held
```

## Independent review

An independent read-only Codex pass (codex-cli 0.147.0, `sandbox: read-only`) was pointed at the
security-critical migrations, the Edge Function, the web router and the telemetry helpers with
the two questions: *"as a normal authenticated user with a modified client, what can I read or
mutate that belongs to another user?"* and *"if the public repo and client bundle are fully
known, does any boundary collapse?"* Its verdict:

> **SECURITY VERDICT: PASS** — Blocker: none, Major: none, Minor: none. One Nice (the
> custom-scheme token item above). "No RPC was found trusting a client-supplied actor identity
> for protected mutation; exposed writers derive the actor from `auth.uid()`. No weaker
> cross-user RLS read, dangerous direct table DML grant, missing `search_path`, over-broad
> privileged-function grant, block bypass, replayable attribution transfer, client-side private
> credential, Edge Function SSRF/secret disclosure, or attacker-controlled web redirect
> destination was found."

Nothing was pushed, nothing was deployed, no migration was written, and the working tree is
clean but for pre-existing founder-local files.
