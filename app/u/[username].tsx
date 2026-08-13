import { useLocalSearchParams } from 'expo-router';

import { EmptyState, Screen } from '@/ui/components';

/** https://bingd.app/u/<username>. A private profile returns an access-safe
 *  page rather than a 404, which would itself leak existence (PRD §16). */
export default function PublicProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();

  return (
    <Screen>
      <EmptyState kind="nothingYet" title={`@${username}`} body="Public profile." />
    </Screen>
  );
}
