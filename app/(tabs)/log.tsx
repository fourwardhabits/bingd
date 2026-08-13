import { EmptyState, Screen } from '@/ui/components';

/**
 * The centre + tab. Opens directly into title search, which is why there is no
 * separate Search tab (docs/design/screens.md §2).
 *
 * Choosing a bucket here never starts comparisons on its own — ranking is a
 * separate deliberate action (PRD §11).
 */
export default function LogScreen() {
  return (
    <Screen>
      <EmptyState
        kind="nothingYet"
        title="What did you watch?"
        body="Search for a film or a season to log it."
        action={{ label: 'Search', onPress: () => {} }}
      />
    </Screen>
  );
}
