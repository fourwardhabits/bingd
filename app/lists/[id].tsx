import { EmptyState, Screen } from '@/ui/components';

/** https://bingd.app/lists/<id>. Private or deleted returns an unavailable
 *  state; the token identifies the object and never authorizes it (PRD §16). */
export default function ListScreen() {
  return (
    <Screen includeBottomInset>
      <EmptyState
        kind="nothingYet"
        title="List unavailable"
        body="This list is private, deleted, or not available yet."
      />
    </Screen>
  );
}
