import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ImportSurface } from '@/lib/analytics';
import { ActionPair, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { ExportHelp, openProviderExport } from './ExportHelp';
import { ProviderLogo } from './ProviderLogo';
import type { ImportProvider } from './providers';

/**
 * A service's page, before a file is chosen (IMP1113-UI, founder text t175u/t177u; polished
 * QA 11-14, §7).
 *
 * One heading, one short paragraph, two actions side by side, and the help one tap away. The
 * always-visible how-to card, the separate help button, the privacy block and *Choose a
 * different service* are gone (founder): the page is for somebody who has the file, and the
 * steps are for somebody who does not, so the steps wait behind *Need help getting the
 * file?*.
 *
 * **The heading is `title1`**, the editorial page title (design-system.md §4), as the
 * onboarding question already was; `display` is for share cards and milestones, which the
 * summaries still are.
 *
 * **Two actions, `ActionPair`** (QA 11-14, §7): *Export* leading and secondary, which opens
 * the provider's own export page and never starts an import; *Upload* trailing and Maroon,
 * the existing picker. Equal halves, stacked primary-first when the labels do not both fit
 * (at the measured widths: IMDb sits in a row from 378pt, Letterboxd's longer labels stack
 * on a phone). The help keeps its steps and loses its own export button, which would now
 * repeat the one above it.
 *
 * **The copy is the importer's behaviour.** IMDb: the founder's wording. Letterboxd: close to
 * the founder's suggestion, with one deviation recorded in the PR. *Titles join your
 * collection* is not what happens: the import reads `watched.csv`, `ratings.csv`,
 * `diary.csv` and `watchlist.csv` only (`archive.ts`); watched films join the collection
 * unranked, diary entries add watch dates to them, and watchlist titles join the watchlist.
 * *Existing scores stay the same* / *keeps its score* is the importer's rule: a title ranked
 * or logged here is `kept`, untouched (`_import_settle`), and an IMDb or Letterboxd rating
 * never becomes a bingd score.
 */
export const INTRO_COPY = {
  imdb: {
    title: 'Bring over your IMDb history',
    body: 'Movies you’ve rated join your collection unranked. Rank them using bingd’s ranking flow. Anything already ranked keeps its score.',
    export: 'IMDb Export',
    upload: 'Upload IMDb file',
  },
  letterboxd: {
    title: 'Bring over your Letterboxd history',
    body: 'Bring over your watched films, diary, and watchlist. Watched films join your collection unranked, ready to rank. Watchlist titles join your watchlist. Existing scores stay the same.',
    export: 'Letterboxd Export',
    upload: 'Upload Letterboxd file',
  },
} as const satisfies Record<
  ImportProvider,
  { title: string; body: string; export: string; upload: string }
>;

export function ImportIntro({
  provider,
  surface,
  onPick,
  exit,
}: {
  provider: ImportProvider;
  surface: ImportSurface;
  /** The existing picker. */
  onPick: () => void;
  /** The onboarding step's *Not now*, where this page is a step of onboarding. */
  exit?: ReactNode;
}) {
  const copy = INTRO_COPY[provider];
  return (
    <View style={styles.block} testID={`import-intro-${provider}`}>
      <ProviderLogo provider={provider} size={theme.layout.icon.lg} />
      <View style={styles.words}>
        <Text variant="title1" accessibilityRole="header">
          {copy.title}
        </Text>
        <Text variant="body" tone="secondary">
          {copy.body}
        </Text>
      </View>
      <View style={styles.actions}>
        <ActionPair
          testID="import-intro-actions"
          secondary={{
            label: copy.export,
            onPress: () => openProviderExport(provider, surface),
            testID: 'import-intro-export',
          }}
          primary={{ label: copy.upload, onPress: onPick, testID: 'import-intro-upload' }}
        />
        {exit}
      </View>
      <ExportHelp provider={provider} surface={surface} withLink={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[4] },
  words: { gap: theme.layout.section.headingToControls },
  actions: { gap: theme.space[2] },
});
