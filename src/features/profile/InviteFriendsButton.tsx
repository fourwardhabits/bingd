import { useRef, useState } from 'react';
import { Alert, Share } from 'react-native';

import { newOperationId } from '@/features/collection/writes';
import { createInviteLink } from '@/features/recommendations/use-recommend';
import { Button } from '@/ui/components';

/**
 * Invite friends, from the one page that is about the person doing the inviting.
 *
 * The invite machinery has been complete for a while — a reusable personal token,
 * `bingd.app/i/<token>` on the web, redemption, activation — and the only way to *start*
 * one was buried inside recommending a title to somebody off-platform. This is the same
 * `create_invite_link` call with no title attached, surfaced where a person would look
 * for it: their own profile, under Share Profile, because the two are the same act
 * pointed at different audiences. It renders on the own profile only; a visitor inviting
 * people "from" somebody else's page would be a sentence with the wrong subject.
 *
 * **The operation id follows `RecommendSheet`'s rule, for the same reason.** The token is
 * stable, but each accepted call writes one `invite_link_creations` row, and that row is
 * rate-limited. A creation that commits and loses its reply returns null here, the person
 * is told it failed, and the natural next move is to tap again — so the id is held across
 * that retry (`??=`) and released only when a link actually comes back. A later tap after
 * a success is a genuinely new decision and mints a new id, which is what the creation
 * log is for.
 *
 * No success state is shown. Opening the share sheet is not an invitation sent — the
 * person may cancel it — and the one honest signal, `invite_link_created`, is already
 * emitted where the row is recorded (`createInviteLink`).
 */
export function InviteFriendsButton() {
  const [inviting, setInviting] = useState(false);
  const intent = useRef<string | null>(null);

  const invite = async () => {
    if (inviting) return;
    setInviting(true);

    try {
      const operationId = (intent.current ??= newOperationId());
      const url = await createInviteLink(null, operationId, 'profile');

      if (!url) {
        // The link is the whole point of this control, so unlike the title share there
        // is nothing to degrade to — say so and keep the id for the retry.
        Alert.alert('Could not get your invite link', 'Check your connection and try again.');
        return;
      }
      intent.current = null;

      // Reuse the sentence the title share already sends, minus the title. Cancelling
      // the sheet resolves normally and is nobody's error.
      await Share.share({ message: `Join me on Bingd: ${url}`, url });
    } catch (error) {
      Alert.alert('Could not share', error instanceof Error ? error.message : 'Sharing failed.');
    } finally {
      setInviting(false);
    }
  };

  return (
    <Button
      label={inviting ? 'Inviting…' : 'Invite friends'}
      kind="secondary"
      onPress={() => void invite()}
    />
  );
}
