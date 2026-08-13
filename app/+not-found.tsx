import { router } from 'expo-router';

import { EmptyState, Screen } from '@/ui/components';

export default function NotFoundScreen() {
  return (
    <Screen>
      <EmptyState
        kind="couldNotLoad"
        title="We could not find that"
        body="The link may have expired, or the thing it pointed at may be private now."
        action={{ label: 'Go to your collection', onPress: () => router.replace('/collection') }}
      />
    </Screen>
  );
}
