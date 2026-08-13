import { EmptyState, Screen } from '@/ui/components';

/** Holds Ranked, Logged, Watchlist, and Lists — the user's working surface
 *  (docs/design/screens.md §2). Renders from SQLite before any network response
 *  so a cold start on a subway shows the collection, not a spinner. */
export default function CollectionScreen() {
  return (
    <Screen>
      <EmptyState
        kind="nothingYet"
        title="Your collection starts here"
        body="Log something you have seen, or bring your history over from Letterboxd."
        action={{ label: 'Log a title', onPress: () => {} }}
      />
    </Screen>
  );
}
