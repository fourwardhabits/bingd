import { fireEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import CreateProfileScreen from '../../../app/(auth)/create-profile';

/**
 * **"Why is the app asking for my birthday?"** — a real beta tester, and a fair
 * question, because the screen answered it nowhere.
 *
 * The two fields above the birthday both carry a hint; this block carried none, and
 * the only place the reason appeared was the refusal screen you see *only* if you are
 * turned away. The rationale existed in the PRD, the store-privacy inventory and the
 * public privacy page — three places a person signing up does not read.
 *
 * These pin the copy against what the code actually does, because a reassurance is
 * worth less than nothing if it drifts from the implementation:
 *
 *   - **the 13+ gate is the only consumer.** `create_profile` compares the date and
 *     nothing reads it afterwards — `is_over_13` has no production caller at all.
 *   - **it is never shown to anyone.** `profile_private` has RLS enabled with no
 *     policy and its select grant revoked, so no API returns it, including to the
 *     person who typed it. It is on the analytics denylist.
 */

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: () => Promise.resolve({ data: null, error: null }) },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: () => {},
}));

jest.mock('@/features/auth', () => ({
  useAuth: () => ({ status: 'no-profile', userId: 'user-1' }),
  createProfile: jest.fn(),
  signOut: jest.fn(),
  usernameAvailability: () => Promise.resolve({ state: 'idle' }),
  takePendingDisplayName: () => Promise.resolve(null),
  clearPendingDisplayName: jest.fn(),
}));

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

describe('why the signup screen asks for a birthday', () => {
  it('says what it is for, and that it is never shown', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() =>
      expect(
        view.getByText('We use this to check you are 13 or over. It is never shown to anyone.'),
      ).toBeTruthy(),
    );
  });

  /**
   * The claim has to stay narrow. Saying it powers recommendations, or that it is
   * "kept secure", would be a sentence the code does not back — and this screen is
   * exactly where an unbacked privacy claim does the most damage.
   */
  it('claims nothing about personalisation', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() => expect(view.getByText(/13 or over/)).toBeTruthy());
    expect(view.queryByText(/recommend/i)).toBeNull();
    expect(view.queryByText(/personalis/i)).toBeNull();
    expect(view.queryByText(/personaliz/i)).toBeNull();
  });

  it('still asks for the date itself, which the gate needs', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() => expect(view.getByText('Date of birth')).toBeTruthy());
    expect(view.getByLabelText('Month')).toBeTruthy();
    expect(view.getByLabelText('Day')).toBeTruthy();
    expect(view.getByLabelText('Year')).toBeTruthy();
  });
});


/**
 * The legal acknowledgment under the create-account button.
 *
 * **Not a checkbox, and not a stored acceptance.** The act of creating the account is
 * the agreement, so a tick box beside the button asks somebody to confirm the thing they
 * are already doing. Persisting a version stamp is what a product needs when it intends
 * to *re-prompt* on a change — a versioned Terms table, a gate on next launch, a screen
 * that blocks the app until somebody taps Agree — and none of that exists or is planned
 * for public v1. The account's own creation timestamp already records when somebody
 * agreed to the Terms as they stood that day.
 *
 * What is worth testing is that the two documents are actually reachable. An
 * acknowledgment pointing at documents nobody can open is worse than none: it claims
 * consent to something unread and unreachable.
 */
describe('the terms acknowledgment at signup', () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

  beforeEach(() => openURL.mockClear());

  it('says what creating an account agrees to', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() => expect(view.getByText(/By creating an account/)).toBeTruthy());
    expect(view.getByText('Terms of Use')).toBeTruthy();
    expect(view.getByText('Privacy Policy')).toBeTruthy();
  });

  it('makes both documents openable', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() => expect(view.getByText('Terms of Use')).toBeTruthy());

    await fireEvent.press(view.getByText('Terms of Use'));
    expect(openURL).toHaveBeenCalledWith('https://bingd.app/terms');

    await fireEvent.press(view.getByText('Privacy Policy'));
    expect(openURL).toHaveBeenCalledWith('https://bingd.app/privacy');
  });

  /**
   * No blocking gate. The acknowledgment is a sentence, not a step: a screen that
   * refuses to proceed until a box is ticked is a different product decision, and one
   * this tranche deliberately did not make.
   */
  it('adds no acceptance control between the reader and the account', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() => expect(view.getByText(/By creating an account/)).toBeTruthy());
    expect(view.queryByLabelText(/agree to the terms/i)).toBeNull();
    expect(view.queryByText(/^I agree$/)).toBeNull();
  });
});
