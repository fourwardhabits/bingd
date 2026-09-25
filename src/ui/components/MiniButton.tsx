import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

/**
 * **A small action that is available rather than urged** (founder, device QA, 2026-09-25).
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A BUTTON AND NOT WORDS
 *
 * Its predecessor was maroon words with no container. That solved the problem it was built
 * for — a filled Maroon `Button` spent the app's strongest emphasis on *I have finished
 * looking at this* — and created a new one the founder named exactly: the words read as
 * **detached**. Text alone has no edge, so at the foot of a sheet it floats rather than
 * sitting anywhere, and there is nothing to say how much of it is the target.
 *
 * So: a container, but the quietest one the design system has. The raised surface and the
 * hairline border are `Button`'s own `secondary` treatment; what makes this *mini* is that
 * it shrinks to its label instead of filling the line, and that the label stays Maroon ink
 * rather than becoming Maroon fill. Between a primary CTA and a bare word, and legible as
 * neither.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE PRIMITIVE FOR BOTH PLACES
 *
 * `Done` at the foot of a utility sheet and `+ New list` under the Lists heading are the
 * same kind of thing — a small, optional act beside content that is the real subject — and
 * the founder asked for one visual language across them. They differ only in where they
 * sit and whether they carry an icon, which is what `align` and `icon` are for. Nothing
 * else about either surface changes.
 *
 * It is deliberately **not** for a primary CTA, for a ranking flow's real `Done`, or for
 * Recommend / Share off bingd. Those are decisions; this is not.
 */
export function MiniButton({
  label,
  onPress,
  icon,
  align = 'center',
  style,
}: {
  label: string;
  onPress: () => void;
  /** An icon before the label, for a control that creates something. */
  icon?: keyof typeof Ionicons.glyphMap;
  /**
   * Where it sits on its own line. `center` is the sheet foot; `start` keeps a control in
   * the place it already occupies — the founder's rule for `+ New list`, which must not
   * move just because it changed shape.
   */
  align?: 'center' | 'start';
  style?: ViewStyle;
}) {
  return (
    <View style={[align === 'center' ? styles.centered : styles.start, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [styles.press, pressed && styles.pressed]}
      >
        {icon ? (
          <Ionicons name={icon} size={theme.layout.icon.md} color={theme.semantic.action} />
        ) : null}
        <Text variant="callout" tone="action">
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // `alignItems` rather than `alignSelf`, so the row shrink-wraps the button and the
  // button shrink-wraps its label — a `stretch` anywhere here is a full-width control.
  centered: { alignItems: 'center' },
  start: { alignItems: 'flex-start' },
  press: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[2],
    // The accessible floor, met by the control itself rather than by a padded parent:
    // Android clips touches outside a parent's box.
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.space[5],
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.raised,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.strong,
  },
  pressed: { opacity: 0.6 },
});
