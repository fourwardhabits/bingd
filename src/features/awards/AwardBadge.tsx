import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { Badge } from './badges';

export type AwardBadgeProps = {
  badge: Badge;
  /** False draws the locked treatment. */
  earned: boolean;
  size?: number;
};

/**
 * One badge, in one of two states.
 *
 * **Locked is the same artwork, faded, on a sunken well.** The founder asked for a
 * greyed or outlined version of the next tier rather than a second set of files, and
 * this is the version of that React Native can actually do: there is no greyscale
 * filter on `Image` on either platform, and `tintColor` is not desaturation — it
 * replaces every opaque pixel with one colour, which turns a popcorn bucket with a face
 * into a maroon blob. Opacity keeps the silhouette and the detail, and the well behind
 * it is what makes the fade read as *locked* rather than as a loading state.
 *
 * The well is drawn in both states, so a row does not change shape when a tier is
 * earned — only its contents brighten.
 *
 * Emoji and artwork sit in the same box at the same size. Ten of the twenty tracks have
 * no art yet (`badges.ts`), and a placeholder that changed the row's geometry would make
 * the sheet look half-built rather than half-illustrated.
 */
export function AwardBadge({ badge, earned, size = theme.layout.awardBadge }: AwardBadgeProps) {
  const inner = size - theme.space[2];

  return (
    <View
      style={[
        styles.well,
        { width: size, height: size, borderRadius: size / 2 },
        earned ? styles.wellEarned : styles.wellLocked,
      ]}
    >
      <View style={earned ? undefined : styles.locked}>
        {badge.kind === 'art' ? (
          <Image
            source={badge.source}
            style={{ width: inner, height: inner }}
            // Never `cover`: these are square canvases with the art centred at its own
            // scale, and cropping one would cut the crown off the gold bucket.
            contentFit="contain"
            transition={0}
          />
        ) : (
          <Text
            variant="title2"
            style={[styles.emoji, { fontSize: inner * 0.62, lineHeight: inner }]}
            allowFontScaling={false}
          >
            {badge.emoji}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  well: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  wellEarned: { backgroundColor: theme.surface.sunken },
  /** Flatter and cooler than the earned well, with a ring rather than a fill. */
  wellLocked: {
    backgroundColor: theme.surface.base,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
  },
  locked: { opacity: 0.32 },
  emoji: { textAlign: 'center' },
});
