import { fireEvent, render, screen } from '@testing-library/react-native';

import { theme } from '@/ui/tokens';

import { ForYouShortcuts, type ForYouShortcut } from './ForYouShortcuts';

/**
 * For You's two feature shortcuts (founder, nav cohesion sprint, 2026-11-06): what each
 * says, the unread badge, Sent to You's toggle state, and the pair stacking at a large
 * text size rather than squeezing two labels into two halves.
 */

const flatten = (style: unknown) =>
  (Array.isArray(style) ? Object.assign({}, ...style.flat(3)) : (style ?? {})) as Record<
    string,
    unknown
  >;

const shortcuts = (over: Partial<Record<'sent' | 'together', Partial<ForYouShortcut>>> = {}) => {
  const sent = jest.fn();
  const together = jest.fn();
  const list: ForYouShortcut[] = [
    {
      key: 'sent',
      icon: 'mail-outline',
      label: 'Sent to You',
      selected: false,
      onPress: sent,
      ...over.sent,
    },
    {
      key: 'watch-together',
      icon: 'people-outline',
      label: 'Watch Together',
      onPress: together,
      ...over.together,
    },
  ];
  return { list, sent, together };
};

// The window, with the text size each case asks for. Jest's own mock reports a font scale
// of 2, which is the large-text case, so every case says which it means.
let mockFontScale = 1;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 360, height: 780, scale: 2, fontScale: mockFontScale }),
}));
const withFontScale = (fontScale: number) => {
  mockFontScale = fontScale;
};

it('draws both features as equal halves of one row', async () => {
  withFontScale(1);
  await render(<ForYouShortcuts shortcuts={shortcuts().list} />);

  expect(flatten(screen.getByTestId('for-you-shortcuts').props.style).flexDirection).toBe('row');
  for (const id of ['for-you-shortcut-sent', 'for-you-shortcut-watch-together']) {
    expect(flatten(screen.getByTestId(id).props.style)).toMatchObject({ flex: 1, flexBasis: 0 });
  }
});

it('stacks them at a large text size', async () => {
  withFontScale(1.3);
  await render(<ForYouShortcuts shortcuts={shortcuts().list} />);

  expect(flatten(screen.getByTestId('for-you-shortcuts').props.style).flexDirection).toBe(
    'column',
  );
  expect(flatten(screen.getByTestId('for-you-shortcut-sent').props.style).flex).toBeUndefined();
});

it('shows the unread count as a badge, and says it in full', async () => {
  withFontScale(1);
  const { list } = shortcuts({
    sent: { badge: '12+', accessibilityLabel: 'Sent to You, at least 12 unopened' },
  });
  await render(<ForYouShortcuts shortcuts={list} />);

  const sent = screen.getByRole('button', { name: 'Sent to You, at least 12 unopened' });
  // Hidden from a screen reader on purpose: the button's label says the count in full.
  expect(screen.getByText('12+', { includeHiddenElements: true })).toBeTruthy();
  expect(sent.props.accessibilityState).toMatchObject({ selected: false });
});

it('draws no badge at zero', async () => {
  withFontScale(1);
  await render(<ForYouShortcuts shortcuts={shortcuts({ sent: { badge: null } }).list} />);
  expect(screen.queryByText('0')).toBeNull();
});

it('marks Sent to You while it is on, and gives Watch Together no toggle state', async () => {
  withFontScale(1);
  await render(<ForYouShortcuts shortcuts={shortcuts({ sent: { selected: true } }).list} />);

  const sent = screen.getByTestId('for-you-shortcut-sent');
  expect(sent.props.accessibilityState).toMatchObject({ selected: true });
  expect(flatten(sent.props.style)).toMatchObject({
    borderColor: theme.semantic.action,
    backgroundColor: theme.surface.sunken,
  });
  expect(
    screen.getByTestId('for-you-shortcut-watch-together').props.accessibilityState?.selected,
  ).toBeUndefined();
});

it('runs each one’s own action', async () => {
  withFontScale(1);
  const { list, sent, together } = shortcuts();
  await render(<ForYouShortcuts shortcuts={list} />);

  await fireEvent.press(screen.getByRole('button', { name: 'Watch Together' }));
  expect(together).toHaveBeenCalledTimes(1);
  expect(sent).not.toHaveBeenCalled();
});
