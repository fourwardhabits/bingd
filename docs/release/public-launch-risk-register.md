# Public-launch risk register

**Last verified against HEAD: 2026-08-23**, during the friend-beta follow-up pass.

## What this document is

The single home for findings that are **not** friend-beta blockers but **are** gates,
hazards or accepted costs on the way to a public store release. It exists because that
register previously lived only inside audit outputs, and an audit output is not a document
anybody maintains.

It is **not** a second PRD, a second decision log or a second deferred roadmap:

- *Why* a capability is postponed, and what it will look like → [`../product/deferred-roadmap.md`](../product/deferred-roadmap.md)
- *What was decided* and by whom → [`../product/decision-log.md`](../product/decision-log.md)
- *What is still unanswered* → [`../product/open-questions.md`](../product/open-questions.md)
- *Security testing and its findings* → [`../security/beta-security-review.md`](../security/beta-security-review.md)
- *Release mechanics* → [`release-lanes.md`](./release-lanes.md), [`safe-update-runbook.md`](./safe-update-runbook.md), [`beta-distribution-readiness.md`](./beta-distribution-readiness.md)

This document holds only the **classification and the current status** of each risk, with
enough evidence to re-check it.

## Release classification

| Lane | Verdict | Held since |
|---|---|---|
| **Friend beta** (TestFlight / Play closed test) | **GO** | Unchanged by this pass. Nothing found here is a friend-beta blocker |
| **Public store** (App Store / Play production) | **NOT YET** | The majors below must be closed, or explicitly resolved by a scope decision |

**The classification discipline, which matters more than any single row.** Four levels,
and items do not drift upward without new concrete evidence:

- **Friend-beta blocker** — stops the current cohort. *There are none.*
- **Pre-public major** — must be closed or consciously scoped out before a public release.
- **Beta-safe minor** — real, known, not worth stopping for. Observed, not fixed.
- **Accepted risk** — a deliberate choice, already argued. **Not a defect.**

Promoting a minor or an accepted risk to a blocker requires new evidence, not a re-reading
of the same facts.

---

## 1. Pre-public majors

Status legend: **OPEN** (unchanged) · **PARTIAL** (some layers closed) · **RESOLVED**.

### M1 — UGC reporting, moderation, and Terms — **OPEN**

Feed comments are user-generated content. Public Notes surfaced as Bingd Reviews are user-
generated content. Both are readable by people other than their author.

- `report_subject` covers `profile`, `display_name`, `username`, `list`, `list_title`,
  `watch_tag`. It does **not** include `comment` or `note` / `review`. No later migration
  extends it.
- The report RPC has **zero client call sites**. Nothing in the app can file a report.
- **No Terms or community-policy acceptance gate exists** before a user creates UGC. There
  is no `/terms` route and no acceptance state.

PRD §27 already gates the public release on the *whole* loop — a report flow with no
operator surface is a checkbox — and `open-questions.md` §7 records that as not open for
debate. HG-4 in `open-questions.md` §5 carries the legal half.

**Why it is not a beta blocker:** the cohort is 30–60 people who know each other, and the
moderation answer at that size is the founder talking to them.

**Documented 2026-08-23, still open.** PRD §22's Reporting section named only the v0.6
taxonomy and said the obligations applied "regardless of the absence of comments" — which
had stopped being true twice over. It now carries an As-built block naming both free-text
surfaces (feed comments, and public notes surfaced as Bingd Reviews), stating that
`report_subject` covers neither and that the report RPC has no client call site at all,
and stating that no Terms of Use exists. **The risk is unchanged and its classification is
unchanged**; what changed is that the document no longer understates the surface it has to
cover. Nothing in the privacy pass implies these surfaces are private — they are public by
their author's own choice, and the gap is the absence of a way to *report* them.

### M2 — TV seasons: documented as rankable only when Completed, unenforced — **OPEN**

Verified in full this pass. The gate is unenforced at every layer *and* the state it
depends on is unreachable by any user, because `set_season_progress` has zero client call
sites. `season_completed` feed events can never fire for the same reason.

The exact contradiction, with both sides cited, is
[`../product/open-questions.md`](../product/open-questions.md) §8 **TV-1**. It is entangled
with repeat-watch semantics and should be resolved with them.

### M3 — Same-title concurrency between logging and ranking — **OPEN**

`set_bucket` takes no lock and runs `_assert_unranked` followed by an upsert with nothing
serializing the two. `rank_start` takes no `(user, media_item)` lock either — the only
advisory locks in the ranking family are keyed on `(user, category)`, which is a different
grain. So `set_bucket` and `rank_start` on the same title can interleave.

This is **known and recorded at the site**: the migration that defines `set_bucket` says so
in its own header. `unlog` versus ranking is the related case.

### M4 — Rank Again is two operations with no atomicity and no idempotency — **OPEN**

`rankAgain` is still `rank_unrank` followed by `rank_start`, in sequence, with no
transaction. A failure between them leaves the title **logged but unranked** — a real state
the app can display, which is what keeps this a major rather than a corruption.

Compounding it: **no ranking RPC takes an operation id**, so nothing server-side can
recognise a replay. A `rank_answer` that finalises and loses its reply is reported to the
reader as a failure over a ranking that exists. The beta answer is honest copy — the sheet
says the outcome is unknown and names checking the collection — rather than a claim that
nothing happened.

The real fix is `_claim_operation` on the ranking functions, which is a migration and is
the same mechanism [`../product/deferred-roadmap.md`](../product/deferred-roadmap.md) §19
needs.

### M5 — Privacy: UI copy, PRD and schema alignment — **RESOLVED 2026-08-23**

Closed by the privacy-contract pass. There is now one contract, and the app, the PRD,
the decision log and the schema all state it the same way. The backend was found
**correct throughout and was not changed** — every defect was a document or a piece of
copy describing it wrongly.

What was wrong and what closed it:

- **Private-account discovery.** `app/settings/privacy.tsx` told the reader *"While your
  account is private, your profile does not appear in search"*. That has been false
  since `20260819000100` moved `search_users` to `can_discover_profile`, which reads
  status and blocks and ignores `visibility` entirely. The copy now says the true thing
  — people can find you by name or @handle and ask to follow; what private gates is your
  rankings, collection, watchlist, reviews and activity. The screen's own header comment
  claimed the same falsehood and was corrected with it. **No RLS was loosened or
  tightened to make this true; the copy was wrong, not the behaviour.**
- **Notes.** PRD §22 listed Notes under "Always private (all accounts)" and asserted
  twice that "Notes and watch dates remain always-private", while public notes have
  shipped as Bingd Reviews since `20260816000000`. The PRD now carries the real
  contract: a note is private until its author publishes it as a review, and a published
  note is still gated by account visibility and by blocks. `decision-log.md` carried the
  same stale claim in two rows and now carries the superseding decisions.
- **Watchlist.** Was already aligned; `open-questions.md` §7 was corrected in the
  previous pass.
- **The default a new note gets.** The client opened new notes **public**. The field is
  labelled *Notes*, it saves on blur with no Done button, and the only thing standing
  between a candid sentence and a public review was noticing an unticked chip called
  "Only me". New notes now default to **private**, the control names the publishing act
  (*Share as a review*), and the Reviews tab's "Write a review" opens ready to publish so
  that door still means what it says. **Client-only: no migration, and no stored row
  changed visibility in either direction.**
- **Signup said nothing.** Every account is public because that is the column default,
  and the first time anybody learned this was by finding the switch that turns it off.
  One sentence under Create my account now says so. The default itself did not move.

**Verified, not assumed:** `watched_on` is owner-only on every path. `user_media` carries
the only SELECT policy it has ever had (`user_id = auth.uid()`), the two review
projections (`public_notes`, `title_reviews`) deliberately omit the column, no
`feed_events.payload` contains a date, and no view, RPC or `returns table` anywhere in
the migration tree names it. Watch-date privacy is the one promise in this section that
never needed correcting.

**Residual, and deliberately not fixed here.** The server's forward default is still
`public` when a caller passes no visibility (`log_watched` / `save_note`). The app always
sends an explicit value, so nothing today depends on it — but the client and the server
now disagree about what an unspecified new note means, and aligning them is a migration.
Recorded as a founder decision in `../product/open-questions.md` §8 **NR-1**. It is not a
privacy exposure: the disagreement can only be reached by a caller that is not this app.

### M6 — Production environment identity is seeded as `nonprod` — **OPEN**

Migrations seed `app_config['env.name'] = "nonprod"` with `on conflict do nothing`, and
every reader defaults to `'nonprod'` when the key is absent. Invite resolution matches
`t.env = v_env`, so a production database that never had `env.name` deliberately set to
`'prod'` **silently mints and resolves nonprod tokens with no error at all**.

No bootstrap step that sets it exists in `docs/release/**` or `scripts/`.

**A fresh production environment must deliberately establish its own environment identity
rather than inheriting that value.** Preserve this row verbatim until a provisioning step
exists — the failure mode is silent, which is what makes it dangerous rather than merely
untidy.

The production backend otherwise remains intentionally **fail-closed** until explicitly
provisioned, which is the correct posture and is not a defect.

### M7 — Deferred referral attribution in production — **OPEN (deliberately deferred)**

`https://bingd.app/i/<token>` is the canonical, stable invite URL and does not change.

The beta mechanism is honest and manual: the landing page keeps the token in the address
bar, and after installing, the visitor returns to it and taps *I already have Bingd*.
Somebody who instead launches from the home screen arrives with no token and is **not
attributed, permanently and undetectably**. No Play Install Referrer and no iOS deferred-
link vendor is wired.

**Acceptable for friend beta. A pre-public item**, because paid or scaled acquisition
without attribution cannot be measured. Reasoning is in
[`../product/deferred-roadmap.md`](../product/deferred-roadmap.md) §7 and §10.

### M8 — Physical-device Universal Link / App Link acceptance — **PARTIAL**

The artifacts and configuration exist: `associatedDomains: ['applinks:bingd.app']`, Android
`intentFilters` with `autoVerify: true` for `/u/`, `/lists/`, `/title/` and `/i/`, plus a
served `apple-app-site-association` and `assetlinks.json` carrying two SHA-256
fingerprints.

**None of it has been verified on hardware.** `device-acceptance.md` records that no iOS
validation of any kind has been performed at any point in this project, and every
acceptance box in that file is unchecked. The custom `bingd://` fallback is secondary to
verified HTTPS links and is not a substitute for this check.

**Configuration present ≠ links verified.** This closes only by running the acceptance
list on real devices.

### M9 — Legal and store operational gates — **OPEN**

Tracked as HG-2 through HG-6 in [`../product/open-questions.md`](../product/open-questions.md) §5
and as unchecked gates in PRD §27. Current split:

| Gate | State |
|---|---|
| Privacy policy, support and account-deletion URLs | **Written and deploying with `main`** |
| Apple App Privacy / Google Data safety answers | **Prepared row-by-row** in [`store-privacy-inventory.md`](./store-privacy-inventory.md) |
| Age-rating rationale | **Drafted** |
| TMDB attribution obligations | **Met** |
| Support mailbox | Pending — founder must confirm it is real and monitored |
| **Terms of use** | **Does not exist.** No document, no route, no client link. Also blocks M1 |
| Brand / name / trademark clearance (HG-3) | Open |
| Google Play production access (HG-5) | Gated on the 14-day / 12-tester rule; **no Play Console app record, signing key, service account or tester list exists yet** |
| Final store and brand assets (HG-6) | Open |

---

### M10 — Public release opens signup; an invite becomes referral, not admission — **OPEN (product requirement, recorded 2026-08-23)**

**Founder decision, recorded here rather than implemented.** For the public App Store and
Play releases the hard invite gate is removed:

- **No invite** → the visitor may create an account normally.
- **Invite present** → the visitor may create an account normally, *and* the inviter
  relationship, the referral attribution and the follow edge are preserved.

An invitation becomes **optional referral and social context**, never a required
admission credential.

**Most of this is already true, which is the useful finding.** Verified at HEAD:
`create_profile(text, text, date)` contains no reference to `invite_tokens`,
`invite_attributions` or any token — the checks are auth, a username pattern, a display
name, and the 13+ date-of-birth gate. There is **no account-level invite gate to remove.**
`redeem_invite` is a separate, optional act that files the attribution and the follow.

**So the friend beta's invite-only quality is a *distribution* gate, not an app gate:** the
only thing stopping a stranger is that the build lives in TestFlight and a Play closed
test. Publishing to the public store is what opens signup, and it needs no change to the
signup path.

What *does* need doing before public release:

- **Deferred attribution.** The token does not survive a trip through TestFlight or Play —
  there is no install referrer and no attribution vendor — so a recipient who installs and
  launches from the home screen arrives with no inviter, permanently and undetectably.
  Acceptable for the beta, tracked as **M7**, and it becomes the difference between
  measurable and unmeasurable referral once acquisition matters.
- **Confirm nothing in the public build teaches invite-only behaviour.** Today the web
  invite page says Bingd "is in closed testing, and this invitation is how you get in",
  which is true now and will be wrong the day the store listing is public.

**Not friend-beta work, and not to be implemented ahead of the store decision.**

---

### Friend-beta invite instruction — verified 2026-08-23, no code change

Recorded because it was in question and the answer is "it already works":

> **Invite friends from Bingd. Send the Bingd invite link, not the raw TestFlight link.**

- **Any ordinary tester can generate one.** `create_invite_link` is granted to
  `authenticated` with no allowlist, admin role or founder check; the only gates are
  signed-in and not-suspended. Profile → **Invite friends** is two taps, and the same link
  is reachable from the Recommend sheet and from Settings → Privacy.
- **One link is enough.** `https://bingd.app/i/<token>` is the canonical URL. The web page
  it resolves to offers a real, public TestFlight join URL and a real Play closed-test
  opt-in URL, both committed in `web/distribution.config.json`. Nothing in the app tells a
  user to ask the founder for anything.
- **The token preserves the inviter** through `redeem_invite` into
  `invite_attributions` and `profiles.invited_by`, plus the follow edge.
- **Two caveats that are platform, not product.** Android closed testing only admits
  Google accounts on the Play Console tester list, so the founder still adds Android
  testers there — no link fixes that. And the recipient must return to the same
  `bingd.app/i/<token>` page after installing and tap *I already have Bingd*, or the
  account is created with no inviter (**M7**).


---

---

### M11 — Push notifications are not built, and the credentials are not configured — **OPEN**

**Verified 2026-08-23** after a real follow produced an inbox row and no phone
notification. That was expected behaviour, not a bug: nothing in the repository has ever
been able to send a push.

| Stage | State |
|---|---|
| `expo-notifications` + config plugin in every build | **done** — so enabling push needs no new binary |
| Apple / Google credentials in `app.config.ts` | **absent** — no `googleServicesFile`, no `aps-environment`; both files gitignored |
| OS permission request | absent — zero call sites |
| Token acquisition and persistence | absent — `device_tokens` exists, no writer, no `register_device_token` RPC |
| Delivery path | absent — `tmdb-adapter` is the only Edge Function |
| Foreground handler / listeners | absent |

**The in-app inbox is the channel the friend beta was built to test, and it works** — the
follow row was created, categorised, routed and rendered correctly. Push is additive.

**Not a friend-beta blocker.** It is a public-launch item, and the credentials are a
founder task with Apple and Google rather than an engineering one. The smallest
implementation slice, in order, is in
[`../product/deferred-roadmap.md`](../product/deferred-roadmap.md) §4.

**Corrected alongside it:** PRD §15's build posture and the §27 launch checklist both
asserted the push credentials were configured. Only the module is.

## 2. Beta-safe minors

Real, known, and **not** worth stopping the beta for. Recorded so they are not rediscovered
as if new, and not promoted without new evidence.

- **A foreground OTA update can reload the app immediately** after it returns active, which
  may discard local UI state the reader was in the middle of.
- **Watch date has a narrow cross-device race.** The log sheet stamps a default date from a
  settled read; a date recorded on another device inside that window needs a server-side
  conditional write to close, which the beta accepts.
- **Support email and address conventions have been inconsistent across documents.**
- **Beta Sentry source-map upload and symbolication are limited**, so stack traces are less
  useful than they will be.
- **Some expected RPC refusals surface as generic server errors** and appear in Sentry as
  noise rather than as the deliberate refusals they are.
- **Temporary OAuth redirect debug logging should be removed** before public release.
- **The first title entering an empty ranking band settles without a comparison** — which is
  correct, and means documentation must not claim a comparison is literally mandatory in
  that case.
- **Catalogue, search and direct-season-discovery edge cases** remain appropriate beta
  observation items rather than fixes.

---

## 3. Accepted risks

Deliberate choices, already argued. **These are not defects and must not be converted into
blockers without new evidence.**

- **Beta data is disposable** and is not intended to migrate into production.
- **No production-grade automatic deferred deep linking during the friend beta** (see M7).
- **The custom `bingd://` scheme is secondary** to verified HTTPS links.
- **There is no full offline write outbox.** PRD §18's capability matrix is decided; the
  outbox is not built.
- **Known npm and build-toolchain audit findings are not, by themselves, a beta blocker.**

---

## 4. Changes made in the 2026-08-23 pass

For traceability, so a later reader can tell what moved and what merely got re-verified.

| Change | Effect on this register |
|---|---|
| Bucket display copy reworded | None. Display-only; stored semantics untouched |
| Collection remembers Movies / TV | None. Local preference, no backend surface |
| Unranked card copy and X dismissal | None. The trigger was already correct and medium-scoped |
| Repeat-watch design written | Adds no risk. §19 is design-only; nothing shipped |
| Letterboxd import deprioritized | **Removes** it as an implied gate on either store release |
| `open-questions.md` §7 watchlist bullet corrected | Closes one third of M5 |
| `open-questions.md` §8 opened | Gives M2 a precise, citable statement |
| Privacy search copy contradiction identified | **New concrete finding**, filed under M5 |

**Nothing was removed from this register as resolved in this pass.** M5 and M8 moved to
PARTIAL on evidence; every other major stands where it did.

## 5. Changes made in the privacy-contract pass, 2026-08-23

| Change | Effect on this register |
|---|---|
| Settings privacy copy corrected | Closes the live false statement in **M5** |
| Signup discloses that accounts start public | Closes the "no disclosure" half of **M5**. The default itself did not move |
| PRD §22 and decision-log reconciled on Notes, watchlist, discovery | Closes the documentation half of **M5** |
| New notes default to private; control renamed *Share as a review* | Closes the "published by inattention" half of **M5**. Client-only, no migration, no stored row changed |
| Watch-date privacy verified exhaustively | Confirms the one promise that was already true. No change required |
| PRD §22 Reporting now names comments and public Reviews | **M1** documented more honestly, **still OPEN**, classification unchanged |
| `open-questions.md` §8 **NR-1** opened | The one residual: client and server disagree on the default for an unspecified new note |

**No RLS policy, RPC or migration was changed.** Every defect this pass closed was a
document or a piece of copy describing the backend wrongly. **M5 is the only major that
moves to RESOLVED**; M1 through M4 and M6 through M9 stand exactly where they did.

## 6. Changes made in the notification-repair pass, 2026-08-23

| Change | Effect on this register |
|---|---|
| Query focus tracking wired to `AppState` | Fixes the stale unread badge. `refetchOnWindowFocus` was inert on a phone, so the inbox query could only refetch when a new observer mounted |
| Inbox opts into focus refetch; refetches on screen focus when stale; Feed's pull-to-refresh includes it | The bell is now correct at launch, on foreground, on tab focus, on pull-to-refresh and after Mark all read |
| Unread badge restyled Parchment-on-Maroon | Cosmetic. Same certified 7.4:1 pair, inverted |
| Inbox layout: compact summary action, Follow back inset and sized to its label, relative timestamps | Cosmetic. No change to what a notification means |
| Inbox uses the shared `unreadCount` selector | Removes a duplicated definition of "unread" that could have drifted from the bell |
| Push pipeline verified end to end | **M11 opened.** Not a new risk — a precise statement of an already-deferred one |
| Invite flow verified | **M10 opened** for the public open-signup requirement. No code changed; ordinary testers can already generate links |

**No SQL, no native config, and no notification semantics changed.** Read/unread still
means what it meant: opening the inbox marks nothing, and only Mark all read clears it.

## 7. Changes made in the invite-welcome and birthday pass, 2026-08-23

| Change | Effect on this register |
|---|---|
| `invite_welcome` notification added (`20260823000100`) | None. An invitee is now told who invited them; **this is the first migration in four passes**, so this tranche needs a backend deploy where the last three did not |
| Birthday helper copy on signup | None. Copy only — the reason was true and unstated |
| DOB retention audited | **DOB-1 opened** in `../product/open-questions.md` §8. Collection is justified; the *retention* is not, because nothing reads the value after signup |
| Push | Untouched. **M11 stands exactly as written** — this welcome is an inbox row and nothing here makes it a push |
| Invite routing, tokens, attribution | Untouched. `redeem_invite` was recreated verbatim with one insert added; the follow, the inviter's notification, the refusal branches and the return shape are byte-identical |

**M10 is unchanged and was not acted on** — the public open-signup requirement stays a
recorded decision, not work. No existing major changed classification in this pass.
