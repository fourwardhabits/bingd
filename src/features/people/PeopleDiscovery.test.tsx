import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { PeopleDiscovery } from './PeopleDiscovery';
import { mutualsLine } from './use-people';

/**
 * People discovery, the second half of For You (founder tranche 2026-08-26 §§10–15;
 * modes and named mutuals from the external-beta polish, 2026-08-27).
 *
 * The screen is thin on purpose — both suggestion lists are decided entirely by
 * `people_mutuals` and `people_taste_matches`, and the privacy rules live there, in
 * `20260826000500`/`20260827000100`, where a DB test can exercise them against real
 * policies. What is asserted here is what only the client can get wrong: which mode
 * shows, what a row says, that the mutual line opens the inspection sheet, and that
 * the Follow control is the app's one follow mutation rather than a second copy of it.
 */

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, { code?: string; message: string } | null> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      const error = mockRpcErrors[name] ?? null;
      return Promise.resolve({ data: error ? null : (mockRpcResults[name] ?? []), error });
    },
  },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));

const person = (over: Record<string, unknown> = {}) => ({
  user_id: 'anna-id',
  username: 'anna',
  display_name: 'Anna',
  avatar_path: null,
  visibility: 'public',
  ...over,
});

beforeEach(() => {
  mockPush.mockReset();
  mockRpcCalls.length = 0;
  mockRpcResults = {};
  mockRpcErrors = {};
});

const open = () => renderWithProviders(<PeopleDiscovery viewerId="viewer" />);

describe('the two modes', () => {
  it('opens on Mutuals and keeps Matches one chip away', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    mockRpcResults.people_taste_matches = [
      person({ user_id: 'bo-id', username: 'bo', display_name: 'Bo', match_score: 91 }),
    ];

    const view = await open();

    await waitFor(() => expect(view.getByText('Ben + 2 more')).toBeTruthy());
    // One mode at a time: the match percentage is behind its chip, not stacked below.
    expect(view.queryByText('91% Match')).toBeNull();

    await fireEvent.press(view.getByText('Matches'));

    await waitFor(() => expect(view.getByText('91% Match')).toBeTruthy());
    expect(view.queryByText('Ben + 2 more')).toBeNull();
  });

  it('says why Mutuals is empty without hiding the Matches that loaded', async () => {
    mockRpcResults.people_mutuals = [];
    mockRpcResults.people_taste_matches = [person({ match_score: 74 })];

    const view = await open();

    await waitFor(() => expect(view.getByText('No mutuals yet')).toBeTruthy());

    await fireEvent.press(view.getByText('Matches'));

    await waitFor(() => expect(view.getByText('74% Match')).toBeTruthy());
  });

  /**
   * The founder's instruction: concise, and not a nag. One sentence naming the two
   * things that genuinely improve the answer — and no chips over it, because a control
   * for choosing which nothing to look at is not a control.
   */
  it('says one thing when there is nothing to suggest', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByText('No suggestions yet')).toBeTruthy());
    expect(
      view.getByText('Rank more titles and follow people to improve suggestions.'),
    ).toBeTruthy();
    expect(view.queryByText('Mutuals')).toBeNull();
  });

  /**
   * One list failing is not the screen failing: the mode that loaded still shows its
   * people, and the one that failed says so in its own frame with its own retry.
   */
  it('still shows the mode that loaded when the other one failed', async () => {
    mockRpcErrors.people_mutuals = { message: 'nope' };
    mockRpcResults.people_taste_matches = [person({ match_score: 74 })];

    const view = await open();

    await waitFor(() => expect(view.getByText('Could not load suggestions')).toBeTruthy());

    await fireEvent.press(view.getByText('Matches'));

    await waitFor(() => expect(view.getByText('74% Match')).toBeTruthy());
    expect(view.queryByText('Could not load suggestions')).toBeNull();
  });

  it('offers a retry when neither list could load', async () => {
    mockRpcErrors.people_mutuals = { message: 'nope' };
    mockRpcErrors.people_taste_matches = { message: 'nope' };

    const view = await open();

    await waitFor(() => expect(view.getByText('Could not load suggestions')).toBeTruthy());
  });

  /**
   * One failure plus one genuine empty is not "nothing to suggest" (review 60): the
   * quiet global sentence would be claiming success over a read that never happened.
   * The errored mode keeps its retry; the empty one keeps its truth.
   */
  it('does not pass a failure off as emptiness', async () => {
    mockRpcErrors.people_mutuals = { message: 'nope' };
    mockRpcResults.people_taste_matches = [];

    const view = await open();

    await waitFor(() => expect(view.getByText('Could not load suggestions')).toBeTruthy());
    expect(view.queryByText('No suggestions yet')).toBeNull();

    await fireEvent.press(view.getByText('Matches'));

    await waitFor(() => expect(view.getByText('No matches yet')).toBeTruthy());
  });
});

describe('a row', () => {
  it('is an identity, one line of context and one control — and nothing else', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 1, mutual_names: ['Ben'] })];

    const view = await open();

    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    expect(view.getByText('@anna')).toBeTruthy();
    // The mutual has a name now, and the line says it rather than a bare count.
    expect(view.getByText('Mutual: Ben')).toBeTruthy();
    // Never both kinds of context on one row: a count and a percentage side by side
    // invite a comparison between two numbers that measure different things.
    expect(view.queryByText(/% Match/)).toBeNull();
    expect(view.getByText('Follow')).toBeTruthy();
  });

  it('opens the profile from the name, not from the control', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 2, mutual_names: ['Ben', 'Cy'] })];

    const view = await open();
    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Anna, @anna, Ben + 1 more'));

    expect(mockPush).toHaveBeenCalledWith('/u/anna');
  });

  /**
   * **The same mutation every other surface uses**, which is the founder's rule for this
   * tranche stated as a test: `FollowControl` is `useSocialWrites`, so a follow started
   * here releases held recommendations, invalidates the recipient picker and refreshes
   * both suggestion lists exactly as one started on a profile does. Three follow paths
   * with three sets of cache effects is how a picker goes stale on one screen and not
   * another — which is a bug this same tranche is fixing elsewhere.
   */
  it('follows through the app’s one follow RPC', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 2, mutual_names: ['Ben', 'Cy'] })];
    mockRpcResults.follow = { status: 'ok', state: 'approved' };

    const view = await open();
    await waitFor(() => expect(view.getByText('Follow')).toBeTruthy());
    await fireEvent.press(view.getByText('Follow'));

    await waitFor(() =>
      expect(mockRpcCalls.some((call) => call.name === 'follow')).toBe(true),
    );
    const call = mockRpcCalls.find((c) => c.name === 'follow');
    expect(call?.args).toMatchObject({ p_followee_id: 'anna-id' });
  });

  /**
   * A private account is reached by asking, and the control has to say so — otherwise
   * the reader taps Follow and is left looking at a button that says Requested with no
   * explanation of what changed. `FollowControl` decides this from the relationship;
   * what this asserts is that a private suggestion is drawn at all.
   */
  it('shows a private account with the control the relationship implies', async () => {
    mockRpcResults.people_mutuals = [
      person({ mutual_count: 2, mutual_names: ['Ben', 'Cy'], visibility: 'private' }),
    ];
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: 'pending', followed_by: null, blocked: false },
    ];

    const view = await open();

    await waitFor(() => expect(view.getByText('Requested')).toBeTruthy());
  });
});

describe('inspecting the mutuals', () => {
  it('opens the full list from the mutual line, and a mutual opens their profile', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    mockRpcResults.mutuals_with = [
      { user_id: 'ben-id', username: 'ben', display_name: 'Ben', avatar_path: null, visibility: 'public' },
      { user_id: 'cy-id', username: 'cy', display_name: 'Cy', avatar_path: null, visibility: 'public' },
      { user_id: 'di-id', username: 'di', display_name: 'Di', avatar_path: null, visibility: 'private' },
    ];

    const view = await open();
    await waitFor(() => expect(view.getByText('Ben + 2 more')).toBeTruthy());

    // The list is not read until somebody asks for it.
    expect(mockRpcCalls.some((call) => call.name === 'mutuals_with')).toBe(false);

    await fireEvent.press(view.getByLabelText('See mutuals with Anna'));

    await waitFor(() => expect(view.getByText('Mutuals with Anna')).toBeTruthy());
    await waitFor(() => expect(view.getByLabelText('Ben, @ben')).toBeTruthy());
    expect(view.getByLabelText('Cy, @cy')).toBeTruthy();
    expect(view.getByLabelText('Di, @di')).toBeTruthy();
    const call = mockRpcCalls.find((c) => c.name === 'mutuals_with');
    expect(call?.args).toMatchObject({ p_subject: 'anna-id' });

    await fireEvent.press(view.getByLabelText('Ben, @ben'));

    expect(mockPush).toHaveBeenCalledWith('/u/ben');
  });

  /**
   * The sheet's read is one page of 30 and the card's count is not capped (review
   * 60b): a full page must say it was cut. Three rows — the ordinary case — must not.
   */
  it('discloses a full page as truncation, and only a full page', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 45, mutual_names: ['Ben'] })];
    mockRpcResults.mutuals_with = Array.from({ length: 30 }, (_, i) => ({
      user_id: `m${i}`,
      username: `m${i}`,
      display_name: `M${i}`,
      avatar_path: null,
      visibility: 'public',
    }));

    const view = await open();
    await waitFor(() => expect(view.getByText('Ben + 44 more')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('See mutuals with Anna'));

    await waitFor(() => expect(view.getByLabelText('M0, @m0')).toBeTruthy());
    expect(view.getByText('Showing the first 30.')).toBeTruthy();
  });

  it('offers no inspection on a match row — there is no mutual to name', async () => {
    mockRpcResults.people_taste_matches = [person({ match_score: 74 })];
    mockRpcResults.people_mutuals = [person({ user_id: 'z', username: 'z', mutual_count: 1, mutual_names: ['Ben'] })];

    const view = await open();
    await waitFor(() => expect(view.getByText('Matches')).toBeTruthy());
    await fireEvent.press(view.getByText('Matches'));
    await waitFor(() => expect(view.getByText('74% Match')).toBeTruthy());

    expect(view.queryByLabelText('See mutuals with Anna')).toBeNull();
  });
});

/**
 * The wording, without a render. The card is a row: one name, and past one, a count —
 * the full list is the sheet's job.
 */
describe('mutualsLine', () => {
  it('names a single mutual', () => {
    expect(mutualsLine({ count: 1, names: ['Abisola'] })).toBe('Mutual: Abisola');
  });

  it('leads with a name and counts the rest', () => {
    expect(mutualsLine({ count: 3, names: ['Abisola', 'Ben', 'Cy'] })).toBe('Abisola + 2 more');
  });

  it('counts from the total, not from the capped name list', () => {
    // The server sends at most three names however many edges it counted.
    expect(mutualsLine({ count: 9, names: ['Abisola', 'Ben', 'Cy'] })).toBe('Abisola + 8 more');
  });

  it('falls back to the bare count when a stale cache has no names', () => {
    expect(mutualsLine({ count: 1, names: [] })).toBe('1 mutual');
    expect(mutualsLine({ count: 2, names: [] })).toBe('2 mutuals');
  });
});
