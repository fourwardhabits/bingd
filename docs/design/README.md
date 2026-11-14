# Bingd — Design

**Version:** Design System v3 (draft for founder review, 2026-11-14)
**Specification:** [`../product/PRD.md`](../product/PRD.md) §5

The PRD fixes the palette, the typefaces, and the voice. These documents turn that into something a
component can consume, a screen can be built from, and a pull request can be reviewed against.

## Index

| Document                                             | Status                                     | Covers                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`design-system.md`](./design-system.md)             | **Current — v3, draft for founder review** | The one design guide: principles, colour, type, space, every shared component, accessibility, the component inventory (§17), and the audit of v2 (Appendix A)     |
| [`ui-review-checklist.md`](./ui-review-checklist.md) | **Current**                                | The v3 rules as yes/no review items; linked from [`.github/pull_request_template.md`](../../.github/pull_request_template.md)                                     |
| [`reference-notes.md`](./reference-notes.md)         | Current                                    | What the design archives taught, and what was deliberately refused                                                                                                |
| [`screens.md`](./screens.md)                         | Historical (v2, 2026-08-15)                | Screen-by-screen purpose, anatomy and states. Still the record of why each screen is shaped as it is; **superseded by `design-system.md` v3 where they disagree** |
| [`ui-pass-plan.md`](./ui-pass-plan.md)               | Historical (2026-08)                       | The first UI pass's plan and audit; superseded by v3 where they disagree                                                                                          |
| [`ui-pass-handoff.md`](./ui-pass-handoff.md)         | Historical (2026-08)                       | The first UI pass's handoff notes; superseded by v3 where they disagree                                                                                           |

**Before changing any UI**, read `design-system.md` (start with §1 and §17), then run the
[UI review checklist](./ui-review-checklist.md). Agents get the same rules through
[`.agents/skills/expo-design-system/references/bingd-design-system-v3.md`](../../.agents/skills/expo-design-system/references/bingd-design-system-v3.md).

There is one design guide. Do not start a competing one; extend `design-system.md` and record the
decision there.

---

## The two findings

**Antique Amber and Muted Sage cannot carry text.** Measured at 2.1:1 and 2.4:1 on Paper (1.9:1 and 2.2:1
on Parchment), both fail WCAG at every size. They are fill colors only. This corrected
[`../architecture/client.md`](../architecture/client.md) §5, which had specified Amber for the ranking
reveal's ordinal — the single most important number in the product.

**Posters fought Parchment, and Parchment lost.** Artwork is treated as a printed object on a page:
hairline border, soft shadow, real margins. The base surface moved to Paper on 2026-08-15 and Parchment
became the warm accent. See `design-system.md` §1.2 and §12.

---

## Decided during design

| Question                                        | Decision                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tab structure — supersedes Provisional INF-4    | **Feed · Collection · + · Recommendations · Profile.** No Search tab; the **+** and title search are the same action |
| Does a comparison card show the opponent's rank | **No.** An ordinal is an anchor that invites agreement instead of a judgment                                         |

Both confirmed by the founder on 2026-08-13. Reasoning in [`screens.md`](./screens.md) §2 and §4. Later
founder decisions, including the twelve component rules of November 2026, are recorded in
`design-system.md` (§17.1 and the sections it cites).

What remains open is in `design-system.md` Appendix G and [`screens.md`](./screens.md) §17.

---

## References

[`references/`](./references/) holds the eighteen third-party screens actually cited in these documents,
resized. PRD §5 permits only these; the full archives stay in the git-ignored `design-references/` at the
repository root.

Reference discipline, from PRD §5: **Apple TV, Apple Wallet, and Open** inform visual language. **Beli,
Letterboxd, Spotify, Cash App, and Strava** inform interaction flows only — their visual language is
explicitly not a model.
