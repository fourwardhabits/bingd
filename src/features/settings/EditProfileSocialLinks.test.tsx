import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import EditProfileScreen from '../../../app/settings/profile';

/**
 * Edit Profile's Social links section — what a person may paste, and what is sent.
 *
 * The normaliser has its own suite (`features/profile/social-links.test.ts`) and this
 * one deliberately does not re-test it. What is asserted here is the *wiring*: that the
 * screen sends the normalised value rather than the typed one, that it sends only what
 * changed, that clearing a box sends `''` and not `undefined`, and that a value the
 * normaliser refuses never reaches `save_profile` at all.
 *
 * Those are the mistakes that produce a form which looks right and stores rubbish.
 */

const mockRpc = jest.fn();
const mockBack = jest.fn();
/** What the navigator is told to do once a guarded leave is allowed. */
const mockDispatch = jest.fn();
/**
 * `save_profile`'s answer. `null` is the ordinary success; a promise holds the save open
 * (for *Saving…*); an error is a refusal.
 */
let mockSaveAnswer: Promise<unknown> | { data: unknown; error: unknown } | null = null;
/** The last `usePreventRemove` the screen registered: whether it guards, and with what. */
let mockGuard: {
  prevent: boolean;
  callback: (event: { data: { action: unknown } }) => void;
} | null = null;
/** What the screen asked the navigator to draw in its header. */
let mockHeaderOptions: { headerRight?: () => React.ReactNode } = {};

let mockProfile = {
  id: 'user-1',
  username: 'sai',
  display_name: 'Sai',
  bio: null as string | null,
  avatar_path: null,
  avatarUri: null,
  visibility: 'public' as const,
  link_instagram: null as string | null,
  link_tiktok: null as string | null,
  link_youtube: null as string | null,
  link_x: null as string | null,
  link_website: null as string | null,
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpc(name, args);
      if (mockSaveAnswer) return Promise.resolve(mockSaveAnswer);
      return Promise.resolve({ data: { status: 'ok' }, error: null });
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: mockBack }),
  useNavigation: () => ({ dispatch: mockDispatch }),
  /**
   * Draws what the screen asked the navigator to put on the right of its header, as
   * `PublicProfileScreen.test.tsx` and `MyListsScreen.test.tsx` do — Save lives there now,
   * and a stand-in that drew nothing would make it untestable.
   */
  Stack: {
    Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) => {
      mockHeaderOptions = options ?? {};
      return options?.headerRight?.() ?? null;
    },
  },
}));

/**
 * React Navigation's `beforeRemove` guard, held so a test can be the navigator: `leave()`
 * below does what a Back press does — asks the guard if it is guarding, and otherwise
 * just goes.
 */
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (
    prevent: boolean,
    callback: (event: { data: { action: unknown } }) => void,
  ) => {
    mockGuard = { prevent, callback };
  },
}));

const BACK = { type: 'GO_BACK' };
const leave = () =>
  act(async () => {
    if (mockGuard?.prevent) mockGuard.callback({ data: { action: BACK } });
    else mockDispatch(BACK);
  });

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => mockProfile,
}));

// An image pipeline and a permission dialog, neither of which is what this is about.
jest.mock('@/features/profile/AvatarPicker', () => ({ AvatarPicker: () => null }));

let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${(issued += 1)}` }));

beforeEach(() => {
  mockRpc.mockClear();
  mockBack.mockClear();
  mockDispatch.mockClear();
  mockSaveAnswer = null;
  mockGuard = null;
  mockHeaderOptions = {};
  issued = 0;
  mockProfile = {
    ...mockProfile,
    username: 'sai',
    display_name: 'Sai',
    bio: null,
    link_instagram: null,
    link_tiktok: null,
    link_youtube: null,
    link_x: null,
    link_website: null,
  };
});

const argsOf = () => mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;

describe('the section', () => {
  it('offers exactly the five networks, and says they are optional', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    expect(view.getByText('SOCIAL LINKS')).toBeTruthy();
    for (const label of ['Instagram', 'TikTok', 'YouTube', 'X', 'Website']) {
      expect(view.getByLabelText(label)).toBeTruthy();
    }
    expect(view.getByText('Optional. Add a handle or link.')).toBeTruthy();
    // Said once, above the five — not repeated under each box (founder, 2026-09-16).
    expect(view.queryByText(/Your username, or the link/)).toBeNull();
    expect(view.queryByText(/twitter\.com links work/)).toBeNull();
    expect(view.queryByText(/add https:\/\//)).toBeNull();
  });

  it('lists the boxes TikTok, Instagram, X, YouTube, Website', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);
    const order = ['TikTok', 'Instagram', 'X', 'YouTube', 'Website'].map(
      (label) => view.getByLabelText(label),
    );
    // Document order of the inputs is the order they are drawn.
    const inputs = view.getAllByLabelText(/^(TikTok|Instagram|X|YouTube|Website)$/);
    expect(inputs).toEqual(order);
  });

  it('shows nothing in the boxes for a profile that has none', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);
    expect(view.getByLabelText('Instagram').props.value).toBe('');
  });

  it('shows the stored handle rather than the URL the header builds', async () => {
    // A box pre-filled with `https://www.instagram.com/suraj/` is the "UI accumulating
    // messy URLs" this feature exists to avoid, reintroduced where it is most visible.
    mockProfile = { ...mockProfile, link_instagram: 'suraj' };
    const view = await renderWithProviders(<EditProfileScreen />);

    expect(view.getByLabelText('Instagram').props.value).toBe('suraj');
  });
});

describe('what is sent', () => {
  it('sends the normalised handle, not what was typed', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(
      view.getByLabelText('Instagram'),
      'https://www.instagram.com/suraj/',
    );
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(argsOf().p_instagram).toBe('suraj');
  });

  it('normalises a twitter.com link into an X handle', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('X'), 'https://twitter.com/suraj');
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(argsOf().p_x).toBe('suraj');
  });

  it('adds https:// to a bare domain', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Website'), 'example.com');
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(argsOf().p_website).toBe('https://example.com');
  });

  it('leaves every untouched field null, so one edit costs nothing else', async () => {
    // Null means "leave this alone" — the convention that keeps a link edit from being
    // charged the handle's thirty-day cooldown, and keeps a bio it never saw.
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('TikTok'), '@surajk');
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    const args = argsOf();
    expect(args.p_tiktok).toBe('surajk');
    for (const key of [
      'p_display_name',
      'p_username',
      'p_bio',
      'p_instagram',
      'p_youtube',
      'p_x',
      'p_website',
    ]) {
      expect(args[key]).toBeNull();
    }
  });

  it('sends an empty string to clear one, because null cannot say that', async () => {
    mockProfile = { ...mockProfile, link_instagram: 'suraj', link_x: 'suraj_k' };
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Instagram'), '');
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(argsOf().p_instagram).toBe('');
    // And clearing one clears exactly one.
    expect(argsOf().p_x).toBeNull();
  });

  it('is one call, not one per field', async () => {
    // The argument for `save_profile` being one transaction is the argument for these
    // being inside it: a person editing their profile is editing one thing.
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Instagram'), 'suraj');
    await fireEvent.changeText(view.getByLabelText('Website'), 'example.com');
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0]?.[0]).toBe('save_profile');
  });

  it('returns to the profile once the save lands', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Instagram'), 'suraj');
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });
});

describe('a value the normaliser refuses', () => {
  it('never reaches save_profile', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Website'), 'javascript:alert(1)');
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    // A Field's error/hint caption is drawn but hidden from the a11y tree (the input speaks
    // it), so queries for it include hidden elements (design-system v3 A.2 #26).
    await waitFor(() => expect(view.getByText(/must start with https/, { includeHiddenElements: true })).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('says so under the box it belongs to, rather than at the bottom of the form', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(
      view.getByLabelText('Instagram'),
      'https://letterboxd.com/suraj',
    );
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(view.getByText(/letterboxd\.com/, { includeHiddenElements: true })).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('keeps Save pressable, because pressing it is what reveals the error', async () => {
    // A Save disabled on invalid input would leave somebody with a dead button, a box
    // that looks fine because it has not been blurred, and nothing to tap that would
    // explain either — `Button`'s `disabledReason` is announced, not drawn.
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Website'), 'javascript:alert(1)');
    const save = view.getByRole('button', { name: 'Save changes' });

    expect(save.props.accessibilityState?.disabled).toBeFalsy();
  });

  it('says nothing while somebody is still typing', async () => {
    // A field that turns red at `h` of `https://` is a field arguing mid-sentence.
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Website'), 'ht');

    expect(view.queryByText(/web address/, { includeHiddenElements: true })).toBeNull();
  });

  it('says so once the box is left', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Website'), 'ht');
    await fireEvent(view.getByLabelText('Website'), 'blur');

    await waitFor(() => expect(view.getByText(/web address/, { includeHiddenElements: true })).toBeTruthy());
  });
});

describe('a box that normalises to what is already stored', () => {
  it('is not a change, and Save stays disabled', async () => {
    mockProfile = { ...mockProfile, link_instagram: 'suraj' };
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Instagram'), '@suraj');
    const save = view.getByRole('button', { name: 'Save changes' });

    expect(save.props.accessibilityState?.disabled).toBe(true);
  });
});

/**
 * **Save in the header** (founder, 2026-11-12). The one Save was at the end of the form,
 * under five social-link boxes; it is the header's text action now, calling the same
 * `save()` under the same rule, and the bottom one is gone.
 */
describe('Save in the header', () => {
  const save = (view: Awaited<ReturnType<typeof renderWithProviders>>) =>
    view.getByRole('button', { name: 'Save changes' });

  it('is the header’s action, and the only Save on the screen', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    expect(mockHeaderOptions.headerRight).toBeDefined();
    expect(view.getAllByRole('button', { name: 'Save changes' })).toHaveLength(1);
    // A short label for a tight header, and the whole action for a screen reader.
    expect(view.getByText('Save')).toBeTruthy();
    expect(view.queryByText('Save changes')).toBeNull();
  });

  /**
   * **The standard Save since 2026-11-13** (founder spec §2A): compact filled Maroon with a
   * Parchment label — the slimmer Rank button's treatment — where a grey tertiary word was.
   * Settings' header Close, which this used to match, is gone.
   */
  it('is the shared filled Maroon SaveButton', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);
    const { StyleSheet } = jest.requireActual<typeof import('react-native')>('react-native');
    const fill = StyleSheet.flatten(view.getByTestId('save-button-fill').props.style);
    expect(fill.backgroundColor).toBe(theme.semantic.action);
    expect(StyleSheet.flatten(save(view).props.style).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('saves once for a double tap', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Bio'), 'Mostly thrillers.');
    await fireEvent.press(save(view));
    await fireEvent.press(save(view));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('is disabled until something has changed, and says why', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    expect(save(view).props.accessibilityState?.disabled).toBe(true);
    expect(save(view).props.accessibilityHint).toBe('Nothing has changed yet');

    await fireEvent.changeText(view.getByLabelText('Bio'), 'Mostly thrillers.');
    expect(save(view).props.accessibilityState?.disabled).toBeFalsy();
  });

  it.each([
    ['an empty display name', 'Display name', '   '],
    ['a handle under three characters', 'Handle', 'ab'],
    ['a bio over the limit', 'Bio', 'x'.repeat(121)],
  ])('is disabled with %s', async (_case, field, value) => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText(field), value);

    expect(save(view).props.accessibilityState?.disabled).toBe(true);
    expect(save(view).props.accessibilityHint).toBe('Fill in a name and a handle first');
  });

  it('saves through the same write, sending only what changed', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Bio'), 'Mostly thrillers.');
    await fireEvent.press(save(view));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    expect(mockRpc.mock.calls[0]?.[0]).toBe('save_profile');
    expect(argsOf().p_bio).toBe('Mostly thrillers.');
    expect(argsOf().p_display_name).toBeNull();
    expect(argsOf().p_username).toBeNull();
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('says Saving… and cannot be pressed twice while the save is out', async () => {
    let finish: (value: unknown) => void = () => {};
    mockSaveAnswer = new Promise((resolve) => {
      finish = resolve;
    });
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Bio'), 'Mostly thrillers.');
    await fireEvent.press(save(view));

    const saving = await view.findByRole('button', { name: 'Saving changes' });
    expect(view.getByText('Saving…')).toBeTruthy();
    expect(saving.props.accessibilityState?.disabled).toBe(true);
    expect(saving.props.accessibilityHint).toBe('Saving your changes');

    await fireEvent.press(saving);
    expect(mockRpc).toHaveBeenCalledTimes(1);

    await act(async () => finish({ data: { status: 'ok' }, error: null }));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('still asks before a handle change, and saves nothing until it is confirmed', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Handle'), 'sai_k');
    await fireEvent.press(save(view));

    expect(alert).toHaveBeenCalledWith(
      'Change your handle to @sai_k?',
      'You can change it again in 30 days.',
      expect.any(Array),
    );
    expect(mockRpc).not.toHaveBeenCalled();

    const buttons = alert.mock.calls[0]?.[2] as AlertButton[];
    await act(async () => buttons.find((b) => b.text === 'Save changes')?.onPress?.());
    await waitFor(() => expect(argsOf().p_username).toBe('sai_k'));
    alert.mockRestore();
  });

  it('shows a refused save in the form, and stays on the screen', async () => {
    mockSaveAnswer = { data: null, error: new Error('That handle is not available.') };
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Bio'), 'Mostly thrillers.');
    await fireEvent.press(save(view));

    await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('stays pressable with a bad link, and pressing it shows the error', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Website'), 'javascript:alert(1)');
    expect(save(view).props.accessibilityState?.disabled).toBeFalsy();

    await fireEvent.press(save(view));
    await waitFor(() => expect(view.getByText(/must start with https/, { includeHiddenElements: true })).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

/**
 * **Leaving with unsaved edits asks first.** There was no guard anywhere in the app; a
 * Back press on a half-edited profile threw the edits away without a word.
 */
describe('leaving with unsaved changes', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });
  afterEach(() => alert.mockRestore());

  const buttons = () => alert.mock.calls.at(-1)?.[2] as AlertButton[];

  it('just goes back when nothing has changed', async () => {
    await renderWithProviders(<EditProfileScreen />);

    await leave();

    expect(alert).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(BACK);
  });

  it('asks, and Keep editing keeps the edits and the screen', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);
    await fireEvent.changeText(view.getByLabelText('Bio'), 'Mostly thrillers.');

    await leave();

    expect(alert).toHaveBeenCalledWith(
      'Discard your changes?',
      'Your profile edits have not been saved.',
      expect.any(Array),
    );
    expect(buttons().map((b) => b.text)).toEqual(['Keep editing', 'Discard']);
    await act(async () => buttons()[0]?.onPress?.());

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(view.getByLabelText('Bio').props.value).toBe('Mostly thrillers.');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('goes where it was going on Discard, without saving', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);
    await fireEvent.changeText(view.getByLabelText('Instagram'), 'suraj');

    await leave();
    await act(async () => buttons().find((b) => b.text === 'Discard')?.onPress?.());

    expect(mockDispatch).toHaveBeenCalledWith(BACK);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('asks for a bad link too, since that is an edit somebody made', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);
    await fireEvent.changeText(view.getByLabelText('Website'), 'javascript:alert(1)');

    await leave();

    expect(alert).toHaveBeenCalledWith('Discard your changes?', expect.any(String), expect.any(Array));
  });

  it('does not ask on the way out after a save', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);
    await fireEvent.changeText(view.getByLabelText('Bio'), 'Mostly thrillers.');

    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    // `router.back()` is a removal like any other; the navigator asks the guard.
    await leave();

    expect(alert).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(BACK);
  });
});
