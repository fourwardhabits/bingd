import { Pressable, StyleSheet, View } from 'react-native';

import { BUCKET_LABEL } from '@/features/collection/score';

import { theme } from '../tokens';
import { Text } from './Text';

/**
 * Always in this order, best first — the bands are ordered, so the control that
 * chooses one has to be too (design-system.md §3).
 *
 * The `id`s are the chip's own camelCase space and are mapped to the stored
 * `loved` / `fine` / `not_for_me` at the write. The words come from
 * `BUCKET_LABEL` so that rewording the scale is one edit rather than three.
 */
export const BUCKETS = [
  { id: 'loved', label: BUCKET_LABEL.loved, color: theme.bucket.loved },
  { id: 'fine', label: BUCKET_LABEL.fine, color: theme.bucket.fine },
  { id: 'notForMe', label: BUCKET_LABEL.not_for_me, color: theme.bucket.notForMe },
] as const;

export type BucketId = (typeof BUCKETS)[number]['id'];

type BucketChipProps = {
  bucket: (typeof BUCKETS)[number];
  selected: boolean;
  onPress: () => void;
};

export type BucketChoicesProps = {
  /** The chosen bucket, or `null` for a question not yet answered. */
  selected: BucketId | null;
  onSelect: (bucket: BucketId) => void;
  testID?: string;
};

export type ChipProps = {
  label: string;
  selected?: boolean;
  /** Omit for a chip that is a label rather than a control — the genre pills on
   *  the title page are metadata, and a button that does nothing when tapped is
   *  worse than plain text. */
  onPress?: () => void;
};

export function Chip({ label, selected = false, onPress }: ChipProps) {
  const content = (
    <Text variant="callout" tone={selected ? 'primary' : 'secondary'}>
      {label}
    </Text>
  );

  if (!onPress) {
    return <View style={styles.chip}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
      hitSlop={theme.space[2]}
    >
      {content}
    </Pressable>
  );
}

/**
 * Selection is signalled by fill, checkmark, and border simultaneously, so
 * colour is never the only carrier of meaning.
 *
 * Choosing a bucket never starts comparisons on its own — that is a separate
 * deliberate action (PRD §11).
 */
function BucketChip({ bucket, selected, onPress }: BucketChipProps) {
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

/**
 * The three-choice scale, laid out — one component, so there is one answer to
 * "what does *How was it?* look like".
 *
 * It exists because there were two. `LogSheet` held the row privately, as a
 * `flexDirection: 'row'` wrapper in its own stylesheet; the onboarding sheet
 * mapped `BUCKETS` into a container that had a gap and nothing else. `BucketChip`
 * is written for a row — `flex: 1` is how three chips take equal columns — and in
 * a column parent of automatic height that same `flex: 1` resolves each chip to
 * zero, so the circles collapsed onto one another and the labels landed on top of
 * the circles below them. That is the founder's screenshot, and no amount of care
 * inside `BucketChip` could have prevented it: the mistake was in the parent that
 * both callers had to remember to write.
 *
 * So the parent is no longer something a caller writes. The row is the component,
 * the chip is its unit, and a third surface asking the same question gets the same
 * layout by construction rather than by copying.
 *
 * The gutter is deliberately *not* here — this sits inside sheets that pad their
 * own content block, and padding it twice is what makes a three-column row too
 * narrow to hold the longest label on a small phone.
 */
export function BucketChoices({ selected, onSelect, testID }: BucketChoicesProps) {
  return (
    <View style={styles.choices} accessibilityRole="radiogroup" testID={testID}>
      {BUCKETS.map((bucket) => (
        <BucketChip
          key={bucket.id}
          bucket={bucket}
          selected={selected === bucket.id}
          onPress={() => onSelect(bucket.id)}
        />
      ))}
    </View>
  );
}

const CIRCLE = 44;

const styles = StyleSheet.create({
  chip: {
    minHeight: theme.layout.control.chipHeight,
    borderRadius: theme.radius.control,
    borderColor: theme.border.hairline,
    borderWidth: StyleSheet.hairlineWidth * 2,
    backgroundColor: theme.surface.raised,
    paddingHorizontal: theme.space[3],
    justifyContent: 'center',
    alignItems: 'center',
  },
  chipSelected: { backgroundColor: theme.surface.sunken },
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
  /**
   * Three equal columns, always. The gap is the sheet's own rhythm rather than a
   * number chosen here, and at a 320pt width it still leaves each column 88pt —
   * room for the 44pt circle with the longest label wrapping beneath it rather
   * than colliding with its neighbour.
   */
  choices: { flexDirection: 'row', gap: theme.space[3] },
});
