import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import { theme } from '../tokens';
import { CompactSwitch } from './CompactSwitch';

/**
 * Movies | TV in the header of Collection and For You (founder, nav cohesion sprint,
 * 2026-11-06): the chosen half Parchment with a Maroon word, as Collection's Watched |
 * Watchlist and the Leaderboard's categories mark a choice; the other half secondary ink;
 * and the word centred in its fill on Android too.
 */
const OPTIONS = [
  { id: 'movies', label: 'Movies' },
  { id: 'tv', label: 'TV' },
] as const;

const flat = <T,>(style: unknown) => StyleSheet.flatten(style as never) as T;

it('marks the chosen half Parchment with a Maroon word, the other quiet', async () => {
  await render(
    <CompactSwitch accessibilityLabel="Medium" options={OPTIONS} value="movies" onChange={() => {}} />,
  );

  const movies = screen.getByRole('radio', { name: 'Movies' });
  const tv = screen.getByRole('radio', { name: 'TV' });
  expect(movies.props.accessibilityState).toMatchObject({ selected: true });

  const chosenWord = within(movies).getByText('Movies');
  expect(flat<TextStyle>(chosenWord.props.style).color).toBe(theme.semantic.action);
  expect(flat<ViewStyle>(chosenWord.parent?.props.style).backgroundColor).toBe(
    theme.surface.sunken,
  );
  expect(flat<TextStyle>(within(tv).getByText('TV').props.style).color).toBe(
    theme.text.secondary,
  );
});

it('centres its words on Android without the font padding', async () => {
  await render(
    <CompactSwitch accessibilityLabel="Medium" options={OPTIONS} value="tv" onChange={() => {}} />,
  );
  const word = flat<TextStyle>(screen.getByText('Movies').props.style);
  expect(word).toMatchObject({ includeFontPadding: false, textAlignVertical: 'center' });
});

it('reports only a change', async () => {
  const onChange = jest.fn();
  await render(
    <CompactSwitch accessibilityLabel="Medium" options={OPTIONS} value="movies" onChange={onChange} />,
  );
  await fireEvent.press(screen.getByRole('radio', { name: 'Movies' }));
  expect(onChange).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('radio', { name: 'TV' }));
  expect(onChange).toHaveBeenCalledWith('tv');
});
