# Privacy disclosure decision matrix

**Last updated:** 9 November 2026  
**Branch:** cursor/privacy-matrix-trailer-production-6b14  
**Evidence base:** Nov 8 2026 privacy investigation package (attached to the PR run), repo code audit, public Apple App Store nutrition label, public Google Play Data safety page.  
**Scope:** reconcile public store declarations against verified code evidence; identify discrepancies; list unresolved founder actions; prepare proposed policy wording for missing descriptions.

No App Store Connect or Play Console sign-in was performed. Public label evidence was taken from the App Store product JSON and Play Data safety HTML, both fetched 2026-11-08.

---

## How to read this table

- **Collected/transferred:** verified from repository code, migrations, SDK config. Not from intent.
- **Recipient:** who ultimately holds or processes the data.
- **Linked:** linked to a user account ("account-linked"), device but not account ("device-linked"), or neither ("not linked / IP exposure").
- **Retention (verified):** what the code and schema comments say. "FOUNDER" means the answer requires a console check or a contract review.
- **Apple declared:** what the public nutrition label actually shows (from the fetched JSON, not from the repo inventory).
- **Play declared:** what the public Data safety page actually shows.
- **Recommended:** what this analysis concludes the declaration should be, with a confidence level.
- **Confidence:** High = code is deterministic; Medium = hypothesis with supporting evidence; Low = requires founder action to resolve.

A code-level finding, a legal-copy recommendation, and a verified console answer are three different things. This matrix reports the first. The founder must supply the third before changing store forms.

---

## Data-type rows

### 1 · Email address

| Field | Value |
|---|---|
| Collected/transferred | Yes — stored in `auth.users` |
| Recipient | Supabase (service provider) |
| Linked | Account-linked |
| Retention | Lifetime of account; deleted on account deletion |
| Apple declared | Contact Info → Email Address, App Functionality |
| Play declared | Personal info → Email address, App functionality, Account management |
| Recommended | **Declare as stated.** Accurate. |
| Evidence | `supabase/migrations/` — `auth.users` schema; account deletion runbook |
| Confidence | High |
| Unresolved | None |

### 2 · Name (display name + Apple/Google identifier name)

| Field | Value |
|---|---|
| Collected/transferred | Yes — stored in `profiles.display_name`; Apple/Google return a name at sign-in |
| Recipient | Supabase (service provider) |
| Linked | Account-linked |
| Retention | Lifetime of account; deleted on account deletion |
| Apple declared | Contact Info → Name, App Functionality |
| Play declared | Personal info → Name, App functionality |
| Recommended | **Declare as stated.** Accurate. |
| Evidence | `profiles` table; `auth.identities` |
| Confidence | High |
| Unresolved | None |

### 3 · Date of birth

| Field | Value |
|---|---|
| Collected/transferred | Yes — stored in `profile_private.date_of_birth` |
| Recipient | Supabase (service provider). Raw date never leaves the database (allowlist enforced + tested) |
| Linked | Account-linked |
| Retention | Lifetime of account; deleted on account deletion. Exact date retained (DOB-1 decision, 2026-08-24) for three purposes: age gate, future age-based recommendations, future aggregate analysis |
| Apple declared | Other Data → Other Data Types, App Functionality |
| Play declared | Personal info → Other info, App functionality |
| Recommended | **Declare as stated.** Accurate. Not "Sensitive Info" on Apple (ordinary DOB is not in Apple's sensitive-info category). Play purpose is App functionality — do not add Personalisation until a recommender actually reads it. |
| Evidence | `20260813001400_security_fixes.sql`; `20260813001400` comment on `profile_private`; `docs/product/open-questions.md` §8 DOB-1; `rls.test.mjs` |
| Confidence | High |
| Unresolved | None |

### 4 · Profile picture

| Field | Value |
|---|---|
| Collected/transferred | Yes — stored in Supabase Storage `avatars/{uuid}/` |
| Recipient | Supabase (service provider) |
| Linked | Account-linked |
| Retention | Deleted on account deletion |
| Apple declared | User Content → Photos or Videos, App Functionality |
| Play declared | Photos and videos → Photos, App functionality |
| Recommended | **Declare as stated.** Accurate. |
| Evidence | `src/features/profile/` upload paths; storage bucket rules |
| Confidence | High |
| Unresolved | None |

### 5 · Rankings, comparisons, notes, reviews, comments, reactions, watch tags

Collectively "Other User Content".

| Field | Value |
|---|---|
| Collected/transferred | Yes — stored in `rankings`, `comparisons`, `ranking_sessions`, `feed_events`, `comments`, `reactions`, `watch_tags`, `user_media`, `watchlist`, `watch_goals` |
| Recipient | Supabase (service provider) |
| Linked | Account-linked |
| Retention | Lifetime of account; deleted on account deletion |
| Apple declared (two purposes) | User Content → Other User Content, App Functionality; **also** Other User Content under **Product Personalization** |
| Play declared | App activity → Other user-generated content |
| Recommended | **Declare under both App Functionality and Product Personalization on Apple.** Rankings and comparisons directly drive `match_scores` and `recommendation_*` tables — what a user ranked influences which titles are recommended to them. Product Personalization is accurate and should stay. The repo inventory previously said "not personalisation"; this was incorrect. |
| Evidence | `match_scores`, `recommendation_*` tables; `src/features/discovery/` recommendation queries; `for-you` screen |
| Confidence | High |
| Unresolved | None — the public Apple label is correct; the old repo inventory line was wrong |

### 6 · User ID (account identifier)

| Field | Value |
|---|---|
| Collected/transferred | Yes — used internally and sent to PostHog and Sentry |
| Recipient | Supabase (service provider), PostHog (analytics service provider), Sentry (crash service provider) |
| Linked | Account-linked |
| Retention | PostHog and Sentry: FOUNDER (check project retention settings); first-party: lifetime of account |
| Apple declared | Identifiers → User ID, Analytics and App Functionality |
| Play declared | Personal info → User IDs, Required, App functionality / Analytics |
| Recommended | **Declare as stated.** Accurate. |
| Evidence | `src/lib/analytics.ts` — `initAnalytics` sends account id; `src/lib/monitoring.ts` — user object reduced to id |
| Confidence | High |
| Unresolved | PostHog and Sentry retention: **FOUNDER** (§6 item 4 in `store-privacy-inventory.md`) |

### 7 · Product analytics / app interactions

| Field | Value |
|---|---|
| Collected/transferred | Yes — PostHog receives named events with a typed property set |
| Recipient | PostHog (analytics service provider) |
| Linked | Account-linked (account id sent as super property) |
| Retention | FOUNDER — PostHog project retention setting not verified from repo |
| Apple declared | Usage Data → Product Interaction, Analytics |
| Play declared | App activity → App interactions, Required |
| Recommended | **Declare as stated.** Accurate. Play: Required (correct — analytics initialises before first render, no opt-out). |
| Evidence | `src/lib/analytics.ts`; `app/_layout.tsx` — PostHog initialised unconditionally; `disabled: false` |
| Confidence | High |
| Unresolved | Retention: **FOUNDER** |

### 8 · Crash and error reports

| Field | Value |
|---|---|
| Collected/transferred | Yes — Sentry receives crash events, performance transactions, navigation events |
| Recipient | Sentry (crash reporting service provider) |
| Linked | Account-linked (user id only; PII scrubbed) |
| Retention | FOUNDER — Sentry project retention setting not verified from repo |
| Apple declared | Diagnostics → Crash Data, Performance Data, Other Diagnostic Data, App Functionality |
| Play declared | App info and performance → Crash logs, Diagnostics, App functionality |
| Recommended | **Declare as stated.** Accurate. |
| Evidence | `src/lib/monitoring.ts`; `sendDefaultPii: false`; scrubbers in `beforeSend` and `beforeSendTransaction` |
| Confidence | High |
| Unresolved | Retention: **FOUNDER**; IP address not explicitly set to `0.0.0.0` (see §11 · Coarse Location via Sentry IP) |

### 9 · Search History

| Field | Value |
|---|---|
| Collected/transferred | Query text leaves the device as a Supabase PostgREST request. It is excluded from the analytics allowlist (confirmed by `ALLOWED_PROPERTY_KEYS` and tests). Whether it is retained in Supabase's own PostgREST request logs is **not established from the repo** |
| Recipient | Supabase (service provider) — for the query itself. Not PostHog or Sentry. |
| Linked | Account-linked (the query goes via authenticated PostgREST, so the session is known) |
| Retention | **FOUNDER** — depends on Supabase project request-log retention. If logs retain PostgREST query strings, the query is retained. If not, the request is ephemeral |
| Apple declared | Search History → Search History, App Functionality |
| Play declared | App activity → In-app search history (present, no ephemeral qualifier asserted) |
| Recommended | **Declare on both platforms.** Whether Apple's row is correct depends on the same log check. Whether Play's row may carry "processed ephemerally" depends on the same check. Declare without the qualifier until the founder verifies log retention. Do not omit the row. |
| Evidence | `src/lib/analytics.ts` — `ALLOWED_PROPERTY_KEYS` excludes search text; `supabase/migrations/` — no search-history table; Supabase PostgREST logs are the residual surface |
| Confidence | Medium (declare is settled; qualifier is FOUNDER) |
| Unresolved | **FOUNDER: check Supabase project (nonprod) → Settings → API → Logs and whether PostgREST request logs retain query parameters. One answer settles both Apple and Play.** |

### 10 · Expo push tokens

| Field | Value |
|---|---|
| Collected/transferred | Yes — stored in `device_tokens` table when push permission is granted |
| Recipient | Supabase (service provider); Expo push service (service provider) |
| Linked | Device-linked and account-linked (row references both) |
| Retention | Persists while account exists; deleted on account deletion |
| Apple declared | **Identifiers → Device ID, Analytics and App Functionality** |
| Play declared | **Device or other IDs, App functionality, Analytics** |
| Recommended | **Declare Device ID (Apple) and Device or other IDs (Play) as currently declared.** The Expo push token is an installation-specific identifier — not an advertising ID, not IDFV — but it is device-scoped and both Apple and Google classify installation tokens under Device ID / Device or other IDs. The old repo inventory line "do not declare Device ID" was wrong for this reason. |
| Evidence | `supabase/migrations/` — `device_tokens` table; `src/lib/push.ts` or equivalent push token storage |
| Confidence | High |
| Unresolved | None — the public declarations are correct; the old inventory was wrong |

### 11 · Coarse Location — device timezone and locale region (first-party)

| Field | Value |
|---|---|
| Collected/transferred | Yes — `report_device_context` stores IANA timezone (e.g., `America/Denver`) and locale region (e.g., `US`) in `account_context` on each signed-in launch |
| Recipient | Supabase first-party (not sent to PostHog or Sentry; allowlist excludes it) |
| Linked | Account-linked |
| Retention | Updated on each launch; persists for lifetime of account; deleted on account deletion |
| Apple declared | Location → **Coarse Location, Analytics** |
| Play declared | No location declared (consistent with analysis: region `US` is not GPS) |
| Recommended | **Apple: this is an App Functionality purpose, not Analytics.** The data is used to decide whether to send a release notification in the account's local window (send window 10:00–20:00 in account's timezone). That is account management, not analytics measurement. The current public label places Coarse Location under Analytics; the correct Apple purpose is App Functionality. **Founder should correct this purpose in App Store Connect.** Play: do not declare Approximate or Precise Location (region `US` from locale is not location data in Play's definition; there is no GPS, IP geolocation, or fine coordinate). |
| Evidence | `supabase/migrations/20260930000100_a_release_you_can_see_coming.sql` — `account_context` table; `report_device_context` function; schema comment; `20260930000200` — send-window logic using `timezone_known`; analytics allowlist excludes timezone |
| Confidence | High (data confirmed); Medium (Apple purpose correction — confirm in App Store Connect) |
| Unresolved | **FOUNDER: open App Store Connect → App Privacy → Location → Coarse Location and change the declared purpose from Analytics to App Functionality.** This is a console edit, not a code change. |

### 12 · Coarse Location — PostHog GeoIP (hypothesis)

| Field | Value |
|---|---|
| Collected/transferred | Hypothesis: PostHog Cloud derives city-level location from the device IP in each event. `@posthog/core` 1.48.0 defaults `disableGeoip` to `false`; `initAnalytics` does not set `disableGeoip: true` |
| Recipient | PostHog (analytics service provider) |
| Linked | Account-linked (account id is a super property on every event) |
| Retention | PostHog project setting — FOUNDER |
| Apple declared | Location → Coarse Location, Analytics (this may be the actual reason for the Analytics purpose, rather than first-party timezone data) |
| Play declared | No location declared |
| Recommended | **Verify the PostHog project setting.** If GeoIP is enabled (the SDK default), PostHog holds city-level location linked to the account identifier. If so: Apple Coarse Location / Analytics is accurate for this reason; the policy should describe IP-derived location. If GeoIP is disabled: neither Apple nor Play needs a location row for PostHog specifically. |
| Evidence | `@posthog/core` 1.48.0 source — `disableGeoip` defaults false; `src/lib/analytics.ts` — `initAnalytics` does not pass `disableGeoip`; PostHog documentation |
| Confidence | Medium (hypothesis; SDK default is documented but project settings override it) |
| Unresolved | **FOUNDER: open PostHog project → Project Settings → Data pipelines and confirm whether GeoIP enrichment is enabled or disabled. If enabled: the Apple Analytics purpose for Coarse Location is justified; add policy wording for IP-derived location (see §proposed-policy-wording). If disabled: remove or correct the Coarse Location row on Apple.** |

### 13 · Coarse Location — Sentry IP (hypothesis)

| Field | Value |
|---|---|
| Collected/transferred | Hypothesis: Sentry infers approximate location from the device IP. `sendDefaultPii: false` prevents Sentry from explicitly collecting IP, but Sentry's documentation notes that IP-based location can still be inferred at the infrastructure level unless `ip_address: '0.0.0.0'` is set |
| Recipient | Sentry (crash reporting service provider) |
| Linked | Account-linked (user id is set on events) |
| Retention | Sentry project setting — FOUNDER |
| Apple declared | Potentially covered by existing Coarse Location / Analytics row |
| Play declared | No location declared |
| Recommended | **Verify the Sentry project setting.** If Sentry's IP collection is off (requires the server-side rule added 2026-11-01 per `security-remediation-2026-11-01.md`), this is not a disclosure surface. If IP is retained, Sentry may derive coarse location. |
| Evidence | `src/lib/monitoring.ts` — `sendDefaultPii: false`; no `ip_address: '0.0.0.0'` in the scrubbers; `security-remediation-2026-11-01.md` server-side rule; Sentry documentation |
| Confidence | Low (hypothesis; server-side rule may cover it) |
| Unresolved | **FOUNDER: confirm that the Sentry server-side IP scrubbing rule from 2026-11-01 is in place and active. If not, add `ip_address: '0.0.0.0'` to the Sentry event in `beforeSend`.** |

### 14 · PostHog device identifier (DeviceId UUID)

| Field | Value |
|---|---|
| Collected/transferred | Yes — PostHog SDK creates and persists its own `DeviceId` (an app-generated UUID, copied from the anonymous id on first install). Not IDFV, not advertising ID, not Android Advertising ID. |
| Recipient | PostHog (analytics service provider). Also stored in PostHog's local storage |
| Linked | Device-linked initially; account-linked after sign-in (PostHog links anonymous and identified ids) |
| Retention | PostHog project setting — FOUNDER |
| Apple declared | Identifiers → Device ID, Analytics and App Functionality |
| Play declared | Device or other IDs, App functionality, Analytics |
| Recommended | **Declare as stated.** The PostHog UUID is the most likely reason the Device ID row exists on both stores. It is device-scoped, persisted across launches, and linked to analytics. The old repo inventory line "do not declare Device ID" was wrong; the public declarations are correct. |
| Evidence | `posthog-react-native` 4.63.0 source — `DeviceId` copied from `anonymousId` on first init; `src/lib/analytics.ts` — no `disableSessionReplay`, no override of device identity; confirmed absent: IDFV, advertising ID, Android ID |
| Confidence | High |
| Unresolved | None |

### 15 · TMDB image requests

| Field | Value |
|---|---|
| Collected/transferred | Device makes direct HTTP requests to TMDB's CDN for posters and metadata images. No user identifier or Bingd header is sent. TMDB sees device IP and which image was requested. |
| Recipient | TMDB CDN (direct from device) |
| Linked | Not linked — IP only, no user token |
| Retention | TMDB's own infrastructure; not in scope for Bingd's declarations |
| Apple declared | Not declared separately. TMDB CDN images are analogous to any website image load. |
| Play declared | Not declared separately. |
| Recommended | **No new data type required.** Loading an image from a CDN does not constitute sharing user data under Apple's or Google's definitions. TMDB is used as a content source under a commercial relationship. The privacy policy already describes this (`docs/product/` and `web/build.mjs`). |
| Evidence | `src/lib/images.ts` — all poster URLs go to TMDB CDN; no user token or Bingd header added to image requests |
| Confidence | High |
| Unresolved | None |

### 16 · YouTube trailer still images (production: opt-in; preview/beta/dev: automatic)

| Field | Value |
|---|---|
| Collected/transferred | Device makes direct HTTP GET requests to `https://i.ytimg.com/vi/<video-id>/hqdefault.jpg`. No user identifier, cookie, or Bingd header is sent. Google sees device IP and which video's image was requested. In production the request only fires after the reader taps "Show previews". In preview, beta, and development it fires automatically when the Cinematic page renders. |
| Recipient | YouTube / Google (direct from device) |
| Linked | Not linked — IP only, no user token sent to Google |
| Retention | Google's own infrastructure. Bingd does not receive or store anything from the request. `expo-image` caches the still on-device. |
| Apple declared | Not declared separately |
| Play declared | Not declared separately. Play's "No data shared with third parties" covers Bingd not transferring user data to Google, not the image CDN request itself. |
| Recommended | **No new data type required for either store.** The image request is structurally identical to TMDB poster loads. Bingd is not sharing declared user data with Google. The privacy policy already names YouTube image servers explicitly. For enabling automatic stills in production: (a) Apple form requires no change — no new data type, no change to linked/tracking answers; (b) Play form requires founder confirmation that "No data shared with third parties" still accurately characterises the automatic load (see below). |
| Evidence | `src/features/title/TrailerRail.tsx`; `src/features/title/trailer-previews.ts`; live privacy policy (fetched 2026-11-08, "Last updated 7 November 2026") — explicit YouTube image-server paragraph |
| Confidence | High (policy coverage confirmed); Medium (Play console answer requires founder verification) |
| Unresolved | **Play Data safety — sharing question:** Play defines *sharing* as transfer to a third party for their own purposes; service-provider transfers are exempt. An automatic image load is not Bingd transferring user data to Google — no user data row in the Data safety form has Google as recipient. "No data shared" refers to the declared data types in the form. The analysis concludes "No data shared" remains accurate for automatic stills. **This conclusion has not been verified against the live Play console form. The founder must open Play Console → Policy and programs → App content → Data safety → Data collection and security and confirm the "No data shared" answer before the production gate is enabled.** |

---

## Summary of discrepancies between repo inventory and public store declarations

| Row | Repo inventory (old) | Public label (verified) | Analysis verdict |
|---|---|---|---|
| Apple — Coarse Location | "Do not declare Location" | Declared: Coarse Location, Analytics | **Label is correct; inventory was wrong.** Source: first-party timezone/region (`account_context`) and/or PostHog GeoIP (hypothesis). Purpose should be App Functionality for first-party data; Analytics for PostHog GeoIP if enabled. Founder must confirm which reason applies and correct the purpose in App Store Connect. |
| Apple — Device ID | "Do not declare Device ID" | Declared: Device ID, Analytics and App Functionality | **Label is correct; inventory was wrong.** Source: PostHog DeviceId UUID and/or Expo push token. Both qualify as device-scoped identifiers under Apple's definition. |
| Apple — Other User Content, Product Personalization | "Not personalisation; only App Functionality and Analytics" | Declared: Other User Content, Product Personalization | **Label is correct; inventory was wrong.** Rankings drive recommendations. Product Personalization is accurate. |
| Play — Device or other IDs | "Do not declare Device or other IDs" | Declared: Device or other IDs, App functionality, Analytics | **Label is correct; inventory was wrong.** Same reasons as Apple Device ID. |
| Play — Location | "Do not declare" | Not declared | Both agree. Correct. |

---

## Founder-only actions (minimum set)

These are the specific questions that cannot be answered from the repository. Each is a single check, not a full form re-audit.

| # | Platform | Where | Question | Priority |
|---|---|---|---|---|
| F-1 | Apple App Store Connect | App Privacy → Location → Coarse Location | **Correct the declared purpose from Analytics to App Functionality** (for first-party timezone/region data, `account_context`). If PostHog GeoIP is also enabled (F-3), the Analytics purpose may additionally be correct — both purposes can be declared. | High |
| F-2 | Google Play Console | Data safety → Data types → Device or other IDs | **Confirm the declared purposes** (App functionality, Analytics) are still accurate. No change expected, but confirm the form matches the current state. | Medium |
| F-3 | PostHog | Project Settings → Data pipelines | **Confirm whether GeoIP enrichment is enabled or disabled.** If enabled: Apple Coarse Location / Analytics is justified for PostHog; add proposed policy wording (§proposed-policy-wording, item A). If disabled: the Coarse Location / Analytics purpose may need removal (leave App Functionality for `account_context`). | High |
| F-4 | Sentry | Dashboard → Project Settings | **Confirm the 2026-11-01 IP-scrubbing server-side rule is active.** If not active, apply `ip_address: '0.0.0.0'` in `monitoring.ts`. | Medium |
| F-5 | Supabase | Project → Settings → Logs | **Check PostgREST request-log retention.** If logs retain query parameters (search text), declare Search History without the "processed ephemerally" qualifier (already declared on both stores). If logs do not retain them, the ephemeral qualifier may be added to the Play row. | Medium |
| F-6 | Google Play Console | Data safety → Data collection and security | **Confirm "No data shared with third parties" remains accurate once trailer stills load automatically** (i.e., once the production gate is enabled). See §16 analysis. Required before the production OTA that enables `trailerPreviewsByDefault`. | High (blocks trailer OTA) |
| F-7 | PostHog + Sentry | Both project dashboards | **Record the actual retention periods** (currently policy says "under their own retention settings"). Add specific numbers to the privacy page under "How long it is kept". This is a legal-copy change; it deploys with `main` and does not require an app update. | Medium |

---

## Proposed policy wording

These are additions to the live policy at `https://bingd.app/privacy/`. None of these should be published until the founder approves their accuracy.

**The live policy does not need to change to enable automatic trailer stills in production.** The YouTube paragraph already covers both opt-in and automatic behavior.

### A · IP-derived location (for PostHog GeoIP if F-3 finds it enabled)

> **Under "Who else sees it" → PostHog paragraph:** "PostHog may also record your approximate location based on your IP address at the time each event is sent. That is city-level, not GPS, and is held under PostHog's own retention settings."

### B · Analytics device identifier

> **Under "Who else sees it" → PostHog paragraph, after the existing sentence:** "PostHog also records a device identifier — an app-generated string, not your Apple or Google account ID — which persists across app launches and links events from the same installation."

### C · Timezone and locale region (first-party, `account_context`)

> **Under "What Bingd stores about you" → after the date-of-birth paragraph:** "Your device's timezone (for example, America/Denver) and locale region (for example, US or GB), reported on each signed-in launch. This is used to send release announcements in your local waking hours and is never returned to any part of the app, including to you."

### D · Retention period placeholders

> **Under "How long it is kept" → PostHog and Sentry sentence, replacing "under their own retention settings":** "PostHog retains analytics data for [N] days. Sentry retains crash reports for [N] days. Deleting your account removes your account identifier from future events but does not remove events already recorded."

---

## Automatic trailer stills: production readiness gate

| Condition | Status |
|---|---|
| Live privacy policy covers YouTube image-server requests | **Met** — policy fetched 2026-11-08 already includes explicit YouTube paragraph |
| Apple form: no new data type required | **Met** — no declared type needs to change for image CDN loads; Analytics/App Functionality purposes for existing types are unaffected |
| Apple form: Coarse Location purpose correction (F-1) | **Founder action required** (does not block the trailer OTA; the row already exists) |
| Play form: "No data shared" verified for automatic loads | **FOUNDER REQUIRED (F-6)** — blocks enabling the production gate |
| PostHog GeoIP confirmed (F-3) | **FOUNDER action required** (affects Coarse Location / Analytics justification; does not itself block trailer OTA) |
| Code change prepared | **Ready in this PR** — `trailerPreviewsByDefault` returns `true` unconditionally |
| Tests updated | **Ready in this PR** — all lanes including production return `true`; Original layout verified not to mount `TrailerRail` |

**Gate summary:** Production can safely be enabled **after F-6 is confirmed**. All other founder actions are independent of the trailer OTA. Do not merge or publish the OTA without F-6.
