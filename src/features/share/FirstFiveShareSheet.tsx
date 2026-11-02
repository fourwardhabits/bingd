import { useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { track } from '@/lib/analytics';
import { Button, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { FIRST_FIVE_CARD_SIZE, FirstFiveCard } from './FirstFiveCard';
import { firstFiveMessage, firstFiveSpokenSummary, type FirstFiveRow } from './first-five';
import { shareCardImage, shareCardText } from './share-card';

export type FirstFiveShareSheetProps = {
  rows: readonly FirstFiveRow[];
  username: string;
  onClose: () => void;
};

/** The heading, the actions and the sheet's own padding, kept clear of the card. */
const SHEET_CHROME = 188;
/** `Sheet` caps itself at 90% of the screen. */
const SHEET_MAX_SHARE = 0.9;

/**
 * Shows the card before anything leaves the phone, then hands it to the system sheet.
 *
 * The preview is the card itself, scaled to fit, rather than a second copy with the real
 * one hidden off screen: a view the reader can see is the one view certain to be laid out
 * and painted when it is captured, and what they approve is exactly what gets sent.
 *
 * The reader's choice of where it goes belongs to the OS. Nothing here is posted and
 * nothing names a platform. Dismissing the system sheet closes this one too, because the
 * OS does not say whether anything was sent, and asking again would be nagging.
 */
export function FirstFiveShareSheet({ rows, username, onClose }: FirstFiveShareSheetProps) {
  const card = useRef<View>(null);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const available = {
    width: screenWidth - theme.layout.gutter * 2,
    height: screenHeight * SHEET_MAX_SHARE - SHEET_CHROME,
  };
  const scale = Math.min(
    1,
    available.width / FIRST_FIVE_CARD_SIZE.width,
    available.height / FIRST_FIVE_CARD_SIZE.height,
  );

  const shareImage = async () => {
    setBusy(true);
    try {
      await shareCardImage(card, 'Share your First Five');
      track({ name: 'first_five_shared', props: { kind: 'image' } });
      onClose();
    } catch {
      track({ name: 'first_five_share_failed' });
      setImageFailed(true);
      setBusy(false);
    }
  };

  const shareText = async () => {
    setBusy(true);
    try {
      await shareCardText(firstFiveMessage(rows));
      track({ name: 'first_five_shared', props: { kind: 'text' } });
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <Sheet visible onClose={onClose} label="Share your First Five">
      <View style={styles.content}>
        <Text variant="title2">Share your First Five</Text>

        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={firstFiveSpokenSummary(rows)}
          style={[
            styles.preview,
            {
              width: FIRST_FIVE_CARD_SIZE.width * scale,
              height: FIRST_FIVE_CARD_SIZE.height * scale,
            },
          ]}
        >
          <View style={[styles.previewCard, { transform: [{ scale }] }]}>
            <FirstFiveCard ref={card} rows={rows} username={username} />
          </View>
        </View>

        {imageFailed ? (
          <Text variant="footnote" tone="secondary" testID="first-five-share-failed">
            We could not make the image. You can still share your list as text.
          </Text>
        ) : null}

        <View style={styles.actions}>
          <View style={styles.action}>
            <Button label="Not now" kind="secondary" fit onPress={onClose} />
          </View>
          <View style={styles.action}>
            <Button
              label={imageFailed ? 'Share as text' : 'Share'}
              fit
              disabled={busy}
              disabledReason="Preparing your card."
              onPress={() => void (imageFailed ? shareText() : shareImage())}
            />
          </View>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    gap: theme.space[3],
  },
  preview: {
    alignSelf: 'center',
    borderRadius: theme.radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    overflow: 'hidden',
  },
  previewCard: {
    width: FIRST_FIVE_CARD_SIZE.width,
    height: FIRST_FIVE_CARD_SIZE.height,
    transformOrigin: 'top left',
  },
  actions: { flexDirection: 'row', gap: theme.space[2] },
  action: { flex: 1 },
});
