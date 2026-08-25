import { Alert, StyleSheet, View } from 'react-native';

import type { Surface } from '@/lib/analytics';
import { Button } from '@/ui/components';

import { noRelationship, useSocialWrites, type Relationship } from './use-social';

export type FollowControlProps = {
  userId: string;
  name: string;
  viewerId: string;
  relationship: Relationship | undefined;
  /** Hidden entirely on your own profile — you cannot follow yourself. */
  isSelf: boolean;
  /** Where this control is being shown, for `follow_created` alone. */
  surface: Surface;
  /**
   * `full` — the default — is the profile's own action area: one control across the
   * width of the screen, in the slot that holds Invite friends on the reader's own page.
   *
   * `compact` is the same control at the end of a row. People discovery needs one per
   * suggestion, and a full-width button under each of ten names would be a screen of
   * buttons with names on it.
   *
   * **A size, and deliberately not a second component.** The founder's rule for this
   * tranche is that a Follow performed from People discovery, from a profile and from a
   * recommendation request must be one mutation with one set of cache effects — three
   * implementations is how the picker ends up stale on one surface and not another,
   * which is the bug this pass is fixing elsewhere. Everything below the styling is
   * shared: the confirmation before unfollowing, the three-state label, `priorState`
   * and its `unknown` case, and `useSocialWrites`.
   */
  size?: 'full' | 'compact';
};

/**
 * The relationship, as one full-width control.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SAME BUTTON DOES THREE THINGS
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
 * WHERE BLOCK AND REPORT WENT
 *
 * Into the menu behind the header's hamburger — `ProfileMenu`, on this same screen.
 * They were here, as two tertiary buttons in a row beside Follow, and the founder's
 * device pass is that the profile's primary action area then read as a moderation
 * console: the three things offered about a person you had just looked up were follow
 * them, block them, and report them, all at the same altitude.
 *
 * That is a hierarchy problem rather than an availability one. Both are still one tap
 * from every profile and both still confirm; what they no longer do is sit permanently
 * beside the one control the page is actually for. `report()`'s rule that a block must
 * never suppress the complaint about somebody is unchanged and is asserted where it
 * now lives.
 *
 * ---------------------------------------------------------------------------
 * WHY UNFOLLOWING CONFIRMS AND FOLLOWING DOES NOT
 *
 * Following is one tap and undone by one tap. Unfollowing a private account is not:
 * withdrawing an approved follow means the next one is a *request*, which somebody
 * else has to answer, so it is worth a sentence. The founder's rule for this pass is
 * the same one — an accidental tap on Following must not silently sever the
 * relationship — and the confirmation this control already had is what keeps it.
 */
export function FollowControl({
  userId,
  name,
  viewerId,
  relationship,
  isSelf,
  surface,
  size = 'full',
}: FollowControlProps) {
  const { follow, unfollow, unblock, busy } = useSocialWrites(viewerId, surface);
  const state = relationship ?? noRelationship();
  const compact = size === 'compact';

  if (isSelf) return null;

  const report = (result: { ok: boolean; message?: string }, failed: string) => {
    if (!result.ok && result.message) Alert.alert(failed, result.message);
  };

  // A blocked account is not a profile to follow, so the one control it offers is the
  // way back. Report is not lost with it — the menu keeps offering it, which is the
  // client half of the rule `report()` states server-side (20260813002000 §4): blocking
  // somebody may not become a way to suppress the complaint about them.
  if (state.blocked) {
    return (
      <View style={compact ? styles.compact : styles.control}>
        <Button
          label="Unblock"
          kind="secondary"
          size={compact ? 'sm' : 'md'}
          disabled={busy}
          disabledReason="Saving your last change."
          onPress={() =>
            void (async () => {
              report(await unblock({ userId }), 'Could not unblock');
            })()
          }
        />
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

  return (
    <View style={compact ? styles.compact : styles.control}>
      <Button
        label={following ? 'Following' : requested ? 'Requested' : 'Follow'}
        /**
         * Filled Maroon to create the relationship, Maroon outline once it exists.
         *
         * It was `secondary` — grey — for both of the latter two, which made the
         * control the reader had just pressed look as though it had been swapped for a
         * different one. Outline keeps the colour and gives up the fill, so the same
         * button visibly changes state.
         *
         * **`Requested` shares the outline and keeps its own word.** The two states are
         * not the same thing and the label is what says so: a pending request is not a
         * follow, and collapsing it into "Following" would tell somebody they have
         * access they have not been granted. What they share is that the act is done
         * and the button is now reporting rather than offering.
         */
        kind={following || requested ? 'outline' : 'primary'}
        size={compact ? 'sm' : 'md'}
        accessibilityHint={
          following
            ? `Unfollow ${name}`
            : requested
              ? `Withdraw your request to follow ${name}`
              : `Follow ${name}`
        }
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
    </View>
  );
}

const styles = StyleSheet.create({
  // Full width, which is the shape of the slot it sits in: on the owner's profile that
  // slot holds Invite friends, and the two screens are meant to be the same screen.
  control: { alignSelf: 'stretch' },
  // As wide as its own label and no wider, so a row of people is a row of names with a
  // control at the end rather than a column of buttons. `Button`'s `sm` is 36pt and
  // clears the 44pt target through hit slop, which is the right tool inside a list.
  compact: { alignSelf: 'center' },
});
