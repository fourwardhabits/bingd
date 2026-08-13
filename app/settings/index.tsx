import { EmptyState, Screen } from '@/ui/components';

/** Privacy controls, blocking, notification preferences, account deletion, and
 *  the TMDB attribution notice required by §19. */
export default function SettingsScreen() {
  return (
    <Screen>
      <EmptyState kind="nothingYet" title="Settings" body="Privacy, notifications, account." />
    </Screen>
  );
}
