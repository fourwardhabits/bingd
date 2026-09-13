import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import type { ImportSurface } from '@/lib/analytics';
import { unrankedMovies } from '@/lib/routes';
import { Button, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { HowToExportSheet } from './HowToExportSheet';
import type { ArchivePreview } from './read-archive';
import {
  useImport,
  type ImportCounts,
  type ImportFailure,
  type ImportPhase,
} from './use-import';

/**
 * The importer, as one screen that changes rather than a flow of several.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE SCREEN
 *
 * Each phase replaces the last in place. A person watching this is waiting on something
 * they cannot influence, and a route change per step would make a back gesture mean five
 * different things, including "abandon an upload halfway", which is the one it must never
 * quietly mean.
 *
 * ---------------------------------------------------------------------------
 * ONE STORY, IN THE WORDS THE NOTIFICATIONS USE
 *
 *   entry       Bring your Letterboxd history
 *   running     Importing your Letterboxd history
 *   pushed      Letterboxd import started / Your Letterboxd history is ready /
 *               We couldn't finish your Letterboxd import
 *   finished    Your Letterboxd history is in
 *
 * No backend words ("matching", "rows", "export payload"), no em dashes, and nothing the
 * implementation does not make true. Physical QA (2026-09-12) found the first version
 * read like documentation of the pipeline, and that the one screen that most needed a
 * next step, the summary, offered only Done.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PRIVACY LINE PROMISES
 *
 * The ZIP is read on the phone (`read-archive.ts`) and never uploaded. What crosses the
 * wire is the normalised rows `payload.ts` builds: film names, years, ratings, dates, and
 * the Letterboxd links that identify each film and diary entry. Reviews, comments, likes
 * and lists are never opened (`archive.ts`). The sentence is short; it is not allowed to
 * be shorter than that.
 */
export function ImportScreen({
  surface,
  jobId,
}: {
  surface: ImportSurface;
  /** The job a notification named. See `useImport`. */
  jobId?: string | null;
}) {
  const router = useRouter();
  const { state, pick, start, reset, watchRunning } = useImport(surface, jobId);
  const [howTo, setHowTo] = useState(false);

  /**
   * Out of the importer without touching the job. The server carries on either way; this
   * is only the screen. Reached from a notification on a cold start there may be nothing
   * underneath, so it lands on Settings rather than doing nothing.
   */
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/settings'));

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
          onLeave={leave}
          onRank={() => router.dismissTo(unrankedMovies())}
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
  onLeave,
  onRank,
}: {
  state: ImportPhase;
  onPick: () => void;
  onStart: (preview: ArchivePreview) => void;
  onReset: () => void;
  onWatch: () => void;
  onHowTo: () => void;
  onLeave: () => void;
  onRank: () => void;
}) {
  switch (state.phase) {
    case 'idle':
      return <Intro onPick={onPick} onHowTo={onHowTo} />;

    case 'reading':
      return <Waiting title="Opening your file" detail="It stays on your phone." />;

    case 'previewing':
      return (
        <Preview
          preview={state.preview}
          onStart={() => onStart(state.preview)}
          onReset={onReset}
        />
      );

    case 'uploading':
      return (
        <Waiting
          title="Importing your Letterboxd history"
          detail={
            state.total > 1
              ? // `Math.min`, because after the last page `sent === total` and the screen
                // stays up for the whole `import_ready` round trip.
                `Keep bingd. open while we send your history. Part ${Math.min(state.sent + 1, state.total)} of ${state.total}.`
              : 'Keep bingd. open while we send your history.'
          }
        />
      );

    case 'working':
      // **The only screen that says the app may be closed, because it is the only one where
      // that is true.** After `import_ready` the work is on a cron tick with no client
      // attached, and the import's notifications (20260917001500) say when it ends. Before
      // it, closing the app stops the upload, which is why `uploading` says the opposite.
      //
      // No duration is promised. The one measured import (24 films, staging, 2026-09-12)
      // took two minutes end to end, which is one data point and not a claim about a
      // library of thousands.
      return (
        <Waiting
          title="Importing your Letterboxd history"
          detail="You can close bingd. Your import will keep running, and we’ll let you know when it’s done. Come back here anytime to check on it."
          note="This may take a few minutes, especially for larger libraries."
          action={<Button label="Leave it running" kind="secondary" onPress={onLeave} />}
        />
      );

    case 'done':
      return (
        <Summary
          counts={state.status.counts}
          onRank={onRank}
          onDone={onLeave}
          onReset={onReset}
        />
      );

    case 'failed':
      return (
        <Failed
          failure={state.failure}
          onRetry={state.preview ? () => onStart(state.preview!) : onPick}
          retryLabel={state.preview ? 'Try again' : 'Choose Letterboxd ZIP'}
          onHowTo={onHowTo}
          onReset={onReset}
          onWatch={onWatch}
        />
      );
  }
}

/**
 * The three steps, said as Letterboxd labels them. The file distinction is the part people
 * get wrong: the export is a ZIP, and a folder or a single CSV will be refused.
 */
const STEPS = [
  'On Letterboxd.com, go to Settings, then Data.',
  'Generate your export.',
  'Download the ZIP.',
  'Come back to bingd. and choose it here.',
] as const;

function Intro({ onPick, onHowTo }: { onPick: () => void; onHowTo: () => void }) {
  return (
    <View style={styles.block}>
      <Text variant="display">Bring your Letterboxd history</Text>
      <Text variant="body" tone="secondary">
        Import the movies you’ve watched, your ratings, Diary dates, and Watchlist. Your bingd.
        rankings stay yours.
      </Text>

      <View style={styles.card}>
        <Text variant="headline">How to get your file</Text>
        {STEPS.map((step, index) => (
          <View key={step} style={styles.step}>
            <Text variant="subhead" tone="action" style={styles.stepNumber}>
              {index + 1}
            </Text>
            <Text variant="body" tone="secondary" style={styles.stepText}>
              {step}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.privacy}>
        <Ionicons
          name="lock-closed-outline"
          size={theme.layout.icon.sm}
          color={theme.text.tertiary}
        />
        <Text variant="footnote" tone="tertiary" style={styles.privacyText}>
          Your ZIP stays on your phone. bingd. only gets what it needs: film names, years,
          ratings, dates, and Letterboxd links. We never open your reviews, comments, likes, or
          lists.
        </Text>
      </View>

      <View style={styles.actions}>
        <Button label="Choose Letterboxd ZIP" onPress={onPick} />
        <Button label="Need help getting the file?" kind="tertiary" onPress={onHowTo} />
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
      <Text variant="display">Ready to import</Text>
      <Text variant="body" tone="secondary">
        Here’s what we found in your Letterboxd file.
      </Text>

      <View style={styles.card}>
        <Stat label="Watched films" value={counts.watched} />
        <Stat label="Ratings" value={counts.rated} />
        <Stat label="On your Watchlist" value={counts.watchlist} />
        <Stat label="Diary entries" value={counts.watches} />
      </View>

      {/* **Only shown when there is something to say.** A permanent "0 couldn't be read"
          line teaches people to ignore the place a real warning would appear. */}
      {counts.malformed > 0 || counts.damagedFiles > 0 ? (
        <View style={styles.warning}>
          <Ionicons
            name="alert-circle-outline"
            size={theme.layout.icon.sm}
            color={theme.text.tertiary}
          />
          <Text variant="footnote" tone="tertiary" style={styles.warningText}>
            {counts.damagedFiles > 0
              ? `${counts.damagedFiles === 1 ? 'One file' : `${counts.damagedFiles} files`} in your ZIP couldn’t be read, so we skipped ${counts.damagedFiles === 1 ? 'it' : 'them'}. Everything else is here.`
              : `${counts.malformed} ${counts.malformed === 1 ? 'entry' : 'entries'} couldn’t be read, so we skipped ${counts.malformed === 1 ? 'it' : 'them'}.`}
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

/** "Import 1 film", not "Import 1 films". */
const importLabel = (films: number) => `Import ${films} ${films === 1 ? 'film' : 'films'}`;

function Summary({
  counts,
  onRank,
  onDone,
  onReset,
}: {
  counts: ImportCounts;
  onRank: () => void;
  onDone: () => void;
  onReset: () => void;
}) {
  // **`stragglers` counts here too.** `_import_settle` reports rows still `pending` or
  // `matched` at settle as their own bucket; to the reader they are films that did not
  // arrive, whatever the worker's reason.
  const unresolved =
    (counts.ambiguous ?? 0) + (counts.unmatched ?? 0) + (counts.stragglers ?? 0);

  const added = counts.watched ?? 0;
  // Kept (built here, left alone) and already (a previous import owns it) are the same
  // thing from the reader's side: it was in bingd. and nothing happened to it.
  const alreadyHere = (counts.kept ?? 0) + (counts.already ?? 0);
  const watchlisted = counts.watchlist ?? 0;
  const diary = counts.viewings ?? 0;
  // **The heading asks whether anything arrived, not whether the job finished.** A
  // re-import that changed nothing must not announce a history arriving.
  const arrived = added + watchlisted > 0;

  return (
    <View style={styles.block}>
      <Text variant="display">
        {arrived ? 'Your Letterboxd history is in' : 'Your Letterboxd history is already here'}
      </Text>

      <View style={styles.card}>
        <Count value={added} label="Added as watched" />
        {/* Rows of zero are left out: a zero invites the reader to wonder what went wrong.
            "Added as watched" always shows, because it is the number the next step is about. */}
        {alreadyHere > 0 ? <Count value={alreadyHere} label="Already in bingd." /> : null}
        {watchlisted > 0 ? <Count value={watchlisted} label="Added to your Watchlist" /> : null}
        {diary > 0 ? (
          <Count
            value={diary}
            label={diary === 1 ? 'Diary entry saved' : 'Diary entries saved'}
          />
        ) : null}
      </View>

      {/* **The unmatched count is shown rather than rounded away**, so a partial import
          never looks complete. */}
      {unresolved > 0 ? (
        <Text variant="footnote" tone="tertiary">
          {unresolved === 1
            ? 'We couldn’t find 1 film from your file, so it wasn’t added.'
            : `We couldn’t find ${unresolved} films from your file, so they weren’t added.`}
        </Text>
      ) : null}

      {added > 0 ? (
        <Text variant="body" tone="secondary">
          Imported movies start unranked. Rank them whenever you want. A ranking you make in
          bingd. always wins.
        </Text>
      ) : null}

      <View style={styles.actions}>
        {/* The next useful thing, first: the films that just arrived are waiting on
            Collection's Unranked tab. Only when there are some to rank. */}
        {added > 0 ? <Button label="Rank imported movies" onPress={onRank} /> : null}
        <Button label="Done" kind={added > 0 ? 'secondary' : 'primary'} onPress={onDone} />
        {/* A finished import is restored for a day, and a notification can open it at any
            time, so this screen is reachable without having just used it. */}
        <Button label="Import another file" kind="tertiary" onPress={onReset} />
      </View>
    </View>
  );
}

/**
 * What went wrong, and what to do about it.
 *
 * Every message names the next action. The two failures with nothing to retry say so
 * rather than offering a button that would fail the same way every time.
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

  const retryable = failure.kind !== 'already_running' && failure.kind !== 'unknown';
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
          <Button label="Need help getting the file?" kind="tertiary" onPress={onHowTo} />
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
      // True: `import_create` reuses the open job and `import_rows_once` makes an
      // already-sent page free, so a retry really does pick up.
      detail:
        'Your connection dropped. Try again and we’ll pick up where it stopped. Nothing gets sent twice.',
      showHowTo: false,
    };
  }

  if (failure.kind === 'already_running') {
    return {
      title: 'An import is already running',
      detail:
        'This file wasn’t sent. Your earlier import is still running, even with the app closed, and bingd. runs one import at a time. Come back when it’s done to import this file.',
      showHowTo: false,
    };
  }

  if (failure.kind === 'unknown') {
    return {
      title: 'We lost track of that import',
      detail:
        'It’s still running on our side. We just can’t see its progress right now. Check your connection and come back in a few minutes.',
      showHowTo: false,
    };
  }

  if (failure.kind === 'server') {
    return {
      // The push's own headline (`push-sender/copy.ts`), because the notification sends
      // people here.
      title: 'We couldn’t finish your Letterboxd import',
      // **Not "nothing was changed".** A job dead-lettered while applying has already
      // written the films it got to. What is true is that trying again is safe: an
      // imported title, a watchlist row and a diary entry are each written once.
      detail:
        'Something went wrong on our side, and part of your history may already be in. Try your file again. Anything already here won’t be added twice.',
      showHowTo: false,
    };
  }

  if (failure.kind === 'unreadable') {
    return {
      title: 'We couldn’t open that file',
      detail: 'Try choosing it again. If it’s in a cloud folder, download it first.',
      showHowTo: false,
    };
  }

  switch (failure.reason) {
    case 'not_a_zip':
      return {
        title: 'That’s not the Letterboxd ZIP',
        detail:
          'Letterboxd sends a ZIP file. If your computer unzipped it, go back to the original download. A single CSV isn’t enough.',
        showHowTo: true,
      };
    case 'not_letterboxd':
      return {
        title: 'That ZIP isn’t from Letterboxd',
        detail:
          'It doesn’t have the files a Letterboxd export has. Check you picked the right one.',
        showHowTo: true,
      };
    case 'empty':
      return {
        title: 'There’s nothing in that file yet',
        detail:
          'It’s a real Letterboxd export, but it has no films in it. Log something on Letterboxd, export again, and choose the new file.',
        showHowTo: false,
      };
    case 'damaged':
      return {
        title: 'That ZIP couldn’t be read',
        detail:
          'It looks incomplete, which usually means the download was cut off. Download it from Letterboxd again.',
        showHowTo: true,
      };
    case 'too_large':
    case 'too_many_entries':
    case 'entry_too_large':
      return {
        title: 'That file is too big',
        detail:
          'It’s much larger than any Letterboxd export, so bingd. won’t open it. Check you picked the right file. If it really is your export, let us know from Settings.',
        showHowTo: true,
      };
    case 'unexpected':
      // Our bug, not theirs, and the copy should not imply they picked the wrong thing.
      return {
        title: 'Something went wrong reading that',
        detail:
          'That’s on us, not you. Try again, and if it keeps happening, let us know from Settings.',
        showHowTo: false,
      };
    case 'too_many_films':
      // A real export and a real refusal: the whole-job ceiling, five times the supported
      // size. Name the size we are built for rather than implying a wrong file.
      return {
        title: 'That library is bigger than we can take',
        detail:
          'bingd. imports up to about ten thousand films, and this file is well past that. Nothing was sent. Let us know from Settings. We’d like to hear from you.',
        showHowTo: false,
      };
  }
}

function Waiting({
  title,
  detail,
  note,
  action,
}: {
  title: string;
  detail: string;
  note?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.waiting}>
      <ActivityIndicator color={theme.semantic.action} />
      <Text variant="headline" style={styles.centred}>
        {title}
      </Text>
      <Text variant="body" tone="secondary" style={styles.centred}>
        {detail}
      </Text>
      {note ? (
        <Text variant="footnote" tone="tertiary" style={styles.centred}>
          {note}
        </Text>
      ) : null}
      {action ? <View style={styles.waitingAction}>{action}</View> : null}
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

/** A summary line, number first: "19  Added as watched". */
function Count({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.count} accessible accessibilityLabel={`${value} ${label}`}>
      <Text variant="headline" style={styles.countValue}>
        {value}
      </Text>
      <Text variant="body" style={styles.statLabel}>
        {label}
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
  step: { flexDirection: 'row', gap: theme.space[3] },
  stepNumber: { width: theme.space[4], textAlign: 'right' },
  stepText: { flex: 1 },
  privacy: { flexDirection: 'row', gap: theme.space[2], alignItems: 'flex-start' },
  privacyText: { flex: 1 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  statLabel: { flex: 1 },
  count: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space[3] },
  countValue: { minWidth: theme.space[8], textAlign: 'right' },
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
  waitingAction: { alignSelf: 'stretch', marginTop: theme.space[3] },
  centred: { textAlign: 'center' },
});
