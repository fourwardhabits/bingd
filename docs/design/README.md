# Bingd — Design

**Version:** v1 (public alpha)
**Specification:** [`../product/PRD.md`](../product/PRD.md) §5

The PRD fixes the palette, the typefaces, and the voice. These documents turn that into something a component can consume and a screen can be built from.

| Document | Covers |
|---|---|
| [`design-system.md`](./design-system.md) | Color, type, space, components, motion, accessibility |
| [`screens.md`](./screens.md) | Every v1 screen: purpose, anatomy, states |
| [`reference-notes.md`](./reference-notes.md) | What the design archives taught, and what was deliberately refused |

Read `design-system.md` §1 first. It contains the two findings that changed the design, and one of them corrected an instruction already written into the architecture.

---

## The two findings

**Antique Amber and Muted Sage cannot carry text on Parchment.** Measured at 1.9:1 and 2.2:1 against the Parchment background, both fail WCAG at every size. They are fill colors only. This corrected [`../architecture/client.md`](../architecture/client.md) §5, which had specified Amber for the ranking reveal's ordinal — the single most important number in the product.

**Posters fight Parchment, and Apple Wallet already solved it.** Artwork is treated as a printed object on a page: hairline border, soft shadow, real margins, and no other color on the surface. See `design-system.md` §1 and §7.

---

## Open, needing a founder decision

| Question | Recommendation |
|---|---|
| Tab structure — supersedes Provisional INF-4 | Feed · Collection · + · Recommendations · Profile |
| Does the comparison card show the opponent's rank | Hide it |

Both are in [`screens.md`](./screens.md) §17 with the reasoning.

---

## References

[`references/`](./references/) holds the eighteen third-party screens actually cited in these documents, resized. PRD §5 permits only these; the full archives stay in the git-ignored `design-references/` at the repository root.

Reference discipline, from PRD §5: **Apple TV, Apple Wallet, and Open** inform visual language. **Beli, Letterboxd, Spotify, Cash App, and Strava** inform interaction flows only — their visual language is explicitly not a model.
