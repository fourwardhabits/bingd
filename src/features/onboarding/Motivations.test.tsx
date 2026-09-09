import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { MOTIVATIONS, chosenMotivations, motivationsProperty } from './motivations';
import { resetMotivationSelection } from './motivation-selection';
import { advanceStage, resetOnboardingStages, stageInMemory } from './use-onboarding-stage';
import { resetTasteIntent } from './use-taste-onboarding';

// Not colocated with the routes: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import MotivationsScreen from '../../../app/onboarding/motivations';
import AnswersScreen from '../../../app/onboarding/answers';

const mockReplace = jest.fn();
const mockPrefs = new Map<string, unknown>();
const mockTrack = jest.fn();

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

jest.mock('@/lib/analytics', () => ({
  track: (event: unknown) => mockTrack(event),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
  // The two screens before the profile form read the account id instead, which is
  // what an `onboarding` session can answer. See `useCurrentUserId`.
  useCurrentUserId: () => 'user-1',
  useAuth: () => ({ status: 'onboarding', userId: 'user-1', email: null }),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: () => Promise.resolve({ data: null, error: null }) },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => {
  mockReplace.mockReset();
  mockTrack.mockReset();
  mockPrefs.clear();
  resetMotivationSelection();
  resetOnboardingStages();
  resetTasteIntent();
});

const eventsNamed = (name: string) =>
  mockTrack.mock.calls.map(([event]) => event).filter((event) => event.name === name);

describe('the six, as data', () => {
  it('keeps the founder’s canonical order', () => {
    expect(MOTIVATIONS.map((motivation) => motivation.id)).toEqual([
      'favorites',
      'friends_watching',
      'next_watch',
      'group_picks',
      'taste_match',
      'collection',
    ]);
  });

  /**
   * **The order is never re-sorted by what was picked.** Floating the chosen ones to the
   * top of step 4 sounds helpful and is not: the reader met these six in a fixed order one
   * screen ago, and reordering asks them to find their own answers again in a list that
   * has moved.
   */
  it('answers in canonical order whatever order they were chosen in', () => {
    const picked = new Set(['collection', 'favorites'] as const);
    expect(chosenMotivations(picked).map((motivation) => motivation.id)).toEqual([
      'favorites',
      'collection',
    ]);
  });

  /**
   * **A scalar, and this is a correctness rule rather than a style.**
   *
   * `sanitize` in `lib/analytics.ts` accepts strings, numbers and booleans and drops
   * everything else, so that a whole row cannot reach a vendor because somebody spread an
   * object into a property bag. An array here would not be rejected loudly: it would be
   * discarded silently, and the event would arrive looking complete with its one
   * interesting property missing.
   */
  it('reports the picks as a delimited string rather than an array', () => {
    const picked = new Set(['collection', 'favorites'] as const);
    const value = motivationsProperty(picked);

    expect(typeof value).toBe('string');
    expect(value).toBe('favorites|collection');
  });

  /**
   * The founder's standing rule, applied to the flow's own copy. The app uses `·` where a
   * separator is needed.
   */
  it('uses no em dash or en dash anywhere in the copy', () => {
    const copy = MOTIVATIONS.flatMap((motivation) => [
      motivation.label,
      motivation.feature,
      motivation.answer,
    ]).join(' ');

    expect(copy).not.toContain('—');
    expect(copy).not.toContain('–');
  });

  /**
   * Onboarding copy naming a surface the reader then cannot find is the one kind of copy
   * error that costs trust immediately, so the names are pinned to the app's own.
   */
  it('names only surfaces that exist', () => {
    const features = MOTIVATIONS.map((motivation) => motivation.feature);
    expect(features).toEqual([
      'Ranking.',
      'Feed.',
      'For You.',
      'Group Picks.',
      'Taste Match.',
      'Collection.',
    ]);
  });
});

describe('step 3, the question', () => {
  const open = async () => {
    const view = await renderWithProviders(<MotivationsScreen />);
    await waitFor(() => expect(view.getByText('What do you want out of bingd.?')).toBeTruthy());
    return view;
  };

  it('offers all six, in canonical order', async () => {
    const view = await open();
    for (const motivation of MOTIVATIONS) {
      expect(view.getByLabelText(motivation.label)).toBeTruthy();
    }
  });

  it('says the limit is not one, because nothing else on the screen does', async () => {
    const view = await open();
    expect(view.getByText('Pick as many as you like.')).toBeTruthy();
  });

  /**
   * **The only gate in the flow**, and it exists because step 4 has nothing to draw
   * otherwise rather than because an answer is owed.
   */
  it('will not continue at zero', async () => {
    const view = await open();

    expect(
      view.getByRole('button', { name: 'Continue' }).props.accessibilityState.disabled,
    ).toBe(true);

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('marks a row as chosen, and lets it be unchosen', async () => {
    const view = await open();
    const row = view.getByLabelText('Know my favorites');

    expect(row.props.accessibilityState.checked).toBe(false);
    await fireEvent.press(row);
    await waitFor(() =>
      expect(view.getByLabelText('Know my favorites').props.accessibilityState.checked).toBe(true),
    );

    await fireEvent.press(view.getByLabelText('Know my favorites'));
    await waitFor(() =>
      expect(view.getByLabelText('Know my favorites').props.accessibilityState.checked).toBe(false),
    );
  });

  it.each([1, 3, 6])('continues with %i chosen', async (count) => {
    const view = await open();
    for (const motivation of MOTIVATIONS.slice(0, count)) {
      await fireEvent.press(view.getByLabelText(motivation.label));
    }

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding/answers'));
    expect(eventsNamed('onboarding_motivations')[0].props.count).toBe(count);
  });

  /**
   * Fired here rather than on the next screen. This is the moment the answer becomes
   * final, and a person who abandons the flow after it still told the product something
   * true — firing on arrival at step 4 would lose exactly the readers whose motivation is
   * most worth knowing.
   */
  it('reports why somebody is here, once, with the slugs and not the labels', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText('Find my next watch'));
    await fireEvent.press(view.getByLabelText('Know my favorites'));
    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    const [event] = eventsNamed('onboarding_motivations');
    expect(event.props).toEqual({ count: 2, picked: 'favorites|next_watch' });
  });

  /**
   * `onboarding_started` is the denominator, and it belongs at the first step after the
   * account exists. It used to fire at the picker, which is three screens further in.
   */
  it('starts the flow here, where the flow now starts', async () => {
    await open();
    await waitFor(() => expect(eventsNamed('onboarding_started')).toHaveLength(1));
  });

  it('restores a selection made before the app was closed', async () => {
    mockPrefs.set('user-1.onboarding.motivations', ['group_picks']);
    const view = await open();

    await waitFor(() =>
      expect(
        view.getByLabelText('Pick something with friends').props.accessibilityState.checked,
      ).toBe(true),
    );
  });
});

describe('step 4, the answers', () => {
  const openWith = async (picked: string[]) => {
    mockPrefs.set('user-1.onboarding.motivations', picked);
    const view = await renderWithProviders(<AnswersScreen />);
    await waitFor(() => expect(view.getByText('Here is how that works')).toBeTruthy());
    return view;
  };

  it('draws one card per pick and none for the rest', async () => {
    const view = await openWith(['favorites', 'group_picks']);

    await waitFor(() => expect(view.getByText(/Every movie finds its place/)).toBeTruthy());
    expect(view.getByText(/Choose who's watching/)).toBeTruthy();
    expect(view.queryByText(/Keep everything you've watched/)).toBeNull();
  });

  /**
   * At six the screen scrolls. The card answering "pick something with friends" is exactly
   * as large as the one answering "know my favorites", because the person picked both.
   */
  it('draws all six when all six were picked', async () => {
    const view = await openWith(MOTIVATIONS.map((motivation) => motivation.id));

    for (const motivation of MOTIVATIONS) {
      await waitFor(() => expect(view.getByText(motivation.feature)).toBeTruthy());
    }
  });

  /**
   * **Continue goes to the profile form, because this screen runs before it now**
   * (founder's reordering, 2026-09-09).
   *
   * The stage still advances to `taste` — that is where the flow is up to, and it is what
   * a relaunch has to remember — but the next *screen* is the account. Ranking writes need
   * an account row and the age and Terms gate belongs to `create_profile`, so the form
   * stays in front of the picker; what moved is the two screens that write nothing but a
   * device preference.
   */
  it('continues to the profile form, and records that the flow reached the picker', async () => {
    const view = await openWith(['favorites']);
    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(mockReplace).toHaveBeenCalledWith('/(auth)/create-profile');
    await waitFor(() => expect(stageInMemory('user-1')).toBe('taste'));
  });

  /**
   * This screen is a function of the previous one's answer, so an unreadable selection is
   * not an empty state — it is a screen with nothing to be about. It returns to the
   * question rather than drawing a heading over nothing.
   */
  it('returns to the question when there is nothing to answer', async () => {
    await renderWithProviders(<AnswersScreen />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding/motivations'));
  });

  /**
   * **And the stage goes back with them, which is what stops the recovery being a loop**
   * (independent review of the founder's reordering).
   *
   * The selection and the stage are separate preference keys written by the same
   * Continue, so one can persist without the other. With the stage left at `answers`,
   * routing reads it as authoritative and replaces the question with this screen the
   * instant it navigates away; the screen hydrates the same empty selection and the pair
   * never settles. Correcting the stage makes both authorities say the same thing, and
   * the navigation becomes agreement rather than an argument.
   */
  it('rewinds the stage with it, so routing does not send them straight back', async () => {
    await advanceStage('user-1', 'answers');
    expect(stageInMemory('user-1')).toBe('answers');

    await renderWithProviders(<AnswersScreen />);

    await waitFor(() => expect(stageInMemory('user-1')).toBe('motivations'));
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/motivations');
  });

  it('leaves a stage that is already behind it alone', async () => {
    // A rewind is a repair, not a second way to advance: it only ever moves backwards.
    await advanceStage('user-1', 'motivations');

    await renderWithProviders(<AnswersScreen />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding/motivations'));
    expect(stageInMemory('user-1')).toBe('motivations');
  });
});
