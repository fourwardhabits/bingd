import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { rankingBacklog } from '@/features/ranking/backlog';
import type { ImportSurface } from '@/lib/analytics';
import { unrankedMovies } from '@/lib/routes';
import { Button, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { HOW_TO_STEPS, HowToExportSheet } from './HowToExportSheet';
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
 * and lists are never opened (`archive.ts`). On Settings the sentence is short and is not
 * allowed to be shorter than that. The onboarding question carries the founder's shorter
 * line instead (2026-09-14), which is true of the same implementation: the ZIP stays on the
 * phone and only what the import needs is read.
 *
 * ---------------------------------------------------------------------------
 * AND THE SAME SCREEN, AS A STEP OF ONBOARDING (2026-09-13)
 *
 * `onboarding` runs this exact machine inside the first-run flow
 * (`app/onboarding/letterboxd.tsx`), because the flow guard replaces any route pushed out
 * of the onboarding group, so the importer has to be drawn where the person already is.
 * Three things differ and nothing else does:
 *
 *   - **The opening asks a question** (*Already use Letterboxd?*) with *Import from
 *     Letterboxd* and *Not now*, instead of Settings' instructions page.
 *   - **Every state short of an accepted import offers Not now**, except the upload
 *     itself, which is the one moment leaving would stop something.
 *   - **Once `import_ready` has succeeded the step lets go.** It says the import carries on
 *     in the background and that we will say when it is done, and offers *Continue*. It
 *     does not wait for the result, and neither leaving nor unmounting touches the job:
 *     `onLeave` is navigation only, and `reset` (the one path to `import_discard`) is not
 *     reachable from any exit.
 *
 * Settings passes no `onboarding` and draws exactly what it drew before.
 */
export type ImportOnboarding = {
  /** The flow's chrome, drawn above the importer in place of a navigation header. */
  readonly header: React.ReactNode;
  /**
   * Leave the step, carrying on to the rest of the flow.
   *
   * `continued` when an import is, or may be, with the server; `skipped` only when the
   * importer knows nothing is running (see `step` in `ImportScreen`). Called synchronously
   * from a press, with nothing awaited first.
   */
  readonly onLeave: (outcome: 'continued' | 'skipped') => void;
};

export function ImportScreen({
  surface,
  jobId,
  onboarding,
}: {
  surface: ImportSurface;
  /** The job a notification named. See `useImport`. */
  jobId?: string | null;
  /** Run as the optional onboarding step. See the header. */
  onboarding?: ImportOnboarding;
}) {
  const router = useRouter();
  const { state, pick, start, reset, watchRunning, recheck, opened, mayBeRunning } = useImport(
    surface,
    jobId,
    { countOpenOnRequest: onboarding !== undefined },
  );
  const [howTo, setHowTo] = useState(false);

  /**
   * The step's exits, with the outcome made honest at the one place both buttons meet.
   *
   * *Not now* is a skip only when the importer **knows** nothing is running. Pressed before
   * the open-job lookup has answered, or after a hand-off whose answer was lost, an import
   * may well be on the server, and reporting that as a skip would undercount the imports
   * the step started. Those leaves report `continued`, the step's other existing outcome,
   * rather than a new word.
   */
  const step: ImportOnboarding | undefined = onboarding && {
    header: onboarding.header,
    onLeave: (outcome) =>
      onboarding.onLeave(outcome === 'skipped' && mayBeRunning() ? 'continued' : outcome),
  };

  /**
   * Out of the importer without touching the job. The server carries on either way; this
   * is only the screen. Reached from a notification on a cold start there may be nothing
   * underneath, so it lands on Settings rather than doing nothing.
   */
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/settings'));

  /**
   * **The question uses the flow's gutters and type, with its actions where the content ends**
   * (founder, physical preview QA, 2026-09-14, twice).
   *
   * The first pass copied People's scaffold exactly, footer and all. People and *Your First
   * Five* have enough content to fill a phone, so their bottom-pinned footer sits under it.
   * This question is two lines, so the same pinned footer opened a large blank band between
   * the words and the buttons, which is the "giant empty area" the founder met on the way
   * back from *Choose a different file* (and would have met on the way in). The intro keeps
   * People's values; the actions follow it in the same scroll body instead of being pinned.
   *
   * **The bottom inset is the importer's in both modes.** With nothing pinned at the bottom,
   * the scroll body is the last thing on the screen, so the screen owns the safe-area
   * padding under it (design-system.md, "The bottom edge belongs to whatever is at the
   * bottom").
   */
  const asking = step !== undefined && state.phase === 'idle';

  return (
    <Screen includeBottomInset>
      {onboarding?.header}
      {asking ? (
        <OnboardingQuestion
          onPick={() => {
            opened();
            void pick();
          }}
          onHowTo={() => {
            opened();
            setHowTo(true);
          }}
          onSkip={() => step.onLeave('skipped')}
        />
      ) : (
        /**
         * **Keyed by phase, so a new state starts at the top.** One scroll view used to carry
         * every phase, and a scroll view can keep its offset when its content shrinks: scrolled
         * down a preview, then *Choose a different file*, and the shorter intro was drawn
         * scrolled past its own end, a blank page until the next drag. A phase change is a new
         * page, so it gets a new scroll view; progress inside a phase (upload parts, polling)
         * keeps the same one.
         */
        <ScrollView key={state.phase} contentContainerStyle={styles.page}>
          <Body
            state={state}
            onPick={() => {
              // A no-op unless this is the onboarding step, where the count waits for a tap.
              opened();
              void pick();
            }}
            onStart={(preview) => void start(preview)}
            onReset={reset}
            onWatch={watchRunning}
            onRecheck={recheck}
            onHowTo={() => {
              opened();
              setHowTo(true);
            }}
            onLeave={leave}
            onRank={() => router.dismissTo(unrankedMovies())}
            onboarding={step}
          />
        </ScrollView>
      )}
      {/* The only sheet this screen has, so there is nothing to serialise it against. On
          the onboarding step the screen is a plain stack route rather than a presented
          one, so this is not a Modal inside anything either. */}
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
  onRecheck,
  onboarding,
}: {
  state: ImportPhase;
  onPick: () => void;
  onStart: (preview: ArchivePreview) => void;
  onReset: () => void;
  onWatch: () => void;
  onHowTo: () => void;
  onLeave: () => void;
  onRank: () => void;
  onRecheck: () => void;
  onboarding?: ImportOnboarding;
}) {
  /**
   * The onboarding step's way on, per state. Undefined on Settings, which renders nothing
   * where these are placed.
   */
  const skip = onboarding ? () => onboarding.onLeave('skipped') : undefined;
  const carryOn = onboarding ? () => onboarding.onLeave('continued') : undefined;

  switch (state.phase) {
    case 'idle':
      // The onboarding step draws its question outside this page (`OnboardingQuestion`).
      return <Intro onPick={onPick} onHowTo={onHowTo} />;

    case 'reading':
      return (
        <Waiting
          title="Opening your file"
          detail="It stays on your phone."
          // Nothing has been sent, so leaving costs nothing, and a picker that never calls
          // back must not be the end of somebody's onboarding.
          action={skip ? <Button label="Not now" kind="secondary" onPress={skip} /> : undefined}
        />
      );

    case 'previewing':
      return (
        <Preview
          preview={state.preview}
          onStart={() => onStart(state.preview)}
          onReset={onReset}
          exit={skip ? <Button label="Not now" kind="secondary" onPress={skip} /> : undefined}
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
                `Keep bingd open while we send your history. Part ${Math.min(state.sent + 1, state.total)} of ${state.total}.`
              : 'Keep bingd open while we send your history.'
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
      if (carryOn) {
        // **The onboarding step's hand-off, and the reason it can end here.** Everything the
        // server needs is on the server, so the flow does not wait for 100%: it says the
        // import carries on and that we will say when it is done (the lifecycle
        // notifications, which the next steps do not interfere with), and lets somebody
        // carry on. The poll keeps running while this is on screen, so a quick import
        // still arrives as its summary; Continue unmounts it and leaves the job alone.
        return (
          <Waiting
            title="Your Letterboxd import is on its way"
            detail="It keeps running in the background, even if you close bingd. We’ll let you know when it’s done."
            note="You can check on it anytime in Settings, under Import from Letterboxd."
            action={<Button label="Continue" onPress={carryOn} />}
          />
        );
      }
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
          onContinue={carryOn}
        />
      );

    case 'failed':
      return (
        <Failed
          exit={
            // **Named for what is true of the job.** Where an import is running (or this
            // screen merely lost sight of one) nothing is being declined, so the way on is
            // Continue; where nothing reached the server, or the server gave up, Not now.
            skip && carryOn ? (
              leavesAJobRunning(state.failure) ? (
                <Button label="Continue" kind="secondary" onPress={carryOn} />
              ) : (
                <Button label="Not now" kind="secondary" onPress={skip} />
              )
            ) : undefined
          }
          failure={state.failure}
          onRetry={
            state.failure.kind === 'unchecked'
              ? onRecheck
              : state.preview
                ? () => onStart(state.preview!)
                : onPick
          }
          retryLabel={
            state.failure.kind === 'unchecked' || state.preview
              ? 'Try again'
              : 'Choose Letterboxd ZIP'
          }
          onHowTo={onHowTo}
          onReset={onReset}
          onWatch={onWatch}
        />
      );
  }
}

/**
 * The four steps, from Letterboxd's Settings to this screen. The file distinction is the part people
 * get wrong: the export is a ZIP, and a folder or a single CSV will be refused.
 */
// One list, shared with the help sheet, so the two cannot drift apart (independent review,
// 2026-09-14).
const STEPS = HOW_TO_STEPS;

function Intro({ onPick, onHowTo }: { onPick: () => void; onHowTo: () => void }) {
  return (
    <View style={styles.block}>
      <Text variant="display">Bring your Letterboxd history</Text>
      <Text variant="body" tone="secondary">
        Import the movies you’ve watched, your ratings, diary dates, and watchlist. Your bingd
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

      <Privacy />

      <View style={styles.actions}>
        <Button label="Choose Letterboxd ZIP" onPress={onPick} />
        <Button label="Need help getting the file?" kind="tertiary" onPress={onHowTo} />
      </View>
    </View>
  );
}

/** The privacy promise. See the header for why it may not be any shorter. */
function Privacy() {
  return (
    <View style={styles.privacy}>
      <Ionicons
        name="lock-closed-outline"
        size={theme.layout.icon.sm}
        color={theme.text.tertiary}
      />
      <Text variant="footnote" tone="tertiary" style={styles.privacyText}>
        Your ZIP stays on your phone. bingd only gets what it needs: film names, years, ratings,
        dates, and Letterboxd links. We never open your reviews, comments, likes, or lists.
      </Text>
    </View>
  );
}

/**
 * The onboarding step's opening: a question, and two answers of equal standing.
 *
 * **Import from Letterboxd goes straight to the picker.** On this screen most readers are
 * deciding whether this applies to them at all, so the instructions are one tap away under
 * *Need help getting the file?* rather than the first thing on the page. Somebody without
 * the file who opens the picker anyway cancels it and lands back here, with both answers
 * still on screen.
 *
 * **Not now is secondary, not tertiary.** The import is never required, and a way on that
 * reads as fine print makes the step feel like a gate.
 *
 * The privacy line is true of the implementation: the ZIP is read on the phone
 * (`read-archive.ts`) and never uploaded, and only the entries the import needs are
 * opened (`archive.ts`).
 */
function OnboardingQuestion({
  onPick,
  onHowTo,
  onSkip,
}: {
  onPick: () => void;
  onHowTo: () => void;
  onSkip: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={onboardingStyles.body}>
      <View style={onboardingStyles.intro}>
        <Text variant="title1">Already use Letterboxd?</Text>
        <Text variant="body" tone="secondary">
          Bring over what you’ve watched, your ratings, diary dates, and watchlist. Imported
          titles start unranked, so your bingd rankings stay yours.
        </Text>
      </View>
      <View style={onboardingStyles.actions}>
        <Button label="Import from Letterboxd" onPress={onPick} />
        <Button label="Not now" kind="secondary" onPress={onSkip} />
        <Button label="Need help getting the file?" kind="tertiary" onPress={onHowTo} />
        <Text variant="footnote" tone="tertiary" style={styles.centred}>
          Your ZIP stays on your phone. bingd only reads the information needed for your import.
        </Text>
      </View>
    </ScrollView>
  );
}

/**
 * Whether a failure leaves an import running on the server.
 *
 * `already_running` and `unknown` both do by definition, and `unchecked` is a job a
 * notification named whose read failed. The rest are refusals before anything was handed
 * over (`archive`, `unreadable`, `upload`) or a job the worker gave up on (`server`).
 */
const leavesAJobRunning = (failure: ImportFailure): boolean =>
  failure.kind === 'already_running' ||
  failure.kind === 'unknown' ||
  failure.kind === 'unchecked';

function Preview({
  preview,
  onStart,
  onReset,
  exit,
}: {
  preview: ArchivePreview;
  onStart: () => void;
  onReset: () => void;
  /** The onboarding step's Not now. */
  exit?: React.ReactNode;
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
        <Stat label="On your watchlist" value={counts.watchlist} />
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
        {exit}
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
  onContinue,
}: {
  counts: ImportCounts;
  onRank: () => void;
  onDone: () => void;
  onReset: () => void;
  /**
   * The onboarding step's way on, which replaces all three actions below. *Rank imported
   * movies* opens Collection, which the flow guard would send straight back; *Done* is
   * Settings' back; and *Import another file* is a second import in the middle of a flow
   * that has just finished its first.
   */
  onContinue?: () => void;
}) {
  // **`stragglers` counts here too.** `_import_settle` reports rows still `pending` or
  // `matched` at settle as their own bucket; to the reader they are films that did not
  // arrive, whatever the worker's reason.
  const unresolved =
    (counts.ambiguous ?? 0) + (counts.unmatched ?? 0) + (counts.stragglers ?? 0);

  const added = counts.watched ?? 0;
  /**
   * Is anything actually waiting to be ranked? One cheap read, and only when this import
   * brought titles at all. `shouldOfferRanking` holds the rule and is tested on its own.
   */
  const backlog = useQuery({
    queryKey: ['ranking-backlog', 'import-complete'],
    enabled: added > 0,
    retry: false,
    staleTime: 0,
    queryFn: () => rankingBacklog('movies', { limit: 1 }),
  });
  const showRank = shouldOfferRanking(added, {
    status: backlog.data?.status,
    total: backlog.data?.total,
    settled: backlog.isSuccess || backlog.isError,
  });
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
        {alreadyHere > 0 ? <Count value={alreadyHere} label="Already in bingd" /> : null}
        {watchlisted > 0 ? <Count value={watchlisted} label="Added to your watchlist" /> : null}
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

      {onContinue ? (
        <View style={styles.actions}>
          <Button label="Continue" onPress={onContinue} />
        </View>
      ) : (
        <View style={styles.actions}>
          {/**
           * **The bridge into the ranking backlog** (founder, 2026-09-22), and the whole of
           * it: a question and a button, no helper line. It is drawn only when titles are
           * actually waiting — `added` says this import brought some, and the backlog read
           * says some are still unranked *now*, so a reader who has ranked them since is not
           * asked again. A backend with the backlog off, or one that predates it, answers
           * `disabled`; then `added` alone decides, which is what this screen did before.
           * It leads to Collection's Unranked tab and the ordinary flow takes over — there
           * is no import-specific queue, and nothing here says every imported title is
           * unranked.
           */}
          {showRank ? (
            <>
              <Text variant="callout">Want to rank what you imported?</Text>
              <Button label="Rank imported titles" onPress={onRank} />
            </>
          ) : null}
          <Button label="Done" kind={showRank ? 'secondary' : 'primary'} onPress={onDone} />
          {/* A finished import is restored for a day, and a notification can open it at any
              time, so this screen is reachable without having just used it. */}
          <Button label="Import another file" kind="tertiary" onPress={onReset} />
        </View>
      )}
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
  exit,
}: {
  failure: ImportFailure;
  onRetry: () => void;
  retryLabel: string;
  onHowTo: () => void;
  onReset: () => void;
  onWatch: () => void;
  /** The onboarding step's way on. */
  exit?: React.ReactNode;
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
        {exit}
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
        'This file wasn’t sent. Your earlier import is still running, even with the app closed, and bingd runs one import at a time. Come back when it’s done to import this file.',
      showHowTo: false,
    };
  }

  if (failure.kind === 'unchecked') {
    return {
      title: 'We couldn’t check your import',
      detail: 'Check your connection and try again.',
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
          'It’s much larger than any Letterboxd export, so bingd won’t open it. Check you picked the right file. If it really is your export, let us know from Settings.',
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
          'bingd imports up to about ten thousand films, and this file is well past that. Nothing was sent. Let us know from Settings. We’d like to hear from you.',
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

/**
 * The first-run flow's page, restated from `app/onboarding/people.tsx` (and the matching
 * intro in `app/onboarding/taste.tsx`), so this step lines up with the steps on either side
 * of it. Kept in step with those by hand: the flow has no shared layout
 * component, and making one would mean rewriting two shipped screens for this one.
 */
const onboardingStyles = StyleSheet.create({
  body: { paddingBottom: theme.space[6] },
  intro: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[4],
    gap: theme.space[2],
  },
  // The question's actions: the flow's gutter and its action spacing (People's footer
  // gap), placed after the words rather than pinned. `intro`'s bottom padding is the seam.
  actions: {
    paddingHorizontal: theme.layout.gutter,
    gap: theme.space[2],
  },
});

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

/**
 * Whether the import-complete screen offers the ranking bridge (founder, 2026-09-22).
 *
 * `added` is what this import brought in as watched; every one of them arrives unranked,
 * because a Letterboxd star is provenance and never a bingd bucket (`20261018000100`). The
 * backlog read then says whether any are still waiting *now*.
 *
 *   nothing added            no — there is nothing this import left to rank
 *   backlog says `disabled`  yes — the flag is off or the backend predates it, so fall
 *                            back to what this screen has always done
 *   backlog says 0 left      no — they have been ranked since
 *   still loading            no — a button that appears late is better than one that
 *                            appears and then vanishes
 */
export function shouldOfferRanking(
  added: number,
  backlog: { status?: string; total?: number; settled: boolean },
): boolean {
  if (added <= 0) return false;
  if (!backlog.settled) return false;
  if (backlog.status === 'ready' || backlog.status === 'empty') return (backlog.total ?? 0) > 0;
  // `disabled`, or no answer at all (an error): the count this screen already has decides.
  return true;
}
