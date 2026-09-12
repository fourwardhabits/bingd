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
 * **Corroborated 2026-09-11, second pass, without ever reading the live page.** The 403 is
 * real and is not a user agent problem — `letterboxd.com` and `letterboxd.zendesk.com` both
 * refuse a scripted fetch outright. What could be established instead, from Letterboxd's
 * own indexed material rather than from third-party blogs:
 *   - the export lives on the **Data** tab of Settings, and `letterboxd.com/settings/data/`
 *     is a real Letterboxd page rather than a guessed path;
 *   - Letterboxd's own *Importing data* page describes it as "click to generate a zip file
 *     containing CSVs of your profile, films, reviews, lists and more" — a generated
 *     download, not a queued email;
 *   - nothing official conditions it on a subscription.
 *
 * That is enough to stop hedging the tab. It is **not** enough to claim the live UI was
 * read, so two things stay soft on purpose: the possibility of an emailed link on a large
 * account, and the mobile app, which is simply not mentioned — the export is a website URL
 * and sending somebody hunting for it in the app is a dead end our copy would have caused.
 *
 * The "Pro is required" claim recurs in secondary sources and is contradicted by the
 * founder's own free-account export, so it appears nowhere.
 *
 * **The button is still the authority, not this list.** It puts somebody in front of the
 * current UI instead of our description of it.
 */

/**
 * The Data tab itself, rather than the settings root.
 *
 * The root was the safer choice while the tab was a guess. It is not a guess now, and the
 * deep link saves the one step people actually get lost on — a settings page with a dozen
 * tabs, only one of which has the export on it. A stale path would land on Letterboxd's own
 * 404 rather than ours, with the site's navigation still on it.
 */
const LETTERBOXD_EXPORT = 'https://letterboxd.com/settings/data/';

const STEPS = [
  'Open letterboxd.com in a browser and sign in — the export lives on the website.',
  'Go to Settings, then the Data tab.',
  'Choose Export Your Data. Letterboxd builds a .zip of your account.',
  'It downloads when it is ready. A large account can take a minute, and Letterboxd may send you a link by email instead.',
  'Save the .zip somewhere your phone can reach — Files, Downloads or Drive all work.',
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
    void Linking.openURL(LETTERBOXD_EXPORT).catch(() => {});
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

        <Button label="Open Letterboxd’s export page" kind="secondary" onPress={open} />
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
