import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { EditListSheet } from './EditListSheet';
import type { ListView } from './types';

let resolveUpdate: ((value: { outcome: 'ok' }) => void) | null = null;
jest.mock('./writes', () => ({
  updateList: jest.fn(
    () =>
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
  ),
}));

const list: ListView = {
  id: 'list-1',
  title: 'Comfort watches',
  description: null,
  orderStyle: 'ranked',
  itemCount: 3,
  updatedAt: '2026-11-14T00:00:00Z',
  isOwner: true,
  shareableByViewer: true,
  visibility: 'private',
  hidden: false,
  owner: null,
};

/**
 * **Save says why it is dead while it saves** (design-system v3 A.2 #9). It was disabled
 * while busy with no `disabledReason`, so a screen reader heard a dimmed button and nothing
 * else. The reason matches `SaveButton`'s busy hint.
 */
it('announces why Save is disabled while the save is in flight', async () => {
  const view = await renderWithProviders(
    <EditListSheet
      list={list}
      profilePrivate={false}
      onClose={() => {}}
      onChanged={() => {}}
    />,
  );

  const idle = view.getByRole('button', { name: 'Save' });
  expect(idle.props.accessibilityState).toMatchObject({ disabled: false });
  expect(idle.props.accessibilityHint).toBeUndefined();

  await fireEvent.press(idle);

  const saving = await waitFor(() => view.getByRole('button', { name: 'Saving…' }));
  expect(saving.props.accessibilityState).toMatchObject({ disabled: true });
  expect(saving.props.accessibilityHint).toBe('Saving your changes');

  await act(async () => {
    resolveUpdate?.({ outcome: 'ok' });
  });
});
