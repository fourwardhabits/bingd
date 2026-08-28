import { StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';

import { AwardBadge } from './AwardBadge';
import { badgeFor } from './badges';

export type AwardActivityLeadProps = {
  awardKey: string;
  tierKey: string;
};

/**
 * The award badge, sized for the feed row's leading slot (20260828000100).
 *
 * An award activity has no poster, and the two wrong answers to that are worse
 * than each other: a fake poster misrepresents what the row is about, and the
 * `MissingArtwork` initials of an award name look like a broken catalogue row.
 * So the badge itself leads — the same `AwardBadge` the sheet draws, always in
 * its earned state (this row exists because it was earned), at 40pt inside the
 * poster's own 40×60 box. The box, not the badge, is what preserves
 * `ActivityRow`'s geometry: the single left text edge derives from the poster
 * width, the actor chip positions against the lead's bounds, and neighbouring
 * rows keep their rhythm because the height does not change.
 *
 * `badgeFor` never throws — an award key this bundle has never heard of falls
 * back to the 🏅 emoji badge, which is the right degradation for a client older
 * than a future track.
 */
export function AwardActivityLead({ awardKey, tierKey }: AwardActivityLeadProps) {
  return (
    <View style={styles.box}>
      <AwardBadge badge={badgeFor(awardKey, tierKey)} earned size={theme.poster.xs.width} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: theme.poster.xs.width,
    height: theme.poster.xs.height,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
