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
  useLocalSearchParams<{ token: string }>();

  return (
    <Screen airy includeBottomInset>
      <EmptyState
        kind="nothingYet"
        title="You have been invited"
        body="Invitations are not active in this build yet."
        action={{ label: 'Accept invitation', onPress: () => {} }}
      />
    </Screen>
  );
}
