import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { strToU8, zipSync } from 'fflate';
import { BackHandler, StyleSheet } from 'react-native';

import {
  clearCelebrations,
  enqueueCelebrations,
  hasCelebrations,
} from '@/features/awards/celebration-queue';
import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { flowProgress, FLOW_STEPS } from './OnboardingHeader';
import { resetOnboardingStages, stageInMemory } from './use-onboarding-stage';

// Not colocated with the route: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import LetterboxdStepScreen from '../../../app/onboarding/letterboxd';

/**
 * The optional *Already use Letterboxd?* step (founder, preview QA Round 3, 2026-09-13).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS DEFENDING
 *
 *   - **Never required.** Not now works from the first frame, after a cancelled picker and
 *     after a refused file, and it carries on to People without a request.
 *   - **The real importer.** The archive below is a real ZIP read by the real reader, and
 *     the RPCs are the ones Settings makes; nothing here is a second import path.
 *   - **The step lets go at acceptance.** Once `import_ready` succeeds the screen offers
 *     Continue, and neither Continue nor unmounting discards or cancels the job.
 *   - **A running import is shown, not duplicated**, whether it is found on open (a
 *     relaunch on this step) or handed back by `import_create`.
 *
 * Each test presses distinct controls only: two presses of one element in a test poison
 * later renders in the file (`bingd-rntl-double-press-poisons-renders`).
 */

const mockReplace = jest.fn();
const mockRpc = jest.fn();
const mockTrack = jest.fn();
const mockPrefs = new Map<string, unknown>();
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, unknown> = {};
/** RPC names whose call never settles, to stand inside a state. */
let mockRpcHangs = new Set<string>();
/**
 * RPC names answered the way the production fetch deadline answers them: late, with
 * PostgREST's shape for an aborted `fetch` (`status: 0`, an abort message, no code).
 */
let mockRpcAborts = new Set<string>();

/**
 * The importer's step deadline, scaled down so a test can wait it out in real time.
 * Everything else about `withGrace` is the real helper.
 */
jest.mock('@/lib/grace', () => {
  const actual = jest.requireActual('@/lib/grace');
  return {
    withGrace: <T, F>(work: Promise<T>, graceMs: number, fallback: F) =>
      actual.withGrace(work, Math.min(graceMs, 40), fallback),
  };
});

/** What the picker answers with. `null` means the person cancelled. */
let mockPicked: Uint8Array | null = null;

/** What the open-job lookup on `import_jobs` answers. */
let mockLiveJob: { data: unknown; error: unknown } = { data: null, error: null };
/** The lookup never answering, so nobody knows yet whether an import is running. */
let mockLiveJobHangs = false;
let mockLookupsAnswered = 0;

jest.mock('expo-file-system', () => ({
  File: {
    pickFileAsync: () =>
      mockPicked === null
        ? Promise.resolve({ canceled: true, result: null })
        : Promise.resolve({
            canceled: false,
            result: { size: mockPicked.length, bytes: () => Promise.resolve(mockPicked) },
          }),
  },
}));

const mockAnswer = (name: string) => {
  const value = mockRpcResults[name];
  return typeof value === 'function' ? (value as () => unknown)() : (value ?? null);
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      if (mockRpcHangs.has(name)) {
        const never = new Promise(() => {});
        return Object.assign(never, { maybeSingle: () => never });
      }
      if (mockRpcAborts.has(name)) {
        const aborted = {
          data: null,
          error: {
            message: 'AbortError: The request did not answer within 10000ms.',
            code: '',
          },
          status: 0,
        };
        const late = new Promise((resolve) => setTimeout(() => resolve(aborted), 10));
        return Object.assign(late, { maybeSingle: () => late });
      }
      const error = mockRpcErrors[name] ?? null;
      const data = error ? null : mockAnswer(name);
      const result = { data, error, maybeSingle: () => Promise.resolve({ data, error }) };
      return Object.assign(Promise.resolve(result), result);
    },
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () =>
          mockLiveJobHangs
            ? new Promise(() => {})
            : Promise.resolve(mockLiveJob).then((answer) => {
                mockLookupsAnswered += 1;
                return answer;
              }),
      };
      return builder;
    },
  },
}));

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: jest.fn(),
    back: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: () => false,
  }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('@/lib/analytics', () => ({
  track: (event: unknown) => mockTrack(event),
}));

const shows = () =>
  (globalThis as unknown as { __modalShows: { refused: number } }).__modalShows;

const JOB = '11111111-2222-4333-8444-555555555555';

/** A Letterboxd export, as a real archive the real reader opens. */
const exportZip = () =>
  zipSync({
    'letterboxd-sai-2026-09-13/watched.csv': strToU8(
      'Date,Name,Year,Letterboxd URI\n' +
        '2024-01-02,Shrek,2001,https://boxd.it/2a\n' +
        '2024-01-03,Dune,2021,https://boxd.it/2b\n',
    ),
  });

const called = () => mockRpc.mock.calls.map(([name]) => name as string);

const stepEvents = () =>
  mockTrack.mock.calls
    .map(([event]) => event as { name: string; props: Record<string, unknown> })
    .filter((event) => event.name === 'onboarding_step_completed');

beforeEach(() => {
  mockReplace.mockClear();
  mockRpc.mockClear();
  mockTrack.mockClear();
  mockPrefs.clear();
  mockRpcResults = {};
  mockRpcErrors = {};
  mockRpcHangs = new Set();
  mockRpcAborts = new Set();
  clearCelebrations();
  mockPicked = null;
  mockLiveJob = { data: null, error: null };
  mockLiveJobHangs = false;
  mockLookupsAnswered = 0;
  resetOnboardingStages();
});

/** The question, drawn and settled (the open-job lookup has answered with nothing). */
const open = async () => {
  const view = await renderWithProviders(<LetterboxdStepScreen />);
  await waitFor(() => expect(view.getByText('Already use Letterboxd?')).toBeTruthy());
  if (!mockLiveJobHangs) {
    await waitFor(() => expect(mockLookupsAnswered).toBeGreaterThan(0));
    // The hook's own continuation after the answer.
    await act(async () => {});
  }
  return view;
};

describe('the question', () => {
  it('asks, says what comes over, and offers both answers', async () => {
    const view = await open();

    // The founder's copy, 2026-09-14.
    expect(
      view.getByText(
        'Bring over what you’ve watched, your ratings, diary dates, and watchlist. Imported titles start unranked, so your bingd rankings stay yours.',
      ),
    ).toBeTruthy();
    expect(view.getByRole('button', { name: 'Import from Letterboxd' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Need help getting the file?' })).toBeTruthy();
    // The privacy promise travels with the importer into onboarding.
    expect(
      view.getByText(
        'Your ZIP stays on your phone. bingd only reads the information needed for your import.',
      ),
    ).toBeTruthy();
    // Not Settings' instructions page.
    expect(view.queryByText('Bring your Letterboxd history')).toBeNull();
  });

  /**
   * **The page the steps either side of it draw** (founder, physical preview QA,
   * 2026-09-14): the gutter intro under `title1`, then a hairline-topped footer holding the
   * actions, with People's exact values. Asserted as structure because jest lays nothing
   * out: the headline and body sit in the scrolling intro, and the footer holds the three
   * actions in the founder's order with the privacy line last, outside what scrolls.
   */
  /**
   * **The flow's gutters and type, with the actions right after the words** (founder,
   * physical preview QA, 2026-09-14, twice). The intro keeps People's values. The actions are
   * **not** pinned in a footer: this question is two lines, and a pinned footer under two
   * lines is the large blank band the founder met coming back from *Choose a different file*.
   * So the actions and the privacy line share the intro's scroll body, in the founder's
   * order, in the flow's gutter, and nothing between them stretches.
   */
  it('draws the flow’s page, with the actions following the words', async () => {
    const view = await open();

    const headline = view.getByText('Already use Letterboxd?');
    const intro = headline.parent!;
    expect(StyleSheet.flatten(intro.props.style)).toMatchObject({
      paddingHorizontal: theme.layout.gutter,
      paddingTop: theme.space[3],
      paddingBottom: theme.space[4],
      gap: theme.space[2],
    });

    const actions = view.getByRole('button', { name: 'Import from Letterboxd' }).parent!;
    const actionStyle = StyleSheet.flatten(actions.props.style);
    expect(actionStyle).toMatchObject({
      paddingHorizontal: theme.layout.gutter,
      gap: theme.space[2],
    });
    // No spacer and no stretch: nothing here grows to fill the screen.
    expect(actionStyle.flex).toBeUndefined();
    expect(actionStyle.flexGrow).toBeUndefined();
    expect(actionStyle.marginTop).toBeUndefined();

    for (const name of ['Import from Letterboxd', 'Not now', 'Need help getting the file?']) {
      expect(view.getByRole('button', { name }).parent).toBe(actions);
    }
    expect(
      view.getByText(
        'Your ZIP stays on your phone. bingd only reads the information needed for your import.',
      ).parent,
    ).toBe(actions);

    // The words and the actions are siblings in one scroll body, words first.
    expect(actions.parent).toBe(intro.parent);
    const siblings = actions.parent!.children as unknown[];
    expect(siblings.indexOf(intro)).toBeLessThan(siblings.indexOf(actions));
    const scroll = intro.parent!.parent!;
    expect(scroll.props.contentContainerStyle).toBeDefined();
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle).flexGrow).toBeUndefined();
  });

  /**
   * **Coming back looks exactly like arriving** (founder, 2026-09-14: *Choose a different
   * file* returned to this question with a giant blank area). The same tree, the same styles,
   * whether the reader got here fresh or from the preview.
   */
  it('returns from Choose a different file to the same page it opened on', async () => {
    const fresh = await open();
    const outline = (view: typeof fresh) => {
      const headline = view.getByText('Already use Letterboxd?');
      const actions = view.getByRole('button', { name: 'Import from Letterboxd' }).parent!;
      return JSON.stringify({
        intro: StyleSheet.flatten(headline.parent!.props.style),
        actions: StyleSheet.flatten(actions.props.style),
        body: StyleSheet.flatten(headline.parent!.parent!.parent!.props.contentContainerStyle),
      });
    };
    const before = outline(fresh);

    mockPicked = exportZip();
    await fireEvent.press(fresh.getByRole('button', { name: 'Import from Letterboxd' }));
    await waitFor(() => expect(fresh.getByText('Ready to import')).toBeTruthy());
    await fireEvent.press(fresh.getByRole('button', { name: 'Choose a different file' }));

    await waitFor(() => expect(fresh.getByText('Already use Letterboxd?')).toBeTruthy());
    expect(outline(fresh)).toBe(before);
  });

  it('does not count the importer as opened just because the step was shown', async () => {
    await open();

    expect(mockTrack).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'import_opened' }),
    );
  });

  it('draws the flow’s progress line, between the payoff and People', () => {
    expect(FLOW_STEPS.indexOf('letterboxd')).toBe(FLOW_STEPS.indexOf('payoff') + 1);
    expect(flowProgress('letterboxd')).toBeLessThan(flowProgress('people'));
    expect(flowProgress('letterboxd')).toBeGreaterThan(flowProgress('payoff'));
  });

  /**
   * Back is not intercepted, the same as every other step: the screen is reached by
   * `replace`, so there is nothing to walk back to, and a handler here is how a hardware
   * back comes to mean "abandon the upload" or to trap somebody on the step.
   */
  it('registers no hardware back handler that could trap somebody on the step', async () => {
    const spy = jest.spyOn(BackHandler, 'addEventListener');
    try {
      await open();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Not now', () => {
  it('carries on to People, touches nothing on the server, and says it was skipped', async () => {
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(stageInMemory('user-1')).toBe('people');
    await waitFor(() => expect(mockPrefs.get('user-1.onboarding.stage')).toBe('people'));
    expect(stepEvents()).toEqual([
      {
        name: 'onboarding_step_completed',
        props: { step: 'letterboxd', outcome: 'skipped' },
      },
    ]);
    expect(called()).toEqual([]);
  });

  /**
   * An award earned in the ranking run waits for the end of onboarding, where the
   * notification step drains it (`FlowEnds.test.tsx`). This step is not the end, and the
   * celebration route would be replaced straight back from here.
   */
  it('leaves an award from the ranking run queued for the end of onboarding', async () => {
    enqueueCelebrations([{ kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' }]);
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(hasCelebrations()).toBe(true);
  });

  it('is still there after the picker is cancelled, with the import still offered', async () => {
    mockPicked = null;
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith({
        name: 'import_archive_selected',
        props: { outcome: 'cancelled' },
      }),
    );
    // Back on the question, both answers live, and no apology for a choice.
    expect(view.getByText('Already use Letterboxd?')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Import from Letterboxd' })).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    // The press that reached the importer is the one that counts it.
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_opened',
      props: { surface: 'onboarding' },
    });
  });

  it('is offered beside the importer’s own explanation of a file that is not the ZIP', async () => {
    mockPicked = strToU8(
      'Date,Name,Year,Letterboxd URI\n2024-01-02,Shrek,2001,https://boxd.it/2a\n',
    );
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));

    await waitFor(() => expect(view.getByText(/not the Letterboxd ZIP/)).toBeTruthy());
    expect(view.getByText('Choose Letterboxd ZIP')).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(stepEvents()[0]?.props).toEqual({ step: 'letterboxd', outcome: 'skipped' });
    expect(called()).toEqual([]);
  });

  it('is offered on the preview, before anything is sent', async () => {
    mockPicked = exportZip();
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));
    await waitFor(() => expect(view.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(called()).toEqual([]);
  });
});

describe('importing from the step', () => {
  /** Pending on the pre-stage read, then running on the server for as long as it is asked. */
  const serverAccepts = () => {
    let reads = 0;
    mockRpcResults = {
      import_create: JOB,
      import_status: () => {
        reads += 1;
        return reads === 1
          ? { status: 'pending', counts: null, completed_at: null }
          : { status: 'matching', counts: {}, completed_at: null };
      },
    };
  };

  it('hands the file to the server, says it carries on, and lets Continue go without touching the job', async () => {
    mockPicked = exportZip();
    serverAccepts();
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));
    await waitFor(() => expect(view.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(view.getByText('Import 2 films'));

    // Accepted: the step does not wait for the result.
    await waitFor(() =>
      expect(view.getByText('Your Letterboxd import is on its way')).toBeTruthy(),
    );
    expect(
      view.getByText(/keeps running in the background, even if you close bingd\./),
    ).toBeTruthy();
    expect(view.getByText(/let you know when it’s done/)).toBeTruthy();
    expect(view.getByText(/anytime in Settings/)).toBeTruthy();
    expect(called().slice(0, 4)).toEqual([
      'import_create',
      'import_status',
      'import_stage',
      'import_ready',
    ]);
    // No way to decline an import that is already on the server.
    expect(view.queryByRole('button', { name: 'Not now' })).toBeNull();

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(stepEvents()).toEqual([
      {
        name: 'onboarding_step_completed',
        props: { step: 'letterboxd', outcome: 'continued' },
      },
    ]);

    // Leaving the screen is not leaving the import.
    await view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(called()).not.toContain('import_discard');
  });

  /**
   * **The upload screen has no buttons, so every wait behind it must end** (independent
   * review 83b, which found the earlier version of this test pinning a dead end).
   *
   * Two shapes of a lost request, both of which now land on the importer's own refusal
   * with Not now beside Try again: the production fetch deadline, which PostgREST answers
   * as `status: 0` with an abort message, and a stall in front of the network that no
   * fetch deadline sees, which `IMPORT_STEP_DEADLINE_MS` bounds.
   */
  it('turns a page the fetch deadline aborted into a refusal with Not now', async () => {
    mockPicked = exportZip();
    serverAccepts();
    mockRpcAborts = new Set(['import_stage']);
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));
    await waitFor(() => expect(view.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(view.getByText('Import 2 films'));

    await waitFor(() => expect(view.getByText(/didn.+t finish sending/)).toBeTruthy());
    expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(stepEvents()[0]?.props).toEqual({ step: 'letterboxd', outcome: 'skipped' });
    expect(called()).not.toContain('import_discard');
  });

  it('turns a page that never answers at all into the same refusal, once the step deadline passes', async () => {
    mockPicked = exportZip();
    serverAccepts();
    mockRpcHangs = new Set(['import_stage']);
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));
    await waitFor(() => expect(view.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(view.getByText('Import 2 films'));

    await waitFor(() => expect(view.getByText(/didn.+t finish sending/)).toBeTruthy());
    expect(called()).not.toContain('import_ready');
    expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Not now' })).toBeTruthy();
  });

  /**
   * **A skip is only a skip when nothing is running** (independent review, 2026-09-13).
   * Leaving before the open-job lookup has answered, or after a hand-off whose answer was
   * lost, may leave an import on the server, so it reports `continued`, the step's other
   * existing outcome.
   */
  it('does not call leaving a skip before it knows whether an import is running', async () => {
    mockLiveJobHangs = true;
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(stepEvents()[0]?.props).toEqual({ step: 'letterboxd', outcome: 'continued' });
  });

  it('does not call leaving a skip after a hand-off whose answer was lost', async () => {
    mockPicked = exportZip();
    serverAccepts();
    mockRpcHangs = new Set(['import_ready']);
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));
    await waitFor(() => expect(view.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(view.getByText('Import 2 films'));
    await waitFor(() => expect(view.getByText('We couldn’t check your import')).toBeTruthy());

    // Start over is the importer's own; it returns to the question with Not now on it.
    await fireEvent.press(view.getByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(view.getByText('Already use Letterboxd?')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    expect(stepEvents()[0]?.props).toEqual({ step: 'letterboxd', outcome: 'continued' });
  });

  /**
   * **A hand-off whose answer was lost is not a failure.** `import_ready` may have
   * committed, so the step says it could not check, keeps the job, and offers Continue (an
   * import may well be running) and Try again, which asks about that job by id.
   */
  it('says it could not check a hand-off that never answered, and finds the job on Try again', async () => {
    mockPicked = exportZip();
    serverAccepts();
    mockRpcHangs = new Set(['import_ready']);
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));
    await waitFor(() => expect(view.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(view.getByText('Import 2 films'));

    await waitFor(() => expect(view.getByText('We couldn’t check your import')).toBeTruthy());
    expect(view.queryByText(/didn.+t finish sending/)).toBeNull();
    expect(view.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(called()).not.toContain('import_discard');

    await fireEvent.press(view.getByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(view.getByText('Your Letterboxd import is on its way')).toBeTruthy(),
    );
    expect(mockRpc).toHaveBeenLastCalledWith('import_status', { p_job_id: JOB });
    expect(called()).not.toContain('import_discard');
  });

  it('shows the result with Continue when the import finishes while the step is open', async () => {
    mockPicked = exportZip();
    let reads = 0;
    mockRpcResults = {
      import_create: JOB,
      import_status: () => {
        reads += 1;
        return reads === 1
          ? { status: 'pending', counts: null, completed_at: null }
          : {
              status: 'done',
              counts: { applied: 2, watched: 2, watchlist: 0, viewings: 0 },
              completed_at: '2026-09-13T00:00:00.000Z',
            };
      },
    };
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));
    await waitFor(() => expect(view.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(view.getByText('Import 2 films'));

    await waitFor(() => expect(view.getByText('Your Letterboxd history is in')).toBeTruthy());
    // Collection is outside the flow, and the guard would send it straight back.
    expect(view.queryByText('Rank imported titles')).toBeNull();
    expect(view.queryByText('Import another file')).toBeNull();
    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(stepEvents()[0]?.props).toEqual({ step: 'letterboxd', outcome: 'continued' });
  });

  it('opens the instructions over the step without a refused presentation', async () => {
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Need help getting the file?' }));
    await waitFor(() => expect(view.getByText('Getting your Letterboxd file')).toBeTruthy());
    // The founder's four steps, numbered, in Letterboxd's current tab names.
    for (const step of [
      'Open Letterboxd.com and go to Settings → Import & Export.',
      'Choose Export your data to generate your export.',
      'Download the ZIP when it’s ready.',
      'Come back to bingd and choose that ZIP.',
    ]) {
      expect(view.getByText(step)).toBeTruthy();
    }
    expect(view.getByRole('button', { name: 'Open Letterboxd’s export page' })).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(view.queryByText('Getting your Letterboxd file')).toBeNull());
    expect(shows().refused).toBe(0);
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_opened',
      props: { surface: 'onboarding' },
    });
  });
});

describe('an import that is already running', () => {
  /**
   * **A relaunch on this step.** The stage brings somebody back here with the import they
   * started still on the server; the step has to show it, not ask the question again.
   */
  it('is shown on open with Continue, and no second import is started', async () => {
    mockLiveJob = {
      data: { id: JOB, status: 'matching', counts: {}, completed_at: null },
      error: null,
    };
    const view = await renderWithProviders(<LetterboxdStepScreen />);

    await waitFor(() =>
      expect(view.getByText('Your Letterboxd import is on its way')).toBeTruthy(),
    );
    expect(view.queryByText('Already use Letterboxd?')).toBeNull();
    expect(called()).not.toContain('import_create');

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(stepEvents()[0]?.props).toEqual({ step: 'letterboxd', outcome: 'continued' });
    expect(called()).not.toContain('import_discard');
  });

  it('is not staged onto when import_create hands it back, and the step still carries on', async () => {
    // The lookup on open missed it, so the question was asked; `import_create` then adopts
    // the running job, and the importer refuses to stage a second archive onto it.
    mockPicked = exportZip();
    mockRpcResults = {
      import_create: JOB,
      import_status: { status: 'matching', counts: {}, completed_at: null },
    };
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Import from Letterboxd' }));
    await waitFor(() => expect(view.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(view.getByText('Import 2 films'));

    await waitFor(() => expect(view.getByText('An import is already running')).toBeTruthy());
    expect(called()).not.toContain('import_stage');
    expect(view.getByText('See the import that’s running')).toBeTruthy();
    // An import is running, so nothing is being declined.
    expect(view.queryByRole('button', { name: 'Not now' })).toBeNull();
    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
    expect(stepEvents()[0]?.props).toEqual({ step: 'letterboxd', outcome: 'continued' });
    expect(called()).not.toContain('import_discard');
  });
});
