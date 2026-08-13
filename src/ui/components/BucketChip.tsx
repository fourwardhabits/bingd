import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

/** Always in this order. The scale expresses "for me" and "not for me", not
 *  good and bad — see design-system.md §3. */
export const BUCKETS = [
  { id: 'loved', label: 'Loved it', color: theme.bucket.loved },
  { id: 'fine', label: 'It was fine', color: theme.bucket.fine },
  { id: 'notForMe', label: 'Not for me', color: theme.bucket.notForMe },
] as const;

export type BucketId = (typeof BUCKETS)[number]['id'];

export type BucketChipProps = {
  bucket: (typeof BUCKETS)[number];
  selected: boolean;
  onPress: () => void;
};

/**
 * Selection is signalled by fill, checkmark, and border simultaneously, so
 * colour is never the only carrier of meaning.
 *
 * Choosing a bucket never starts comparisons on its own — that is a separate
 * deliberate action (PRD §11).
 */
export function BucketChip({ bucket, selected, onPress }: BucketChipProps) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={bucket.label}
      onPress={onPress}
      style={styles.container}
      hitSlop={theme.space[2]}
    >
      <View
        style={[
          styles.circle,
          { borderColor: bucket.color },
          selected && { backgroundColor: bucket.color },
        ]}
      >
        {selected ? (
          <Text
            variant="headline"
            tone={bucket.id === 'loved' ? 'inverse' : 'onFill'}
            accessibilityElementsHidden
          >
            ✓
          </Text>
        ) : null}
      </View>
      <Text variant="callout" style={styles.label}>
        {bucket.label}
      </Text>
    </Pressable>
  );
}

const CIRCLE = 44;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
  },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: theme.radius.full,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { textAlign: 'center' },
});
