import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { inkAlpha, theme } from '../tokens';
import { Text } from './Text';
import { useKeyboardHeight } from './use-keyboard-height';

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Announced when the sheet opens. */
  label: string;
  children: React.ReactNode;
};

/**
 * The modal pattern for the whole app (design-system.md §8).
 *
 * It was specified there from the start and never built: `LogSheet`, `RankingSheet`
 * and `SeasonPicker` each reached for `<Modal presentationStyle="pageSheet">`, which
 * is a *full-height* native sheet. That is the reason the log flow reads as a
 * sequence of screens rather than as one small act — a page-sheet has to be filled,
 * so the content inside it spreads out to justify the height it was given.
 *
 * This anchors to the bottom and takes only the height its content needs, up to 90%.
 * The context the user was looking at stays visible above it, which is what makes
 * logging feel incidental (Beli 224, reference-notes.md §2).
 *
 * The backdrop is capped at 40% per §8: a warm light ground under a heavy scrim turns
 * muddy rather than dark.
 *
 * **It rises with the keyboard, which is the founder's device finding answered at the
 * one place that fixes every sheet at once.** A bottom-anchored sheet with a composer
 * at its foot — comments, the note in the log sheet, a goal's target — is covered by
 * the keyboard *by construction* on Android, where edge-to-edge means the window never
 * resizes and `adjustResize` has nothing to adjust. The measured height goes on the
 * root's padding rather than the sheet's margin, which does two things with one value:
 * it lifts the sheet clear, and it re-resolves `maxHeight: '90%'` against the space
 * that is actually left, so a tall sheet shrinks instead of running off the top.
 */
export function Sheet({ visible, onClose, label, children }: SheetProps) {
  const keyboard = useKeyboardHeight();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      accessibilityViewIsModal
      statusBarTranslucent
    >
      <View style={[styles.root, keyboard > 0 && { paddingBottom: keyboard }]}>
        {/* Tapping away closes.

            Hidden from the accessibility tree on purpose. Every sheet in the app
            carries its own labelled Close control, and an accessible scrim would put
            a *second* element called "Close" in front of a screen reader before it
            reached any of the content — two identical announcements for the same
            action. Dismissal stays available to those users through that control and
            through the hardware back button, which `onRequestClose` handles. */}
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <SafeAreaView edges={['bottom']} style={styles.sheet} accessibilityLabel={label}>
          <View
            style={styles.handle}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          {children}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

export type SheetRowProps = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  /** The current value, shown on the right. Absent reads as "nothing set yet". */
  value?: string | null;
  onPress?: () => void;
  /** Renders the row present but inert, and says why to a screen reader. */
  disabledReason?: string;
  /** Marks the row as open, so the chevron points down and state is announced. */
  expanded?: boolean;
};

/**
 * One compact row inside a sheet: icon, label, current value, chevron.
 *
 * A row rather than a form field, which is the density decision borrowed from Beli's
 * "Add to my list of ▾". A multiline `Field` is 48pt of input plus a label plus a
 * hint before the user has typed anything, and three of those cannot coexist with a
 * bucket prompt in a sheet anyone would call small. A row states its value in one
 * line and spends space only when opened.
 *
 * `disabledReason` exists because a row for something not built yet is worth keeping
 * — it shows where the feature will live — but only if it says so out loud rather
 * than looking broken (design-system.md §8, on disabled buttons).
 */
export function SheetRow({
  icon,
  label,
  value,
  onPress,
  disabledReason,
  expanded,
}: SheetRowProps) {
  const disabled = Boolean(disabledReason) || !onPress;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, expanded }}
      accessibilityLabel={label}
      accessibilityHint={disabledReason ?? value ?? undefined}
      accessibilityValue={value ? { text: value } : undefined}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={disabled ? theme.text.tertiary : theme.text.secondary}
      />
      <Text variant="callout" tone={disabled ? 'tertiary' : 'primary'} style={styles.rowLabel}>
        {label}
      </Text>
      <Text variant="footnote" tone="tertiary" numberOfLines={1} style={styles.rowValue}>
        {disabledReason ?? value ?? ''}
      </Text>
      {disabled ? null : (
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={theme.layout.icon.sm}
          color={theme.text.tertiary}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: inkAlpha(0.4),
  },
  sheet: {
    backgroundColor: theme.surface.raised,
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    maxHeight: '90%',
    ...theme.elevation.e2,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.border.strong,
    marginTop: theme.space[2],
    marginBottom: theme.space[1],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
  },
  rowLabel: { flexShrink: 0 },
  rowValue: { flex: 1, textAlign: 'right' },
  pressed: { opacity: 0.6 },
});
