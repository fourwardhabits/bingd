import { useLocalSearchParams } from 'expo-router';

import { EmptyState, Screen } from '@/ui/components';

/** Deep link target for https://bingd.app/title/movie/<id> (PRD §16).
 *  The route definition is shared with the web page, so the two cannot drift. */
export default function TitleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <Screen>
      <EmptyState kind="nothingYet" title="Title" body={`Detail for ${id}.`} />
    </Screen>
  );
}
