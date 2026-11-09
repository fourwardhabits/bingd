# PR #239 — automatic trailer thumbnails: privacy review

**Date:** 2026-11-09. **Branch:** `cursor/privacy-matrix-trailer-production-6b14`.
**Scope:** the single change PR #239 prepares — `trailerPreviewsByDefault()` returning `true`
in production, so the Cinematic title page loads YouTube still images without the reader
tapping _Show trailer previews_. Nothing in this document has been confirmed or approved by
the founder, and no store declaration, policy page or OTA has been changed.

> **Released 2026-11-09.** The change shipped in the production OTA of 2026-11-09 (merge
> `19362af`) by founder decision, under the existing Play Data safety declaration. The
> question below (F-6) stays open; see §4 and `production-state.md`.

**Determination in one line.** Apple's label and the published privacy policy already cover
the change. For Google Play, no exemption covers automatic loads and no identifier is sent,
but one classification question is **unresolved**: whether passing the device's IP address
to a third-party image host counts as sharing **Approximate location**. That question
already applies to TMDB images in production today. Declaring _App interactions_ as Shared
is **not supported** by what the request carries.

---

## 1 · Verified request behaviour

### What the app requests

| Fact                                                                                                                       | Evidence                                                                                                                                                          | Status                    |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| URL is `https://i.ytimg.com/vi/<video id>/hqdefault.jpg`, where the id is the 11-character YouTube key                     | `src/features/title/TrailerRail.tsx:66-70`; key shape enforced by `src/lib/images.ts:90-99`                                                                       | Verified (code)           |
| No custom headers are passed (`source={{ uri: still }}` only)                                                              | `src/features/title/TrailerRail.tsx:88-111`                                                                                                                       | Verified (code)           |
| Resolved to `expo-image` 57.0.2 in this branch                                                                             | `package.json:60` (`~57.0.2` range); `package-lock.json:9532-9534` (`node_modules/expo-image` version `57.0.2`)                                                   | Verified                  |
| Only Cinematic mounts `TrailerRail`; Original never requests a still                                                       | `TitleScreen.test.tsx` ("does not load YouTube thumbnails in Original layout…")                                                                                   | Verified (test)           |
| Default cache policy is `disk`, so each still is requested about once per device until evicted, not on every page visit    | `node_modules/expo-image/src/Image.types.ts:252-254` (`@default 'disk'`)                                                                                          | Verified (library source) |
| Nothing else in the app contacts a YouTube or `ytimg` host; `www.youtube.com/watch` is only opened with `Linking` on a tap | `rg -i "ytimg\|youtube" src`: the only request is in `TrailerRail.tsx`; the other matches are `videoUri` in `images.ts`, comments, and profile social-link fields | Verified (code)           |
| No YouTube API key or agreement is used; video keys come from TMDB                                                         | `rg -i "googleapis.com/youtube\|YOUTUBE_API"` returns nothing                                                                                                     | Verified (code)           |

### Android (the platform the Play form governs)

- **HTTP client.** `ExpoImageOkHttpClientGlideModule` registers Glide's OkHttp loader with
  `OkHttpClientProvider.createClient()`
  (`node_modules/expo-image/android/src/main/java/expo/modules/image/okhttp/ExpoImageOkHttpClientGlideModule.kt:80-84`).
  React Native's builder sets timeouts and a `ReactCookieJarContainer`, nothing else
  (`node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/network/OkHttpClientProvider.kt:48-58`).
- **Cookies: none.** The container returns an empty list until something calls
  `setCookieJar` (`ReactCookieJarContainer.kt:35-36`). Only `NetworkingModule.initialize()`
  calls it (`NetworkingModule.kt:173-174`), and only on its own client, which it builds
  separately with `createClient(context)` (`NetworkingModule.kt:132-164`). expo-image's
  client therefore never sends or stores a cookie. No package in `node_modules` and nothing in
  the app calls `setOkHttpClientFactory`.
- **Headers.** expo-image passes `LazyHeaders.DEFAULT` when the source has no headers
  (`node_modules/expo-image/android/src/main/java/expo/modules/image/records/SourceMap.kt:161-163`).
  In Glide 5.0.5 that default holds one header, `User-Agent` = `System.getProperty("http.agent")`
  ([LazyHeaders.java](https://github.com/bumptech/glide/blob/v5.0.5/library/src/main/java/com/bumptech/glide/load/model/LazyHeaders.java),
  [Headers.java:31](https://github.com/bumptech/glide/blob/v5.0.5/library/src/main/java/com/bumptech/glide/load/model/Headers.java)).
  Glide's `OkHttpStreamFetcher.loadData` copies those headers and adds nothing
  ([source](https://github.com/bumptech/glide/blob/v5.0.5/integration/okhttp3/src/main/java/com/bumptech/glide/integration/okhttp3/OkHttpStreamFetcher.java)).
- **Observed on the wire (replay, not a device).** OkHttp 4.9.2 (the version React Native
  0.86 pins, `node_modules/react-native/gradle/libs.versions.toml:37`) was configured exactly
  as above and sent to a local echo server. It sent:

  ```
  GET /vi/dQw4w9WgXcQ/hqdefault.jpg HTTP/1.1
  User-Agent: Dalvik/2.1.0 (Linux; U; Android 14; Pixel 7 Build/UQ1A.240205.004)
  Host: 127.0.0.1:8765
  Connection: Keep-Alive
  Accept-Encoding: gzip
  ```

  No `Cookie`, no `Referer`, no `Accept`, no app or package name. The `User-Agent` value was
  a placeholder for the replay. On a phone it is the real `http.agent` string, which carries
  the Android version, device model and build id.

- **Over HTTPS** Google also sees the source IP address and the TLS server name `i.ytimg.com`.

### iOS (relevant to the Apple label)

- SDWebImage `~> 5.21.0` (`node_modules/expo-image/ios/ExpoImage.podspec:31`). Its downloader
  sets `User-Agent` to `<CFBundleExecutable>/<CFBundleShortVersionString> (<UIDevice model>; iOS <version>; Scale/<n>)`
  and `Accept: image/*,*/*;q=0.8`
  ([SDWebImageDownloader.m:106-126](https://github.com/SDWebImage/SDWebImage/blob/5.21.0/SDWebImage/Core/SDWebImageDownloader.m)).
  On iOS, then, the request does name the app and its version. `UIDevice.model` is the
  generic `iPhone`/`iPad`, not the hardware model.
- expo-image enables `.handleCookies` (`node_modules/expo-image/ios/ImageView.swift:30`), so
  the request carries any cookies the app's shared cookie store holds for `i.ytimg.com`. The
  host sets none (observed below), and nothing else in the app talks to a YouTube host, so
  none is expected. This is inferred from source and response headers, not seen on a device.
- `NSURLSession` normally adds its own `Accept-Language` and `Accept-Encoding`. That is
  platform behaviour and was **not** verified here.

### Response from the hosts (observed 2026-11-09 from this VM)

| Host                             | Status | `Set-Cookie` | Server                                                      |
| -------------------------------- | ------ | ------------ | ----------------------------------------------------------- |
| `i.ytimg.com/vi/…/hqdefault.jpg` | 200    | **none**     | `sffe` (Google); `report-to` points at `csp.withgoogle.com` |
| `image.tmdb.org/t/p/w342/…`      | 200    | **none**     | `BunnyCDN`                                                  |

### Is it linked, and what can be inferred?

- **Linked to a bingd account or a stable device id: no.** Nothing bingd holds is sent.
- **Location: inferable by the recipient.** The IP address can be used to infer an
  approximate location. Google's privacy policy says it collects "information about the
  interaction of your apps, browsers, and devices with our services, including IP address
  … and the date, time, and referrer URL of your request," and lists "IP address" among the
  location information it may use ([policies.google.com/privacy](https://policies.google.com/privacy)).
  That is Google's general policy. Nothing public says what `i.ytimg.com` in particular logs
  or keeps. **Assumed, not verified.**
- **Viewing interest: inferable.** A video id maps to one title, so a request shows that a
  client at this IP displayed that title's trailers. On Android nothing in the request ties it
  to bingd. On iOS the User-Agent names the app. IP, User-Agent and timing together are
  pseudonymous, not anonymous.

### Same reasoning for TMDB

TMDB posters, backdrops, cast photos and logos load through the same `expo-image` path
(`src/lib/images.ts:15-80`; `src/ui/components/Poster.tsx:1`; `src/features/title/ImmersiveHero.tsx:1`).
The headers and cookie behaviour are the same, `image.tmdb.org` sets no cookie, and the URL
path identifies the title. These loads have been **automatic in production for a long time**,
including the title page's hero image. TMDB/BunnyCDN is a third party in the same sense
Google is. TMDB is currently declared as nothing on Play (no type marked Shared, per the
founder's CSV export as described in the task) and is described in the privacy policy.

---

## 2 · Official policy citations

**Google Play — Data safety** ([support.google.com/googleplay/android-developer/answer/10787469](https://support.google.com/googleplay/android-developer/answer/10787469)):

- Collection: _"'Collect' means transmitting data from your app off a user's device … This
  includes user data transmitted off device from your app by libraries and/or SDKs used in
  your app, irrespective of whether data is transmitted to you or a third-party server."_
- Pseudonymous data: _"User data collected pseudonymously must be disclosed. For example,
  data that can reasonably be re-associated with a user must be disclosed."_
- Ephemeral processing: _"User data transmitted off device that is processed ephemerally
  needs to be included in your form response, but if it meets the standard below, it will not
  be disclosed … Processing data 'ephemerally' means accessing and using it while the data is
  only stored in memory and retained for no longer than necessary to service the specific
  request in real-time."_
- Sharing: _"'Sharing' refers to transferring user data collected from your app to a third
  party. This includes user data transferred: … From your app libraries and SDKs.
  Transferring data collected from your app off a user's device directly to a third party via
  libraries and/or SDKs included in your app."_
- Exemptions: _"Service providers. Transferring user data to a 'service provider' that
  processes it on behalf of the developer … 'Service provider' means an entity that processes
  user data on behalf of the developer and based on the developer's instructions."_ /
  _"Legal purposes …"_ / _"User-initiated action or prominent disclosure and user consent.
  Transferring user data to a third party based on a specific user-initiated action, where the
  user reasonably expects the data to be shared, or based on a prominent in-app disclosure and
  consent that meets the requirements described in our User Data policy."_ / _"Anonymous
  data. Transferring user data that has been fully anonymized so that it can no longer be
  associated with an individual user."_
- Third party: _"'Third party' means any organization other than the first party or its
  service providers."_
- Approximate location: _"User or device physical location to an area greater than or equal
  to 3 square kilometers … Note: Approximate location that is inferred, such as via IP address
  or Access Point Name, must be disclosed here."_
- IP addresses (FAQ): _"As with other data types, you should disclose your collection, use and
  sharing of IP addresses based on their particular usage and practices. For example, where
  developers use IP addresses as a means to determine location, then that data type should be
  declared."_
- Transient client-side requests (FAQ): _"If this use is ephemeral, you do not need to include
  it in your form response. However, you must declare any use of that user data beyond the
  ephemeral processing …"_
- App interactions: _"Information about how a user interacts with the app. For example, the
  number of times they visit a page, screenshots taken, or sections they tap on."_
- Device or other IDs: _"Identifiers that relate to an individual device, browser or app. For
  example, an IMEI number, MAC address, Widevine Device ID, Firebase installation ID, or
  advertising identifier."_
- Scope: _"All developers that have an app published on Google Play must complete the Data
  safety form, including apps on closed, open, or production testing tracks … Apps that are
  active on internal testing tracks are exempt."_ / _"your Data safety section describes the
  sum of your app's data collection and sharing across all its versions currently distributed
  on Google Play."_

**Apple — App Privacy Details** ([developer.apple.com/app-store/app-privacy-details](https://developer.apple.com/app-store/app-privacy-details/)):

- _"'Collect' refers to transmitting data off the device in a way that allows you and/or your
  third-party partners to access it for a period longer than what is necessary to service the
  transmitted request in real time. 'Third-party partners' refers to analytics tools,
  advertising networks, third-party SDKs, or other external vendors whose code you've added to
  your app."_
- _"You collect and store IP address from your users. Declare the relevant data types based on
  how you use IP address, such as precise location, coarse location, device ID, or diagnostics."_

**bingd privacy policy** ([bingd.app/privacy](https://bingd.app/privacy/), "Last updated 7 November 2026", fetched 2026-11-09):

- _"YouTube (Google) supplies trailer still images. When a title page shows its trailers, your
  device loads each trailer's still image directly from YouTube's image servers, which means
  Google sees that request — your IP address and which video's image was asked for — the way
  any website you load an image from would. Bingd sends YouTube nothing about your account."_
- _"… posters and images load directly from TMDB's servers, which means TMDB sees the request
  the way any website you load an image from would."_

---

## 3 · Classification analysis (Google Play)

**Is Google a third party?** Yes. bingd has no contract with Google for `i.ytimg.com` and
gives it no instructions. Google serves the image under its own terms, so it is not a service
provider as Play defines one.

**Do any exemptions apply to automatic loads?**

| Exemption                        | Applies?                   | Why                                                                                                                                                                                                                                                                                       |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service provider                 | No                         | Google does not process on bingd's behalf or on its instructions.                                                                                                                                                                                                                         |
| Legal purposes                   | No                         | Not relevant.                                                                                                                                                                                                                                                                             |
| User-initiated action            | **No** for automatic loads | Opening a title page is not "a specific user-initiated action where the user reasonably expects the data to be shared." The production opt-in deployed today (a button labelled "Show trailer previews. Loads images from YouTube.") plausibly qualified. Removing it removes that basis. |
| Prominent disclosure and consent | No                         | There is no in-app disclosure-and-consent flow. A privacy-policy paragraph does not meet the User Data policy's prominent-disclosure requirements.                                                                                                                                        |
| Anonymous data                   | No                         | The IP address is not anonymised, and Play requires pseudonymous data to be disclosed.                                                                                                                                                                                                    |
| Ephemeral processing             | Cannot be asserted         | This is not a sharing exemption. It controls whether _collected_ data is displayed. It also depends on the recipient keeping the data only in memory, and Google's policy describes server logs that include IP addresses.                                                                |

**Does any Play data type apply?**

| Data type                                 | Finding                      | Basis                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device or other IDs                       | **Not triggered** (verified) | No cookie, no identifier. The User-Agent describes OS and model; it is not an identifier "that relate[s] to an individual device" like Play's examples.                                                                                                                                                                                                                                                                         |
| User IDs / Personal info                  | **Not triggered** (verified) | Nothing about the account is sent.                                                                                                                                                                                                                                                                                                                                                                                              |
| App interactions                          | **Not supported**            | The request is a content fetch. It carries no record of how the user uses bingd, and on Android nothing identifies the app. A recipient could at most infer that some client displayed a given video. Marking App interactions as Shared would declare a transfer the request does not make.                                                                                                                                    |
| In-app search history, user content, etc. | Not triggered                | Not in the request.                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Approximate location**                  | **Unresolved**               | Play says IP-inferred location "must be disclosed here," and its FAQ ties IP disclosure to "particular usage and practices," with the developer's own use as the example. bingd does not use the IP. The guidance does not say whether handing an IP to a third-party content host, which may infer location on its own account, counts as sharing Approximate location. Nothing in the repo or in public sources settles this. |

**Consistency with TMDB.** The automatic `image.tmdb.org` loads in production raise the same
question with the same facts. The OTA would not create a new kind of transfer. It would add
Google, a second recipient, whose general privacy policy says it uses IP addresses for location.

**Beta track.** The beta lane builds the production package `app.bingd`
(`eas.json` build `beta`: `APP_VARIANT=production`; `app.config.ts:59,271`) and submits to
Play's `alpha` track as a draft (`eas.json` submit `beta`: `"track": "alpha"`). Under the
older gate (`lane !== 'production'`), beta builds already loaded stills automatically. Closed
testing is in scope for the Data safety form. If a beta release has been rolled out on that
track, automatic loads are already distributed on Google Play under the current form. Whether
one has been rolled out is **not verified**: the submission is a draft, and Play Console
release history is not visible from the repo.

---

## 4 · Recommendation

| Surface                                  | Determination                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Apple App Privacy label**              | **Existing disclosure supported.** Apple's "collect" covers access by "you and/or your third-party partners," meaning vendors "whose code you've added to your app." No Google or YouTube code is in the app, and bingd keeps nothing from the request. No label answer changes.                                                                                                                 |
| **Privacy policy** (`bingd.app/privacy`) | **Existing disclosure supported.** The YouTube paragraph does not depend on a tap ("When a title page shows its trailers, your device loads…") and names the IP address and video. One optional addition, not required and not published: say that the request also carries the phone's operating system and model, which the device puts in every image request (applies to TMDB too).          |
| **Google Play Data safety**              | **Unresolved, on one question:** Approximate location via IP, for both `i.ytimg.com` and `image.tmdb.org`. Everything else is settled: no exemption covers automatic loads; Device or other IDs and User IDs are not triggered; App interactions as Shared is not supported. Writing down a rationale does not substitute for an accurate answer, and the Data safety form has no field for one. |

**Gate (as written before release).** Keep the production OTA blocked until the
Approximate-location question is resolved (F-6). The code gate is unchanged.

**Status after release (2026-11-09).** The founder chose to ship under the existing Play
declaration, and the production OTA of 2026-11-09 (merge `19362af`) published it. F-6 is an
open privacy follow-up, not a compliance determination. See `production-state.md`.

---

## 5 · Founder-only actions

Neither has been done, and neither is done by this PR.

1. **Get an authoritative answer to the one open question.** Ask Google Play developer
   support (Play Console → Help → Contact support → policy question) this exact question:
   _"Our app's image library loads public images directly from third-party hosts
   (`i.ytimg.com`, `image.tmdb.org`). The request carries only the device's IP address,
   a User-Agent and the image path. No cookies, identifiers or account data are sent, and we do
   not receive or use the IP. Must we declare Location → Approximate location as collected
   and/or shared?"_ A written answer settles it. Checking whether a beta release with
   automatic stills has been rolled out on the alpha track (Play Console → Test and release →
   Closed testing → release history) shows whether the question is already live on Play.
2. **If the answer is yes (or the founder decides to declare conservatively),** exactly one
   Play Console answer changes, and it changes because of TMDB whatever happens to the OTA:
   **App content → Data safety → Data types → Location → Approximate location**: select it;
   _Is this data collected, shared, or both?_ → **Collected** and **Shared** (Play counts
   library transmissions to third-party servers as collection); _processed ephemerally?_ →
   **No** (Google's retention cannot be shown to be ephemeral); _required or optional?_ →
   **Required** for automatic loads; purpose for collection and for sharing → **App
   functionality**. Publish the form once decided; the production OTA already shipped on
   2026-11-09. Apple and the privacy policy do not change.
   If the answer is no, no answer on any form changes.

Do **not** add App interactions as Shared. The evidence does not support it.

---

## 6 · Docs and tests changed in this commit

- `docs/release/pr239-thumbnail-privacy-review.md` — this report (new).
- `docs/release/privacy-decision-matrix.md` — §15 (TMDB) and §16 (YouTube) rewritten to the
  determination above; the F-6 row, the readiness-gate row and the gate summary no longer
  offer an Option A/B choice; removed claims that "IP is not a Play data type" and that a CDN
  image load "does not constitute sharing," and removed every reference to a Play Console
  "notes" field.
- `docs/release/store-privacy-inventory.md` — §1 trailer paragraphs, the §3 service-provider
  paragraph (no "optional notes" field), the §3 image-host note, and §6 item 8 rewritten to
  match.
- `src/features/title/trailer-previews.ts` — comment only: states the determination and the
  open question in place of the Option A/B text.
- `src/features/title/TrailerRail.tsx` and `app/title/[id].tsx` — comments only: they now
  say the caller decides through `previews`, that production deployed today uses the Show
  previews opt-in, and that the prepared change loads stills with the page.
- Matrix "Proposed policy wording" gains item E: optional, unpublished, and not required for
  the OTA.
- No behaviour or test changes. The thumbnail behaviour is unchanged; no defect was found.

### Not verified, and what would settle each

| Item                                                                                                        | What would settle it                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real-device Android request headers (the replay matches the library configuration, but not a release build) | Capture one still request from a release build through an intercepting proxy (e.g. mitmproxy with a user CA on a debug-signed copy of the release config) |
| iOS cookie and `NSURLSession` default headers                                                               | The same capture on an iOS build                                                                                                                          |
| Whether `i.ytimg.com` logs or uses IP addresses for location                                                | No public source found; Google Play support's answer (action 1) makes it moot                                                                             |
| Whether a beta release with automatic stills is live on the alpha track                                     | Play Console release history (action 1)                                                                                                                   |
