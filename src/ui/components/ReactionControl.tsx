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
            <Text variant="caption" tone={active ? 'action' : 'tertiary'} style={styles.count}>
              {count}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.cluster} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Glyphs glyphs={summary} />
            <Text variant="caption" tone={active ? 'action' : 'tertiary'} style={styles.count}>
              {count}
            </Text>
          </View>
        )
      ) : null}
    </View>
  );
}

/**
 * Overlapped, so three glyphs read as one object and cost the width of about two.
 *
 * **Each glyph now sits in a fixed-height centred box, and the cropping this fixes was
 * the cluster's rather than the action slot's** (founder, physical Android, 2026-09-05).
 * The slot was given exactly this treatment on 2026-09-04 and the founder confirms it is
 * right; these glyphs were left as a bare `caption` `Text`, which means Android's
 * `includeFontPadding` was still on and the line box was still whatever the token said.
 * Both matter for a colour emoji and neither does for the Latin text the tokens were
 * measured on: the padding is asymmetric, so it tilts the glyph off the centre the count
 * beside it is aligned to, and a line box sized for a 12pt cap-height crops the top of a
 * glyph whose ascent is taller.
 *
 * **The size is untouched.** The founder's judgement is that the cluster reads correctly
 * small against a caption-sized count, so `emojiText` keeps `caption`'s `fontSize` and
 * changes only the line box, the padding and the centring — which is the difference
 * between a glyph that is drawn wrong and one that is drawn small on purpose.
 *
 * The box fixes **height only**. A fixed width would change the overlap arithmetic below
 * and move the cluster's rhythm, and width was never the axis anything was clipped on.
 */
function Glyphs({ glyphs }: { glyphs: string[] }) {
  if (!glyphs.length) return null;
  return (
    <View style={styles.glyphs} accessibilityElementsHidden>
      {glyphs.slice(0, 3).map((glyph, index) => (
        <View
          key={glyph}
          style={[styles.glyphBox, index > 0 ? styles.glyphOverlap : undefined]}
        >
          <Text variant="caption" allowFontScaling={false} style={styles.clusterEmoji}>
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
 * How much taller than its nominal size a colour emoji's line box has to be.
 *
 * `Text` merges a type token first, and every token in this app was measured on Latin
 * text — so the line box that arrives is sized for a cap height and an emoji's ascent is
 * taller than one. A line box shorter than the glyph is exactly how Android crops it,
 * while iOS looks perfect, which is what makes this the class of defect that reaches a
 * device before it reaches anybody's screen.
 *
 * The safe direction is always up: both boxes below centre their child and neither clips,
 * so headroom costs nothing and a tight box costs the top of 🔥. **Raised from 1.3 to 1.4
 * on 2026-09-05**, after the founder found glyphs still cropping on a physical Android
 * pass — 1.3 is the conventional figure and conventional was not enough here.
 *
 * One number, applied wherever an emoji is drawn, so the action slot and the summary
 * cluster cannot drift into two different treatments of the same problem.
 */
const EMOJI_HEADROOM = 1.4;

/** The action slot's line box. Taller than the slot on purpose; the slot does not clip. */
const EMOJI_LINE = Math.ceil(EMOJI_SIZE * EMOJI_HEADROOM);

/**
 * The summary cluster's glyph size and its line box.
 *
 * **The size is `caption`'s, unchanged**, and that is the point: the founder's judgement
 * is that the cluster reads correctly small against a caption-sized count, so the fix
 * here is the box and the padding rather than the type. What was wrong was never how big
 * these are.
 */
const CLUSTER_EMOJI_SIZE = theme.typography.caption.fontSize;
const CLUSTER_EMOJI_LINE = Math.ceil(CLUSTER_EMOJI_SIZE * EMOJI_HEADROOM);

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
    // Android draws text into a box whose vertical centre is not the glyph's when the
    // ascent and descent are unequal, which is every colour emoji. Both of these are
    // what make "centred in the slot" mean the glyph rather than the box.
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  cluster: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  glyphs: { flexDirection: 'row', alignItems: 'center' },

  /**
   * The cluster glyph's box: caption's line height, centred, height only.
   *
   * Height, because that is the axis a glyph is cropped and mis-centred on, and because
   * this is the figure `slop` derives the 44pt tap target from — a box of any other
   * height would silently move the target. Not width, because a fixed width would change
   * the overlap below and shift the cluster's rhythm for nothing.
   */
  glyphBox: {
    height: theme.typography.caption.lineHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clusterEmoji: {
    fontSize: CLUSTER_EMOJI_SIZE,
    lineHeight: CLUSTER_EMOJI_LINE,
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  /**
   * The count, given the same padding treatment as the glyphs beside it.
   *
   * It is Latin text and does not need the headroom, but it does need to stop measuring
   * itself differently: `alignItems: 'center'` on the cluster centres two boxes against
   * each other, and while one of them carried Android's font padding and the other did
   * not, the two were centred on different things. That is the founder's third symptom —
   * the emoji and the count not sitting level — and it is a property of the pair rather
   * than of either one.
   */
  count: { includeFontPadding: false },
  glyphOverlap: { marginLeft: -theme.space[1] },
  pressed: { opacity: 0.7 },
});
