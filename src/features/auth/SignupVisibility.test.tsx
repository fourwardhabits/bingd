import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import CreateProfileScreen from '../../../app/(auth)/create-profile';

/**
 * **The privacy decision, made before the account exists rather than described after.**
 *
 * The screen used to set visibility by the column default and by nothing the reader
 * did, and say so in a paragraph *under* Create my account: "Your account starts
 * public…". That is a description of a decision already taken. The founder's correction
 * is that somebody should see the choice and be able to change it before they sign up.
 *
 * Two things are load-bearing here and neither is the control itself.
 *
 * **The default is Public and stays Public.** PRD §22 keeps it, `profiles.visibility`
 * defaults to it, and `create_profile` still takes no visibility argument. Seeding the
 * control any other way would show somebody an answer that differs from what the insert
 * is about to store — which is worse than not asking.
 *
 * **The helper copy is held to what the schema does.** A private account is still
 * findable: `search_users` moved to `can_discover_profile` on 2026-08-19 precisely so
 * that somebody who knows you can find you and ask, while `can_view_profile` keeps the
 * rankings, watchlist, reviews and activity behind approval. A signup screen promising
 * invisibility is the sentence somebody decides what to write against, and the Privacy
 * screen already had to learn this once.
 */

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: () => {},
}));

const mockCreateProfile = jest.fn();
const mockApplyInitialVisibility = jest.fn();

jest.mock('@/features/auth', () => ({
  useAuth: () => ({ status: 'no-profile', userId: 'user-1' }),
  createProfile: (...args: unknown[]) => mockCreateProfile(...args),
  applyInitialVisibility: (...args: unknown[]) => mockApplyInitialVisibility(...args),
  signOut: jest.fn(),
  usernameAvailability: () => Promise.resolve(true),
  takePendingDisplayName: () => Promise.resolve(null),
  clearPendingDisplayName: jest.fn(),
}));

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

/**
 * The date-of-birth confirmation, answered.
 *
 * `submit` will not send anything until `confirmDateOfBirth` resolves, and it resolves
 * from an `Alert` button — auth.md §4 makes an under-13 signup *delete* the account, so
 * a mistyped year is destructive in a way no other field on this screen is and the date
 * is read back before it is sent. Under Jest nobody presses anything, so a test that
 * does not answer the alert simply waits until it times out. This presses "Yes, that is
 * right", which is what a person does.
 */
const confirmDateOfBirth = () =>
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
    const yes = (buttons as AlertButton[] | undefined)?.find((b) => b.style !== 'cancel');
    yes?.onPress?.();
  });

beforeEach(() => {
  confirmDateOfBirth();
  mockRpc.mockReset().mockResolvedValue({ data: null, error: null });
  mockCreateProfile.mockReset().mockResolvedValue({ outcome: 'created' });
  mockApplyInitialVisibility.mockReset().mockResolvedValue({ ok: true });
});

const open = async () => {
  const view = await renderWithProviders(<CreateProfileScreen />);
  await waitFor(() => expect(view.getByText('Profile visibility')).toBeTruthy());
  return view;
};

describe('choosing who can see you, at signup', () => {
  it('shows the choice rather than a paragraph about it', async () => {
    const view = await open();

    expect(view.getByRole('radio', { name: 'Public' })).toBeTruthy();
    expect(view.getByRole('radio', { name: 'Private' })).toBeTruthy();
    // The paragraph the control replaced. It was under the button that created the
    // account, describing a setting the reader had no part in.
    expect(view.queryByText(/Your account starts public/)).toBeNull();
  });

  it('starts on Public, which is what the column already does', async () => {
    const view = await open();

    expect(view.getByRole('radio', { name: 'Public' }).props.accessibilityState.selected).toBe(
      true,
    );
    expect(view.getByRole('radio', { name: 'Private' }).props.accessibilityState.selected).toBe(
      false,
    );
  });

  it('is a radio group, not two buttons that happen to be adjacent', async () => {
    const view = await open();

    // `SegmentedTabs` would have said `tablist`/`tab`, which tells a screen reader that
    // choosing Private navigates somewhere. This is an answer to a question, so it is a
    // radio group whose options are radios — asserted on the props rather than through
    // `getByRole`, which has no query for a grouping role.
    const group = view.getByLabelText('Profile visibility');
    expect(group.props.accessibilityRole).toBe('radiogroup');
    expect(view.getByRole('radio', { name: 'Public' })).toBeTruthy();
    expect(view.getByRole('radio', { name: 'Private' })).toBeTruthy();
  });

  /**
   * The two sentences, checked against the privacy contract rather than against
   * whatever sounds most reassuring.
   */
  it('describes public as what public actually is', async () => {
    const view = await open();

    expect(view.getByText('Anyone can see your rankings and reviews.')).toBeTruthy();
  });

  it('says a private account is still findable, because it is', async () => {
    const view = await open();

    await fireEvent.press(view.getByRole('radio', { name: 'Private' }));

    await waitFor(() =>
      expect(
        view.getByText(
          'People can still find you, but only approved followers can see your activity.',
        ),
      ).toBeTruthy(),
    );
    // The over-claims. `can_discover_profile` exists so that a private account can be
    // found by name and asked; promising otherwise here would be a privacy claim this
    // schema deliberately does not make.
    expect(view.queryByText(/nobody can find you/i)).toBeNull();
    expect(view.queryByText(/hidden from search/i)).toBeNull();
    expect(view.queryByText(/will not appear in search/i)).toBeNull();
  });
});

describe('persisting the choice', () => {
  const fillIn = async (view: Awaited<ReturnType<typeof open>>) => {
    await fireEvent.changeText(view.getByLabelText('Username'), 'rosalind');
    await fireEvent.changeText(view.getByLabelText('Month'), '04');
    await fireEvent.changeText(view.getByLabelText('Day'), '11');
    await fireEvent.changeText(view.getByLabelText('Year'), '1994');
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Create my account' }).props.accessibilityState.disabled,
      ).toBe(false),
    );
  };

  it('sends Private through the existing visibility path once the account exists', async () => {
    const view = await open();
    await fillIn(view);

    await fireEvent.press(view.getByRole('radio', { name: 'Private' }));
    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    // `create_profile` still takes no visibility — giving it one is a migration, and
    // this tranche adds no SQL. `set_profile_visibility` is the function the Privacy
    // screen has always called, so a private account created here is private by exactly
    // the mechanism that makes an account private later.
    await waitFor(() => expect(mockApplyInitialVisibility).toHaveBeenCalledWith('private'));
    expect(mockCreateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'rosalind' }),
    );
    expect(mockCreateProfile.mock.calls[0][0]).not.toHaveProperty('visibility');
  });

  it('does not spend a write saying public to a column that is already public', async () => {
    const view = await open();
    await fillIn(view);

    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(mockCreateProfile).toHaveBeenCalled());
    // The writer short-circuits `public` — it is the default, and the function is rate
    // limited at twenty profile edits a day. Asserted at this level because the screen
    // is what decides to call it at all.
    expect(mockApplyInitialVisibility).toHaveBeenCalledWith('public');
  });
});

/**
 * **Three ways a chosen Private could still have landed on a public account.**
 *
 * Review 41 found two of them and they share a shape: the account exists, the router
 * gate is opened, and the visibility write either has not happened or has not finished.
 * Whoever signed up is then inside the app, ranking things, on a profile that is public
 * — and nothing ever told them so.
 *
 * The rule these hold is one sentence: **the gate is not opened until the visibility
 * this person chose has been sent.** Not "succeeded" — a refusal is survivable and is
 * reported — but sent, and waited for.
 */
describe('a private account is private before the app opens', () => {
  const fillIn = async (view: Awaited<ReturnType<typeof open>>) => {
    await fireEvent.changeText(view.getByLabelText('Username'), 'rosalind');
    await fireEvent.changeText(view.getByLabelText('Month'), '04');
    await fireEvent.changeText(view.getByLabelText('Day'), '11');
    await fireEvent.changeText(view.getByLabelText('Year'), '1994');
    await fireEvent.press(view.getByRole('radio', { name: 'Private' }));
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Create my account' }).props.accessibilityState.disabled,
      ).toBe(false),
    );
    return view;
  };

  it('keeps the button dead until the visibility write is done, not until the insert is', async () => {
    // The first Major: `busy` was cleared the moment `create_profile` answered, so a
    // second tap could land while the visibility request was still in flight, earn
    // `already_exists`, and open the gate underneath it.
    let release: () => void = () => {};
    mockApplyInitialVisibility.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true });
      }),
    );

    const view = await fillIn(await open());
    // Deliberately not awaited: the submission is being held open on purpose, and
    // awaiting the press would wait for the very thing this test is inspecting.
    void fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(mockApplyInitialVisibility).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Creating…' }).props.accessibilityState.disabled,
      ).toBe(true),
    );

    release();
    await waitFor(() =>
      expect(view.getByRole('button', { name: 'Create my account' })).toBeTruthy(),
    );
  });

  it('applies the choice when the insert committed and lost its reply', async () => {
    // The second Major. `changed` means the profile may exist, so this branch opens the
    // gate — and it opened it without ever sending the visibility. The person is shown
    // an error, carried into the app anyway, and never told their choice was dropped.
    mockCreateProfile.mockResolvedValue({
      outcome: 'failed',
      message: 'The network went away.',
      changed: true,
    });

    const view = await fillIn(await open());
    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(mockApplyInitialVisibility).toHaveBeenCalledWith('private'));
  });

  it('applies the choice on a retry that answers already_exists', async () => {
    // On a screen only reachable *without* a profile, `already_exists` is almost always
    // this signup's own first attempt having committed. The retry is the same person
    // making the same choice.
    mockCreateProfile.mockResolvedValue({ outcome: 'already_exists' });

    const view = await fillIn(await open());
    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(mockApplyInitialVisibility).toHaveBeenCalledWith('private'));
  });

  it('does not hold somebody on the form when the visibility write is refused', async () => {
    mockApplyInitialVisibility.mockResolvedValue({ ok: false });

    const view = await fillIn(await open());
    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    // The account exists by then. Refusing to continue would strand somebody on a
    // signup form for an account they already have — the dead end `already_exists`
    // exists to prevent. They are told, and pointed at the screen that finishes it.
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Your account is ready',
        expect.stringContaining('Settings › Privacy'),
      ),
    );
  });

  it('never makes an account more visible than its owner left it', async () => {
    // The safety property behind calling this on two *uncertain* outcomes. Public is the
    // column default and the writer short-circuits it, so the only account this path can
    // change is one whose owner asked for more privacy than they were about to get.
    mockCreateProfile.mockResolvedValue({ outcome: 'already_exists' });
    const view = await open();
    await fireEvent.changeText(view.getByLabelText('Username'), 'rosalind');
    await fireEvent.changeText(view.getByLabelText('Month'), '04');
    await fireEvent.changeText(view.getByLabelText('Day'), '11');
    await fireEvent.changeText(view.getByLabelText('Year'), '1994');
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Create my account' }).props.accessibilityState.disabled,
      ).toBe(false),
    );

    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(mockApplyInitialVisibility).toHaveBeenCalledWith('public'));
    expect(mockApplyInitialVisibility).not.toHaveBeenCalledWith('private');
  });
});
