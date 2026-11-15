import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type DisclosureProps = {
  /** The question or heading the control answers, e.g. *Need help getting the file?* */
  label: string;
  /**
   * A short value drawn at the trailing edge of the control, before the chevron: a
   * summary row's count. Spoken after the label.
   */
  trailing?: string;
  /** What a screen reader hears for the trailing value, where the digits alone are vague. */
  trailingLabel?: string;
  /** `body` for a row inside a card, `callout` for a quieter inline help link. */
  variant?: 'body' | 'callout';
  /** Called with the new state after every press. For analytics, never for layout. */
  onToggle?: (expanded: boolean) => void;
  children: ReactNode;
  testID?: string;
};

/**
 * **Something worth knowing, one tap away and closed until then** (IMP1113-UI).
 *
 * An inline, collapsed-by-default section: a full-width row with a label and a chevron,
 * and the content drawn under it in the same scroll body once it is open. Not a sheet: the
 * content is short and belongs to the page it is on, and a modal for four lines of help
 * was the always-visible card's opposite failure.
 *
 * **Accessibility.** The row is a `button` with `expanded` state, labelled with the
 * visible words (and the trailing value, where there is one), so VoiceOver and TalkBack
 * read *Need help getting the file?, button, collapsed*. The content follows the control
 * in the reading order.
 *
 * **Large text.** The label wraps (`flexShrink`, no line cap) and the row grows with it;
 * the chevron stays on the first line's centre. The row is never shorter than the 44pt
 * target, by its own box rather than by slop a parent could clip.
 */
export function Disclosure({
  label,
  trailing,
  trailingLabel,
  variant = 'body',
  onToggle,
  children,
  testID,
}: DisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  const spoken = trailing ? `${label}, ${trailingLabel ?? trailing}` : label;

  return (
    <View testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityState={{ expanded }}
        onPress={() => {
          const next = !expanded;
          setExpanded(next);
          onToggle?.(next);
        }}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <Text
          variant={variant}
          tone={variant === 'callout' ? 'action' : 'primary'}
          style={styles.label}
        >
          {label}
        </Text>
        {trailing ? (
          <Text variant="headline" style={styles.trailing}>
            {trailing}
          </Text>
        ) : null}
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={theme.layout.icon.sm}
          color={variant === 'callout' ? theme.semantic.action : theme.text.secondary}
        />
      </Pressable>
      {expanded ? (
        <View style={styles.content} testID={testID ? `${testID}-content` : undefined}>
          {children}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
  },
  // `Button`'s pressed state, so the two kinds of control answer a press alike.
  pressed: { opacity: 0.85 },
  label: { flexShrink: 1, flexGrow: 1 },
  trailing: { textAlign: 'right' },
  // The 44pt row already leaves about `space[2]` under a one-line label, so `space[1]` more
  // makes the seam the `controlsToContent` interval (design-system.md §5) without a second
  // owner for it.
  content: { paddingTop: theme.space[1] },
});
