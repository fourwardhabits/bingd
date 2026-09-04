import { fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { ReactionControl } from './ReactionControl';

/**
 * **One reaction, drawn once** (founder, 2026-08-28 §6).
 *
 * The founder read the old control off the device and named what was wrong with it in
 * one line: `[filled heart] [❤️] 1` is a single reaction represented twice. The filled
 * heart meant "I reacted with love" and the glyph beside it meant the same thing again,
 * counted.
 *
 * So the leftmost slot is now the reader's own emoji when they have one, and the cluster
 * beside it no longer repeats that kind. Everything else about the control is unchanged,
 * and most of this file is spent proving the "unchanged" half — because the way this
 * change goes wrong is not a glyph in the wrong place, it is a count that quietly starts
 * excluding the reader, or a gesture that stops removing a reaction.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUERIES LOOK LIKE THIS
 *
 * The glyph cluster is hidden from the accessibility tree on purpose — its reader
 * already has the count in the control's own label — so it takes `includeHiddenElements`
 * to see. The *action slot's* glyph is not hidden, which is the distinction several
 * assertions below turn on: scoping with `within` separates "what I chose" from "what
 * everybody chose" without either slot needing a testID.
 */

const LABEL_MINE = 'You reacted to this. Tap to remove, long press to change.';
const LABEL_NONE = 'React to this. Long press for more reactions.';

type Props = Parameters<typeof ReactionControl>[0];

const draw = (props: Partial<Props> = {}) =>
  render(
    <ReactionControl
      label={props.active ? LABEL_MINE : LABEL_NONE}
      active={false}
      glyphs={[]}
      count={0}
      onToggle={jest.fn()}
      onOpenPicker={jest.fn()}
      onOpenDetail={jest.fn()}
      {...props}
    />,
  );

type View = Awaited<ReturnType<typeof draw>>;

const actionSlot = (view: View, active = true) =>
  view.getByLabelText(active ? LABEL_MINE : LABEL_NONE);

const cluster = (view: View) => view.getByLabelText(/See who reacted/);

const glyphsIn = (node: ReturnType<typeof actionSlot>, glyph: string) =>
  within(node).queryAllByText(glyph, { includeHiddenElements: true });

// ---------------------------------------------------------------------------

describe('a reader who has not reacted', () => {
  it('keeps the empty heart as the quick-reaction affordance', async () => {
    const view = await draw({ glyphs: ['❤️', '😂'], count: 4 });

    // No emoji in the action slot: love is what a plain tap *sets*, so drawing it there
    // would claim a reaction the reader has not made.
    expect(glyphsIn(actionSlot(view, false), '❤️')).toHaveLength(0);
  });

  it('shows every kind present, having subtracted nothing', async () => {
    const view = await draw({ glyphs: ['❤️', '😂'], count: 4 });

    expect(glyphsIn(cluster(view), '❤️')).toHaveLength(1);
    expect(glyphsIn(cluster(view), '😂')).toHaveLength(1);
    expect(view.getByText('4')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('a reader who has reacted', () => {
  it('draws their heart once, in the action slot, and not again beside it', async () => {
    // The founder's example, exactly: `[filled heart] [❤️] 1` became `❤️ 1`.
    const view = await draw({ active: true, mineGlyph: '❤️', glyphs: ['❤️'], count: 1 });

    expect(view.getAllByText('❤️', { includeHiddenElements: true })).toHaveLength(1);
    expect(glyphsIn(actionSlot(view), '❤️')).toHaveLength(1);
    expect(view.getByText('1')).toBeTruthy();
  });

  it('puts a laugh in the slot when a laugh is what they chose', async () => {
    const view = await draw({
      active: true,
      mineGlyph: '😂',
      glyphs: ['😂', '❤️', '😮'],
      count: 3,
    });

    expect(glyphsIn(actionSlot(view), '😂')).toHaveLength(1);
    // …and the other two meanings are still on the row, unchanged.
    expect(glyphsIn(cluster(view), '❤️')).toHaveLength(1);
    expect(glyphsIn(cluster(view), '😮')).toHaveLength(1);
  });

  it('excludes only their own kind from the cluster', async () => {
    const view = await draw({
      active: true,
      mineGlyph: '❤️',
      glyphs: ['❤️', '😂', '😮'],
      count: 3,
    });

    expect(glyphsIn(cluster(view), '❤️')).toHaveLength(0);
    expect(glyphsIn(cluster(view), '😂')).toHaveLength(1);
    expect(glyphsIn(cluster(view), '😮')).toHaveLength(1);
  });

  /**
   * The one that must not drift. Hiding a duplicate glyph is a de-duplication of the
   * alphabet, never of the tally: the reader is one of the three people who reacted and
   * the row has to go on saying so.
   */
  it('counts the reader in the total, which is every reaction from everyone', async () => {
    const view = await draw({ active: true, mineGlyph: '❤️', glyphs: ['❤️', '😂'], count: 3 });

    expect(view.getByText('3')).toBeTruthy();
    expect(view.getByLabelText('3 reactions. See who reacted.')).toBeTruthy();
  });

  it('adds no label, no reaction name and no second pill', async () => {
    // Founder §6, visual restraint: the compact inline grammar and nothing else.
    const view = await draw({ active: true, mineGlyph: '❤️', glyphs: ['❤️'], count: 1 });

    expect(view.queryByText(/^Reacted/)).toBeNull();
    expect(view.queryByText('Love')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the gestures, which are the established ones', () => {
  it('removes the reaction on a tap of the chosen emoji', async () => {
    const onToggle = jest.fn();
    const view = await draw({ active: true, mineGlyph: '😂', glyphs: ['😂'], count: 1, onToggle });

    await fireEvent.press(actionSlot(view));
    expect(onToggle).toHaveBeenCalled();
  });

  it('opens the same picker on a long press of it', async () => {
    const onOpenPicker = jest.fn();
    const view = await draw({
      active: true,
      mineGlyph: '😂',
      glyphs: ['😂'],
      count: 1,
      onOpenPicker,
    });

    await fireEvent(actionSlot(view), 'longPress');
    expect(onOpenPicker).toHaveBeenCalled();
  });

  it('still opens the reactor list from the cluster', async () => {
    // It is the *glyph* that is hidden from the row, never a person: the breakdown
    // behind the count still names everybody, the reader included.
    const onOpenDetail = jest.fn();
    const view = await draw({
      active: true,
      mineGlyph: '❤️',
      glyphs: ['❤️', '😂'],
      count: 4,
      onOpenDetail,
    });

    await fireEvent.press(cluster(view));
    expect(onOpenDetail).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('a caller that passes no glyph', () => {
  it('keeps the filled heart for a surface that knows only whether', async () => {
    // `mineGlyph` is optional, so a caller with `active` alone — the shape this
    // component had before §6 — is still a working control rather than an empty slot.
    const view = await draw({ active: true, glyphs: ['❤️'], count: 1 });

    expect(actionSlot(view)).toBeTruthy();
    expect(glyphsIn(cluster(view), '❤️')).toHaveLength(1);
  });

  it('shows the whole summary while a reaction is being cleared', async () => {
    /**
     * `active` false with a glyph still held is the half-beat between the tap and the
     * refetch. Subtracting the kind there would drop a meaning *other people* used from
     * a row whose reader has merely stopped using it.
     */
    const view = await draw({ active: false, mineGlyph: '❤️', glyphs: ['❤️', '😂'], count: 3 });

    expect(glyphsIn(cluster(view), '❤️')).toHaveLength(1);
    expect(glyphsIn(cluster(view), '😂')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
/**
 * The action slot's geometry (founder, 2026-09-04).
 *
 * The founder read the row off the device: reacting made the leftmost control
 * "noticeably smaller and lighter" than the comment, recommend and bookmark icons beside
 * it. It was — the heart was an Ionicon at `icon.sm` and the emoji replacing it was
 * `caption`, 12 against 20, because each had been given the size that suited it in
 * isolation.
 *
 * These assertions are about numbers rather than appearance, which is the honest limit of
 * what a renderer test can say: they can prove the two states occupy one slot and that
 * every emoji is treated identically, and they cannot prove the result looks level. The
 * one judged value, `EMOJI_SIZE`, is pinned to a band rather than an exact figure so that
 * tuning it on a device is not a test edit.
 */
describe('the action slot', () => {
  /** Every representative glyph the brief names, spanning the bounds that differ most. */
  const REPRESENTATIVE = ['❤️', '😂', '🔥', '👏', '😮'];

  const flat = (node: { props: { style?: unknown } }) =>
    StyleSheet.flatten(node.props.style as never) as Record<string, number | string>;

  const emojiIn = (view: View, glyph: string) =>
    within(actionSlot(view)).getByText(glyph, { includeHiddenElements: true });

  it('is the same fixed square whether it holds a heart or an emoji', async () => {
    const empty = flat(actionSlot(await draw(), false));
    const reacted = flat(actionSlot(await draw({ active: true, mineGlyph: '😂', count: 1 })));

    expect(empty.width).toBe(theme.layout.icon.sm);
    expect(empty.height).toBe(theme.layout.icon.sm);
    // The whole of "the row must not shift when somebody reacts", in one assertion.
    expect(reacted.width).toBe(empty.width);
    expect(reacted.height).toBe(empty.height);
  });

  it('centres whatever is in it, on both axes', async () => {
    const style = flat(actionSlot(await draw({ active: true, mineGlyph: '🔥', count: 1 })));

    expect(style.alignItems).toBe('center');
    expect(style.justifyContent).toBe('center');
  });

  it('draws the emoji at the weight of the icons beside it, not at caption', async () => {
    const style = flat(emojiIn(await draw({ active: true, mineGlyph: '❤️', count: 1 }), '❤️'));

    expect(style.fontSize).toBeGreaterThan(theme.typography.caption.fontSize);
    /**
     * A band, not a figure. The lower bound is the regression this fixes — anything near
     * caption is the complaint again. The upper bound is `icon.sm`, because a colour
     * emoji fills its em box where a stroked icon does not, so matching the icon's
     * nominal size overshoots. Tuning inside the band is a device decision.
     */
    expect(style.fontSize).toBeGreaterThanOrEqual(16);
    expect(style.fontSize).toBeLessThanOrEqual(theme.layout.icon.sm);
  });

  /**
   * The no-special-casing rule, stated as a test. A per-emoji size table is the thing
   * that goes stale the first time the six change, so there must be exactly one
   * treatment — and the fixed square above is what absorbs the differing glyph bounds.
   */
  it('treats every representative emoji identically', async () => {
    /**
     * Sequential, never `Promise.all`. Concurrent `render`s overlap their `act()` scopes
     * and the damage lands on the *next* test in the file as a confusing "unable to
     * find", not here — the same trap the awaited-`fireEvent` rule exists for.
     */
    const styles: Record<string, number | string>[] = [];
    for (const glyph of REPRESENTATIVE) {
      styles.push(flat(emojiIn(await draw({ active: true, mineGlyph: glyph, count: 1 }), glyph)));
    }

    for (const style of styles) {
      expect(style).toEqual(styles[0]);
    }
  });

  /**
   * No `lineHeight`, and it is deliberate rather than forgotten: the slot centres the
   * text box, so leaving the box at its natural height is what cannot clip a tall glyph
   * and what keeps six different emoji on one optical centre. `includeFontPadding` is
   * Android's asymmetric ascent/descent padding, which would tilt that centre.
   */
  it('gives the glyph a line box with room to spare, so a tall emoji cannot be clipped', async () => {
    const style = flat(emojiIn(await draw({ active: true, mineGlyph: '🔥', count: 1 }), '🔥'));

    /**
     * The regression this guards is silent and platform-specific: `Text` merges the
     * `caption` token first, which brings `lineHeight: 16`, and a line box shorter than
     * the glyph crops it on Android while looking perfect on iOS. So the assertion is
     * that the box was overridden *upward*, not merely that it exists.
     */
    expect(style.lineHeight).toBeGreaterThan(theme.typography.caption.lineHeight);
    expect(Number(style.lineHeight)).toBeGreaterThanOrEqual(Number(style.fontSize) * 1.25);
    // Taller than the slot is correct: the slot centres and does not clip.
    expect(style.lineHeight).toBeGreaterThanOrEqual(theme.layout.icon.sm);
    expect(style.includeFontPadding).toBe(false);
  });

  it('keeps the 44pt tap target, and keeps it the same in both states', async () => {
    const slot = theme.layout.icon.sm;
    const empty = actionSlot(await draw(), false);
    const reacted = actionSlot(await draw({ active: true, mineGlyph: '👏', count: 1 }));

    for (const node of [empty, reacted]) {
      expect(slot + 2 * (node.props.hitSlop as number)).toBe(theme.layout.minTapTarget);
    }
  });

  /**
   * The cluster is not the action slot and must not follow it. It summarises what other
   * people chose, sits against a caption-sized count, and is meant to read small — the
   * founder's complaint was about the control at the end of the row, and matching the
   * cluster to it would be the redesign this is not.
   */
  it('leaves the summary cluster at caption, and its own tap target at 44', async () => {
    const view = await draw({ active: true, mineGlyph: '❤️', glyphs: ['❤️', '😂'], count: 4 });
    const other = glyphsIn(cluster(view), '😂')[0];

    expect(flat(other!).fontSize).toBe(theme.typography.caption.fontSize);
    expect(
      theme.typography.caption.lineHeight + 2 * (cluster(view).props.hitSlop as number),
    ).toBe(theme.layout.minTapTarget);
  });
});
