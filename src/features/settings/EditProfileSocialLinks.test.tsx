import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

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
      return Promise.resolve({ data: { status: 'ok' }, error: null });
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: mockBack }),
  Stack: { Screen: () => null },
}));

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
  issued = 0;
  mockProfile = {
    ...mockProfile,
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

    await waitFor(() => expect(view.getByText(/must start with https/)).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('says so under the box it belongs to, rather than at the bottom of the form', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(
      view.getByLabelText('Instagram'),
      'https://letterboxd.com/suraj',
    );
    await fireEvent.press(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(view.getByText(/letterboxd\.com/)).toBeTruthy());
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

    expect(view.queryByText(/web address/)).toBeNull();
  });

  it('says so once the box is left', async () => {
    const view = await renderWithProviders(<EditProfileScreen />);

    await fireEvent.changeText(view.getByLabelText('Website'), 'ht');
    await fireEvent(view.getByLabelText('Website'), 'blur');

    await waitFor(() => expect(view.getByText(/web address/)).toBeTruthy());
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
