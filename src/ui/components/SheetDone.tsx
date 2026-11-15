import { DismissFooter } from './DismissFooter';

/**
 * **The way out of a utility sheet**, now the standard `DismissFooter` (founder spec §2B,
 * 2026-11-13).
 *
 * Kept as its own export so the sheets that already draw it — Where to watch, a genre's
 * titles, an episode, a sitting's ranked titles, the cast and reviews sheets — changed in
 * one place: text-only Maroon `Close`, centred, in its own white bar, a 44pt target.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DEFAULT WORD IS CLOSE NOW
 *
 * These sheets are statements. Nothing in them is a decision, so the act at their foot is
 * dismissal, and the founder's rule is that a dismiss-only action reads *Close*. A *Done*
 * that genuinely completes something — finishing a log — is not this control and keeps
 * its own word and weight where it is.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS, AND WHY IT ADDS NO INSET
 *
 * Inside a `Sheet` it pays no bottom inset: the sheet does (`BottomInsetPaidContext`).
 * A sheet that wants it pinned below a scrolling list passes a `DismissFooter` as its
 * `footer` instead; the callers that still render this inline keep the placement they had.
 */
export function SheetDone({
  onPress,
  label = 'Close',
}: {
  onPress: () => void;
  /** Overridable for a sheet whose way out is worded differently. */
  label?: string;
}) {
  return <DismissFooter onPress={onPress} label={label} testID="sheet-done" />;
}
