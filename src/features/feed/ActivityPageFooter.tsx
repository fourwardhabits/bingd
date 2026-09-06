import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type ActivityPageFooterProps = {
  /** A page is in flight. Outranks everything else, including the error that caused it. */
  isFetchingNextPage: boolean;
  /** The query is in its error state. Only meaningful here when rows are already drawn. */
  isError: boolean;
  /** False once `getNextPageParam` has returned null — the true end. */
  hasNextPage: boolean;
  /** How many rows are on screen. Nothing is drawn under an empty list. */
  count: number;
  /** Resumes from the cursor of the last page that succeeded. */
  onRetry: () => void;
};

/**
 * What sits under a paged list of activity: a spinner, a retry, or a full stop.
 *
 * **The error line is the load-bearing one.** Without it a failed second page has only
 * one way to be shown — the section's own "Could not load your activity" empty state —
 * which is a sentence about the whole read, printed above a screenful of activity that
 * loaded perfectly. The founder's requirement is that a later page failing preserves the
 * rows already there, and that is as much about what the screen *says* as about what it
 * keeps: rows stay, and the apology shrinks to the one page that actually failed.
 *
 * Retrying calls `fetchNextPage` and nothing else. It resumes from the cursor of the
 * last page that succeeded, so the rows on screen are neither re-read nor disturbed.
 *
 * The order of the three branches is an order of precedence. A fetch in flight outranks
 * the error that preceded it, because the retry is what put it in flight. The end line
 * is drawn only under a list with something in it — an empty section already has an
 * empty state saying considerably more, and "That's everything" under it would be the
 * screen agreeing with itself.
 *
 * The wording differs from the feed's on purpose. This sits under one person's history,
 * where "You're all caught up" would be wrong — there is nothing to be caught up *on*,
 * the list has simply ended.
 */
export function ActivityPageFooter({
  isFetchingNextPage,
  isError,
  hasNextPage,
  count,
  onRetry,
}: ActivityPageFooterProps) {
  if (isFetchingNextPage) {
    return (
      <View style={styles.footer}>
        <ActivityIndicator color={theme.semantic.action} />
      </View>
    );
  }

  if (isError && count > 0) {
    return (
      <View style={styles.footer}>
        <Text variant="footnote" tone="secondary">
          Could not load more activity.
        </Text>
        <Button kind="tertiary" size="sm" label="Try again" onPress={onRetry} />
      </View>
    );
  }

  if (!hasNextPage && count > 0) {
    return (
      <View style={styles.footer}>
        <Text variant="footnote" tone="secondary">
          That&rsquo;s the end of the list.
        </Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  footer: {
    alignItems: 'center',
    gap: theme.space[2],
    paddingVertical: theme.space[5],
    paddingHorizontal: theme.layout.gutter,
  },
});
