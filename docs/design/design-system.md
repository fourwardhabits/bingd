# Bingd — Design System

**Version:** v1 (public alpha)
**Status:** Draft for review
**Date:** 2026-08-13
**Specification:** [`../product/PRD.md`](../product/PRD.md) §5 · [`../architecture/client.md`](../architecture/client.md) §4

The PRD fixes the palette, the typefaces, and the voice. This document turns those into values a component can consume, and resolves the places where the brand as written does not survive contact with a real screen.

---

## 1. Two problems in the palette

Both were found by measuring the PRD §5 colors rather than by looking at them, and both would otherwise have shipped.

### Antique Amber and Muted Sage cannot carry text on Parchment

Measured against Parchment `#F5EBDD`:

| Foreground | Ratio | WCAG AA body (4.5:1) | WCAG AA large (3:1) |
|---|---|---|---|
| Ink `#242326` | 13.3:1 | pass | pass |
| Bingd Maroon `#773744` | 7.4:1 | pass | pass |
| Muted Sage `#92A895` | **2.2:1** | **fail** | **fail** |
| Antique Amber `#D4A64C` | **1.9:1** | **fail** | **fail** |

Amber and Sage are mid-luminance colors sitting on a light background. No text size rescues them — even at display size they fall below the 3:1 large-text floor.

This caught one already-written instruction. [`client.md`](../architecture/client.md) §5 specified the ranking reveal as "Antique Amber for the ordinal," which would have rendered the single most important number in the product at 1.9:1 — effectively invisible in daylight and to anyone with low vision. That section has been corrected.

**Resolution.** Amber and Sage are **fill colors, never ink**. Where the PRD calls for amber emphasis, amber becomes the surface and Ink sits on top of it, which measures 7.0:1. The reveal is specified accordingly in §9. Both colors remain available for non-text use — rings, bars, dots, illustration — where the 3:1 non-text threshold applies and both still fail against Parchment, so even there they need an Ink hairline to define their edge.

### Posters fight Parchment

Movie posters are dark, saturated, full-bleed rectangles. Letterboxd works because its background is near-black, so artwork sits in a void and the interface disappears. Parchment does the opposite: every poster becomes a loud object on a quiet page.

The PRD anticipated this — Midnight is reserved as a "future dark companion for poster-heavy surfaces" and explicitly not built in v1 (§5). So v1 has to make artwork work on a light warm ground.

**Apple Wallet already solves this exact problem**, and PRD §5 names it as a visual reference.

![Apple Wallet — saturated cards on a light neutral ground](./references/apple-wallet-1-cards-on-light.jpg)

Wallet's entire job is rendering arbitrary, saturated, high-contrast rectangles on a near-white background, and it works because of four things: every card gets a generous radius and a soft shadow that seats it as a physical object, cards keep real margins rather than tiling edge to edge, the surrounding chrome is strictly neutral, and **the cards are the only color on the screen**.

**Resolution.** Treat every poster as a **printed object on a page** rather than as a window, following Wallet's model. Consistent 2:3 crop, a hairline Ink border at 12% so pale posters do not bleed into the background, a soft warm shadow, and generous Parchment margins on every side. No full-bleed backdrop headers, no edge-to-edge artwork, no poster behind text.

One rule is harder for Bingd than for Wallet: Parchment is a *chromatic* background, warmer and more saturated than Wallet's near-white, so it starts with less headroom. That makes Wallet's fourth rule non-negotiable here — **artwork is the only color on a content surface.** No Amber accents, no Sage indicators, and no colored chrome adjacent to a poster grid. Amber and Sage belong on surfaces that have no artwork on them: milestones, the reveal, sync state, empty states.

This is a constraint the brand can carry. An archive of printed cards on paper is exactly what "keep what you watch" should feel like.

The full poster rules are in §7.

---

## 2. Color tokens

### Brand — fixed by PRD §5, not open to adjustment

```ts
export const brand = {
  parchment: '#F5EBDD',
  maroon:    '#773744',
  ink:       '#242326',
  amber:     '#D4A64C',
  sage:      '#92A895',
  midnight:  '#19242D',  // reserved, not used in v1
} as const;
```

### Derived — neutrals mixed from Parchment and Ink

Not new brand colors. Each is a tint or shade of two colors already in the system, which is why none of them introduces a new hue.

| Token | Value | Use |
|---|---|---|
| `surface.base` | `#F5EBDD` | Screen background |
| `surface.raised` | `#FCF6EC` | Cards, sheets, anything above the page |
| `surface.sunken` | `#EADFCF` | Inputs, wells, skeletons, poster placeholders |
| `border.hairline` | Ink @ 12% | Default separation, poster edges |
| `border.strong` | Ink @ 24% | Focus, selected outlines, input borders |
| `text.primary` | `#242326` | 13.3:1 |
| `text.secondary` | `#5F5A56` | 5.8:1 — supporting copy |
| `text.tertiary` | `#6E6862` | 4.7:1 — timestamps, counts, metadata |
| `text.onFill` | `#242326` | Ink on Amber (7.0:1) or Sage (6.1:1) |
| `text.inverse` | `#F5EBDD` | Parchment on Maroon (7.4:1) |

There is no lighter tertiary. A fourth text tone would fall below 4.5:1, and the honest fix for "this is less important" is smaller type or more space, not weaker contrast.

### Semantic

```ts
export const semantic = {
  action:        brand.maroon,      // primary buttons, links, selected
  actionText:    '#F5EBDD',
  emphasis:      brand.amber,       // milestone fills, reveal surface
  progress:      brand.sage,        // watched, completed, sync success
  danger:        brand.maroon,      // destructive confirmation
  focusRing:     brand.maroon,
} as const;
```

Destructive actions reuse Maroon rather than introducing red. The palette has no red, a new one would compete with the brand color, and destructive actions in this product are rare and always confirmed with words. The confirm button is labeled with the verb — "Delete list" — never a bare "OK," so color is never the only signal that something is irreversible.

---

## 3. The bucket scale

Three buckets, always in this order, always with a label.

| Bucket | Color | Token | Ink on fill |
|---|---|---|---|
| Loved it | Bingd Maroon `#773744` | `bucket.loved` | — uses `text.inverse` at 7.4:1 |
| It was fine | Muted Sage `#92A895` | `bucket.fine` | 6.1:1 |
| Not for me | Stone `#9A8F86` | `bucket.notForMe` | 4.9:1 |

**Stone is a derived warm grey**, named so it cannot be mistaken for a brand accent. It reads as receded rather than as a rejection, which matches the product's position: the buckets express *for me* and *not for me*, not good and bad.

Three deliberate choices here.

**Not red, yellow, green.** That triad is Beli's, borrowed from food safety, and it says "bad, mediocre, good" about the film rather than about the viewer's response to it. It also fails for the roughly one in twelve men with red-green color vision deficiency, and green and red are both absent from Bingd's palette.

**Amber is excluded**, even though it is the obvious middle color. Amber's job in this system is milestones, awards, and the reveal. Using it for "it was fine" would spend the product's celebration color on its most neutral state, and after a few weeks of use amber would read as *unremarkable* everywhere it appears.

**Color is never the only signal.** Every bucket indicator carries its label, or sits under a band header that names it. On collection rows the indicator is a small filled shape paired with the band grouping, never a bare colored dot.

Unselected chips render as an outlined ring in the bucket color on `surface.raised`; the selected chip fills and adds a checkmark. This is the interaction from Beli 224 and it works because selection is signalled by fill, checkmark, and border simultaneously.

---

## 4. Typography

**DM Serif Display** ships Regular and Italic only — there is no bold. Any design that needs a heavier serif is not achievable, so serif emphasis must come from size and space. This is a real constraint and it is easy to discover too late.

**Inter** at 400, 500, and 600. Not 700; at these sizes 600 is enough, and capping the range keeps the type feeling calm.

Both are bundled as local assets and never fetched at runtime — the same failure the brand SVGs currently have (PRD §5).

| Token | Family | Size / line | Use |
|---|---|---|---|
| `reveal` | DM Serif Display | 88 / 88 | The ordinal in the ranking reveal. Nowhere else |
| `display` | DM Serif Display | 40 / 44 | Share cards, milestone moments |
| `title1` | DM Serif Display | 28 / 34 | Editorial screen titles |
| `title2` | DM Serif Display | 22 / 28 | Title names, section headers |
| `headline` | Inter 600 | 17 / 22 | Row titles, buttons |
| `body` | Inter 400 | 16 / 24 | Notes, descriptions, prose |
| `callout` | Inter 500 | 15 / 20 | Secondary actions, chip labels |
| `subhead` | Inter 500 | 14 / 20 | Field labels, metadata headers |
| `footnote` | Inter 400 | 13 / 18 | Timestamps, counts |
| `caption` | Inter 500 | 12 / 16, +0.2 tracking | Overlines, tab labels |

**Dynamic Type is supported** across the whole app. `reveal` and `display` cap at 130% because they are already display-scale and clip before they help; everything else scales without a ceiling. No token ever scales below 100%. Layouts that break at 200% are bugs, not acceptable trade-offs — the ranking list, the comparison screen, and settings are the three most likely to break and are called out in [`screens.md`](./screens.md).

---

## 5. Space

A 4pt base. Screen gutter 16. Gap between sections 24. Card padding 16.

```ts
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64 };
```

PRD §5 asks for airy onboarding, comparison, reveal, and share surfaces, and efficient rows on Rankings and Search. In practice that means those two groups use different vertical rhythms: **airy surfaces** use 24 and 32 between elements and center their content vertically; **efficient surfaces** use 12 between rows with a 56pt minimum row height.

---

## 6. Radius, elevation, motion

**Radius.** Cards 12, controls 8 (buttons, inputs, chips), sheets 20 on the top corners only, avatars full-round. No pill buttons — PRD §5.

**Elevation.** Two levels, both using Ink rather than black. Pure black shadow on a warm background reads as a grey smudge.

| Token | Shadow | Use |
|---|---|---|
| `e1` | `0 1px 2px` Ink @ 6% | Raised cards, poster md and above |
| `e2` | `0 8px 24px` Ink @ 14% | Sheets, popovers |

**Motion.** 120ms for state changes, 200ms for sheets, 260ms for navigation, standard easing. The ranking reveal is the single exception (§9).

`prefers-reduced-motion` is honored everywhere. When it is set, the reveal becomes a cross-fade of the same composition — the moment still happens, it just does not move.

---

## 7. Posters

Artwork always renders 2:3, the TMDB standard. Anything else is letterboxed against `surface.sunken`, never stretched.

| Token | Size | Use |
|---|---|---|
| `poster.xs` | 40 × 60 | Dense lists, search results, tag rows |
| `poster.sm` | 56 × 84 | Ranking rows, watchlist rows |
| `poster.md` | 88 × 132 | Feed strips, list previews |
| `poster.lg` | 132 × 198 | Title detail, recommendation cards |
| `poster.xl` | 180 × 270 | Comparison cards, share cards |

Rules that make artwork sit on Parchment:

- **Hairline border**, Ink @ 12%, inset. Without it, pale posters dissolve into the page.
- **Radius 8 below 100pt wide, 12 at or above.** A 12pt radius on a 40pt thumbnail eats the artwork; the rule keeps the *visual* corner constant as the poster scales, which is what PRD §5's 12px card radius is actually asking for.
- **Shadow `e1` at md and above only.** Small posters with shadows produce visual noise in a list.
- **Never full-bleed.** No backdrop headers, no artwork behind text, no edge-to-edge grids. Minimum 16pt of Parchment on every screen edge.
- **Artwork is the only color present.** On any surface showing posters, all other elements are Ink, Parchment, or a derived neutral. Amber and Sage do not appear near artwork (§1).
- **Missing artwork is a designed state**, not a broken image: `surface.sunken` fill, the title's first two initials in DM Serif Display, `text.tertiary`. This will be common, because Letterboxd imports reach obscure titles the catalog has no poster for.

---

## 8. Components

Specified by anatomy and rules rather than by pixel measurements, which belong in code.

### Button

Three kinds. Primary is Maroon with `text.inverse`. Secondary is `surface.raised` with a `border.strong` outline and Ink label. Tertiary is a bare Ink label with no container.

Minimum height 48, minimum tap target 44 × 44, radius 8, `headline` label. One primary per screen. Disabled state reduces opacity to 40% **and** the button announces why it is disabled to screen readers — an unexplained dead button is the most common accessibility failure in this pattern.

### Bucket chip

The triad from §3. Three chips in a row, equal width, each an outlined circle above its label. Tapping fills the circle, adds a checkmark, and leaves the other two outlined. Selecting a bucket never starts comparisons on its own — that is a separate deliberate action (PRD §11, [`api.md`](../architecture/api.md) §1).

### Rank badge

The ordinal, rendered as `#18` in Inter 600 on `surface.raised` with a `border.hairline`, or in Maroon on Parchment where it needs emphasis. Always accompanied by its category — `#18 in Movies` — because a bare ordinal is meaningless across categories.

**Never rendered as a score, percentage, ring, or bar.** This is the constraint most likely to be violated by muscle memory, because every comparable app displays a number out of ten.

### Title row

`poster.sm`, then title and year on one line, then a metadata line, then a trailing action. 56pt minimum height. The metadata line carries the bucket label and rank when both exist: `Loved it · #4 in Movies`.

### Comparison card

`poster.xl`, title beneath in `title2`, nothing else. The card is deliberately bare — no year, no runtime, no genre, no rank. Every additional element is something the user reads instead of deciding, and the mechanic depends on feeling fast.

The comparison target does **not** show its current position — founder decision, 2026-08-13. Showing it turns a gut call into arithmetic, and the mechanic depends on the answer being instinctive ([`screens.md`](./screens.md) §4).

### Sheet

Radius 20 top corners, `surface.raised`, `e2`, drag handle, no dimmed backdrop below 40% — Parchment behind a heavy scrim turns muddy. Sheets are the primary modal pattern; full-screen modals are reserved for onboarding and the reveal.

### Empty state

Illustration or large glyph, a `title2` line in DM Serif Display, one `body` line, and exactly one action. Written in the Curious Collector voice: "Nothing here yet" rather than "No results found."

Every list surface needs three distinct empty states that are frequently collapsed into one by mistake: **nothing yet** (new user), **nothing matches** (filter applied), and **could not load** (network or server). They read differently and offer different actions.

### Pending and offline

Queued writes render with a `pending` marker per [`offline-sync.md`](../architecture/offline-sync.md) §4: the row stays fully legible at 70% opacity with a small Sage sync glyph. Not a spinner, and never a greyed-out row — the user's action did happen, it just has not reached the server.

Actions that cannot be queued — ranking, blocking, reporting — are **visibly disabled with a reason** when offline rather than failing on tap. PRD §5's offline voice applies: "Saved on this device. We'll sync when you're online."

---

## 9. The ranking reveal

PRD §5 grants exactly one surface real animation, and [`client.md`](../architecture/client.md) §5 identifies this as the product's payoff moment.

The composition, revised for the contrast finding in §1:

An **Amber panel** fills the center of a Parchment screen. The ordinal sits on that panel in DM Serif Display at `reveal` size in **Ink**, measuring 7.0:1 rather than the 1.9:1 that Amber-on-Parchment would have produced. Category and title sit below in `title2`. The panel is the only place in the app where Amber appears at that scale, which is what makes it feel like an award.

The sequence: the comparison screen clears, the panel scales up from 92% while fading in over roughly 280ms, and the ordinal counts up to its final value over roughly 500ms, settling with a small overshoot. Total under a second. It resolves to a still composition that is worth screenshotting, because it will be.

Under `prefers-reduced-motion`, the final composition cross-fades in with no counting and no scale.

---

## 10. Accessibility

Beyond the contrast work in §1 and §2.

**The comparison screen is the hard case.** Two posters side by side with no text is unusable with a screen reader, and it is the core mechanic. Each card exposes an accessibility label naming the film and its year and nothing else, the question is announced as a heading, and the three controls carry explicit labels — "Undo last comparison," "Too tough to call," "Skip this comparison." Tapping a poster is a button, not an image.

**Every tap target is at least 44 × 44**, including the bucket chips, the reaction row, and the poster tiles in a grid.

**Color is never the sole carrier of meaning** — buckets pair with labels, sync state pairs with a glyph, selection pairs with a checkmark and border.

**Motion respects the system setting**, including the reveal.

**Dynamic Type is supported to 200%.** Rankings, comparison, and settings are the screens most likely to break and are the ones to test first.

---

## 11. Keeping the system honest

Two mechanisms, both cheap, both preventing the failures this document exists to catch.

**A contrast test.** A unit test computes WCAG ratios for every semantic foreground and background pair in the token file and asserts the required threshold. The Amber and Sage failures in §1 were found by measurement, and a test is how they stay found — including for any color added later.

**A lint rule banning raw color literals** in `src/features/` and `src/ui/`, so a hex value can only appear in the token file. Without it, a hardcoded `#D4A64C` reintroduces the exact defect this document opens with.

---

## 12. Open

| Item | Who decides |
|---|---|
| Illustration style for empty states and onboarding | Founder, once a source is chosen |
| Whether Midnight ships as a dark theme before mass market | Deferred — PRD §5 |

Two items that sat here were resolved by the founder on 2026-08-13: the tab structure ([`screens.md`](./screens.md) §2) and whether a comparison card shows its opponent's rank, which it does not ([`screens.md`](./screens.md) §4).
