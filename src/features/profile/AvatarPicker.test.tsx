import { fireEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { AvatarPicker } from './AvatarPicker';

/**
 * **The profile picture's Change and Remove are the app's ordinary action row** (founder
 * QA, 2026-11-12): the same `Button` kinds and order as every other pair — the secondary
 * act on the left, the Maroon one on the right — rather than two controls stacked beside
 * the picture in two different styles.
 */

let mockAvatarUri: string | null = 'https://example.invalid/me.jpg';
const mockPick = jest.fn(() => Promise.resolve({ outcome: 'ok' as const }));
const mockRemove = jest.fn(() => Promise.resolve({ outcome: 'ok' as const }));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: mockAvatarUri ? 'user-1/me.jpg' : null,
    avatarUri: mockAvatarUri,
  }),
}));

jest.mock('./avatar', () => ({
  pickAndUploadAvatar: (...args: unknown[]) => mockPick(...(args as [])),
  removeAvatar: (...args: unknown[]) => mockRemove(...(args as [])),
}));

beforeEach(() => {
  mockAvatarUri = 'https://example.invalid/me.jpg';
  mockPick.mockClear();
  mockRemove.mockClear();
});

type Node = { props: Record<string, unknown>; children?: unknown[] };

const styleOf = (node: Node) => {
  const style = node.props.style;
  return StyleSheet.flatten(
    (typeof style === 'function'
      ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : style) as never,
  ) as { backgroundColor?: string; flexDirection?: string };
};

describe('the profile picture actions', () => {
  it('puts Remove (secondary) on the left and Change (Maroon) on the right, in one row', async () => {
    const view = await renderWithProviders(<AvatarPicker />);
    const row = view.getByTestId('avatar-actions');
    expect(styleOf(row as unknown as Node).flexDirection).toBe('row');

    const remove = view.getByRole('button', { name: 'Remove' });
    const change = view.getByRole('button', { name: 'Change' });
    // Left to right in the row: Remove, then Change.
    const children = row.children as unknown[];
    expect(children).toHaveLength(2);
    expect(children.indexOf(remove)).toBe(0);
    expect(children.indexOf(change)).toBe(1);

    // The shared Button's own kinds: secondary is the raised surface, primary is Maroon.
    expect(styleOf(remove as unknown as Node).backgroundColor).toBe(theme.surface.raised);
    expect(styleOf(change as unknown as Node).backgroundColor).toBe(theme.semantic.action);
  });

  it('offers only the Maroon Choose a picture when there is no picture to remove', async () => {
    mockAvatarUri = null;
    const view = await renderWithProviders(<AvatarPicker />);
    expect(view.queryByRole('button', { name: 'Remove' })).toBeNull();
    const choose = view.getByRole('button', { name: 'Choose a picture' });
    expect(styleOf(choose as unknown as Node).backgroundColor).toBe(theme.semantic.action);
  });

  it('still changes and removes the picture', async () => {
    const view = await renderWithProviders(<AvatarPicker />);
    await fireEvent.press(view.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(mockPick).toHaveBeenCalledWith('user-1', 'user-1/me.jpg'));
    await fireEvent.press(view.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('user-1/me.jpg'));
  });
});
