import { Linking, StyleSheet, View } from 'react-native';

import { track, type ImportSurface } from '@/lib/analytics';
import { Button, Disclosure, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { ImportProvider } from './providers';

/**
 * How to get the file, for the one step of this flow that happens in somebody else's app.
 *
 * IMP1113-UI: this copy moved here, verbatim, from `HowToExportSheet`, when the help became
 * an inline disclosure on the intro and on the failure screens instead of a sheet. The
 * evidence below is unchanged and still governs the words.
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
export const LETTERBOXD_EXPORT = 'https://letterboxd.com/settings/data/';

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
 *
 * Step 2 is no longer soft (2026-11-13): IMDb Help's Ratings FAQ (updated 9 Feb 2026) puts
 * the Export icon at the top right of Your Ratings, not in a menu. Taken from the founder's
 * brief, which checked the page; this environment still cannot reach imdb.com.
 */
export const IMDB_HOW_TO_STEPS = [
  'On imdb.com, sign in and open Your Ratings.',
  'Tap Export at the top right of Your Ratings.',
  'IMDb prepares a CSV file. When it’s ready, download it (IMDb may list it under Your exports).',
  'Come back to bingd and choose that CSV.',
] as const;

export const IMDB_RATINGS = 'https://www.imdb.com/list/ratings';

const HELP = {
  letterboxd: {
    steps: HOW_TO_STEPS,
    open: 'Open Letterboxd’s export page',
    url: LETTERBOXD_EXPORT,
  },
  imdb: {
    steps: IMDB_HOW_TO_STEPS,
    open: 'Open your IMDb ratings',
    url: IMDB_RATINGS,
  },
} as const satisfies Record<
  ImportProvider,
  { steps: readonly string[]; open: string; url: string }
>;

/**
 * *Need help getting the file?*, collapsed until asked (IMP1113-UI). The numbered steps and a
 * link to the provider's own page, which is the authority (the header above says why).
 *
 * The link counts `import_instructions_opened` exactly as the sheet's button did, so the
 * funnel keeps its meaning.
 */
export function ExportHelp({
  provider,
  surface,
}: {
  provider: ImportProvider;
  surface: ImportSurface;
}) {
  const help = HELP[provider];
  const open = () => {
    track({ name: 'import_instructions_opened', props: { surface, provider } });
    void Linking.openURL(help.url).catch(() => {});
  };

  return (
    <Disclosure label="Need help getting the file?" variant="callout" testID="export-help">
      <View style={styles.body}>
        {help.steps.map((step, index) => (
          <View key={step} style={styles.step}>
            <Text variant="subhead" tone="action" style={styles.number}>
              {index + 1}
            </Text>
            <Text variant="body" tone="secondary" style={styles.stepText}>
              {step}
            </Text>
          </View>
        ))}
        <Button label={help.open} kind="secondary" onPress={open} />
      </View>
    </Disclosure>
  );
}

const styles = StyleSheet.create({
  body: { gap: theme.space[3] },
  step: { flexDirection: 'row', gap: theme.space[3] },
  // A fixed width so the numbers form a column and the text a straight left edge.
  number: { width: theme.space[4], textAlign: 'right' },
  stepText: { flex: 1 },
});
