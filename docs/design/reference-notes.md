# Bingd — Reference Notes

**Date:** 2026-08-13
**Specification:** [`../product/PRD.md`](../product/PRD.md) §5 reference discipline

What was studied in the design archives, what Bingd takes from each app, and what it deliberately refuses. The bulk archives are git-ignored; the screens cited here are committed, resized, under [`references/`](./references/) as PRD §5 requires.

PRD §5 divides the references: **Apple TV, Apple Wallet, and Open** inform visual language. **Beli, Letterboxd, Spotify, Cash App, and Strava** inform interaction flows only, and their visual language is explicitly not a model.

---

## 1. Coverage

Eleven apps, 3,479 screens. The Mobbin export is a flat run of numbered PNGs with no flow labels, so each app was surveyed by generating labelled contact sheets and then opening individual screens at full resolution.

| App | Screens | Surveyed | Purpose |
|---|---|---|---|
| Beli | 470 | **Fully** | The closest analog. Interaction only |
| Letterboxd | 256 | Substantially | Movie-domain patterns. Interaction only |
| Apple Wallet | 133 | Partially | **Visual.** Saturated objects on a light ground |
| Apple TV | 136 | Partially | **Visual.** Poster-heavy structure |
| Open | 210 | Partially | **Visual.** Airy, ceremonial, typographic |
| Spotify | 588 | Not yet | Discovery shelves, Wrapped-style share cards |
| Strava | 709 | Not yet | Social feed, kudos, leaderboards |
| Cash App | 236 | Not yet | Username-as-identity, invite flows |
| Shop | 283 | Not yet | Product cards on a light ground |
| Tiimo | 232 | Not yet | Calm scheduling, accessibility-forward |
| Ultrahuman | 226 | Not yet | Data display — largely a counter-example |

The five unsurveyed apps are not blocking. Nothing in [`design-system.md`](./design-system.md) or [`screens.md`](./screens.md) depends on them, and they are most useful later: Spotify and Strava when the feed and share cards are built, Cash App when invitations are, Tiimo when accessibility is reviewed in depth.

**On a paid Mobbin account.** It would help, though less than expected. The free export gives the screens but not the flow labels, so 470 unlabelled images had to be surveyed to locate the eight that mattered. Paid access adds named flows and search, which turns that survey into a lookup. That is a real saving if the design work continues at this depth, and close to worthless if it does not — the archives already on disk cover v1.

---

## 2. Beli — the closest analog

The reference that matters most, and the one whose visual language must be ignored most carefully.

### Adopted

**The log flow is a sheet, not a screen** ([`beli-224`](./references/beli-224-bucket-prompt.jpg)). Context stays visible underneath, which is what makes logging feel like a small act rather than a form. The bucket prompt, the comparison, and the result all happen in one growing sheet.

**Three muted circles that fill on selection.** Unselected chips are outlined and desaturated; the chosen one fills and takes a checkmark. Selection is signalled three ways at once, which is why it survives an accessibility review.

**The comparison control triad** ([`beli-252`](./references/beli-252-comparison.jpg)) — Undo, "Too tough," Skip. These map exactly to `rank_back` and `rank_skip` in [`ranking.md`](../architecture/ranking.md), which is independent confirmation that the API has the right shape. "Too tough" in particular is a real affordance and not a nicety: without it, users force a preference they do not have and the ranking degrades.

**Tags rendered inline in the activity sentence** ([`beli-370`](./references/beli-370-activity-item.jpg)) — "Judy ranked SOOTHR LIC **with** Jesse Bendit, Allie, Eliot Frost." This is the right home for Bingd's watch tagging. A tag written into the sentence is part of the story; a tag in a metadata row is filing.

**Saves as social proof.** Beli shows "19 bookmarks" on an activity item. The Bingd equivalent — watchlist adds from an activity — is simultaneously a social signal and the product's core virality metric (PRD §28).

**A milestone tracker toward unlocking recommendations** ([`beli-30`](./references/beli-30-collection-progress.jpg)), used only where the target is finite. Beli also gates Recs and Playlists behind *contribution* rather than payment, which is a useful precedent for the capability model.

**The notification catalogue** ([`beli-446`](./references/beli-446-notification-settings.jpg)) — twelve toggles — as the scope baseline the founder asked for. Bingd's v1 set is a deliberate subset.

### Refused

**Numeric scores.** Beli displays a 0–10 everywhere: on activity items, on comparison cards, as Friend Score and Average Score. It is the single largest divergence, it is forbidden by PRD §10, and it is the constraint most likely to be violated by muscle memory since every comparable product does it.

**Streaks** ("125 week streak!"). Streaks manufacture obligation. Bingd's position is a collection you keep, not a habit you maintain.

**Red, yellow, green buckets.** Reasoning in [`design-system.md`](./design-system.md) §3.

**Asking what you dislike during onboarding** ([`beli-20`](./references/beli-20-onboarding-dislikes.jpg)). Pre-experience exclusions are guesses, and the same signal arrives honestly from the *Not for me* bucket.

**Invite rewards** ([`beli-110`](./references/beli-110-invite-perks.jpg)) — credits, locked recs, "you used up all your invites." Already a founder decision: track attribution, ship no rewards.

---

## 3. Letterboxd — the domain reference

### Adopted

**Poster grid density.** Three across with tight, even gutters ([`letterboxd-21`](./references/letterboxd-21-poster-grid.jpg)) is the right density for a collection. It reads as a shelf.

**The log sheet's anatomy** ([`letterboxd-33`](./references/letterboxd-33-log-sheet.jpg)): poster, date watched, note, add-to-lists, all in one sheet. Bingd's differs only in replacing stars with buckets.

**Information order on title detail** ([`letterboxd-34`](./references/letterboxd-34-title-detail.jpg)): the user's own state before catalog metadata.

### Refused

**Stars.** The premise of the product is that stars force self-calibration against an absolute scale (PRD §4).

**The dark visual language.** Letterboxd works because posters sit in a void. Bingd cannot borrow the solution without borrowing the background, which PRD §5 defers to Midnight after v1.

**Review-forward culture.** Letterboxd's center of gravity is written criticism. Bingd's notes are private by default and short by design.

---

## 4. Apple Wallet — the visual answer

The most useful of the three visual references, because it solves Bingd's hardest layout problem directly: arbitrary saturated rectangles on a light neutral ground ([`apple-wallet-1`](./references/apple-wallet-1-cards-on-light.jpg)). The four rules Wallet follows, and what they become for posters, are in [`design-system.md`](./design-system.md) §1 and §7.

Wallet also handles **numeric emphasis on light** ([`apple-wallet-33`](./references/apple-wallet-33-numeric-emphasis.jpg)) — a large figure, tightly set, with everything else neutral. Bingd's reveal takes the scale and the restraint. It does not take the progress ring, because a ring around an ordinal implies a scale with a maximum, and there is no such thing as being 60% of the way to a rank.

---

## 5. Apple TV — structure without the surface

Entirely dark and full-bleed, so most of its surface language is unusable here. Two structural patterns transfer ([`apple-tv-5`](./references/apple-tv-5-shelves.jpg)):

**Horizontal shelves with a clear header per row**, which is the right structure for recommendations and discovery. Vertical grids are for a collection you own; shelves are for material you are being offered.

**Metadata compressed to one line under artwork.** Apple TV never stacks three metadata lines under a poster, and neither should Bingd.

Its numbered Top 10 treatment is also worth noting as prior art for the share card, with the caveat that Apple's numerals sit over artwork and Bingd's cannot.

---

## 6. Open — the ceremonial register

Also dark, and it paywalls during onboarding, which Bingd must not do (PRD §20). What transfers is composition ([`open-3`](./references/open-3-single-question.jpg)):

**One question per screen**, enormous negative space, a single primary action, and a display-scale wordmark with wide letter-spacing. This is the model for Bingd's onboarding and for the reveal, and it is the closest any reference comes to the "airy" direction in PRD §5.

**The celebration moment** ([`open-45`](./references/open-45-celebration.jpg)) — a single large numeral, centered, with a short line of copy — is structurally what the ranking reveal should be. Bingd's version puts the numeral on an Amber panel for contrast reasons ([`design-system.md`](./design-system.md) §9), but the composition is the same.

---

## 7. What the references could not settle

Three things no reference answers, because no reference app has Bingd's combination of constraints.

**A ceremonial light theme.** Every app studied that treats a moment as ceremonial does it on a dark ground. Amber-on-Parchment is Bingd's own problem and the solution in [`design-system.md`](./design-system.md) §9 has no precedent in this set.

**An ordinal as the headline number.** Every reference displays either a score, a percentage, or a count. Nothing in the set displays a rank as its primary output, so the rank badge is designed from first principles.

**A collection that is explicitly two states.** Logged-but-unranked has no analog. Beli's items are always scored once logged, and Letterboxd's are always either rated or not. The Logged/Ranked split in [`screens.md`](./screens.md) §5 is unprecedented in this set and therefore the most likely to confuse users, which makes it the first thing worth watching in the alpha.
