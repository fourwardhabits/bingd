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
        hitSlop={slop}
        style={({ pressed }) => [styles.heart, pressed && styles.pressed]}
      >
        {mine ? (
          // No pill, no label, no name beside it: the emoji alone, in the slot the
          // heart was in, so the row's width and rhythm are unchanged (founder §6,
          // visual restraint). `allowFontScaling={false}` matches the cluster —
          // emoji do not gain legibility from Dynamic Type, they just reflow the row.
          <Text variant="caption" allowFontScaling={false}>
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

/**
 * The slop that carries the 44pt floor for a caption-height control — the comment
 * strip's rule, now the shared one: the tap target must be 44pt, not the ink.
 */
const slop = (theme.layout.minTapTarget - theme.typography.caption.lineHeight) / 2;

const styles = StyleSheet.create({
  control: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  heart: { flexDirection: 'row', alignItems: 'center' },
  cluster: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  glyphs: { flexDirection: 'row', alignItems: 'center' },
  glyphOverlap: { marginLeft: -theme.space[1] },
  pressed: { opacity: 0.7 },
});
