import { forwardRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { formatScore } from '@/features/collection/score';
import { Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import type { FirstFiveRow } from './first-five';

/**
 * The card's own size, in points.
 *
 * 4:5, the one shape that needs no second version: it fills a feed post, sits whole in a
 * Story with no safe-zone work, and reads at thumbnail size in a message thread. Captured
 * at the device's own pixel ratio rather than resized, which is 1080 by 1350 on a 3x phone
 * and stays sharp everywhere else. Resizing would soften the type, and the type is the
 * whole card.
 */
export const FIRST_FIVE_CARD_SIZE = { width: 360, height: 450 } as const;

export type FirstFiveCardProps = {
  rows: readonly FirstFiveRow[];
  username: string;
};

/**
 * The share card: the reader's own five, in words.
 *
 * **Text only, and that is a build rule as well as a design.** No poster artwork, because
 * whether artwork may leave an app screenshot is an open licensing question. And no image
 * of any kind, the wordmark included: Android draws a capture to a software canvas, which
 * cannot read the hardware bitmaps an image view holds, so plain text is what makes the
 * capture safe as well as distinctive.
 *
 * **No text here scales with the system size.** This is an image of fixed proportions. On
 * screen it would overflow at a large setting, and the file it produces must not depend on
 * who made it.
 *
 * `collapsable={false}` because a view the renderer flattens away cannot be captured.
 */
export const FirstFiveCard = forwardRef<View, FirstFiveCardProps>(function FirstFiveCard(
  { rows, username },
  ref,
) {
  return (
    <View ref={ref} collapsable={false} style={styles.card} testID="first-five-card">
      <View style={styles.body}>
        <View style={styles.brandRow}>
          <Text variant="title2" allowFontScaling={false} style={styles.wordmark}>
            bingd.
          </Text>
          <Text
            variant="callout"
            tone="secondary"
            allowFontScaling={false}
            numberOfLines={1}
            style={styles.handle}
          >
            @{username}
          </Text>
        </View>

        <Text variant="display" allowFontScaling={false} style={styles.heading}>
          My First Five
        </Text>

        <View style={styles.rows}>
          {rows.map((row) => (
            <View key={row.mediaItemId} style={styles.row} testID="first-five-card-row">
              <Text variant="title1" allowFontScaling={false} style={styles.rank}>
                {row.rank}
              </Text>
              <Text allowFontScaling={false} numberOfLines={2} style={styles.title}>
                {row.title}
                {row.year ? <Text style={styles.year}>{`\u00A0\u00A0${row.year}`}</Text> : null}
              </Text>
              <View style={styles.score}>
                <Text variant="score" allowFontScaling={false} style={styles.scoreText}>
                  {formatScore(row.score)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.invitation}>
        <Text allowFontScaling={false} style={styles.question}>
          What’s your first five?
        </Text>
        <Text variant="callout" allowFontScaling={false} style={styles.answer}>
          Rank yours free at bingd.app
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    width: FIRST_FIVE_CARD_SIZE.width,
    height: FIRST_FIVE_CARD_SIZE.height,
    backgroundColor: theme.surface.sunken,
    overflow: 'hidden',
  },
  body: {
    flex: 1,
    paddingHorizontal: theme.space[6],
    paddingTop: theme.space[5],
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space[4],
  },
  wordmark: { color: theme.semantic.action },
  handle: { flexShrink: 1 },
  heading: { marginTop: theme.space[3] },
  rows: { marginTop: theme.space[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 50,
    gap: theme.space[3],
  },
  rank: { width: 20, textAlign: 'center', color: theme.semantic.score },
  title: {
    flex: 1,
    fontFamily: fontFamily.serif,
    fontSize: 18,
    lineHeight: 21,
    color: theme.text.primary,
  },
  year: {
    fontFamily: fontFamily.sans,
    fontSize: 12,
    color: theme.text.tertiary,
  },
  score: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.semantic.score,
  },
  scoreText: { color: theme.semantic.scoreInk, fontSize: 14, lineHeight: 17 },
  invitation: {
    paddingHorizontal: theme.space[6],
    paddingVertical: theme.space[4],
    gap: 2,
    backgroundColor: theme.semantic.action,
  },
  question: {
    fontFamily: fontFamily.serif,
    fontSize: 20,
    lineHeight: 24,
    color: theme.text.inverse,
  },
  answer: { color: theme.text.inverse },
});
