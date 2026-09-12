import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import type { ImportSurface } from '@/lib/analytics';
import { Button, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { HowToExportSheet } from './HowToExportSheet';
import type { ArchivePreview } from './read-archive';
import { useImport, type ImportCounts, type ImportFailure, type ImportPhase } from './use-import';

/**
 * The importer, as one screen that changes rather than a flow of several.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE SCREEN
 *
 * Each phase replaces the last in place, under a heading that stays put. A person watching
 * this is waiting on something they cannot influence, and a route change per step would
 * make a back gesture mean five different things — including "abandon an upload halfway",
 * which is the one it must never quietly mean.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE COPY IS FOR
 *
 * Three promises, made before the file is chosen rather than after, because they are the
 * grounds on which somebody decides:
 *
 *   1. what is read      four files, named
 *   2. what is not read  reviews, comments, likes, lists and deleted activity — and the
 *                        word is *never opened*, because `archive.ts` makes that literally
 *                        true rather than a policy we apply afterwards
 *   3. what is kept      film names, years, ratings and dates; not the archive
 *
 * Contract V3 §14 is the third one's source, and `20260917000400` is what makes it true of
 * the rows that could not be matched as well as the ones that could.
 */
export function ImportScreen({ surface }: { surface: ImportSurface }) {
  const router = useRouter();
  const { state, pick, start, reset, watchRunning } = useImport(surface);
  const [howTo, setHowTo] = useState(false);

  return (
    <Screen includeBottomInset>
      <ScrollView contentContainerStyle={styles.page}>
        <Body
          state={state}
          onPick={() => void pick()}
          onStart={(preview) => void start(preview)}
          onReset={reset}
          onWatch={watchRunning}
          onHowTo={() => setHowTo(true)}
          onDone={() => router.back()}
        />
      </ScrollView>
      <HowToExportSheet visible={howTo} onClose={() => setHowTo(false)} surface={surface} />
    </Screen>
  );
}

function Body({
  state,
  onPick,
  onStart,
  onReset,
  onWatch,
  onHowTo,
  onDone,
}: {
  state: ImportPhase;
  onPick: () => void;
  onStart: (preview: ArchivePreview) => void;
  onReset: () => void;
  onWatch: () => void;
  onHowTo: () => void;
  onDone: () => void;
}) {
  switch (state.phase) {
    case 'idle':
      return <Intro onPick={onPick} onHowTo={onHowTo} />;

    case 'reading':
      return <Waiting title="Reading your export" detail="This stays on your phone." />;

    case 'previewing':
      return <Preview preview={state.preview} onStart={() => onStart(state.preview)} onReset={onReset} />;

    case 'uploading':
      return (
        <Waiting
          title="Sending your history"
          detail={
            state.total > 1
              ? // `Math.min`, because after the last page `sent === total` and the screen
                // stays up for the whole `import_ready` round trip — long enough to read
                // "Part 10 of 9" on any export over five hundred rows.
                `Part ${Math.min(state.sent + 1, state.total)} of ${state.total}. Keep the app open for this bit.`
              : 'Keep the app open for this bit.'
          }
        />
      );

    case 'working':
      // **The only screen that says the app may be closed, because it is the only one where
      // that is true.** After `import_ready` the work is on a cron tick with no client
      // attached; before it, closing the app stops the upload.
      return (
        <Waiting
          title="Matching your films"
          detail="This carries on without you — you can close the app and come back."
        />
      );

    case 'done':
      return <Summary counts={state.status.counts} onDone={onDone} onReset={onReset} />;

    case 'failed':
      return (
        <Failed
          failure={state.failure}
          onRetry={state.preview ? () => onStart(state.preview!) : onPick}
          retryLabel={state.preview ? 'Try again' : 'Choose a file'}
          onHowTo={onHowTo}
          onReset={onReset}
          onWatch={onWatch}
        />
      );
  }
}

function Intro({ onPick, onHowTo }: { onPick: () => void; onHowTo: () => void }) {
  return (
    <View style={styles.block}>
      <Text variant="display">Bring your Letterboxd history</Text>
      <Text variant="body" tone="secondary">
        Your films land in your collection, and your ratings become Loved, Fine or Not for me
        — so Bingd knows your taste from day one instead of asking you to start over.
      </Text>

      <View style={styles.card}>
        <Line icon="checkmark-circle-outline" tone="action">
          Films you&rsquo;ve watched, with the dates you watched them
        </Line>
        <Line icon="checkmark-circle-outline" tone="action">
          Your ratings, and your watchlist
        </Line>
        {/* Named individually rather than as "we ignore the rest". `deleted/` is the one
            that matters most and the one nobody would think to ask about, so it is said
            out loud. */}
        <Line icon="close-circle-outline">
          Never opened: your reviews, comments, likes, lists, or anything you deleted
        </Line>
      </View>

      {/* **This sentence names the Letterboxd links, and an earlier draft did not.**

          It said "only the film names, years, ratings and dates above", which was not what
          crosses the wire: `filmUri` becomes `imported_titles.letterboxd_uri` and each
          viewing's `diaryUri` becomes `imported_watches.diary_uri`, both kept permanently —
          the second is `not null` and half the primary key, which is what makes re-importing
          the same diary a no-op instead of a pile of duplicates.

          A diary link resolves to that person's own entry page, so leaving it out of the one
          sentence somebody reads before deciding was the omission least defensible here. The
          links are worth keeping; pretending they are not sent is not. */}
      <Text variant="footnote" tone="tertiary">
        The .zip stays on your phone. Bingd receives what&rsquo;s listed above — names, years,
        ratings and dates — along with the Letterboxd links that identify each film and each
        viewing. Nothing else from the archive is sent, and no copy of it is kept.
      </Text>

      <View style={styles.actions}>
        <Button label="Choose your export" onPress={onPick} />
        <Button label="How do I export from Letterboxd?" kind="tertiary" onPress={onHowTo} />
      </View>
    </View>
  );
}

function Preview({
  preview,
  onStart,
  onReset,
}: {
  preview: ArchivePreview;
  onStart: () => void;
  onReset: () => void;
}) {
  const { counts } = preview.normalised;

  return (
    <View style={styles.block}>
      <Text variant="display">Here&rsquo;s what we found</Text>
      <Text variant="body" tone="secondary">
        Nothing has been sent yet. Have a look, then decide.
      </Text>

      <View style={styles.card}>
        <Stat label="Films watched" value={counts.watched} />
        <Stat label="With a rating" value={counts.rated} />
        <Stat label="On your watchlist" value={counts.watchlist} />
        <Stat label="Viewings with a date" value={counts.watches} />
      </View>

      {/* **Only shown when there is something to say.** A permanent "0 rows we couldn't
          read" line teaches people to ignore the place a real warning would appear. */}
      {counts.malformed > 0 || counts.damagedFiles > 0 ? (
        <View style={styles.warning}>
          <Ionicons
            name="alert-circle-outline"
            size={theme.layout.icon.sm}
            color={theme.text.tertiary}
          />
          <Text variant="footnote" tone="tertiary" style={styles.warningText}>
            {counts.damagedFiles > 0
              ? `${counts.damagedFiles === 1 ? 'One file' : `${counts.damagedFiles} files`} in the archive couldn't be read and ${counts.damagedFiles === 1 ? 'was' : 'were'} skipped. Everything else is here.`
              : `${counts.malformed} ${counts.malformed === 1 ? 'row' : 'rows'} couldn't be read and ${counts.malformed === 1 ? 'was' : 'were'} skipped.`}
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button label={importLabel(counts.watched + counts.watchlist)} onPress={onStart} />
        <Button label="Choose a different file" kind="tertiary" onPress={onReset} />
      </View>
    </View>
  );
}

/** "Import 1 film", not "Import 1 films". Every other string on this screen singularises. */
const importLabel = (films: number) => `Import ${films} ${films === 1 ? 'film' : 'films'}`;

function Summary({
  counts,
  onDone,
  onReset,
}: {
  counts: ImportCounts;
  onDone: () => void;
  onReset: () => void;
}) {
  const applied = counts.applied ?? 0;
  // **`stragglers` counts here too.** `_import_settle` reports rows still `pending` or
  // `matched` at settle as their own bucket, and leaving them out of this total made the
  // summary's numbers fail to add up to the number of films the preview promised — while
  // saying nothing at all about the difference. A row nobody placed is unresolved to the
  // person reading this, whatever the worker's internal reason for not placing it.
  const unresolved =
    (counts.ambiguous ?? 0) + (counts.unmatched ?? 0) + (counts.stragglers ?? 0);

  return (
    <View style={styles.block}>
      <Text variant="display">{applied > 0 ? 'Your history is in' : 'Import finished'}</Text>

      <View style={styles.card}>
        <Stat label="Added to your collection" value={counts.watched ?? 0} />
        <Stat label="Added to your watchlist" value={counts.watchlist ?? 0} />
        <Stat label="Viewings recorded" value={counts.viewings ?? 0} />
      </View>

      {/* **The unmatched count is shown rather than rounded away.** These are films the
          catalogue could not place — a remake it cannot tell apart, or something it simply
          does not have — and hiding them would make a partial import look complete. Their
          names are the only thing kept on the server for them (20260917000400), which is
          exactly what a repair surface needs and nothing more. */}
      {unresolved > 0 ? (
        <Text variant="footnote" tone="tertiary">
          {unresolved === 1 ? 'One film' : `${unresolved} films`} couldn&rsquo;t be matched to
          anything in Bingd&rsquo;s catalogue. We&rsquo;ve kept{' '}
          {unresolved === 1 ? 'its name' : 'their names'} so you can add{' '}
          {unresolved === 1 ? 'it' : 'them'} yourself.
        </Text>
      ) : null}

      <Text variant="footnote" tone="tertiary">
        Imported films sit in your collection as watched. Rank them whenever you like — a
        ranking you do yourself always wins.
      </Text>

      <View style={styles.actions}>
        <Button label="Done" onPress={onDone} />
        {/* **A way on, because this screen is now reachable without having just used it.**
            A finished import is restored for a day after it completes, so somebody who
            closed the app during "Matching your films" gets the summary they were owed —
            and somebody with a second archive would otherwise meet the same summary with
            only a Done button on it, which is a dead end wearing a tick. */}
        <Button label="Import another file" kind="tertiary" onPress={onReset} />
      </View>
    </View>
  );
}

/**
 * What went wrong, and what to do about it.
 *
 * Every message names the next action. "Something went wrong" with no way forward is the
 * failure mode this exists to avoid — most of these are recoverable in one tap, and the two
 * that are not say so plainly rather than inviting a pointless retry.
 */
function Failed({
  failure,
  onRetry,
  retryLabel,
  onHowTo,
  onReset,
  onWatch,
}: {
  failure: ImportFailure;
  onRetry: () => void;
  retryLabel: string;
  onHowTo: () => void;
  onReset: () => void;
  onWatch: () => void;
}) {
  const { title, detail, showHowTo } = explain(failure);

  // **Two failures have nothing to retry, and offering it anyway is how a dead end gets
  // built.** An import that is already running and one this client has lost sight of are
  // both cases where the work is fine and pressing a button cannot help — the answer is to
  // come back later. A prominent "Try again" there would fail identically every time.
  const retryable = failure.kind !== 'already_running' && failure.kind !== 'unknown';

  // **A refusal that can show you what it is refusing about.** `already_running` means this
  // archive was not sent because another import owns the slot; naming that without offering
  // a look at it leaves somebody guessing which of their files is in flight.
  const watchable = failure.kind === 'already_running' && failure.status !== undefined;

  return (
    <View style={styles.block}>
      <Text variant="display">{title}</Text>
      <Text variant="body" tone="secondary">
        {detail}
      </Text>
      <View style={styles.actions}>
        {retryable ? <Button label={retryLabel} onPress={onRetry} /> : null}
        {watchable ? <Button label="See the import that’s running" onPress={onWatch} /> : null}
        {showHowTo ? (
          <Button label="How do I export from Letterboxd?" kind="tertiary" onPress={onHowTo} />
        ) : null}
        <Button
          label="Start over"
          kind={retryable || watchable ? 'tertiary' : 'primary'}
          onPress={onReset}
        />
      </View>
    </View>
  );
}

function explain(failure: ImportFailure): {
  title: string;
  detail: string;
  showHowTo: boolean;
} {
  if (failure.kind === 'upload') {
    return {
      title: 'That didn’t finish sending',
      // True, and the reason it is worth saying: `import_create` reuses the open job and
      // `import_rows_once` makes an already-sent page free, so a retry really does pick up.
      detail:
        'Your connection dropped part-way. Trying again picks up where it stopped — nothing is sent twice.',
      showHowTo: false,
    };
  }

  if (failure.kind === 'already_running') {
    return {
      title: 'An import is already running',
      // Says plainly that *this* file was not sent. The earlier version described the other
      // import and left somebody to infer what had happened to the one they just chose —
      // and the screen it led to showed the running job's counts under "Your history is
      // in", which made the wrong inference the natural one.
      detail:
        'This file hasn’t been sent — one of your earlier imports is still going, and Bingd runs one at a time. That one carries on without the app open. Come back when it’s done and you can import this file then.',
      showHowTo: false,
    };
  }

  if (failure.kind === 'unknown') {
    return {
      title: 'We’ve lost track of that import',
      detail:
        'It’s still running on our side — this app just can’t see how far along it is. Check your connection and open this screen again in a few minutes.',
      showHowTo: false,
    };
  }

  if (failure.kind === 'server') {
    return {
      title: 'The import couldn’t be completed',
      detail:
        'Something went wrong on our side, and nothing has been changed in your collection. Please try again later, or let us know from Settings if it keeps happening.',
      showHowTo: false,
    };
  }

  if (failure.kind === 'unreadable') {
    return {
      title: 'That file couldn’t be opened',
      detail: 'Try choosing it again. If it lives in a cloud folder, download it first.',
      showHowTo: false,
    };
  }

  switch (failure.reason) {
    case 'not_a_zip':
      return {
        title: 'That’s not the export file',
        detail:
          'Letterboxd sends a .zip. If your computer unzipped it for you, go back to the original download rather than the folder — a single .csv isn’t enough on its own.',
        showHowTo: true,
      };
    case 'not_letterboxd':
      return {
        title: 'That .zip isn’t a Letterboxd export',
        detail:
          'It doesn’t contain the files a Letterboxd export has. Check you picked the right archive.',
        showHowTo: true,
      };
    case 'empty':
      return {
        title: 'There’s nothing in there yet',
        detail:
          'That export is a valid one — it just has no films in it. Log something on Letterboxd, export again, and it will have something to bring across.',
        showHowTo: false,
      };
    case 'damaged':
      return {
        title: 'That archive couldn’t be read',
        detail:
          'It looks incomplete, which usually means the download was interrupted. Download it from Letterboxd again.',
        showHowTo: true,
      };
    case 'too_large':
    case 'too_many_entries':
    case 'entry_too_large':
      return {
        title: 'That file is too big',
        detail:
          'It’s far larger than any Letterboxd export, so Bingd won’t open it. Check you picked the export and not something else. If this really is your export, let us know from Settings.',
        showHowTo: true,
      };
    case 'unexpected':
      // Our bug, not theirs, and the copy should not imply otherwise by suggesting they
      // picked the wrong thing.
      return {
        title: 'Something went wrong reading that',
        detail:
          'Bingd couldn’t make sense of the file, and that’s on us rather than on you. Trying again is worth a go; if it keeps happening, let us know from Settings.',
        showHowTo: false,
      };
  }
}

function Waiting({ title, detail }: { title: string; detail: string }) {
  return (
    <View style={styles.waiting}>
      <ActivityIndicator color={theme.semantic.action} />
      <Text variant="headline">{title}</Text>
      <Text variant="footnote" tone="tertiary" style={styles.centred}>
        {detail}
      </Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <Text variant="body" style={styles.statLabel}>
        {label}
      </Text>
      <Text variant="headline">{value}</Text>
    </View>
  );
}

function Line({
  icon,
  tone,
  children,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  tone?: 'action';
  children: React.ReactNode;
}) {
  return (
    <View style={styles.line}>
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={tone === 'action' ? theme.semantic.action : theme.text.tertiary}
      />
      <Text variant="footnote" tone="secondary" style={styles.lineText}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: theme.layout.gutter, paddingBottom: theme.space[10] },
  block: { gap: theme.space[4] },
  card: {
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    padding: theme.space[4],
    gap: theme.space[3],
  },
  line: { flexDirection: 'row', gap: theme.space[3], alignItems: 'flex-start' },
  lineText: { flex: 1 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  statLabel: { flex: 1 },
  warning: {
    flexDirection: 'row',
    gap: theme.space[2],
    alignItems: 'flex-start',
  },
  warningText: { flex: 1 },
  actions: { gap: theme.space[2], marginTop: theme.space[2] },
  waiting: {
    gap: theme.space[3],
    alignItems: 'center',
    paddingVertical: theme.space[10],
  },
  centred: { textAlign: 'center' },
});
