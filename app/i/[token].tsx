import { useLocalSearchParams } from 'expo-router';

import { EmptyState, Screen } from '@/ui/components';

/**
 * Invitation acceptance, https://bingd.app/i/<token> (PRD §17).
 *
 * Acceptance is always explicit, and an invitation opened while signed into a
 * different account discloses which account will accept and offers to switch,
 * rather than silently binding to whoever happens to be logged in.
 */
export default function InvitationScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();

  return (
    <Screen airy>
      <EmptyState
        kind="nothingYet"
        title="You have been invited"
        body={`Invitation ${token}.`}
        action={{ label: 'Accept invitation', onPress: () => {} }}
      />
    </Screen>
  );
}
