import { Linking, ScrollView, StyleSheet, View } from 'react-native';

import { track } from '@/lib/analytics';
import type { ImportSurface } from '@/lib/analytics';
import { Button, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { ImportProvider } from './providers';

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
 * read, and the mobile app is simply not mentioned — the export is a website URL and sending
 * somebody hunting for it in the app is a dead end our copy would have caused.
 *
 * **Re-checked 2026-09-14, and the tab has a new name.** Letterboxd's own pages are still a
 * 403 to a scripted fetch. Two independent current guides (listy.is and achriom.com, both
 * mid-2026) agree the export now lives under **Settings → Import & Export**, behind a control
 * labelled **Export your data**; the older name for that tab is *Data*, which is still the
 * path `LETTERBOXD_EXPORT` opens. The copy uses the current names. Whether the ZIP downloads
 * at once or arrives by email differs between those sources, so step 3 says *when it's
 * ready*, which is true of both.
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

/**
 * The four steps (founder, 2026-09-14), in the tab names the header records as current.
 */
export const HOW_TO_STEPS = [
  'Open Letterboxd.com and go to Settings → Import & Export.',
  'Choose Export your data to generate your export.',
  'Download the ZIP when it’s ready.',
  'Come back to bingd and choose that ZIP.',
] as const;

/**
 * **IMDb's steps, written to be true under either of the flows IMDb has shipped**
 * (20261113000100).
 *
 * Not verified against IMDb's live pages: this environment cannot reach imdb.com, so, as with
 * Letterboxd's first copy (`letterboxd-import.md` §4), the wording stays soft where the flow
 * may differ. What is solid: the export is the **Ratings** page's own export, it is a single
 * **CSV**, and recent IMDb prepares it and offers the download on an exports page rather than
 * immediately. The button opens the ratings page, which is where the control is in both.
 * Recorded as open for the founder in `docs/product/imdb-import.md`.
 */
export const IMDB_HOW_TO_STEPS = [
  'On imdb.com, sign in and open Your Ratings.',
  'Open the page’s menu and choose Export.',
  'IMDb prepares a CSV file. When it’s ready, download it (IMDb may list it under Your exports).',
  'Come back to bingd and choose that CSV.',
] as const;

const IMDB_RATINGS = 'https://www.imdb.com/list/ratings';

const SHEET = {
  letterboxd: {
    label: 'How to export from Letterboxd',
    title: 'Getting your Letterboxd file',
    steps: HOW_TO_STEPS,
    open: 'Open Letterboxd’s export page',
    url: LETTERBOXD_EXPORT,
  },
  imdb: {
    label: 'How to export from IMDb',
    title: 'Getting your IMDb file',
    steps: IMDB_HOW_TO_STEPS,
    open: 'Open your IMDb ratings',
    url: IMDB_RATINGS,
  },
} as const;

export function HowToExportSheet({
  visible,
  onClose,
  surface,
  provider = 'letterboxd',
}: {
  visible: boolean;
  onClose: () => void;
  surface: ImportSurface;
  /** Whose steps. Letterboxd when absent, which is every caller that predates the choice. */
  provider?: ImportProvider;
}) {
  const sheet = SHEET[provider];
  const open = () => {
    track({ name: 'import_instructions_opened', props: { surface, provider } });
    void Linking.openURL(sheet.url).catch(() => {});
  };

  return (
    <Sheet visible={visible} onClose={onClose} label={sheet.label}>
      {/**
       * **The sheet's own layout, the way the Details sheet draws it** (founder, physical
       * preview QA, 2026-09-14: the first version ran edge to edge). `Sheet` supplies the
       * panel, the handle and the safe-area padding under the last child, and no horizontal
       * padding, so the content brings the gutter. The steps scroll inside the panel's 90%
       * cap (shrink, no grow) and the two actions stay below them, so the largest text sizes
       * cannot push Done off the sheet. Same shape as `TitleRecallSheet`.
       */}
      <View style={styles.sheet}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
          <Text variant="headline">{sheet.title}</Text>

          <View style={styles.steps}>
            {sheet.steps.map((step, index) => (
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
        </ScrollView>

        <View style={styles.foot}>
          <Button label={sheet.open} onPress={open} />
          <Button label="Done" kind="secondary" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingTop: theme.space[2], flexShrink: 1 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  // The wrapper's `space[2]` is the gap under the handle (design-system.md, Layout
  // invariants), so the body pads the sides and the bottom only.
  body: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.layout.gutter,
    gap: theme.space[4],
  },
  steps: { gap: theme.space[3] },
  step: { flexDirection: 'row', gap: theme.space[3] },
  // A fixed width so the numbers form a column and the text a straight left edge.
  number: { width: theme.space[4], textAlign: 'right' },
  stepText: { flex: 1 },
  foot: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    gap: theme.space[2],
  },
});
