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
  /** Distinct glyphs present, most common first. Sliced to three here. */
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
 * The heart stays a heart in both states rather than becoming the reader's own
 * glyph: the cluster already shows what they chose, counted with everybody else's,
 * and the same emoji twice in one row read as a duplicate (the feed learned this
 * first). Filled Maroon says *I* have acted; the cluster says what everybody said.
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
  glyphs,
  count,
  onToggle,
  onOpenPicker,
  onOpenDetail,
}: ReactionControlProps) {
  return (
    <View style={styles.control}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        accessibilityHint="Long press to choose a different reaction"
        onPress={onToggle}
        onLongPress={onOpenPicker}
        hitSlop={slop}
        style={({ pressed }) => [styles.heart, pressed && styles.pressed]}
      >
        <Ionicons
          name={active ? 'heart' : 'heart-outline'}
          size={theme.layout.icon.sm}
          color={active ? theme.semantic.action : theme.text.tertiary}
        />
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
            <Glyphs glyphs={glyphs} />
            <Text variant="caption" tone={active ? 'action' : 'tertiary'}>
              {count}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.cluster} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Glyphs glyphs={glyphs} />
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
