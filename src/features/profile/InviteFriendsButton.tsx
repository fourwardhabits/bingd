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
 *
 * **Filled Maroon since the header pass, and it sits beside Share Profile rather than
 * under it.** Share Profile is what you do with people who are already here; this is
 * how anybody new arrives, which on an app with no users yet is the more valuable of
 * the two. `fit`, because half a gutter row at 320pt is 140 and "Invite friends" at
 * `md`'s default padding does not fit it — see `ProfileActions`.
 */
export function InviteFriendsButton() {
  /**
   * **"Opening…" covers the mint and nothing after it.**
   *
   * The label used to read "Inviting…" from the tap until `Share.share` settled, and on
   * iOS that promise settles only when the sheet closes, so the whole time a person was
   * choosing where to send the link the button behind the sheet said an invitation was
   * underway. None is: the sheet may be dismissed, and attribution happens at
   * redemption (`redeem_invite`), not here. The one wait worth naming is the RPC before
   * the sheet can present — there is no cached link to skip it, because every accepted
   * tap records a creation — so the transient label is scoped to that and drops the
   * moment the link comes back.
   */
  const [opening, setOpening] = useState(false);
  /**
   * **The tap guard is a ref, held until the sheet settles.**
   *
   * Reading state let two taps inside one render both through: two `create_invite_link`
   * calls, two creation rows, two share sheets. The ref is set synchronously on the
   * first tap and released only in `finally` — after the mint failed or the sheet
   * closed — so a tap behind an open sheet is ignored and the first tap after it works.
   */
  const busy = useRef(false);
  const intent = useRef<string | null>(null);

  const invite = async () => {
    if (busy.current) return;
    busy.current = true;
    setOpening(true);

    try {
      const operationId = (intent.current ??= newOperationId());
      const url = await createInviteLink(null, operationId, 'profile');
      setOpening(false);

      if (!url) {
        // The link is the whole point of this control, so unlike the title share there
        // is nothing to degrade to — say so and keep the id for the retry.
        Alert.alert('Could not get your invite link', 'Check your connection and try again.');
        return;
      }
      intent.current = null;

      // Reuse the sentence the title share already sends, minus the title. Cancelling
      // the sheet resolves normally and is nobody's error.
      await Share.share({ message: `Join me on bingd. ${url}`, url });
    } catch (error) {
      Alert.alert('Could not share', error instanceof Error ? error.message : 'Sharing failed.');
    } finally {
      busy.current = false;
      setOpening(false);
    }
  };

  return (
    <Button label={opening ? 'Opening…' : 'Invite friends'} fit onPress={() => void invite()} />
  );
}
