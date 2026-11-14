<!--
Keep every heading. Write "n/a" and the reason instead of deleting a section.
-->

## 1 Intent and acceptance criteria

<!-- What this changes and why. One checkbox per AC, each with its evidence (test name, file). -->

- [ ] **AC1**

## 2 Implementation summary

<!-- Delivery type (OTA-safe JS / native / migration), files touched, what is deliberately out of scope. -->

## 3 Tests and CI

<!-- Commands run and results: focused suites, full jest, typecheck, lint; db/race if supabase/ changed. -->

## 4 Review

<!-- Independent review status. -->

## 5 Preview and QA

<!-- Founder / device steps to verify. -->

## 6 Production

<!-- Release, OTA, migration or deploy steps, or "n/a" with the reason. -->

## 7 Decisions and follow-ups

<!-- Defaults taken, exceptions, open questions, follow-ups. -->

---

### UI changes (delete nothing; mark "n/a - no UI change" if none)

Required when the diff touches anything a person sees (`app/`, `src/ui/`, `src/features/**` views).

- [ ] Read [Design System v3](../docs/design/design-system.md) before changing UI, and reused the canonical component from its inventory (§17).
- [ ] Ran the [UI review checklist](../docs/design/ui-review-checklist.md) and noted any item answered "no" below.
- [ ] Checked 320pt width and fontScale 2 (stacking, truncation, wrapping).
- [ ] Checked accessibility (role, label, state) and the interaction states touched (pressed, disabled, loading, selected, error).
- [ ] Attached representative visual evidence: screenshots, or layout test output where jest is the evidence.
- [ ] Listed any justified exception here **and** in the guide (§ of `design-system.md`), or "none".

Exceptions:
