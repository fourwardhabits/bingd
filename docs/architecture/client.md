# Bingd — Client Architecture

**Version:** v1 (public alpha)
**Specification:** [`../product/PRD.md`](../product/PRD.md) §5, §7, §16, §24 · [`api.md`](./api.md)

Expo, React Native, TypeScript. One codebase, three variants.

---

## 1. Layout

```
app/                        Expo Router — file-based routes
  (auth)/                   sign-in, sign-up, onboarding
  (tabs)/                   feed, search, log, recommendations, profile
  title/[id].tsx
  u/[username].tsx
  lists/[id].tsx
  i/[token].tsx             invitation acceptance
  settings/
src/
  api/                      generated types, RPC wrappers, query keys
  features/                 ranking, collection, social, import,
                            notifications, sharing, recommendations
  offline/                  SQLite, outbox, sync engine
  ui/                       primitives, tokens, share-card renderers
  lib/                      analytics, deep links, capabilities, errors
```

Organized by **feature** rather than by technical layer. A `components/` directory holding every component in the app forces every change to touch several distant folders; grouping the ranking screen with its hooks, its RPC calls, and its types keeps a change local. `ui/` holds only genuinely shared primitives.

Expo Router is used because deep links are a product requirement, not an afterthought (PRD §16). File-based routing means `bingd.app/u/alex` and the in-app profile screen are the same route definition, so they cannot drift apart.

---

## 2. Navigation — Provisional (INF-4)

Five tabs: **Feed · Search · + · Recommendations · Profile**, with Rankings and Lists inside Profile.

The reasoning is that a ranking *is* an identity, so it belongs with the profile rather than competing with it for a tab. The center **+** is the log-and-rank entry point, which is the action the product most wants to be frictionless.

Marked Provisional in the PRD and expected to change during design. Nothing else in the architecture depends on it.

**It has changed.** [`../design/screens.md`](../design/screens.md) §2 proposes **Feed · Collection · + · Recommendations · Profile**, moving the collection out of Profile and dropping the separate Search tab. Pending founder confirmation; this section is superseded once that lands.

---

## 3. State

Three kinds of state, deliberately not unified.

| Kind | Owner | Examples |
|---|---|---|
| **Server state** | TanStack Query | Feed, profiles, rankings, recommendations, catalog |
| **Durable local state** | SQLite | Outbox, own-collection mirror |
| **Ephemeral UI state** | React | Form inputs, sheets, the current comparison card |

No Redux, no global store. Server state is not application state, and treating it as such is what produces stale caches that need manual invalidation everywhere. TanStack Query owns fetching, caching, retry, and revalidation; SQLite owns what must survive a cold start with no network.

### Query keys

Structured so invalidation can be surgical:

```
['rankings', userId, category]
['collection', userId]
['feed', { cursor }]
['recommendations', userId]
['title', mediaItemId]
['capabilities']
```

Completing a ranking invalidates `['rankings', me, category]` and `['collection', me]` and nothing else. The feed refreshes on its own schedule rather than being blown away by an unrelated write.

### Optimistic updates

Only for outbox-eligible operations ([`api.md`](./api.md) §1). Every one carries the `pending` marker from [`offline-sync.md`](./offline-sync.md) §4 until the server confirms.

**Ranking is never optimistic.** The position comes from the server, and guessing it would mean showing the user a number that might change — in the one moment the product has built up to.

---

## 4. Design tokens

The PRD §5 palette and type system live in one token file. Components never hardcode a color.

```ts
export const color = {
  parchment: '#F5EBDD',   // primary background
  maroon:    '#773744',   // identity, action, selected
  ink:       '#242326',   // text, structure
  amber:     '#D4A64C',   // awards, milestones, reveals
  sage:      '#92A895',   // watched, progress, completion
  midnight:  '#19242D',   // reserved — dark theme, not built in v1
} as const;
```

Tokens are consumed through a theme object rather than imported directly, so the Midnight dark theme in PRD §5 is purely additive later — a second theme object, not a search-and-replace across the app.

Type: **DM Serif Display** for the wordmark, ranking reveals, editorial headers, and share cards. **Inter** for everything functional. Both bundled as local assets — never fetched at runtime, which is the same failure the brand SVGs currently have (PRD §5).

Radii follow PRD §5: 12px cards, 8px inputs, full-round on avatars only. No pill buttons.

---

## 5. The ranking reveal

PRD §5 grants exactly one surface real animation, and this is it. Everything else is minimal.

The comparison sequence is deliberately plain — two posters, one question, no decoration — so the reveal lands by contrast. The reveal uses DM Serif Display at display size and a single transition. It is the product's payoff moment and the thing most likely to be screenshotted.

**Corrected 2026-08-13.** This section previously specified Antique Amber for the ordinal. Amber measures 1.9:1 against Parchment and fails WCAG at every text size, so the ordinal is set in Ink on an Amber panel instead — 7.0:1, same visual emphasis. The composition is in [`../design/design-system.md`](../design/design-system.md) §9.

Comparison cards prefetch the next pivot's poster while the user is deciding, so the sequence never stalls on an image load. A stall here is disproportionately damaging, because the whole mechanic depends on feeling quick.

---

## 6. Share cards

Rendered **on-device** to PNG via `react-native-view-shot`, from real React components using the same tokens as the app.

On-device rather than server-side because PRD §16 requires sharing to work under weak connectivity. A server-rendered card needs a round trip at the exact moment someone is trying to post something.

The Top 10 is the polished artifact (PRD §16) and must render correctly with ten titles, with fewer than ten, and with missing artwork. The text-first fallback is a real layout, not a degraded one — it exists both for missing artwork and for the possibility that HG-1 restricts artwork in exported images.

Open Graph images for web pages are server-rendered by `og-render`, since they are requested by messaging platforms rather than by the app.

---

## 7. Deep links

Universal Links on iOS and App Links on Android, verified by `apple-app-site-association` and `assetlinks.json` on `bingd.app`. `.app` is HSTS-preloaded, so HTTPS is mandatory from the first deploy (PRD §24).

Routes are in PRD §16. Two client behaviors matter:

**A link opens its exact destination**, not the home screen. This is the difference between a share loop that works and one that quietly loses people, and it is worth testing on both platforms for every route.

**Signed-out and wrong-account states are handled explicitly.** An invitation opened while signed into a different account discloses which account will accept and offers to switch (PRD §17), rather than silently binding the invitation to whoever happens to be logged in.

---

## 8. Variants

Configured in `app.config.ts` from the `APP_VARIANT` environment variable.

| Variant | Bundle ID | Name | Backend |
|---|---|---|---|
| development | `app.bingd.dev` | bingd dev | nonprod |
| preview | `app.bingd.preview` | bingd preview | nonprod |
| production | `app.bingd` | bingd | production |

Non-production builds show a persistent environment badge. Icons differ so the three are distinguishable on a home screen at a glance.

`expo-notifications` and both push credentials are present in **all** variants from the first build, per PRD §15 — including production, where delivery is flagged off server-side.

---

## 9. Performance

| Concern | Approach |
|---|---|
| Long ranking lists | `FlashList`, with positions already dense so no client-side ordering is needed |
| Poster loading | `expo-image` with disk cache and blurhash placeholders |
| Comparison prefetch | Next pivot's artwork prefetched during the current decision |
| Feed pagination | Cursor-based on `created_at`, never offset |
| Cold start | Own collection renders from SQLite before any network response |

Cold start is the one worth defending. A user opening the app on a subway should see their collection immediately, not a spinner that resolves into a spinner.

---

## 10. Accessibility

Not deferred. Retrofitting is more expensive than building it in, and the comparison mechanic has a specific trap.

- Every interactive element carries an accessible label and a target of at least 44×44 points.
- **The comparison screen must work for screen readers.** Two posters side by side with no text is unusable otherwise, so each option exposes title, year, and its position in the sequence.
- Colors meet WCAG AA against Parchment. Maroon on Parchment passes; Amber on Parchment does **not** at body size and is therefore restricted to large display type and decorative fills.
- Dynamic Type is respected. Ranking rows and share cards are tested at the largest supported size.
- Motion respects the reduce-motion setting, including the ranking reveal.

---

## 11. Analytics

A typed first-party event layer. Screens never call a vendor SDK directly, so the provider decision stays reversible.

**Required:** no event payload carries note text, watch dates, email, or any private field (PRD §23).

Event names come from the PRD: `share_*` and `invite_*` from §16 and §17, gate hits from §20, recommendation feedback from §13. `share_sheet_opened` is recorded as an intent, never as a completed post.
