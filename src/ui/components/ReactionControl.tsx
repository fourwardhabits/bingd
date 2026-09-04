import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type ReactionControlProps = {
  /**
   * The heart's whole announcement, built by the caller so each surface keeps its
   * sentence — "React to Ada's comment…", "You reacted to Dune (2021)…". The
   * ownership lives here as words because the visible control carries it only as a
   * colour.
   */
  label: string;
  /** Fills the heart. True exactly when the viewer has an active reaction. */
  active: boolean;
  /**
   * The viewer's own reaction as a glyph, or null.
   *
   * When it is set it **becomes the action slot** — the leftmost control is the emoji
   * they chose rather than a heart — and it is removed from the cluster beside it. See
   * the component header for why. `active` still says *whether*; this says *which*, and
   * a caller that has only the first gets the heart in both states as before.
   */
  mineGlyph?: string | null;
  /**
   * Distinct glyphs present, most common first — every kind, the viewer's included.
   *
   * Callers pass the whole summary and this component drops the viewer's own; doing it
   * the other way round would mean two surfaces each deciding what to subtract.
   */
  glyphs: string[];
  count: number;
  /** A plain tap: the default reaction on or off (the callers own the exact rule). */
  onToggle: () => void;
  /** A long press: the six-reaction picker. The caller owns the pill's placement. */
  onOpenPicker?: () => void;
  /**
   * Opens the reactor list from the cluster — tap or long press, because a target
   * this small should not demand the rarer gesture. Absent, the cluster is
   * decorative and hidden from screen readers, whose reader already has the count
   * in the heart's label.
   */
  onOpenDetail?: () => void;
};

/**
 * One reaction control, wherever a reaction is attached (founder, 2026-08-27 §17).
 *
 * This is the COMMENT grammar, promoted: the founder tested both surfaces on the
 * device and preferred the comment's — heart first, then the glyph cluster and the
 * total inline beside it, one compact object — over the feed's separate summary band.
 * Both surfaces render this now, so the two cannot drift again.
 *
 * ---------------------------------------------------------------------------
 * THE ACTION SLOT IS THE READER'S OWN REACTION (founder, 2026-08-28 §6)
 *
 * This component used to keep a heart in the action slot in both states, on the
 * argument that the cluster already showed what the reader chose. The founder read the
 * result off the device and it says the opposite: a filled heart with a ❤️ immediately
 * beside it is one reaction drawn twice, and the duplicate is the loudest thing in the
 * row.
 *
 * So, having reacted, the leftmost slot *is* their emoji and the cluster no longer
 * repeats that kind:
 *
 *     no reaction     ♡   ❤️ 😂   4
 *     reacted ❤️      ❤️   😂     4
 *     reacted 😂      😂   ❤️     4
 *     only reactor    ❤️          1
 *
 * Three things this must not quietly change, and each is a test below:
 *
 * 1. **The count is every reaction, the viewer's included.** Hiding a glyph is a
 *    de-duplication of the alphabet, not of the tally. The number is passed in whole
 *    and this file never arithmetics on it.
 * 2. **The gestures are the established ones.** Tap the action slot to set or clear;
 *    hold it for the six-reaction picker. That is what the heart already did, so a
 *    reader who has reacted taps their own emoji to take it back — which is also the
 *    rule `feed.tsx` and `CommentThread` state in words on their toggles.
 * 3. **The cluster still opens the reactor list**, unchanged, and still reports
 *    everybody — the viewer included. It is the *glyph* that is hidden there, never a
 *    person.
 *
 * A reader with no reaction still gets the outline heart: it is the quick-react
 * affordance, and love is the default the plain tap sets.
 *
 * The count is absent at zero rather than showing "0" — a nought beside every row is
 * a scoreboard nobody asked for.
 *
 * ---------------------------------------------------------------------------
 * THE ACTION SLOT IS A FIXED SQUARE, AND BOTH STATES FILL IT
 *
 * The slot draws two very different things — an Ionicon and a colour emoji — and until
 * 2026-09-04 it drew them at two different sizes, because each had simply been given the
 * size that suited it in isolation: `icon.sm` (20) for the heart, `caption` (12) for the
 * emoji. Every neighbour in the actions strip is an Ionicon at `icon.sm`, so reacting
 * dropped the leftmost control to 60% of its neighbours and the row visibly lost weight
 * at the one end the reader had just touched. The founder reported it as the row looking
 * uneven.
 *
 * The slot is therefore a square of `icon.sm` with both states centred in it, which
 * fixes the two halves of the problem separately:
 *
 *   - **the square** ends the horizontal shift. The two states no longer measure
 *     themselves; the slot is 20 wide whichever is in it, so nothing to the right of it
 *     moves when somebody reacts, and the tap target is the same 44pt in both states
 *     rather than 48 in one and 44 in the other.
 *   - **`EMOJI_SIZE`** ends the weight mismatch. See its own note for why it is not
 *     simply `icon.sm`.
 *
 * The glyph *cluster* is deliberately left at `caption`. It is a summary of what other
 * people chose, sits beside a caption-sized count, and is meant to read as small — the
 * complaint was about the action slot, and matching the cluster to it would be the
 * redesign this is not.
 *
 * What this deliberately does not own: the picker pill. Its placement is the
 * caller's — both surfaces draw it inside the row, directly above this control —
 * because a pill positioned from in here would sit inside the actions strip and
 * grow it, moving the neighbouring controls under an open picker.
 */
export function ReactionControl({
  label,
  active,
  mineGlyph = null,
  glyphs,
  count,
  onToggle,
  onOpenPicker,
  onOpenDetail,
}: ReactionControlProps) {
  /**
   * The one line that removes the duplicate. Keyed on the glyph rather than the kind
   * because the glyph is all this component is given, and the six are distinct.
   *
   * Guarded on `active` as well, so a caller mid-write — the glyph still held while the
   * reaction has just been cleared — shows the whole summary rather than silently
   * dropping a kind other people used.
   */
  const mine = active ? mineGlyph : null;
  const summary = mine ? glyphs.filter((glyph) => glyph !== mine) : glyphs;

  return (
    <View style={styles.control}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        // Only where a long press does something — a surface wired without the
        // picker (the profile's compact rows) must not announce an action it
        // cannot perform.
        accessibilityHint={onOpenPicker ? 'Long press to choose a different reaction' : undefined}
        onPress={onToggle}
        onLongPress={onOpenPicker}
        hitSlop={slotSlop}
        style={({ pressed }) => [styles.slot, pressed && styles.pressed]}
      >
        {mine ? (
          // No pill, no label, no name beside it: the emoji alone, in the slot the
          // heart was in, so the row's width and rhythm are unchanged (founder §6,
          // visual restraint). `allowFontScaling={false}` matches the cluster —
          // emoji do not gain legibility from Dynamic Type, they just reflow the row.
          <Text variant="caption" allowFontScaling={false} style={styles.emoji}>
            {mine}
          </Text>
        ) : (
          <Ionicons
            name={active ? 'heart' : 'heart-outline'}
            size={theme.layout.icon.sm}
            color={active ? theme.semantic.action : theme.text.tertiary}
          />
        )}
      </Pressable>

      {count > 0 ? (
        onOpenDetail ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${count} ${count === 1 ? 'reaction' : 'reactions'}. See who reacted.`}
            onPress={onOpenDetail}
            onLongPress={onOpenDetail}
            hitSlop={slop}
            style={({ pressed }) => [styles.cluster, pressed && styles.pressed]}
          >
            <Glyphs glyphs={summary} />
            <Text variant="caption" tone={active ? 'action' : 'tertiary'}>
              {count}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.cluster} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Glyphs glyphs={summary} />
            <Text variant="caption" tone={active ? 'action' : 'tertiary'}>
              {count}
            </Text>
          </View>
        )
      ) : null}
    </View>
  );
}

/** Overlapped, so three glyphs read as one object and cost the width of about two. */
function Glyphs({ glyphs }: { glyphs: string[] }) {
  if (!glyphs.length) return null;
  return (
    <View style={styles.glyphs} accessibilityElementsHidden>
      {glyphs.slice(0, 3).map((glyph, index) => (
        <View key={glyph} style={index > 0 ? styles.glyphOverlap : undefined}>
          <Text variant="caption" allowFontScaling={false}>
            {glyph}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The action slot, square, and the same size as every other icon in an actions strip. */
const SLOT = theme.layout.icon.sm;

/**
 * The emoji's size in that slot, and it is deliberately not `SLOT`.
 *
 * An Ionicon at size 20 is a stroked outline that leaves air inside its em box. A colour
 * emoji fills nearly all of its own, and is solid rather than drawn in one weight — so
 * at equal nominal size the emoji reads *heavier* than the icon beside it, not equal.
 * Set a little under, it reads level.
 *
 * One number for all six kinds. Their glyph bounds differ — 🔥 is tall and narrow, 👏
 * is wide, ❤️ carries a variation selector — and none of that is corrected for here,
 * because a per-emoji table is a thing that gets out of date the first time the set
 * changes. The square below is what absorbs the difference: whatever the glyph's
 * intrinsic box, it is centred in the same 20pt slot.
 */
const EMOJI_SIZE = 17;

/**
 * The emoji's line box, and it is **taller than the slot on purpose**.
 *
 * `Text` merges the `caption` token first, which brings `lineHeight: 16` — shorter than a
 * 17pt colour emoji needs, and a line box shorter than the glyph is exactly how Android
 * crops one. Overriding it is therefore not optional, and the safe direction is up: the
 * slot centres its child and does not clip, so a box with room to spare costs nothing and
 * a tight one costs the top of 🔥.
 *
 * 1.3em is the conventional headroom for colour emoji, which have taller ascents than the
 * Latin text these tokens were measured on.
 */
const EMOJI_LINE = Math.ceil(EMOJI_SIZE * 1.3);

/**
 * The slop that carries the 44pt floor for a caption-height control — the comment
 * strip's rule: the tap target must be 44pt, not the ink.
 *
 * Two of them, because the two controls are two heights. The cluster is caption-sized
 * text; the action slot is `SLOT`. Sharing one figure between them was survivable while
 * the slot's height depended on which state it was in, and is not now that it is fixed —
 * the cluster would silently drop to 40pt.
 */
const slop = (theme.layout.minTapTarget - theme.typography.caption.lineHeight) / 2;
const slotSlop = (theme.layout.minTapTarget - SLOT) / 2;

const styles = StyleSheet.create({
  control: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  /**
   * Fixed, and both dimensions matter. The width is what stops the row shifting when a
   * 20pt heart is replaced by a glyph of some other width; the height, with
   * `justifyContent`, is what centres every emoji identically whatever its bounds.
   */
  slot: { width: SLOT, height: SLOT, alignItems: 'center', justifyContent: 'center' },
  /**
   * The line box is the caption token's, overridden — see `EMOJI_LINE`. It ends up
   * taller than the slot, which is right: the slot centres and does not clip, so the
   * overflow is invisible and the glyph is whole. `includeFontPadding` is Android's
   * asymmetric ascent/descent padding, which would tilt that centre.
   */
  emoji: {
    fontSize: EMOJI_SIZE,
    lineHeight: EMOJI_LINE,
    textAlign: 'center',
    includeFontPadding: false,
  },
  cluster: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  glyphs: { flexDirection: 'row', alignItems: 'center' },
  glyphOverlap: { marginLeft: -theme.space[1] },
  pressed: { opacity: 0.7 },
});
