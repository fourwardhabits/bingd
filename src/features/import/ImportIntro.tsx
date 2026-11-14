import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ImportSurface } from '@/lib/analytics';
import { Button, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { ExportHelp } from './ExportHelp';
import { ProviderLogo } from './ProviderLogo';
import type { ImportProvider } from './providers';

/**
 * A service's page, before a file is chosen (IMP1113-UI, founder text t175u/t177u).
 *
 * One heading, one paragraph, one action, and the help one tap away. The always-visible
 * how-to card, the separate help button, the privacy block and *Choose a different
 * service* are gone (founder): the page is for somebody who has the file, and the steps are
 * for somebody who does not, so the steps wait behind *Need help getting the file?*.
 *
 * **Two accuracy edits to the founder's IMDb text**, recorded in the PR: *titles* became
 * *movies* (shows and episodes are not added from IMDb this release, so "titles" promised
 * more than arrives), and *add them to your collection* became *rank them* (they are already
 * in the collection once imported; the ranking flow is what turns them into scores).
 *
 * *Anything already ranked on bingd will keep its rating* is the importer's rule: a title
 * ranked or logged here is `kept`, untouched (`_import_settle`), and an IMDb or Letterboxd
 * rating never becomes a bingd score.
 */
export const INTRO_COPY = {
  imdb: {
    title: 'Bring over your IMDb history',
    body: 'Import the movies you’ve rated on IMDb. They join your collection unranked, and you can use the ranking flow to quickly rank them. Anything already ranked on bingd will keep its rating.',
    upload: 'Upload IMDb CSV',
  },
  letterboxd: {
    title: 'Bring over your Letterboxd history',
    // Films, diary and watchlist: the three things the Letterboxd import reads
    // (`archive.ts`). Watched films join the collection; watchlist titles join the
    // watchlist, which is why the second sentence names watched films only.
    body: 'Import the films you’ve watched on Letterboxd, plus your diary and watchlist. Watched films join your collection unranked, and you can use the ranking flow to quickly rank them. Anything already ranked on bingd will keep its rating.',
    upload: 'Upload Letterboxd ZIP',
  },
} as const satisfies Record<ImportProvider, { title: string; body: string; upload: string }>;

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
        <Text variant="display" accessibilityRole="header">
          {copy.title}
        </Text>
        <Text variant="body" tone="secondary">
          {copy.body}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button label={copy.upload} onPress={onPick} />
        {exit}
      </View>
      <ExportHelp provider={provider} surface={surface} />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[4] },
  words: { gap: theme.layout.section.headingToControls },
  actions: { gap: theme.space[2] },
});
