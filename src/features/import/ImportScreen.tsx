import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import type { Edge } from 'react-native-safe-area-context';

import type { ImportSurface } from '@/lib/analytics';
import { unrankedMovies } from '@/lib/routes';
import { Button, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { CompletionSummary } from './CompletionSummary';
import { ExportHelp } from './ExportHelp';
import { ImportIntro, INTRO_COPY } from './ImportIntro';
import { PreviewSummary, QUIET_SLOP } from './PreviewSummary';
import { ProviderChoice } from './ProviderChoice';
import { PROVIDER_NAME, type ImportProvider } from './providers';
import {
  providerOfJob,
  useImport,
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
    // The intro's action, so the retry on a refused file says the same thing (IMP1113-UI).
    choose: INTRO_COPY.letterboxd.upload,
    empty:
      'It’s a real Letterboxd export, but it has no films in it. Log something on Letterboxd, export again, and choose the new file.',
    tooLarge:
      'It’s much larger than any Letterboxd export, so bingd won’t open it. Check you picked the right file. If it really is your export, let us know from Settings.',
  },
  imdb: {
    importing: 'Importing your IMDb history',
    onItsWay: 'Your IMDb import is on its way',
    couldNotFinish: 'We couldn’t finish your IMDb import',
    choose: INTRO_COPY.imdb.upload,
    empty:
      'It’s a real IMDb ratings export, but there’s nothing rated in it. Rate something on IMDb, export again, and choose the new file.',
    tooLarge:
      'It’s much larger than any IMDb ratings export, so bingd won’t open it. Check you picked the right file. If it really is your export, let us know from Settings.',
  },
} as const satisfies Record<ImportProvider, Record<string, string>>;

type Copy = (typeof COPY)[ImportProvider];

/** Under a native-stack header: the header owns the top inset. See the render. */
const HEADER_EDGES: readonly Edge[] = ['left', 'right'];
/** With no header above it, as `Screen`'s own default. */
const ONBOARDING_EDGES: readonly Edge[] = ['top', 'left', 'right'];

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
 *   entry       Bring over your Letterboxd history      (ImportIntro)
 *   preview     Ready to import                         (PreviewSummary)
 *   running     Importing your Letterboxd history
 *   pushed      Letterboxd import started / Your Letterboxd history is ready /
 *               We couldn't finish your Letterboxd import
 *   finished    Your Letterboxd history is in           (CompletionSummary)
 *
 * IMP1113-UI moved each provider-aware phase into its own file (`ImportIntro`,
 * `ExportHelp`, `PreviewSummary`, `CompletionSummary`, `UnmatchedDisclosure`); this file
 * keeps the machine's wiring, the waiting states and the failures, and `useImport`, the
 * parsers and the counts are as they were.
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
 * and lists are never opened (`archive.ts`). The service pages no longer carry a privacy
 * block (founder, IMP1113-UI); the onboarding question and the choice of service keep the
 * founder's shorter line (2026-09-14), which is true of the same implementation: the file
 * stays on the phone and only what the import needs is read.
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

  /**
   * **To the other service, from a file that belongs to it** (IMP1113-UI polish). Only where
   * this screen was reached from the choice of service, because only there is the other
   * service one of the screen's own pages. `reset` first, so the failure and anything held
   * for it go, then the other service's page.
   */
  const switchProvider =
    chooser && fixedProvider === undefined
      ? (next: ImportProvider) => {
          reset();
          setChosen(next);
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
    /**
     * **The top edge is onboarding's alone** (founder QA, 2026-11-12, the Settings root's fix).
     * Settings ▸ Import from shows a native-stack header (`app/settings/import.tsx`), which
     * already consumes the status-bar inset, so `Screen`'s default `top` edge added it a second
     * time below the header. The onboarding step has no header (`headerShown: false` on
     * `onboarding/letterboxd`) and draws its own chrome inside this `Screen`, so there the top
     * edge is still this screen's. Left and right apply in both.
     */
    <Screen includeBottomInset edges={onboarding ? ONBOARDING_EDGES : HEADER_EDGES}>
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
          surface={surface}
          onPick={() => {
            opened();
            void pick();
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
            jobProvider={jobProvider}
            surface={surface}
            onPick={() => {
              // A no-op unless this is the onboarding step, where the count waits for a tap.
              opened();
              void pick();
            }}
            onStart={(preview) => void start(preview)}
            onReset={reset}
            onWatch={watchRunning}
            onRecheck={recheck}
            onSwitchProvider={switchProvider}
            onLeave={leave}
            onRank={() => router.dismissTo(unrankedMovies())}
            onboarding={step}
          />
        </ScrollView>
      )}
    </Screen>
  );
}

function Body({
  state,
  provider,
  copy,
  jobProvider,
  surface,
  onPick,
  onStart,
  onReset,
  onWatch,
  onLeave,
  onRank,
  onRecheck,
  onSwitchProvider,
  onboarding,
}: {
  state: ImportPhase;
  provider: ImportProvider;
  copy: Copy;
  /** Whose job a phase describes; the chosen provider before there is a job. */
  jobProvider: ImportProvider;
  surface: ImportSurface;
  onPick: () => void;
  onStart: (preview: ImportPreview) => void;
  onReset: () => void;
  onWatch: () => void;
  onLeave: () => void;
  onRank: () => void;
  onRecheck: () => void;
  /** To the other service's page. Absent where there is no choice of service. */
  onSwitchProvider?: (next: ImportProvider) => void;
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
      return (
        <ImportIntro
          provider={provider}
          surface={surface}
          onPick={onPick}
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

    case 'previewing': {
      const preview = state.preview;
      return (
        <PreviewSummary
          preview={preview}
          onStart={() => onStart(preview)}
          onReset={onReset}
          exit={skip ? <Button label="Not now" kind="secondary" onPress={skip} /> : undefined}
        />
      );
    }

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
      return (
        <CompletionSummary
          counts={state.status.counts}
          provider={state.status.provider ?? provider}
          jobId={state.status.jobId}
          onRank={onRank}
          onDone={onLeave}
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
          help={<ExportHelp provider={jobProvider} surface={surface} />}
          onReset={onReset}
          onWatch={onWatch}
          onSwitchProvider={onSwitchProvider}
        />
      );
  }
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
  surface,
  onPick,
  onSkip,
}: {
  surface: ImportSurface;
  onPick: () => void;
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
        <ExportHelp provider="letterboxd" surface={surface} />
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
  help,
  onReset,
  onWatch,
  onSwitchProvider,
  exit,
}: {
  failure: ImportFailure;
  copy: Copy;
  onRetry: () => void;
  retryLabel: string;
  /** The collapsed *Need help getting the file?*, for failures a different file would fix. */
  help: React.ReactNode;
  onReset: () => void;
  onWatch: () => void;
  /** To the other service's page, where the screen was reached from the choice. */
  onSwitchProvider?: (next: ImportProvider) => void;
  /** The onboarding step's way on. */
  exit?: React.ReactNode;
}) {
  const target = onSwitchProvider ? otherServiceFor(failure) : null;
  const { title, detail, showHowTo } = explain(failure, copy, target !== null);

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
        <Button
          label="Start over"
          kind={retryable || watchable ? 'tertiary' : 'primary'}
          onPress={onReset}
        />
        {target !== null && onSwitchProvider ? (
          // Quiet and centred, as *Choose a different file* on Ready: `sm` drawn at the
          // compact height, the slop returning it to the 44pt target.
          <View style={styles.quiet}>
            <Button
              label={`Import from ${PROVIDER_NAME[target]} instead`}
              kind="tertiary"
              tone="secondary"
              size="sm"
              hitSlop={QUIET_SLOP}
              onPress={() => onSwitchProvider(target)}
              testID="import-switch-provider"
            />
          </View>
        ) : null}
      </View>
      {showHowTo ? help : null}
    </View>
  );
}

/**
 * The service a refused file most likely belongs to: a ZIP picked on IMDb's page is
 * Letterboxd's export, and a file that is not a ZIP on Letterboxd's page may well be IMDb's
 * CSV. Null for every other failure.
 */
const otherServiceFor = (failure: ImportFailure): ImportProvider | null =>
  failure.kind !== 'archive'
    ? null
    : failure.reason === 'is_zip'
      ? 'letterboxd'
      : failure.reason === 'not_a_zip'
        ? 'imdb'
        : null;

function explain(
  failure: ImportFailure,
  copy: Copy = COPY.letterboxd,
  /** The page offers *Import from … instead*, so the detail can point at it. */
  canSwitch = false,
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
        // No "go back" (IMP1113-UI polish): with the choice of service, the button below
        // does it; without one, the sentence names what to choose.
        detail: canSwitch
          ? 'IMDb exports one CSV file. If this is your Letterboxd export, you can import it from Letterboxd instead.'
          : 'IMDb exports one CSV file. If this is your Letterboxd export, choose Letterboxd instead.',
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
        detail: canSwitch
          ? 'Letterboxd sends a ZIP file. If your computer unzipped it, use the original download. A single CSV isn’t enough. If this is your IMDb ratings export, you can import it from IMDb instead.'
          : 'Letterboxd sends a ZIP file. If your computer unzipped it, use the original download. A single CSV isn’t enough.',
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
  actions: { gap: theme.space[2], marginTop: theme.space[2] },
  waiting: {
    gap: theme.space[3],
    alignItems: 'center',
    paddingVertical: theme.space[10],
  },
  waitingAction: { alignSelf: 'stretch', marginTop: theme.space[3] },
  centred: { textAlign: 'center' },
  quiet: { alignItems: 'center' },
});
