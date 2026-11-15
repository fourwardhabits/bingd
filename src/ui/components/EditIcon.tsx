import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

/**
 * **The one Edit glyph** (FU1113-B). For a control that edits something the reader wrote
 * or set — a note, a profile. Never for Rerank, Rank, Add, Bookmark, Share or Delete: each
 * of those has its own glyph, and a pencil on any of them says the wrong verb.
 */
export const EDIT_ICON_NAME = 'create-outline';

export type EditIconProps = {
  /** `sm` 20pt (inline, in rows), `md` 24pt (standalone). Default `sm`. */
  size?: 'sm' | 'md';
  /** Defaults to Maroon, the app's action ink. */
  color?: string;
  testID?: string;
};

export function EditIcon({ size = 'sm', color = theme.semantic.action, testID }: EditIconProps) {
  return (
    <Ionicons
      name={EDIT_ICON_NAME}
      size={theme.layout.icon[size]}
      color={color}
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

export type EditActionProps = {
  onPress: () => void;
  /** Required: an icon alone says nothing to a screen reader. */
  accessibilityLabel: string;
  /** Printed beside the glyph when there is room for a word ("Edit"). */
  label?: string;
  testID?: string;
};

/**
 * The Edit glyph as a control: the icon, an optional word, and a 44pt target drawn as one
 * (no slop for a parent to clip).
 */
export function EditAction({ onPress, accessibilityLabel, label, testID }: EditActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <View style={styles.inner}>
        <EditIcon size="sm" />
        {label ? (
          <Text variant="subhead" tone="action" numberOfLines={1}>
            {label}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    minWidth: theme.layout.minTapTarget,
    minHeight: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space[2],
  },
  inner: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  pressed: { opacity: 0.6 },
});
