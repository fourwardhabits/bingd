import { ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Sheet, SheetDone, SheetHeader, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

export type CompanionsSheetProps = {
  actorName: string;
  /** The title they watched, as the post names it, or null. */
  title: string | null;
  /** Everyone the post's "with Anna and 2 others" stands for, in the post's order. */
  names: string[];
  onClose: () => void;
};

/**
 * **Everyone a post says the actor watched with** (founder, 2026-11-19).
 *
 * "watched Dune with Anna and 2 others" promised two more people, and nothing on the Feed
 * named them. This is the complete list behind that count.
 *
 * It reads nothing. The names are the post's own (`FeedItem.companions`), which the Feed
 * already resolved through `watch_tag_visible`, so the list is exactly the set this reader
 * may see and exactly the set the count was taken from: it cannot promise a person it then
 * fails to show. They are names and not profiles because that is all the post carries; a
 * tagged person's profile is one search away, and reaching it from here would need the
 * Feed to hydrate a username for every companion on every page.
 */
export function CompanionsSheet({ actorName, title, names, onClose }: CompanionsSheetProps) {
  const heading = `${actorName} watched with`;
  return (
    <Sheet visible onClose={onClose} label={heading}>
      <SheetHeader title={heading} subtitle={title ?? undefined} />
      <ScrollView contentContainerStyle={styles.scroll} testID="companions-sheet-list">
        {names.map((name, index) => (
          <View
            key={`${name}#${index}`}
            style={styles.row}
            accessible
            accessibilityLabel={name}
          >
            <Avatar size="sm" name={name} />
            <Text variant="callout" numberOfLines={1} style={styles.name}>
              {name}
            </Text>
          </View>
        ))}
      </ScrollView>
      <SheetDone onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingVertical: theme.space[2],
    minHeight: theme.layout.rowMinHeight,
  },
  name: { flexShrink: 1, fontFamily: fontFamily.sansSemibold },
});
