import { useLocalSearchParams } from 'expo-router';

import { EmptyState, Screen } from '@/ui/components';

/** https://bingd.app/lists/<id>. Private or deleted returns an unavailable
 *  state; the token identifies the object and never authorizes it (PRD §16). */
export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <Screen>
      <EmptyState kind="nothingYet" title="List" body={`List ${id}.`} />
    </Screen>
  );
}
