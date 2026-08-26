# bingd. — brand guide

**Last updated:** 2026-08-25
**Product baseline:** PR #48, reviewed head `7179d0d` · **Release/native push delta:** PR #49, reviewed head `3e90661`

**Companion documents:** [`PRD.md`](./PRD.md) §5 · [`gtm-context.md`](./gtm-context.md) ·
[`../design/design-system.md`](../design/design-system.md)

This is the canonical brand reference: enough for a marketer, a designer, or a coding
agent to produce bingd.-consistent work without screenshots. Every value below is quoted
from the implementation — `src/ui/tokens/color.ts`, `typography.ts`, `layout.ts` — which
is the source of truth. If this document and those files disagree, the files win and this
document must be corrected. Nothing here is invented.

---

## 1. The name

**The user-facing name is `bingd.` — always lowercase, and the period is part of the
brand.** The clipped spelling is deliberate, adjacent to *binge* without forcing a
branded verb.

| Write | Never write |
|---|---|
| bingd. | Bingd |
| bingd. Awards | BINGD |
| Share off bingd. | bingd.. |

**The period doubles as sentence punctuation.** When the name ends a sentence, one period
serves both jobs — shipped copy reads *"You will not see each other on bingd."* and
*"Somebody you invited joins bingd. and ranks their first ten titles."* Write sentences so
the name never sits directly before a second period; recast rather than produce `bingd..`.

Mid-sentence the name keeps its period and the sentence continues after it: *"bingd.
learns from how they compare to each other, not from stars."* This reads oddly in
isolation and correctly in product, and it is consistent everywhere shipped copy uses it.

Capitalised **Bingd** appears only in internal documents and code comments (this repo's
docs use it as an ordinary proper noun for readability). It never appears in user-facing
copy, store listings, or marketing surfaces.

**The wordmark** is the text `bingd.` set in DM Serif Display, rendered in Bingd Maroon
(`src/ui/components/Wordmark.tsx`). The square icon mark lives at
`assets/brand/bingd-icon.svg`.

---

## 2. Brand essence

**Primary archetype: Curious Collector.** Warm, simple, observant, personal, lightly
playful. **Secondary: Playful Explorer**, used only where the product has earned more
energy — awards, milestones, reveals, discovery prompts, share moments (this is exactly
where Antique Amber appears, and only there).

The product should feel: tasteful · curious · social · warm · lightly playful ·
opinionated enough to have personality.

It should never feel: precious · cinephile-snobbish · corporate · hyper-gamified ·
meme-chasing · like a neon streaming app.

The founding statement (PRD §5): bingd. is a social entertainment collection **for people
who love watching things, not analyzing them**.

---

## 3. Color

Canonical values from `src/ui/tokens/color.ts` — the only file in the client permitted to
contain a color literal (lint-enforced). **v1 is light-only**; `userInterfaceStyle` is
pinned to `light` and Midnight is reserved, unused.

### Brand palette

| Token | Hex | Role |
|---|---|---|
| **Paper** `brand.paper` | `#FBF8F4` | The base surface everywhere — a warm near-white |
| **Parchment** `brand.parchment` | `#F5EBDD` | Warm accent surface: sunken wells, inputs, chips, selected tabs, poster placeholders |
| **Bingd Maroon** `brand.maroon` | `#773744` | Primary identity and action: wordmark, buttons, selected states, score fills, danger |
| **Ink** `brand.ink` | `#242326` | Primary text and structural contrast |
| **Antique Amber** `brand.amber` | `#D4A64C` | Emphasis fills only: awards, milestones, reveals, special moments |
| **Muted Sage** `brand.sage` | `#92A895` | Progress and calm utility fills; the "fine" bucket |
| **Midnight** `brand.midnight` | `#19242D` | Reserved for a future dark companion. **Not used in v1** |

### Functional tokens

| Token | Value | Role |
|---|---|---|
| `surface.base` | `#FBF8F4` (Paper) | Screen background |
| `surface.raised` | `#FFFFFF` | Cards and sheets above the base |
| `surface.sunken` | `#F5EBDD` (Parchment) | Wells, inputs, chips |
| `text.primary` | `#242326` (Ink) | Body and headings |
| `text.secondary` | `#5F5A56` | Supporting copy |
| `text.tertiary` | `#6E6862` | Metadata |
| `text.inverse` | `#F5EBDD` | Text on maroon fills |
| `border.hairline` | Ink @ 12% | Default rules and outlines |
| `border.strong` | Ink @ 24% | Emphasised borders |
| `semantic.action` | Maroon | The one action color; `actionText` is Parchment |
| `semantic.score` | Maroon fill, Parchment ink | The score badge |
| `semantic.emphasis` | Amber | **Fills only**, never text on Paper |
| `semantic.progress` | Sage | **Fills only** |
| `semantic.danger` | Maroon | Destructive actions share the action color |
| `semantic.focusRing` | Maroon | Focus indication |

### Bucket colors

| Bucket | Fill | Ink on it |
|---|---|---|
| `loved` — *I liked it* | `#773744` Maroon | `#F5EBDD` |
| `fine` — *It was fine* | `#92A895` Sage | Ink |
| `not_for_me` — *I didn’t like it* | `#9A8F86` Stone | Ink |

Stone exists only as a bucket color, not as a brand color. Award tiers (decorative only):
bronze `#A9713F`, silver `#9E9C97`, gold = Amber, locked = Ink @ 22%.

**There is no success/warning/error triad.** Errors and destructive actions use Maroon;
completion and progress use Sage; celebration uses Amber. Adding a red/green/yellow set
would be off-system.

Contrast is measured, not assumed: `src/ui/tokens/contrast.ts` asserts AA ratios in tests
(body 4.5:1, large text 3:1). Any new pairing must be measured and added there.

---

## 4. Typography

Two families, loaded from `@expo-google-fonts/dm-serif-display` and
`@expo-google-fonts/inter` (`src/ui/tokens/typography.ts`; no local font files).

| Family | Role |
|---|---|
| **DM Serif Display** (regular + italic) | The brand voice in type: wordmark, the ranking reveal, display moments, screen titles |
| **Inter** (400 / 500 / 600) | Everything functional: navigation, buttons, body, metadata |

The type scale, exactly as pinned:

| Token | Face | Size / line |
|---|---|---|
| `reveal` | DM Serif | 88 / 88 — the score reveal, the one earned dramatic moment |
| `display` | DM Serif | 40 / 44 |
| `title1` | DM Serif | 28 / 34 |
| `title2` | DM Serif | 22 / 28 |
| `headline` | Inter 600 | 17 / 22 |
| `body` | Inter 400 | 16 / 24 |
| `callout` | Inter 500 | 15 / 20 |
| `subhead` | Inter 500 | 14 / 20 |
| `footnote` | Inter 400 | 13 / 18 |
| `caption` | Inter 500 | 12 / 16, +0.2 tracking |
| `score` | Inter 600 | 17 / 20, tabular numerals |
| `ordinal` | Inter 600 | 15 / 20, tabular numerals |
| `sectionHeader` | Inter 600 | 12 / 16, +0.6 tracking, uppercase |

Rule of thumb: **serif is for moments, sans is for use.** A surface that is all serif is
shouting; a reveal in Inter is a receipt.

---

## 5. Shape, density, and layout grammar

From `src/ui/tokens/layout.ts`:

- **Corner radius:** cards 12 · controls 8 · sheets 20 · avatars full-round. Poster radius
  scales with size (12 ≥ 100pt wide, 8 ≥ 60, else 6). **No pill buttons.**
- **Spacing:** a 4pt scale (4–64). Screen gutter 16, section gap 24, card padding 16.
- **Tap targets:** minimum 44pt; buttons 48pt tall; dense rows 56pt.
- **Posters are the hero.** Aspect 2:3, six pinned sizes (38×57 up to 180×270), 3-column
  grids, shelves with a deliberate 0.7 peek. Artwork carries content surfaces; typography
  carries reveals, milestones and share cards.
- **Sheets are the interaction grammar.** Logging, ranking, comments from the Feed,
  recommendations, requests, awards — bottom sheets (radius 20), not pushed screens.
  (The exception proves the rule: a comment *notification* opens a dedicated
  conversation page, because that tap arrives from outside the surface the sheet
  belongs to.)
- **Elevation is whisper-quiet:** two levels only, Ink-tinted shadows at 6% and 14%.
- **Motion is minimal with one exception:** state 120ms, sheets 200ms, navigation 260ms —
  and the ranking reveal earns real animation (280ms panel, 500ms count).
- **Density:** airy on onboarding, comparison, reveal and share surfaces; efficient rows
  on collection and search. Compact information density, restrained cards.

Avoid: giant cards, spacious empty SaaS layouts, constant pills, gradients, dark-glass
streaming-app styling, progress bars toward "completing" a collection (explicitly
forbidden — PRD §11).

---

## 6. Imagery

- **Film and TV artwork is the visual hero** wherever content is the subject. Posters are
  served from the TMDB CDN, never rehosted (PRD §19).
- **Profile and social UI does not compete with posters:** avatars are small (18–72pt),
  identity blocks are typographic, and the feed row is one sentence with a small poster
  and score circle.
- Poster placeholders are Parchment. A text-first branded layout must always exist for
  titles with no artwork.
- **Awards** are drawn badge art on a collectible wall (ten of twenty tracks still carry
  an emoji placeholder — [`deferred-roadmap.md`](./deferred-roadmap.md) §14). Tier metals
  are decorative color, never UI signals.
- TMDB attribution is required wherever provider data shows: the exact notice and an
  approved logo, less prominent than bingd.'s own mark.

---

## 7. Voice

Short, curious, human, confident, lightly playful. The app talks like a friend who keeps
a good list — never like a platform.

Not: meme-heavy · overly cute · corporate ("utilize", "experience", "content") ·
breathless · film-school jargon ("cinematography", "auteur") · algorithm talk
("our engine", "personalization").

Working rules, all visible in shipped copy:

- **Plain sentences, no exclamation marks.** Even celebration is calm: *"You are all set."*
- **Say what happens, not what went wrong.** *"This build cannot send notifications to
  your lock screen yet. You will still see everything in the app."*
- **The reader's taste is the authority.** *"Which did you like more?"* — never "which is
  better". The score is their ordering, not a rating of the film.
- **No contractions of honesty.** Failure copy admits the actual state: *"We lost the
  connection before hearing back, so it may already be ranked."*
- **Privacy copy names the audience.** *"Only you can read this."* / *"Anyone who can see
  your profile will be able to read it."*
- **No fake numbers, ever.** Match shows *"Rank more to see Match"* or *"Not enough
  shared taste yet"* — never `TBD`, never `0%`.

### Example copy — verbatim from the current product

| Copy | Where |
|---|---|
| I liked it · It was fine · I didn’t like it | The three buckets |
| How was it? | The bucket prompt |
| Which did you like more? | Comparison |
| Rank again / Change your rating | The two ranked-title controls |
| Finish your log | The post-rank button |
| Write review / Edit review / Share as a review | Review controls |
| Add private note / Make it a private note | Note controls |
| Only you can read this. | Private-note helper |
| Recommendation requests · 3 → View | The For You requests alert |
| Nothing waiting — Recommendations from people you do not follow turn up here. | Requests empty state |
| Rank more to see Match | Match, when the viewer is short |
| Stay in the loop | Onboarding notification step |
| Know when friends follow you, recommend something, or interact with what you watched. | Its explanation |
| We will send a six-digit code. No password to remember. | Sign-in |
| Keep what you watch. | Sign-in headline |
| Your feed is quiet right now. — Rank a title, or follow someone, and activity will appear here. | Feed empty state |
| A film, a series, or @someone | Search placeholder |
| Anything you have ever seen. It does not have to be recent. | Onboarding bucket helper |
| Public — Anyone can see your rankings and reviews. / Private — Only approved followers can see your activity. | Signup visibility helper |

**Value proposition** (PRD §1): *Keep what you watch. Know what you love. Find what's
next.*

---

## 8. Terminology — the words the product uses, and the ones it retired

| Say | Not | Why |
|---|---|---|
| Rank / Ranked | Rate / star | Comparison is the product |
| I liked it / It was fine / I didn’t like it | Loved it / Not for me | Superseded labels; the stored values are still `loved` / `fine` / `not_for_me` |
| Review | public note | A published note **is** the review; there is no second object |
| Private note | just "note" | The visibility is the name |
| Rank again | rewatch-rank / re-rank | It means *another watch* |
| Change your rating | edit ranking | It means *a correction*, no feed activity |
| Recommendation request | pending recommendation | The user-facing term |
| Sent to you | inbox / received | The delivered-recommendations list |
| For You → Titles / People | Discover, Explore | The two modes of one question |
| Match | compatibility / similarity score | Displayed as `87% Match` |
| Watchlist | save for later | On a watched title it means *watch again* |
| Details | What is this? | Retired copy, both on the title page tabs and under comparison posters |
| Search | Log / + | The centre tab's name since 2026-08-19 |
| bingd. Awards | achievements / badges | The branded surface name |
| Feed | timeline | Chronological, from people you follow |

TV language: a **season** is ranked and logged; a **series** is a grouping page. Never
imply a whole series can be ranked, and never show minutes for a season — episodes count
it.
