import { Ionicons } from '@expo/vector-icons';
import { Linking, StyleSheet, View } from 'react-native';

import { track } from '@/lib/analytics';
import type { ImportSurface } from '@/lib/analytics';
import { Button, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * How to get the file, for the one step of this flow that happens in somebody else's app.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS VERIFIED HERE, AND WHAT IS NOT
 *
 * The founder's instruction was not to write these steps from memory, and that turned out
 * to matter: every Letterboxd URL answers a scripted fetch with HTTP 403, so the live
 * settings page could not be read while writing this. What follows is therefore split
 * deliberately between what is *evidence* and what is *description*.
 *
 * **Verified, from the founder's own export committed at
 * `src/features/import/__fixtures__/real-export.ts`:**
 *   - the export is a ZIP of CSV files;
 *   - it contains `watched.csv`, `ratings.csv`, `diary.csv`, `watchlist.csv` and more;
 *   - it was produced by a **free** account, which is why nothing below says "Pro".
 *
 * **Not verified, and written to be true either way:** where exactly the control sits, and
 * how the file is delivered. Secondary sources disagree — some describe Settings ▸ Data,
 * others Settings ▸ Advanced Settings, some an immediate download and others an emailed
 * link. Rather than assert one and be wrong for half of the people reading it, the copy
 * names the destination, admits the alternative label, and covers both deliveries in one
 * sentence.
 *
 * **So the button is the authority, not this list.** `letterboxd.com/settings` is the one
 * URL that is certainly real regardless of which sub-tab the export lives on, and it puts
 * somebody in front of the current UI instead of our description of it. If these steps
 * drift, the button still works.
 *
 * **Open question for the founder**, recorded rather than guessed: confirm the current
 * label and the delivery, and this copy can lose its hedge. `docs/product/letterboxd-import.md`
 * carries it as an open item.
 */

/**
 * The settings root rather than a deep link to the export tab.
 *
 * A deep link would be one better tap and one worse failure: if the path has changed it
 * lands on a 404, which reads as "this app is broken" rather than "look in Settings". The
 * root has been stable for the life of the site.
 */
const LETTERBOXD_SETTINGS = 'https://letterboxd.com/settings/';

const STEPS = [
  'Sign in to Letterboxd — in their app or at letterboxd.com.',
  'Open Settings, then look for Data. Some versions call it Advanced Settings; the option you want is Export Your Data.',
  'Tap Export Your Data. Letterboxd builds a .zip file of your account.',
  'Depending on your account, it either downloads straight away or arrives by email a few minutes later.',
  'Save the .zip where you can find it again — Files, Downloads or Drive all work.',
] as const;

export function HowToExportSheet({
  visible,
  onClose,
  surface,
}: {
  visible: boolean;
  onClose: () => void;
  surface: ImportSurface;
}) {
  const open = () => {
    track({ name: 'import_instructions_opened', props: { surface } });
    void Linking.openURL(LETTERBOXD_SETTINGS).catch(() => {});
  };

  return (
    <Sheet visible={visible} onClose={onClose} label="How to export from Letterboxd">
      <View style={styles.body}>
        <Text variant="headline">Getting your export</Text>

        <View style={styles.steps}>
          {STEPS.map((step, index) => (
            <View key={step} style={styles.step}>
              <Text variant="subhead" tone="action" style={styles.number}>
                {index + 1}
              </Text>
              <Text variant="body" tone="secondary" style={styles.stepText}>
                {step}
              </Text>
            </View>
          ))}
        </View>

        {/* **The one instruction that is ours rather than Letterboxd's**, and the one people
            get wrong: a desktop browser will happily unzip the archive on download, and a
            folder cannot be handed to a file picker. Said plainly and given its own place,
            because it is the difference between this working and a confusing refusal. */}
        <View style={styles.note}>
          <Ionicons
            name="information-circle-outline"
            size={theme.layout.icon.sm}
            color={theme.text.tertiary}
          />
          <Text variant="footnote" tone="tertiary" style={styles.noteText}>
            Choose the .zip file itself. If your computer unzipped it for you, use the
            original download rather than the folder.
          </Text>
        </View>

        <Button label="Open Letterboxd settings" kind="secondary" onPress={open} />
        <Button label="Done" kind="tertiary" onPress={onClose} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: theme.space[4], paddingBottom: theme.space[2] },
  steps: { gap: theme.space[3] },
  step: { flexDirection: 'row', gap: theme.space[3] },
  // A fixed width so the numbers form a column and the text a straight left edge, rather
  // than each step hanging from wherever its own digit ended.
  number: { width: theme.space[4], textAlign: 'right' },
  stepText: { flex: 1 },
  note: {
    flexDirection: 'row',
    gap: theme.space[2],
    alignItems: 'flex-start',
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    padding: theme.space[3],
  },
  noteText: { flex: 1 },
});
