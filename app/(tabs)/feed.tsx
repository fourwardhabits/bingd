import { EmptyState, Screen } from '@/ui/components';

/** PRD §14. Fan-out on read: followed users' activity is queried at read time
 *  rather than written into per-user inboxes (docs/architecture/README.md AD-5). */
export default function FeedScreen() {
  return (
    <Screen>
      <EmptyState
        kind="nothingYet"
        title="Nothing here yet"
        body="Follow a few people and their rankings will show up here."
        action={{ label: 'Find friends', onPress: () => {} }}
      />
    </Screen>
  );
}
