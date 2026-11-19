# Privacy disclosure decision matrix

**Last updated:** 9 November 2026 (after the production OTA of 2026-11-09, merge `19362af`)  
**Originally prepared in:** PR #239  
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
| Play declared | App activity → Other user-generated content, **App functionality only** (founder Data safety CSV export, 2026-11-08, not committed). Personalisation purpose is **not currently declared** on Play. |
| Recommended | **Apple: already correctly declared** under both App Functionality and Product Personalization — the public label is accurate and should stay. **Play: Personalisation is a proposed addition, not the current form.** Whether to add it is a store-declaration change requiring founder approval; the current form (App functionality only) is not wrong, it is incomplete if rankings are driving the recommendation engine. |
| Evidence | `match_scores`, `recommendation_*` tables; `src/features/discovery/` recommendation queries; `for-you` screen; founder Data safety CSV export, 2026-11-08 (not committed) |
| Confidence | High (Apple — public label confirmed); Medium (Play — current form per CSV export, but Personalisation purpose may be warranted) |
| Unresolved | **Play Personalisation purpose:** the current form declares App functionality only for Other user-generated content. Adding Personalisation is a store-declaration change that requires a founder console action, is independent of the trailer OTA gate, and is not a correction of an error — the current form is not inaccurate, it is incomplete. |

### 6 · User ID (account identifier)

| Field | Value |
|---|---|
| Collected/transferred | Yes — used internally and sent to PostHog and Sentry |
| Recipient | Supabase (service provider), PostHog (analytics service provider), Sentry (crash service provider) |
| Linked | Account-linked |
| Retention | PostHog and Sentry: FOUNDER (check project retention settings); first-party: lifetime of account |
| Apple declared | Identifiers → User ID, Analytics and App Functionality |
| Play declared | **Not currently declared as User IDs** (founder Data safety CSV export, 2026-11-08, not committed). Account identifiers sent to PostHog and Sentry appear to be covered by the declared **Device or other IDs** row (App functionality, Analytics) — see §14 and §10. |
| Recommended | **Open founder decision (F-8).** The account UUID sent to PostHog (as distinct user identifier, separate from the device UUID in §14) and Sentry may be more accurately described as User IDs than as Device or other IDs. Whether to add Personal info → User IDs, Required, App functionality / Analytics to the Play form is a store-declaration change that requires founder approval and is independent of the trailer OTA gate. |
| Evidence | `src/lib/analytics.ts` — `initAnalytics` sends account id; `src/lib/monitoring.ts` — user object reduced to id; founder Data safety CSV export, 2026-11-08 (not committed) |
| Confidence | Medium (Play declared row unverified until CSV export reviewed; F-8 not yet decided) |
| Unresolved | **F-8 (see below):** whether to add Personal info → User IDs row to Play form. Also: PostHog and Sentry retention — **FOUNDER** (§6 item 4 in `store-privacy-inventory.md`) |

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
| Collected/transferred | The device loads posters, backdrops, stills, cast photos and logos directly from `image.tmdb.org` through `expo-image`, automatically, in every lane including production. The request carries the device IP, the User-Agent (on Android, the OS version, device model and build) and the image path, which identifies the title. No cookie is sent or set, and no account or device identifier goes with it. Same mechanism as §16; see `pr239-thumbnail-privacy-review.md` §1. |
| Recipient | TMDB / BunnyCDN (direct from device). A third party, not a service provider: it serves images under TMDB's terms, not on bingd's instructions. |
| Linked | Not linked to a bingd account or stable device id. Pseudonymous (IP + User-Agent + timing). |
| Retention | TMDB's/BunnyCDN's own. bingd receives and keeps nothing from the request. |
| Apple declared | Not declared separately. |
| Play declared | Not declared (no type is marked Shared, per the founder's CSV export as described to the agent). |
| Recommended | **Apple and privacy policy: existing disclosure supported** (no TMDB code in the app; the policy says posters load directly from TMDB's servers). **Play: unresolved on one question**: whether passing the IP to a third-party image host is sharing Approximate location. Play's FAQ ties IP disclosure to "particular usage and practices", and bingd does not use the IP. No exemption applies to these automatic loads. TMDB is used under a testing-stage arrangement (written confirmation permitting zero-revenue use; commercial agreement required before monetisation — see §5 of `store-privacy-inventory.md`). |
| Evidence | `src/lib/images.ts:15-80`; `src/ui/components/Poster.tsx:1`; `src/features/title/ImmersiveHero.tsx:1`; `image.tmdb.org` response has no `Set-Cookie` (observed 2026-11-09) |
| Confidence | High (request contents); Low (Play classification) |
| Unresolved | **F-6** (shared with §16): the Approximate-location question, an open privacy follow-up. It applies to production for TMDB images and, since the OTA of 2026-11-09, for trailer stills too. |

### 16 · YouTube trailer still images (automatic in all lanes, production included, since the OTA of 2026-11-09)

| Field | Value |
|---|---|
| Collected/transferred | Device makes direct HTTP GET requests to `https://i.ytimg.com/vi/<video-id>/hqdefault.jpg` through `expo-image`. **Verified** (library source plus a wire replay of the Android OkHttp configuration): on Android the request carries `User-Agent` (Android `http.agent`: OS version, device model, build), `Host`, `Connection` and `Accept-Encoding`. There is no `Cookie` (expo-image's OkHttp cookie container is never given a jar) and no `Referer`, and nothing identifies the app or the account. On iOS (source only) the User-Agent names the app and version, and `Accept` is set. The host sets no cookie (observed). Google also sees the IP address. The video id maps to one title. See `pr239-thumbnail-privacy-review.md` §1. **Deployed (production OTA 2026-11-09, merge `19362af`):** `trailerPreviewsByDefault` returns `true` for all lanes, so the request fires when the Cinematic page renders, in production as in preview, beta and development. The production OTA of 2026-11-07 had required a "Show previews" tap. |
| Recipient | YouTube / Google (direct from device) |
| Linked | Not linked to a bingd account or stable device id. Pseudonymous: IP + User-Agent + timing. Google can infer approximate location from the IP, and the video id points to the title viewed. |
| Retention | Google's own. Google's privacy policy describes logging IP addresses with requests to its services; nothing public covers `i.ytimg.com` specifically. bingd receives and keeps nothing. `expo-image` caches the still on disk (default `cachePolicy: 'disk'`), so a still is fetched about once per device. |
| Apple declared | Not declared separately |
| Play declared | Not declared separately. |
| Recommended | **Apple: existing disclosure supported.** Apple's "collect" covers access by "you and/or your third-party partners", meaning vendors "whose code you've added to your app". No Google code is in the app. **Privacy policy: existing disclosure supported.** The YouTube paragraph does not depend on a tap. **Play: unresolved on one question**, Approximate location via IP (see Unresolved). **App interactions as Shared is not supported**: the request carries no record of how the user uses bingd, and on Android nothing identifies the app. |
| Evidence | `src/features/title/TrailerRail.tsx:66-111`; expo-image 57.0.2 Android `ExpoImageOkHttpClientGlideModule.kt:80-84`, `SourceMap.kt:161-163`; React Native `OkHttpClientProvider.kt:48-58`, `ReactCookieJarContainer.kt:35-36`, `NetworkingModule.kt:135-174`; Glide 5.0.5 `LazyHeaders`; SDWebImage 5.21 `SDWebImageDownloader.m:106-126`; live privacy policy (fetched 2026-11-09). Full citations in `pr239-thumbnail-privacy-review.md`. |
| Confidence | High (request contents, Apple, policy); Low (Play Approximate-location classification) |
| Unresolved | **F-6 — Play Approximate location (shared with §15).** Google is a third party. No exemption covers automatic loads: Google is not a service provider (no contract, no instructions); opening a page is not "a specific user-initiated action where the user reasonably expects the data to be shared" (the former production opt-in button, OTA of 2026-11-07, plausibly was); there is no prominent in-app disclosure and consent; the IP is not anonymised; and ephemeral processing is not a sharing exemption and cannot be shown for Google. Device or other IDs and User IDs are not triggered (verified: no cookie or identifier). What remains open is that Play says IP-inferred location "must be disclosed" as Approximate location, and its FAQ ties IP disclosure to "particular usage and practices", with the developer's own use as the example. Whether a third-party host's possible inference counts is not answered by the published guidance. The same question already applies to TMDB in production (§15). **Beta track (unverified):** the beta lane builds package `app.bingd` and submits to the `alpha` closed-testing track (as a draft). Under the old gate it loaded stills automatically. Closed testing is in scope for Data safety. If a beta release has been rolled out there, automatic loads are already distributed on Play. |

---

## Summary of discrepancies between repo inventory and public store declarations

| Row | Repo inventory (old) | Public label (verified) | Analysis verdict |
|---|---|---|---|
| Apple — Coarse Location | "Do not declare Location" | Declared: Coarse Location, Analytics | **Label is correct; inventory was wrong.** Source: first-party timezone/region (`account_context`) and/or PostHog GeoIP (hypothesis). Purpose should be App Functionality for first-party data; Analytics for PostHog GeoIP if enabled. Founder must confirm which reason applies and correct the purpose in App Store Connect. |
| Apple — Device ID | "Do not declare Device ID" | Declared: Device ID, Analytics and App Functionality | **Label is correct; inventory was wrong.** Source: PostHog DeviceId UUID and/or Expo push token. Both qualify as device-scoped identifiers under Apple's definition. |
| Apple — Other User Content, Product Personalization | "Not personalisation; only App Functionality and Analytics" | Declared: Other User Content, Product Personalization | **Label is correct; inventory was wrong.** Rankings drive recommendations. Product Personalization is accurate. |
| Play — Device or other IDs | "Do not declare Device or other IDs" | Declared: Device or other IDs, App functionality, Analytics | **Label is correct; inventory was wrong.** Same reasons as Apple Device ID. |
| Play — Location | "Do not declare" | Not declared | Both agree. Correct. |
| Play — User IDs | Earlier inventory described as "Personal info → User IDs, Required, App functionality / Analytics" (declared) | **Not declared** per founder Data safety CSV export, 2026-11-08 | **Inventory was incorrect; CSV export is ground truth.** Whether to add a User IDs row is F-8 (not decided). |
| Play — Other user-generated content, Personalisation | Inventory proposed "App functionality, Personalisation" (2026-11-09 update) | **App functionality only** per founder Data safety CSV export, 2026-11-08 | **Proposed addition not yet in form.** Current form is not wrong; adding Personalisation purpose is a founder console action (independent of trailer OTA). |

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
| F-6 | Google Play Console / Play developer support | Data safety → Data types → Location → Approximate location | **Open privacy follow-up, not a compliance determination.** The founder chose on 2026-11-09 to ship automatic stills under the existing declaration (production OTA of 2026-11-09). **Still to resolve:** does passing the device IP to third-party image hosts (`i.ytimg.com`, `image.tmdb.org`) mean declaring Approximate location? Ask Google Play developer support in writing (exact question in `pr239-thumbnail-privacy-review.md` §5), and check Closed testing release history for a rolled-out beta. **If yes:** select Approximate location, mark it Collected and Shared, ephemeral No, Required, purpose App functionality, and publish it once decided; production already loads stills automatically, and TMDB images raise the same question. **If no:** no form change. Do not add App interactions as Shared: the evidence does not support it. | High (open follow-up) |
| F-7 | PostHog + Sentry | Both project dashboards | **Record the actual retention periods** (currently policy says "under their own retention settings"). Add specific numbers to the privacy page under "How long it is kept". This is a legal-copy change; it deploys with `main` and does not require an app update. | Medium |
| F-8 | Google Play Console | Data safety → Personal info → User IDs | **Decide whether to add a User IDs row.** The founder's Data safety CSV export (2026-11-08, not committed) shows no User IDs row; account identifiers sent to PostHog (analytics user id) and Sentry (user object id) are not currently declared there. If the account UUID is considered a user identifier distinct from device identifiers (§6, §14), add Personal info → User IDs, Required, App functionality / Analytics. If it is treated as covered by Device or other IDs (already declared), no change is needed. Record the decision. Independent of the trailer OTA gate. | Medium |

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

### E · Image requests also carry device details (optional; not required for the trailer OTA)

> **Under "Who else sees it" → after the TMDB and YouTube paragraphs:** "Like any image request, these also carry your phone's operating system version and model, which your device adds on its own. No cookie or identifier goes with them."

---

## Automatic trailer stills: production readiness gate (shipped 2026-11-09)

| Condition | Status |
|---|---|
| Live privacy policy covers YouTube image-server requests | **Met** — policy fetched 2026-11-08 already includes explicit YouTube paragraph |
| Apple form: no new data type required | **Met** — no declared type needs to change for image CDN loads; Analytics/App Functionality purposes for existing types are unaffected |
| Apple form: Coarse Location purpose correction (F-1) | **Founder action required** (does not block the trailer OTA; the row already exists) |
| Play form: Approximate-location question resolved (F-6) | **Open privacy follow-up.** The founder chose on 2026-11-09 to ship under the existing declaration; this is not a compliance determination. If the answer is "declare", publish the form change once decided. If it is "not required", no form change. |
| PostHog GeoIP confirmed (F-3) | **FOUNDER action required** (affects Coarse Location / Analytics justification; does not itself block trailer OTA) |
| Code change | **Shipped** — `trailerPreviewsByDefault` returns `true` unconditionally (merge `19362af`, production OTA 2026-11-09) |
| Tests updated | **Merged** — all lanes including production return `true`; Original layout verified not to mount `TrailerRail` |

**Gate summary (updated after release):** Apple and the privacy policy already cover automatic stills. Automatic stills shipped to production in the OTA of 2026-11-09 (merge `19362af`), by founder decision under the existing Play declaration. **F-6**, the Play Approximate-location question for third-party image hosts (YouTube and TMDB), remains an open privacy follow-up; shipping is not a determination that no declaration is needed. All other founder actions are independent. Full evidence: `pr239-thumbnail-privacy-review.md`; release record: `production-state.md`.
