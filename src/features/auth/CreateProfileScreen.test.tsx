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
 *   - **it is not shown on a profile.** `profile_private` has RLS enabled with no
 *     policy and its select grant revoked, so no API returns it, including to the
 *     person who typed it. It is on the analytics denylist, and nothing renders it.
 *
 * **The second clause used to read "it is never shown to anyone", and that sentence is
 * gone on founder review (2026-08-25).** The narrower statement above is the one this
 * app can keep on its own account. "Shown to anyone" is heard as a claim about
 * everything that ever touches the value — staff, processors, whoever operates the
 * database — and that is a Privacy Policy's claim to make, with the whole handling
 * story behind it, not a caption's. The tests below pin the narrower promise *and*
 * assert the broad one has not come back, because the way this defect returns is
 * somebody restoring a sentence that reads better.
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
  // See `account-escape.test.tsx` for the behaviour; here only its presence matters.
  UseDifferentAccountButton: () => {
    const React = jest.requireActual('react');
    const { Text } = jest.requireActual('react-native');
    return React.createElement(Text, null, 'Use a different account');
  },
}));

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

describe('why the signup screen asks for a birthday', () => {
  it('says what it is for, and that it is not on your profile', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() =>
      expect(
        view.getByText(
          'Your birthday is private and isn’t shown on your profile. We use it to ' +
            'confirm you’re 13 or older, and may use age to improve recommendations.',
        ),
      ).toBeTruthy(),
    );
  });

  /**
   * The sentence the founder struck out, asserted absent by its own words.
   *
   * A copy test that only pins the new string passes the moment somebody adds the old
   * one back beside it, which is precisely the shape this regression would take: the
   * broad sentence reads warmer, and warmer is why it was written the first time.
   */
  it('does not promise the birthday is never shown to anyone', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() => expect(view.getByText(/13 or older/)).toBeTruthy());

    expect(view.queryByText(/never shown to anyone/i)).toBeNull();
    // The neighbouring forms of the same over-claim.
    expect(view.queryByText(/nobody (can )?(ever )?sees?/i)).toBeNull();
    expect(view.queryByText(/no one will ever see/i)).toBeNull();
  });

  /**
   * **The claim widened on 2026-08-25, and the test that guarded the old one had to
   * widen with it — carefully, because the direction it guards still matters.**
   *
   * This used to assert that the screen said *nothing* about personalisation. That was
   * the right rule while the retention story was "one comparison at signup and never
   * read again": a screen promising personalisation from a value nothing personalises
   * would have been an unbacked privacy claim in the place they do the most damage.
   *
   * DOB-1 changed the underlying fact. The founder's decision is to keep the date for
   * eligibility *and* for future personalisation and aggregate taste analysis, so
   * silence is now the misleading option — it would rule out a use the product intends
   * to make, and broadening it later under copy that excluded it is exactly the move
   * this screen should not make.
   *
   * So what is pinned instead is the **tense**. "May also help ... as bingd. improves"
   * is a statement about intent; "we use your birthday to recommend things" would be a
   * statement about today, and today it is false — nothing reads the column but the
   * age gate. The assertions below are that the hedge is present and the present-tense
   * claim is absent.
   */
  it('describes personalisation as a possibility, never as something already happening', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() => expect(view.getByText(/13 or older/)).toBeTruthy());

    // The hedge, in whichever words carry it. It was "may also help us personalise
    // recommendations as bingd. improves" and is now "may use age to improve
    // recommendations" — shorter, same tense, same claim.
    expect(view.getByText(/may use age to improve/i)).toBeTruthy();
    // The forms that would claim it is already true.
    expect(view.queryByText(/we use .*to personalise/i)).toBeNull();
    expect(view.queryByText(/powers your recommendations/i)).toBeNull();
    // And the claim that would be plainly false, which is the one the founder ruled
    // out by name: the date is stored, in `profile_private`.
    expect(view.queryByText(/we (do not|don.t) (save|store|keep)/i)).toBeNull();
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

/**
 * **The screen is no longer a locked room.** Build 4, physical device: signed in with
 * the wrong email, landed here, and there was no way out — Settings is behind the
 * profile gate and an iOS reinstall keeps the Keychain session. The escape's behaviour
 * lives in `account-escape.test.tsx`; what this suite pins is that "Pick your name"
 * actually offers it.
 */
describe('the way out of the wrong account', () => {
  it('offers Use a different account beneath the form', async () => {
    const view = await renderWithProviders(<CreateProfileScreen />);

    await waitFor(() => expect(view.getByText('Pick your name')).toBeTruthy());
    expect(view.getByText('Use a different account')).toBeTruthy();
  });
});
