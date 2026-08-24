import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { ReportSheet } from '@/features/moderation/ReportSheet';
import type { Surface } from '@/lib/analytics';
import { Button } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { noRelationship, useSocialWrites, type Relationship } from './use-social';

export type FollowControlProps = {
  userId: string;
  name: string;
  viewerId: string;
  relationship: Relationship | undefined;
  /** Hidden entirely on your own profile — you cannot follow or block yourself. */
  isSelf: boolean;
  /** Where this control is being shown, for `follow_created` alone. */
  surface: Surface;
};

/**
 * Follow, unfollow, withdraw a request — and block.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SAME BUTTON DOES FOUR THINGS
 *
 * `follows` has three states from the viewer's side — absent, pending, approved — and
 * a control per state would mean three controls, two of which are always wrong. One
 * button that names the state it is in is how every social product does this, and it
 * is also the only version where the label and the action cannot disagree.
 *
 * The state comes from `follow_state_with`, which reports what the viewer could
 * already select. Nothing here infers a relationship from anything else on the page.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DESTRUCTIVE ONES CONFIRM AND THE OTHERS DO NOT
 *
 * Following is one tap and undone by one tap. Unfollowing a private account is not:
 * withdrawing an approved follow means the next one is a *request*, which somebody
 * else has to answer, so it is worth a sentence. Blocking is confirmed always — it
 * severs the relationship in both directions, and `unblock` deliberately does not
 * restore what it removed (api.md §3).
 */
export function FollowControl({
  userId,
  name,
  viewerId,
  relationship,
  isSelf,
  surface,
}: FollowControlProps) {
  const { follow, unfollow, block, unblock, busy } = useSocialWrites(viewerId, surface);
  const state = relationship ?? noRelationship();
  const [reporting, setReporting] = useState(false);

  if (isSelf) return null;

  const report = (result: { ok: boolean; message?: string }, failed: string) => {
    if (!result.ok && result.message) Alert.alert(failed, result.message);
  };

  // A blocked account is not a profile to follow. The only control it offers is the
  // way back — and the page around it is already empty, because `can_view_profile` is
  // false in both directions, so this is the whole of what a blocked profile shows.
  /**
   * Report, wherever the profile is.
   *
   * Present on the blocked branch too, and that is the client half of a rule the
   * database already states: `report()` checks that a subject exists and deliberately
   * not that the caller can still see it, so that blocking somebody cannot become a
   * way to suppress the complaint about them (20260813002000 §4). Hiding the control
   * the moment you block would reintroduce, in the UI, exactly the inversion the
   * server refuses to have.
   *
   * It is a tertiary control beside Block rather than a red button, and it is not
   * bundled with Block: the two are different acts. A block is between two people and
   * takes effect immediately; a report is a message to whoever runs Bingd, and
   * neither one implies the other.
   */
  const reportControl = (
    <Button
      label="Report"
      kind="tertiary"
      onPress={() => setReporting(true)}
      accessibilityHint={`Tells whoever runs bingd. about ${name}`}
    />
  );

  const reportSheet = (
    <ReportSheet
      visible={reporting}
      onClose={() => setReporting(false)}
      subject="profile"
      subjectId={userId}
      noun="profile"
    />
  );

  if (state.blocked) {
    return (
      <View style={styles.row}>
        <Button
          label="Unblock"
          kind="secondary"
          disabled={busy}
          disabledReason="Saving your last change."
          onPress={() =>
            void (async () => {
              report(await unblock({ userId }), 'Could not unblock');
            })()
          }
        />
        {reportControl}
        {reportSheet}
      </View>
    );
  }

  const following = state.following === 'approved';
  const requested = state.following === 'pending';

  const confirmUnfollow = () =>
    Alert.alert(
      requested ? `Withdraw your request to ${name}?` : `Unfollow ${name}?`,
      requested
        ? 'They will not be told you asked.'
        : 'You will stop seeing their activity. Following a private account again needs their approval.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: requested ? 'Withdraw' : 'Unfollow',
          style: 'destructive',
          onPress: () =>
            void (async () => {
              report(await unfollow({ userId }), 'Could not unfollow');
            })(),
        },
      ],
    );

  const confirmBlock = () =>
    Alert.alert(`Block ${name}?`, 'You will not see each other on bingd. Any follow between you is removed, and unblocking does not bring it back.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            report(await block({ userId }), 'Could not block');
          })(),
      },
    ]);

  return (
    <View style={styles.row}>
      <Button
        label={following ? 'Following' : requested ? 'Requested' : 'Follow'}
        // Secondary once there is a relationship: the button stops being the thing to
        // do on this page and becomes a statement of where you stand.
        kind={following || requested ? 'secondary' : 'primary'}
        disabled={busy}
        disabledReason="Saving your last change."
        onPress={() => {
          if (following || requested) return confirmUnfollow();
          void (async () => {
            /**
             * **`undefined` is not "no relationship".**
             *
             * This button renders "Follow" from `noRelationship()` while
             * `follow_state_with` is still in flight, so a press can arrive before anybody
             * has looked. Reporting that as "there was no edge" is how a re-follow gets
             * counted as a new one, which independent review 24 named. The three states
             * are passed through as three, and `unknown` emits nothing.
             *
             * The branch above already returned for anybody the screen *knows* is in a
             * relationship, so the only two possibilities left here are a genuine new
             * follow and a read that has not landed.
             */
            const result = await follow({
              userId,
              priorState: relationship === undefined ? 'unknown' : 'none',
            });
            report(result, 'Could not follow');
          })();
        }}
      />
      <Button label="Block" kind="tertiary" disabled={busy} disabledReason="Saving your last change." onPress={confirmBlock} />
      {reportControl}
      {reportSheet}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[3],
  },
});
