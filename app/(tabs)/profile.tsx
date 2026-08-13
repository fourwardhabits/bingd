import { EmptyState, Screen } from '@/ui/components';

/** The public identity page: stats, match, leaderboard, and the Top 10 that
 *  feeds the share card (PRD §16). */
export default function ProfileScreen() {
  return (
    <Screen>
      <EmptyState
        kind="nothingYet"
        title="Your profile"
        body="Your top titles and stats will appear here once you have ranked a few."
      />
    </Screen>
  );
}
