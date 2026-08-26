import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { PeopleDiscovery } from './PeopleDiscovery';
import { peopleSections, type PersonSuggestion } from './use-people';

/**
 * People discovery, the second half of For You (founder tranche 2026-08-26 §§10–15).
 *
 * The screen is thin on purpose — both suggestion lists are decided entirely by
 * `people_mutuals` and `people_taste_matches`, and the privacy rules live there, in
 * `20260826000500`, where a DB test can exercise them against real policies. What is
 * asserted here is what only the client can get wrong: which sections appear, in what
 * order, what a row says, and that the Follow control is the app's one follow mutation
 * rather than a second copy of it.
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

describe('the two sections', () => {
  it('leads with mutuals and puts taste matches under them', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3 })];
    mockRpcResults.people_taste_matches = [
      person({ user_id: 'bo-id', username: 'bo', display_name: 'Bo', match_score: 91 }),
    ];

    const view = await open();

    await waitFor(() => expect(view.getByText('MUTUALS')).toBeTruthy());
    expect(view.getByText('TASTE MATCHES')).toBeTruthy();
    expect(view.getByText('3 mutuals')).toBeTruthy();
    expect(view.getByText('91% Match')).toBeTruthy();
  });

  /**
   * A heading over nothing is worse than a missing heading: it says the app looked and
   * had an answer, and then does not give one.
   */
  it('draws no heading for a section with nobody in it', async () => {
    mockRpcResults.people_mutuals = [];
    mockRpcResults.people_taste_matches = [person({ match_score: 74 })];

    const view = await open();

    await waitFor(() => expect(view.getByText('TASTE MATCHES')).toBeTruthy());
    expect(view.queryByText('MUTUALS')).toBeNull();
  });

  /**
   * The founder's instruction: concise, and not a nag. One sentence naming the two
   * things that genuinely improve the answer, with no call to action underneath it and
   * no second attempt further down the screen.
   */
  it('says one thing when there is nothing to suggest', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByText('No suggestions yet')).toBeTruthy());
    expect(
      view.getByText('Rank more titles and follow people to improve suggestions.'),
    ).toBeTruthy();
  });

  /**
   * One list failing is not the screen failing. The error state is for the case where
   * there is genuinely nothing to draw.
   */
  it('still shows the list that loaded when the other one failed', async () => {
    mockRpcErrors.people_mutuals = { message: 'nope' };
    mockRpcResults.people_taste_matches = [person({ match_score: 74 })];

    const view = await open();

    await waitFor(() => expect(view.getByText('TASTE MATCHES')).toBeTruthy());
    expect(view.queryByText('Could not load suggestions')).toBeNull();
  });

  it('offers a retry when neither list could load', async () => {
    mockRpcErrors.people_mutuals = { message: 'nope' };
    mockRpcErrors.people_taste_matches = { message: 'nope' };

    const view = await open();

    await waitFor(() => expect(view.getByText('Could not load suggestions')).toBeTruthy());
  });
});

describe('a row', () => {
  it('is an identity, one line of context and one control — and nothing else', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 1 })];

    const view = await open();

    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    expect(view.getByText('@anna')).toBeTruthy();
    // Singular, because "1 mutuals" is the kind of thing a reader notices and nothing
    // else does.
    expect(view.getByText('1 mutual')).toBeTruthy();
    // Never both kinds of context on one row: a count and a percentage side by side
    // invite a comparison between two numbers that measure different things.
    expect(view.queryByText(/% Match/)).toBeNull();
    expect(view.getByText('Follow')).toBeTruthy();
  });

  it('opens the profile from the name, not from the control', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 2 })];

    const view = await open();
    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Anna, @anna, 2 mutuals'));

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
    mockRpcResults.people_mutuals = [person({ mutual_count: 2 })];
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
    mockRpcResults.people_mutuals = [person({ mutual_count: 2, visibility: 'private' })];
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: 'pending', followed_by: null, blocked: false },
    ];

    const view = await open();

    await waitFor(() => expect(view.getByText('Requested')).toBeTruthy());
  });
});

/**
 * The ordering rules, without a render. They are three lines of code and one of them —
 * the de-duplication — is the kind of thing that only shows up on a real account, where
 * somebody is both a friend of a friend and a good taste match.
 */
describe('peopleSections', () => {
  const suggestion = (id: string, context: PersonSuggestion['context']): PersonSuggestion => ({
    id,
    username: id,
    name: id,
    avatarUri: null,
    isPrivate: false,
    context,
  });

  it('never lists the same person twice', () => {
    const both = [suggestion('anna', { kind: 'mutuals', count: 2 })];
    const sections = peopleSections(both, [suggestion('anna', { kind: 'match', score: 80 })]);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe('Mutuals');
  });

  it('lets taste matches lead when there are no mutuals', () => {
    const sections = peopleSections([], [suggestion('bo', { kind: 'match', score: 80 })]);

    expect(sections.map((s) => s.title)).toEqual(['Taste matches']);
  });

  it('is empty when both are', () => {
    expect(peopleSections([], [])).toEqual([]);
    expect(peopleSections(undefined, undefined)).toEqual([]);
  });
});
