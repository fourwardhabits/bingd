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

/**
 * **A dot on one option** (founder QA B6, 2026-11-15): For You marks the side of Movies | TV
 * holding unread Sent to You rows. Out of the flow, so the word and the half do not move,
 * and said after the label. An option without one is exactly what it was.
 */
describe('an option’s indicator', () => {
  const withDot = [
    { id: 'movies', label: 'Movies' },
    { id: 'tv', label: 'TV', indicator: 'new recommendations' },
  ] as const;

  it('draws nothing and says nothing extra when no option asks for one', async () => {
    await render(
      <CompactSwitch accessibilityLabel="Medium" options={OPTIONS} value="movies" onChange={() => {}} />,
    );
    expect(screen.getByRole('radio', { name: 'TV' })).toBeTruthy();
    expect(
      screen.queryByTestId('compact-switch-indicator-tv', { includeHiddenElements: true }),
    ).toBeNull();
  });

  it('says what the dot means after the label, and draws it out of the flow', async () => {
    const onChange = jest.fn();
    await render(
      <CompactSwitch accessibilityLabel="Medium" options={withDot} value="movies" onChange={onChange} />,
    );

    const tv = screen.getByRole('radio', { name: 'TV, new recommendations' });
    expect(tv.props.accessibilityState).toMatchObject({ selected: false });
    expect(screen.getByRole('radio', { name: 'Movies' })).toBeTruthy();

    const dot = screen.getByTestId('compact-switch-indicator-tv', { includeHiddenElements: true });
    const style = flat<ViewStyle>(dot.props.style);
    expect(style).toMatchObject({
      position: 'absolute',
      backgroundColor: theme.semantic.action,
      borderRadius: theme.radius.full,
    });
    // Inside the fill's side padding, so it cannot sit over the word.
    expect((style.width as number) + (style.right as number)).toBeLessThanOrEqual(
      theme.space[2],
    );
    // The word's fill is unchanged by it.
    const word = screen.getByText('TV', { includeHiddenElements: true });
    expect(flat<ViewStyle>(word.parent?.props.style).paddingHorizontal).toBe(theme.space[2]);
    // Heard once, in the label: the dot itself is hidden.
    expect(dot.props.accessibilityElementsHidden).toBe(true);

    await fireEvent.press(tv);
    expect(onChange).toHaveBeenCalledWith('tv');
  });
});
