import { fireEvent, render, within } from '@testing-library/react-native';

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
