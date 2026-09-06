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

  /** The same, for a node that may be the propless root the walk below ends on. */
  const flatLoose = (node: { props?: { style?: unknown } }) =>
    StyleSheet.flatten(node.props?.style as never) as Record<string, unknown> | undefined;

  const emojiIn = (view: View, glyph: string) =>
    within(actionSlot(view)).getByText(glyph, { includeHiddenElements: true });

  /**
   * The height a `Text` actually occupies, which is its `lineHeight` when one is set and
   * the font's own metrics when it is not.
   *
   * With no line box there is nothing to overflow, so `0` is the honest answer for
   * "how much does this demand of its container" — the glyph is laid out on its natural
   * ascent and descent, and a container sized past that has room by construction.
   */
  const lineBoxOf = (style: Record<string, number | string>) => Number(style.lineHeight ?? 0);

  it('is the same fixed box whether it holds a heart or an emoji', async () => {
    const empty = flat(actionSlot(await draw(), false));
    const reacted = flat(actionSlot(await draw({ active: true, mineGlyph: '😂', count: 1 })));

    // The *width* is what stops the row shifting when a 20pt heart is replaced by a
    // glyph of some other width. It is still `icon.sm`, and still the reason this is a
    // fixed box at all.
    expect(empty.width).toBe(theme.layout.icon.sm);
    // The *height* is taller than the width since 2026-09-06, and that is the fix: a
    // container has to be larger than what it holds. It was `icon.sm` too, so the slot
    // was 20pt around a 24pt line box and every pixel of the difference was overflow.
    expect(Number(empty.height)).toBeGreaterThan(Number(empty.width));

    // The whole of "the row must not shift when somebody reacts", in one assertion.
    expect(reacted.width).toBe(empty.width);
    expect(reacted.height).toBe(empty.height);
  });

  /**
   * The invariant the last two attempts both broke, stated so a third cannot.
   *
   * `ReactionPill` has drawn six colour emoji correctly since it shipped, and its shape
   * is a 28pt line box inside a 36pt container. Both boxes here were the other way round
   * — 20 holding 24, and 16 holding 17 — and React Native on Android grows a line box by
   * expanding the *ascent*, so the excess lands above the glyph and pushes it down into
   * whatever is willing to clip it.
   */
  it('never gives the glyph a line box larger than the container holding it', async () => {
    const view = await draw({ active: true, mineGlyph: '🔥', glyphs: ['🔥', '😮'], count: 4 });

    const slot = flat(actionSlot(view));
    const slotGlyph = flat(emojiIn(view, '🔥'));
    expect(lineBoxOf(slotGlyph)).toBeLessThanOrEqual(Number(slot.height));

    const box = flat(glyphsIn(cluster(view), '😮')[0]!.parent as never);
    const clusterGlyph = flat(glyphsIn(cluster(view), '😮')[0]!);
    expect(lineBoxOf(clusterGlyph)).toBeLessThanOrEqual(Number(box.height));
  });

  it('puts no clipping ancestor between the glyph and the row', async () => {
    // A container with room is only room if nothing above it hides what spills. Walked
    // rather than asserted on one node, because the ancestor that clips is exactly the
    // one nobody thought about.
    const view = await draw({ active: true, mineGlyph: '😭', glyphs: ['😭'], count: 1 });

    type Node = { parent?: Node | null; props?: { style?: unknown } };
    let node: Node | null | undefined = emojiIn(view, '😭') as unknown as Node;
    while (node) {
      // The root container has no props of its own; everything below it does.
      expect(flatLoose(node)?.overflow).not.toBe('hidden');
      node = node.parent;
    }
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
   * **No `lineHeight` at all**, which is the 2026-09-06 fix and not an omission.
   *
   * `Text` merges `caption` first and brings a 16pt line box sized for Latin text, so a
   * 17pt colour emoji arrives in a box shorter than it needs. #103 answered that by
   * overriding the box *upward* to 24, and the founder's device showed the glyph still
   * clipped and now sitting below the three Ionicons beside it — because React Native on
   * Android grows a line box by expanding the ascent, so the extra space lands above the
   * glyph and pushes it down.
   *
   * Cancelling the token outright leaves the glyph on the font's own metrics: the
   * `Text`'s measured box and the glyph become the same thing, so the slot's
   * `justifyContent` centres what the reader actually sees. `includeFontPadding` is
   * Android's asymmetric padding and is the other thing that tilts a glyph off centre.
   */
  it('carries no line box, so nothing is added above the glyph', async () => {
    const style = flat(emojiIn(await draw({ active: true, mineGlyph: '🔥', count: 1 }), '🔥'));

    expect(style.lineHeight).toBeUndefined();
    expect(style.includeFontPadding).toBe(false);
    expect(style.textAlignVertical).toBe('center');
  });

  it('keeps the 44pt tap target, and keeps it the same in both states', async () => {
    const empty = actionSlot(await draw(), false);
    const reacted = actionSlot(await draw({ active: true, mineGlyph: '👏', count: 1 }));

    // Measured from the slot's own height rather than from `icon.sm`, which is only its
    // width now. Reading the wrong one is how the target quietly grows past 44.
    const height = Number(flat(empty).height);
    for (const node of [empty, reacted]) {
      expect(height + 2 * (node.props.hitSlop as number)).toBe(theme.layout.minTapTarget);
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

/**
 * **The summary cluster's geometry** (founder, physical Android, 2026-09-05).
 *
 * The action slot above was given a fixed square, an overridden line box and
 * `includeFontPadding: false` on 2026-09-04, and the founder confirms it now looks right.
 * The cluster beside it was left as a bare `caption` `Text` — so on Android the glyphs
 * still carried the platform's asymmetric font padding and still took the token's line
 * box, which is sized for a cap height rather than for an emoji's ascent.
 *
 * Three symptoms, one cause: a cropped glyph, a glyph sitting off the vertical centre,
 * and the emoji and the count not looking level with each other.
 *
 * **The size is deliberately not part of the fix.** Every assertion here holds the
 * cluster at `caption`'s `fontSize`, because the founder's judgement is that it reads
 * correctly small and what was wrong was how it was drawn, not how big it was. A renderer
 * cannot prove a glyph is uncropped on a device; what it can prove is that the three
 * properties which crop and tilt one are set, and that they are set the same way in both
 * places an emoji is drawn.
 */
describe('the summary cluster', () => {
  const flat = (node: { props: { style?: unknown } }) =>
    StyleSheet.flatten(node.props.style as never) as Record<string, number | string>;

  const REPRESENTATIVE = ['❤️', '😂', '🔥', '👏', '😮'];

  const clusterGlyph = async (glyph: string) => {
    const view = await draw({
      active: false,
      glyphs: [glyph],
      count: 4,
    });
    return flat(glyphsIn(cluster(view), glyph)[0]!);
  };

  it('carries no line box either, at the size it has always been', async () => {
    // The same fix as the slot, at the cluster's size. The size is what the founder
    // confirmed is right; the line box is what was wrong.
    const style = await clusterGlyph('🔥');

    expect(style.fontSize).toBe(theme.typography.caption.fontSize);
    expect(style.lineHeight).toBeUndefined();
  });

  it('drops the padding that would tilt it off centre, and centres it on both axes', async () => {
    const style = await clusterGlyph('😮');

    expect(style.includeFontPadding).toBe(false);
    expect(style.textAlign).toBe('center');
    expect(style.textAlignVertical).toBe('center');
  });

  it('treats every representative glyph identically, with no per-emoji exception', async () => {
    // The same no-special-casing rule the action slot is held to. A per-emoji table is
    // the thing that goes stale the first time the six change.
    const styles: Record<string, number | string>[] = [];
    for (const glyph of REPRESENTATIVE) styles.push(await clusterGlyph(glyph));

    for (const style of styles) expect(style).toEqual(styles[0]);
  });

  it('centres the glyph in a box the tap target is still measured from', async () => {
    // Height only, and exactly caption's line height: `slop` derives the 44pt target from
    // that figure, so a box of any other height would silently move the target. Width is
    // left intrinsic because a fixed one would change the overlap and shift the rhythm.
    const view = await draw({ active: false, glyphs: ['❤️'], count: 2 });
    const box = glyphsIn(cluster(view), '❤️')[0]!.parent;
    const style = flat(box as never);

    expect(style.height).toBe(theme.typography.caption.lineHeight);
    expect(style.alignItems).toBe('center');
    expect(style.justifyContent).toBe('center');
    expect(style.width).toBeUndefined();
  });

  it('measures the count the same way it measures the glyphs', async () => {
    // The founder's third symptom is a property of the pair rather than of either one:
    // `alignItems: 'center'` centres two boxes against each other, and while one carried
    // Android's font padding and the other did not, they were centred on different things.
    const view = await draw({ active: false, glyphs: ['❤️'], count: 12 });
    const count = within(cluster(view)).getByText('12', { includeHiddenElements: true });

    expect(flat(count).includeFontPadding).toBe(false);
  });

  it('is unchanged by a two-digit count', async () => {
    const view = await draw({ active: false, glyphs: ['❤️', '😂'], count: 12 });

    expect(within(cluster(view)).getByText('12', { includeHiddenElements: true })).toBeTruthy();
    expect(flat(glyphsIn(cluster(view), '😂')[0]!).fontSize).toBe(
      theme.typography.caption.fontSize,
    );
  });

  it('draws the glyph the same whether the viewer has reacted or not', async () => {
    // Selected changes the count's tone and nothing about the glyph geometry.
    const off = await clusterGlyph('😂');
    const on = flat(
      glyphsIn(
        cluster(await draw({ active: true, mineGlyph: '❤️', glyphs: ['❤️', '😂'], count: 4 })),
        '😂',
      )[0]!,
    );

    expect(on).toEqual(off);
  });

  it('draws an emoji the same way in the slot and in the cluster, bar the size', async () => {
    // One treatment, two places. The sizes differ on purpose — the slot matches the icons
    // beside it and the cluster is a small summary — and everything else must not.
    const view = await draw({ active: true, mineGlyph: '❤️', glyphs: ['❤️', '🔥'], count: 5 });
    const slot = flat(within(actionSlot(view)).getByText('❤️', { includeHiddenElements: true }));
    const summary = flat(glyphsIn(cluster(view), '🔥')[0]!);

    for (const key of [
      'includeFontPadding',
      'textAlign',
      'textAlignVertical',
      'lineHeight',
    ] as const) {
      expect(summary[key]).toEqual(slot[key]);
    }
    // Two sizes on purpose — the slot matches the icons beside it and the cluster is a
    // small summary — and one rule for everything else.
    expect(Number(summary.fontSize)).toBeLessThan(Number(slot.fontSize));
  });
});
