import { StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { AwardBadge } from './AwardBadge';
import { TierDots } from './TierDots';
import { awardAnnouncement } from './announcement';
import { badgeFor } from './badges';
import { AWARD_TRACKS } from './tracks';

export type CelebrationCardProps = {
  awardKey: string;
  tierKey: string;
};

/**
 * One earned award, as the thing at the centre of its own celebration.
 *
 * **The same content as the feed's award row, in the shape a payoff needs.** Badge,
 * the tier's name, and the sentence saying what was done — all three from
 * `awardAnnouncement`, which is the one place that decides what an award is *called*,
 * so the celebration, the feed post and the inbox congratulations cannot say three
 * different things about one event. The badge and the tier dots are the sheet's own.
 *
 * **No heart, no comment, no reaction control.** The founder was explicit and the reason
 * is the same one that keeps a profile's own Recent activity from being a place to react
 * to yourself: this is the reader's own achievement, shown to them alone, and a row of
 * social affordances on it invites somebody to congratulate themselves. The feed post
 * that the same unlock produced is where other people react, and it already exists.
 *
 * **No extra paragraph.** A name, a sentence, and a picture. Anything else here is
 * copy explaining a reward, which is the fastest way to stop it feeling like one.
 *
 * `badgeFor` never throws and `awardAnnouncement` falls back to a neutral name, so an
 * award key from a future migration renders a plain, honest card on an older client
 * rather than a blank one.
 */
export function CelebrationCard({ awardKey, tierKey }: CelebrationCardProps) {
  const { title, achievement } = awardAnnouncement({ key: awardKey, tierKey });
  const track = AWARD_TRACKS.find((candidate) => candidate.key === awardKey);
  /**
   * Which of the three was reached, for the dots.
   *
   * -1 for a track this bundle does not know, which `TierDots` draws as three empty
   * rings — honest, rather than a guess at a tier the client cannot name.
   */
  const tierIndex = track
    ? track.tiers.findIndex((candidate) => candidate.key === tierKey)
    : -1;

  return (
    <View
      style={styles.card}
      accessible
      accessibilityRole="text"
      accessibilityLabel={[`You earned ${title}`, achievement].filter(Boolean).join('. ')}
    >
      <View style={styles.badge}>
        <AwardBadge
          badge={badgeFor(awardKey, tierKey)}
          earned
          size={theme.layout.awardBadge * 2}
        />
        {track ? <TierDots earnedTierIndex={tierIndex} /> : null}
      </View>
      <Text variant="caption" tone="secondary">
        AWARD EARNED
      </Text>
      <Text variant="title2" style={styles.name}>
        {title}
      </Text>
      {achievement ? (
        <Text variant="footnote" tone="secondary" style={styles.name}>
          {achievement}
        </Text>
      ) : null}
    </View>
  );
}

const BADGE = theme.layout.awardBadge * 2;

const styles = StyleSheet.create({
  /**
   * Raised rather than transparent. The card sits on a wall of posters, and the one
   * thing that must never be in question is which pixels are the message — a card that
   * borrowed the artwork behind it would be legible on some awards and not on others.
   */
  card: {
    alignItems: 'center',
    gap: theme.space[2],
    paddingVertical: theme.space[6],
    paddingHorizontal: theme.space[5],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.base,
    ...theme.elevation.e2,
  },
  // The badge's own box, so `TierDots` can position against its lower edge exactly as
  // it does in the sheet.
  badge: { width: BADGE, height: BADGE, marginBottom: theme.space[2] },
  name: { textAlign: 'center' },
});
