import { Platform, StyleSheet } from 'react-native';

import { fontFamily, theme } from '../tokens';
import { Text, type TextProps } from './Text';

export type SentenceLinkProps = {
  label: string;
  onPress: () => void;
  /** What a screen reader hears, when the visible words alone would not say where it goes. */
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * **The pressable phrase inside a post's sentence** — "and **3 others**", "and **2 more**",
 * "ranked **6 titles**", "with Anna and **2 others**" (founder, 2026-11-19).
 *
 * A nested `Text`, so it wraps with the sentence rather than breaking it into blocks, in
 * the entity treatment the actor and the title already carry: semibold, primary ink.
 * That is how this app marks what can be touched in a sentence, so the count reads as a
 * link and not as a muted clause.
 *
 * The press belongs to the phrase alone. A nested `Text` with its own `onPress` is the
 * innermost press target, so the tap opens the complete list and nothing else — not the
 * representative title, not the actor. Callers must not put it inside a run that has a
 * press of its own (the title's), where the two would compete.
 */
export function SentenceLink({
  label,
  onPress,
  accessibilityLabel,
  testID,
}: SentenceLinkProps) {
  return (
    <Text
      variant="subhead"
      style={styles.link}
      onPress={onPress}
      accessibilityRole={INLINE_ROLE}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {label}
    </Text>
  );
}

/**
 * A button on iOS and Android, where a pressable run is part of the sentence's one
 * attributed string. On the web a `button` role makes react-native-web draw a `<button>`,
 * which the browser lays out as an inline-block: the line may break before it whatever
 * non-breaking space precedes it, which undoes the headline's binding of "+ 5 more" to the
 * title (refined card feed, 2026-11-22). A `link` role is drawn as an inline run there.
 */
const INLINE_ROLE = Platform.OS === 'web' ? 'link' : 'button';

/** "1 other", "3 others": the count after a name, singular when it is one. */
export function othersLabel(count: number) {
  return `${count} ${count === 1 ? 'other' : 'others'}`;
}

/**
 * "with **Anna**", "with **Anna and Raj**", or "with **Anna** and **2 others**".
 *
 * Two names is the ceiling, as it is for reactions: ten tagged friends written out would
 * push the title off the sentence they belong to. Past two, the rest is a count, and where
 * the surface can show them all (`onPressAll`) the count is a link to every one of them.
 * Without one it is plain entity ink, as it always was.
 */
export function CompanionNames({
  names,
  onPressAll,
  entityStyle,
  testID,
}: {
  names: string[];
  onPressAll?: () => void;
  /** The host sentence's entity style, so the names match its actor and title. */
  entityStyle: TextProps['style'];
  testID?: string;
}) {
  if (names.length <= 2 || !onPressAll) {
    return (
      <Text variant="subhead" style={entityStyle}>
        {companionNames(names)}
      </Text>
    );
  }
  const others = othersLabel(names.length - 1);
  return (
    <>
      <Text variant="subhead" style={entityStyle}>
        {names[0]}
      </Text>
      {' and '}
      <SentenceLink
        label={others}
        onPress={onPressAll}
        accessibilityLabel={`${others}. See everyone they watched with.`}
        testID={testID}
      />
    </>
  );
}

/** "Anna", "Anna and Raj", or "Anna and 3 others". */
export function companionNames(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${othersLabel(names.length - 1)}`;
}

const styles = StyleSheet.create({
  link: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
});
