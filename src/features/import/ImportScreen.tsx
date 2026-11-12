import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import type { ImportSurface } from '@/lib/analytics';
import { unrankedMovies } from '@/lib/routes';
import { Button, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { HOW_TO_STEPS, HowToExportSheet, IMDB_HOW_TO_STEPS } from './HowToExportSheet';
import { ProviderChoice } from './ProviderChoice';
import { ProviderLogo } from './ProviderLogo';
import { type ImportProvider } from './providers';
import type { ArchivePreview } from './read-archive';
import type { ImdbPreview } from './read-imdb';
import {
  isImdbPreview,
  providerOfJob,
  useImport,
  type ImportCounts,
  type ImportFailure,
  type ImportPhase,
  type ImportPreview,
} from './use-import';

/**
 * **The words that name a provider, per provider** (20261113000100).
 *
 * The Letterboxd column is the copy this screen has always had, verbatim, so the Letterboxd
 * import reads exactly as it did. The IMDb column says the same things about IMDb. Phases
 * that describe a job (running, done, failed) take the JOB's provider, so a notification
 * about an IMDb import opens on IMDb's words whichever screen it lands on.
 */
const COPY = {
  letterboxd: {
    importing: 'Importing your Letterboxd history',
    onItsWay: 'Your Letterboxd import is on its way',
    couldNotFinish: 'We couldn’t finish your Letterboxd import',
    choose: 'Choose Letterboxd ZIP',
    empty:
      'It’s a real Letterboxd export, but it has no films in it. Log something on Letterboxd, export again, and choose the new file.',
    tooLarge:
      'It’s much larger than any Letterboxd export, so bingd won’t open it. Check you picked the right file. If it really is your export, let us know from Settings.',
  },
  imdb: {
    importing: 'Importing your IMDb history',
    onItsWay: 'Your IMDb import is on its way',
    couldNotFinish: 'We couldn’t finish your IMDb import',
    choose: 'Choose IMDb CSV',
    empty:
      'It’s a real IMDb ratings export, but there’s nothing rated in it. Rate something on IMDb, export again, and choose the new file.',
    tooLarge:
      'It’s much larger than any IMDb ratings export, so bingd won’t open it. Check you picked the right file. If it really is your export, let us know from Settings.',
  },
} as const satisfies Record<ImportProvider, Record<string, string>>;

type Copy = (typeof COPY)[ImportProvider];

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
  provider: fixedProvider,
  chooser = false,
}: {
  surface: ImportSurface;
  /** The job a notification named. See `useImport`. */
  jobId?: string | null;
  /** Run as the optional onboarding step. See the header. */
  onboarding?: ImportOnboarding;
  /**
   * Whose file this screen imports (20261113000100). Letterboxd when absent and `chooser`
   * is off, which is every caller that predates the choice and draws what it always drew.
   */
  provider?: ImportProvider;
  /**
   * Open on the choice of service instead of one service's page: Settings ▸ Import from,
   * and the onboarding question (founder spec 2026-11-10, §7 and §9). The choice is this
   * screen's idle state, so the open-job lookup still runs underneath it and an import
   * already running is shown as running rather than behind a question.
   */
  chooser?: boolean;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<ImportProvider | null>(null);
  /**
   * Whether this screen opens on the choice of service. Its open is counted on the choice
   * (or on a running import it shows), because before the choice there is no provider to
   * put on `import_opened` (2026-11-11, see the event in `lib/analytics.ts`).
   */
  const offersChoice = chooser === true && fixedProvider === undefined;
  const { state, provider, pick, start, reset, watchRunning, recheck, opened, mayBeRunning } =
    useImport(surface, jobId, {
      countOpenOnRequest: onboarding !== undefined || offersChoice,
      provider: fixedProvider ?? chosen ?? undefined,
    });
  const [howTo, setHowTo] = useState(false);

  /** Whether the idle page is the choice of service rather than one service's page. */
  const choosing =
    chooser && fixedProvider === undefined && chosen === null && state.phase === 'idle';

  /**
   * The provider a phase's words are about: the job's own once there is a job, else the one
   * chosen here (`useImport` resolves both).
   */
  const jobProvider: ImportProvider = providerOfJob(state) ?? provider;

  /**
   * Off onboarding, a chooser that shows an import already running counts the open the way
   * a mount used to, with that job's provider. On onboarding the count waits for a tap, as
   * it always has.
   */
  const shownJobProvider = providerOfJob(state);
  useEffect(() => {
    if (onboarding === undefined && offersChoice && shownJobProvider !== undefined) opened();
  }, [onboarding, offersChoice, shownJobProvider, opened]);

  /** Back to the choice, from a service's page. Only where there is a choice to go back to. */
  const chooseAgain =
    chooser && fixedProvider === undefined
      ? () => {
          reset();
          setChosen(null);
        }
      : undefined;

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
  const asking = step !== undefined && state.phase === 'idle' && !chooser;

  return (
    <Screen includeBottomInset>
      {onboarding?.header}
      {choosing ? (
        <ChooseProvider
          onboarding={step !== undefined}
          onChoose={(next) => {
            opened(next);
            setChosen(next);
          }}
          onSkip={step ? () => step.onLeave('skipped') : undefined}
        />
      ) : asking ? (
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
            provider={provider}
            copy={COPY[jobProvider]}
            onChooseAgain={chooseAgain}
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
      <HowToExportSheet
        visible={howTo}
        onClose={() => setHowTo(false)}
        surface={surface}
        provider={provider}
      />
    </Screen>
  );
}

function Body({
  state,
  provider,
  copy,
  onChooseAgain,
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
  provider: ImportProvider;
  copy: Copy;
  /** Back to the choice of service. Absent where there is no choice. */
  onChooseAgain?: () => void;
  onPick: () => void;
  onStart: (preview: ImportPreview) => void;
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
      // The onboarding step draws its question outside this page (`OnboardingQuestion`),
      // unless it opened on the choice of service, which leads here.
      return provider === 'imdb' ? (
        <ImdbIntro
          onPick={onPick}
          onHowTo={onHowTo}
          onChooseAgain={onChooseAgain}
          exit={skip ? <Button label="Not now" kind="secondary" onPress={skip} /> : undefined}
        />
      ) : (
        <Intro
          onPick={onPick}
          onHowTo={onHowTo}
          onChooseAgain={onChooseAgain}
          exit={skip ? <Button label="Not now" kind="secondary" onPress={skip} /> : undefined}
        />
      );

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
      if (isImdbPreview(state.preview)) {
        const preview = state.preview;
        return (
          <ImdbPreviewView
            preview={preview}
            onStart={() => onStart(preview)}
            onReset={onReset}
            exit={skip ? <Button label="Not now" kind="secondary" onPress={skip} /> : undefined}
          />
        );
      }
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
          title={copy.importing}
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
            title={copy.onItsWay}
            detail="It keeps running in the background, even if you close bingd. We’ll let you know when it’s done."
            // The Settings row has been "Import from" since 20261113000100.
            note="You can check on it anytime in Settings, under Import from."
            action={<Button label="Continue" onPress={carryOn} />}
          />
        );
      }
      return (
        <Waiting
          title={copy.importing}
          detail="You can close bingd. Your import will keep running, and we’ll let you know when it’s done. Come back here anytime to check on it."
          note="This may take a few minutes, especially for larger libraries."
          action={<Button label="Leave it running" kind="secondary" onPress={onLeave} />}
        />
      );

    case 'done':
      if ((state.status.provider ?? provider) === 'imdb') {
        return (
          <ImdbSummary
            counts={state.status.counts}
            onRank={onRank}
            onDone={onLeave}
            onReset={onReset}
            onContinue={carryOn}
          />
        );
      }
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
          copy={copy}
          onRetry={
            state.failure.kind === 'unchecked'
              ? onRecheck
              : state.preview
                ? () => onStart(state.preview!)
                : onPick
          }
          retryLabel={
            state.failure.kind === 'unchecked' || state.preview ? 'Try again' : copy.choose
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

function Intro({
  onPick,
  onHowTo,
  onChooseAgain,
  exit,
}: {
  onPick: () => void;
  onHowTo: () => void;
  /** Back to the choice of service, where this page was reached from one. */
  onChooseAgain?: () => void;
  /** The onboarding step's Not now, where this page is a step of onboarding. */
  exit?: React.ReactNode;
}) {
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
        {exit}
        <Button label="Need help getting the file?" kind="tertiary" onPress={onHowTo} />
        {onChooseAgain ? (
          <Button label="Choose a different service" kind="tertiary" onPress={onChooseAgain} />
        ) : null}
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
  // Kept (built here, left alone) and already (a previous import owns it) are the same
  // thing from the reader's side: it was in bingd. and nothing happened to it.
  const alreadyHere = (counts.kept ?? 0) + (counts.already ?? 0);
  const watchlisted = counts.watchlist ?? 0;
  const diary = counts.viewings ?? 0;
  // **The heading asks whether anything arrived, not whether the job finished.** A
  // re-import that changed nothing must not announce a history arriving, and a file whose
  // films all went unmatched must not be told they were already here (2026-11-11).
  const arrived = added + watchlisted > 0;

  return (
    <View style={styles.block}>
      <Text variant="display">
        {arrived
          ? 'Your Letterboxd history is in'
          : alreadyHere > 0
            ? 'Your Letterboxd history is already here'
            : 'Nothing was added'}
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

      {added > 0 ? (
        <Text variant="body" tone="secondary">
          Imported movies start unranked. Rank them whenever you want. A ranking you make in
          bingd always wins.
        </Text>
      ) : null}

      {onContinue ? (
        <View style={styles.actions}>
          <Button label="Continue" onPress={onContinue} />
        </View>
      ) : (
        <View style={styles.actions}>
          {/* The next useful thing, first: the films that just arrived are waiting on
              Collection's Unranked tab. Only when there are some to rank. */}
          {added > 0 ? <Button label="Rank imported movies" onPress={onRank} /> : null}
          <Button label="Done" kind={added > 0 ? 'secondary' : 'primary'} onPress={onDone} />
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
  copy,
  onRetry,
  retryLabel,
  onHowTo,
  onReset,
  onWatch,
  exit,
}: {
  failure: ImportFailure;
  copy: Copy;
  onRetry: () => void;
  retryLabel: string;
  onHowTo: () => void;
  onReset: () => void;
  onWatch: () => void;
  /** The onboarding step's way on. */
  exit?: React.ReactNode;
}) {
  const { title, detail, showHowTo } = explain(failure, copy);

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

function explain(
  failure: ImportFailure,
  copy: Copy = COPY.letterboxd,
): {
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
      title: copy.couldNotFinish,
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
    // ---------------------------------------------------------------------------
    // The IMDb reader's refusals (20261113000100). Each names what the person picked and
    // what to pick instead.
    // ---------------------------------------------------------------------------
    case 'is_zip':
      return {
        title: 'That’s a ZIP, not the IMDb file',
        detail:
          'IMDb exports one CSV file. If this is your Letterboxd export, go back and choose Letterboxd instead.',
        showHowTo: true,
      };
    case 'not_imdb':
      return {
        title: 'That isn’t an IMDb ratings export',
        detail:
          'It doesn’t have the columns IMDb’s ratings export has. Export your ratings from IMDb and choose that CSV.',
        showHowTo: true,
      };
    case 'imdb_list':
      return {
        title: 'That’s an IMDb list, not your ratings',
        detail:
          'bingd brings in what you’ve rated, from your Ratings export. Watchlists and other lists aren’t imported yet.',
        showHowTo: true,
      };
    case 'nothing_supported':
      return {
        title: 'There are no movies in that file',
        detail:
          'bingd brings in the movies you’ve rated on IMDb. Everything in this file is a TV show, an episode, or another kind of title bingd doesn’t add from IMDb yet.',
        showHowTo: false,
      };
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
        detail: copy.empty,
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
        detail: copy.tooLarge,
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

/**
 * The choice of service: Settings ▸ Import from, and the onboarding question (founder spec
 * 2026-11-10, §7 and §9). One list for both (`ProviderChoice`), so the two cannot drift.
 *
 * **On onboarding it keeps the step's shape**: the flow's gutters and type, its actions where
 * the words end, *Not now* secondary and on the first frame. Choosing a service opens that
 * service's own page, with its instructions, its picker, and *Not now* still on it.
 */
function ChooseProvider({
  onboarding,
  onChoose,
  onSkip,
}: {
  onboarding: boolean;
  onChoose: (provider: ImportProvider) => void;
  onSkip?: () => void;
}) {
  if (onboarding) {
    return (
      <ScrollView contentContainerStyle={onboardingStyles.body}>
        <View style={onboardingStyles.intro}>
          <Text variant="title1">Already tracking movies somewhere else?</Text>
          <Text variant="body" tone="secondary">
            Bring your history over from Letterboxd or IMDb. Imported titles start unranked, so
            your bingd rankings stay yours.
          </Text>
        </View>
        <View style={onboardingStyles.actions}>
          <ProviderChoice onChoose={onChoose} />
          {onSkip ? <Button label="Not now" kind="secondary" onPress={onSkip} /> : null}
          <Text variant="footnote" tone="tertiary" style={styles.centred}>
            Your file stays on your phone. bingd only reads the information needed for your
            import.
          </Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.block}>
        <Text variant="display">Bring your watch history</Text>
        <Text variant="body" tone="secondary">
          Already track movies somewhere else? Bring your history into bingd.
        </Text>
        <ProviderChoice onChoose={onChoose} />
        <Text variant="footnote" tone="tertiary">
          Imported titles start unranked, so your bingd rankings stay yours.
        </Text>
      </View>
    </ScrollView>
  );
}

/**
 * IMDb's page: what comes in, how to get the file, and the picker.
 *
 * **The ratings sentence is the founder's rule made legible** (spec §8): an IMDb rating is
 * brought along as where the title came from, and never becomes a bingd score. Saying so here
 * is what stops "8/10 on IMDb" being read as "8.0 in bingd".
 */
function ImdbIntro({
  onPick,
  onHowTo,
  onChooseAgain,
  exit,
}: {
  onPick: () => void;
  onHowTo: () => void;
  onChooseAgain?: () => void;
  exit?: React.ReactNode;
}) {
  return (
    <View style={styles.block}>
      <ProviderLogo provider="imdb" size={28} />
      <Text variant="display">Bring your IMDb history</Text>
      <Text variant="body" tone="secondary">
        Import the movies you’ve rated on IMDb. They join your collection unranked, and your
        IMDb ratings come along as a note, not as bingd scores. Your bingd rankings stay yours.
      </Text>

      <View style={styles.card}>
        <Text variant="headline">How to get your file</Text>
        {IMDB_HOW_TO_STEPS.map((step, index) => (
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
        {/* True of `imdbStagingRows`: the id, title, original title, year, type and the
            person's own rating. Never Date Rated, never the community rating. */}
        <Text variant="footnote" tone="tertiary" style={styles.privacyText}>
          Your CSV stays on your phone. bingd only gets what it needs: titles, years, IMDb ids,
          and your ratings. The dates you rated things are never sent.
        </Text>
      </View>

      <View style={styles.actions}>
        <Button label="Choose IMDb CSV" onPress={onPick} />
        {exit}
        <Button label="Need help getting the file?" kind="tertiary" onPress={onHowTo} />
        {onChooseAgain ? (
          <Button label="Choose a different service" kind="tertiary" onPress={onChooseAgain} />
        ) : null}
      </View>
    </View>
  );
}

/** "1 movie", "2 movies". */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the IMDb file holds, before anything is sent.
 *
 * Movies and TV shows are counted separately because they will not be treated alike: a movie
 * joins the collection, and a whole show is matched and reported but **not added in this
 * release** (founder decision, 2026-11-11). Since 20261114000200 a whole show is rankable in
 * its own pool, so the old season-only reason no longer holds: an IMDb rating of a
 * show is not a bingd ranking, and importing never ranks or logs a show or a season. The
 * copy says exactly that (founder, 2026-11-11 6:35 PM CST). The preview labels the
 * limitation on the count itself, so neither the summary nor the collection is the first
 * place somebody learns it.
 */
function ImdbPreviewView({
  preview,
  onStart,
  onReset,
  exit,
}: {
  preview: ImdbPreview;
  onStart: () => void;
  onReset: () => void;
  exit?: React.ReactNode;
}) {
  const { counts } = preview.normalised;
  const unsupported = counts.episodes + counts.otherUnsupported;
  const unread = counts.malformed + counts.invalidIds;

  return (
    <View style={styles.block}>
      <Text variant="display">Ready to import</Text>
      <Text variant="body" tone="secondary">
        Here’s what we found in your IMDb file.
      </Text>

      <View style={styles.card}>
        <Stat label="Movies" value={counts.movies} />
        {counts.tvShows > 0 ? (
          <Stat label="TV shows, not added" value={counts.tvShows} />
        ) : null}
        <Stat label="Ratings" value={counts.rated} />
        {unsupported > 0 ? <Stat label="Not supported" value={unsupported} /> : null}
      </View>

      {counts.tvShows > 0 ? (
        <Note>
          {`We’ll look for the ${plural(counts.tvShows, 'show', 'shows')} you rated and count the ones we find in your summary. bingd lets you rank entire TV shows or individual seasons. TV shows from IMDb imports aren’t added yet.`}
        </Note>
      ) : null}
      {counts.episodes > 0 ? (
        <Note>
          {`${plural(counts.episodes, 'TV episode', 'TV episodes')} won’t come in, because bingd doesn’t track single episodes.`}
        </Note>
      ) : null}
      {counts.damaged || unread > 0 ? (
        <Note warning>
          {counts.damaged
            ? 'Part of your file couldn’t be read, so some titles may be missing. Everything we could read is here.'
            : `${plural(unread, 'row', 'rows')} couldn’t be read, so we skipped ${unread === 1 ? 'it' : 'them'}.`}
        </Note>
      ) : null}

      <Text variant="body" tone="secondary">
        Your IMDb ratings are kept as a note of where each movie came from. They don’t become
        bingd scores, and imported movies start unranked.
      </Text>

      <View style={styles.actions}>
        <Button
          label={`Import ${plural(counts.movies, 'movie', 'movies')}`}
          onPress={onStart}
        />
        {exit}
        <Button label="Choose a different file" kind="tertiary" onPress={onReset} />
      </View>
    </View>
  );
}

function Note({ children, warning = false }: { children: string; warning?: boolean }) {
  return (
    <View style={styles.warning}>
      <Ionicons
        name={warning ? 'alert-circle-outline' : 'information-circle-outline'}
        size={theme.layout.icon.sm}
        color={theme.text.tertiary}
      />
      <Text variant="footnote" tone="tertiary" style={styles.warningText}>
        {children}
      </Text>
    </View>
  );
}

/**
 * How the IMDb import went, in the founder's six outcomes (spec §10): added to collection,
 * already in collection, previously imported, unmatched, unsupported, import failed.
 *
 * Zero rows are left out, as on the Letterboxd summary, except *Added to collection*, the
 * number the next step is about. Media-type sentences appear only when they explain a count:
 * a show and an episode are "not supported" for different reasons, and each gets its own.
 */
function ImdbSummary({
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
  onContinue?: () => void;
}) {
  const added = counts.watched ?? 0;
  // Built here and left alone. A second IMDb id naming a title this import just placed
  // (`duplicate`) is not "already in your collection": it is counted once, as added, and
  // not again (independent review, 2026-11-11).
  const inCollection = counts.kept ?? 0;
  const previously = counts.already ?? 0;
  const unmatched =
    (counts.ambiguous ?? 0) + (counts.unmatched ?? 0) + (counts.stragglers ?? 0);
  const unsupported = counts.unsupported ?? 0;
  const failed = counts.failed ?? 0;
  // Whole shows the import MATCHED to bingd's show and did not add (founder decision,
  // 2026-11-11: IMDb shows are not imported this release, although a show is rankable). They are reported on
  // their own line, not as "Not supported": the title is supported, the destination is not.
  const shows = counts.unsupported_tv ?? 0;
  const episodes = counts.unsupported_episode ?? 0;
  const notSupported = Math.max(unsupported - shows, 0);
  // Whatever else bingd has no destination for: games, music videos, podcasts, or an id
  // TMDB files as an episode. Every "Not supported" gets a sentence.
  const otherUnsupported = Math.max(unsupported - shows - episodes, 0);

  return (
    <View style={styles.block}>
      {/* "Already here" only when something was: a file that added nothing because
          nothing matched says that instead, with the lines below saying why (2026-11-11). */}
      <Text variant="display">
        {added > 0
          ? 'Your IMDb history is in'
          : inCollection + previously > 0
            ? 'Your IMDb history is already here'
            : 'Nothing was added'}
      </Text>

      <View style={styles.card}>
        <Count value={added} label="Added to your collection" />
        {inCollection > 0 ? (
          <Count value={inCollection} label="Already in your collection" />
        ) : null}
        {previously > 0 ? <Count value={previously} label="Imported before" /> : null}
        {unmatched > 0 ? <Count value={unmatched} label="Couldn’t match" /> : null}
        {shows > 0 ? <Count value={shows} label="TV shows matched, not added" /> : null}
        {notSupported > 0 ? <Count value={notSupported} label="Not supported" /> : null}
        {failed > 0 ? <Count value={failed} label="Couldn’t import" /> : null}
      </View>

      {shows > 0 ? (
        <Text variant="footnote" tone="tertiary">
          {`${plural(shows, 'TV show was', 'TV shows were')} matched but not added. bingd lets you rank entire TV shows or individual seasons. TV shows from IMDb imports aren’t added yet.`}
        </Text>
      ) : null}
      {episodes > 0 ? (
        <Text variant="footnote" tone="tertiary">
          {`${plural(episodes, 'TV episode wasn’t', 'TV episodes weren’t')} added. bingd doesn’t track single episodes.`}
        </Text>
      ) : null}
      {otherUnsupported > 0 ? (
        <Text variant="footnote" tone="tertiary">
          {`${plural(otherUnsupported, 'title wasn’t', 'titles weren’t')} added because ${otherUnsupported === 1 ? 'it’s' : 'they’re'} a kind of title bingd doesn’t track, like a game or a single episode.`}
        </Text>
      ) : null}
      {unmatched > 0 ? (
        <Text variant="footnote" tone="tertiary">
          {`We couldn’t match ${plural(unmatched, 'title', 'titles')} from your file, so ${unmatched === 1 ? 'it wasn’t' : 'they weren’t'} added.`}
        </Text>
      ) : null}
      {failed > 0 ? (
        <Text variant="footnote" tone="tertiary">
          {`${plural(failed, 'title', 'titles')} couldn’t be saved. Importing the file again is safe: nothing is added twice.`}
        </Text>
      ) : null}

      {added > 0 ? (
        <Text variant="body" tone="secondary">
          Imported movies start unranked, and your IMDb ratings stay a note rather than a score.
          Rank them whenever you want. A ranking you make in bingd always wins.
        </Text>
      ) : null}

      {onContinue ? (
        <View style={styles.actions}>
          <Button label="Continue" onPress={onContinue} />
        </View>
      ) : (
        <View style={styles.actions}>
          {added > 0 ? <Button label="Rank imported movies" onPress={onRank} /> : null}
          <Button label="Done" kind={added > 0 ? 'secondary' : 'primary'} onPress={onDone} />
          <Button label="Import another file" kind="tertiary" onPress={onReset} />
        </View>
      )}
    </View>
  );
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
