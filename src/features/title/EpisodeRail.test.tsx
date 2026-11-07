import { fireEvent, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { EpisodeRail, railCardWidth } from './EpisodeRail';

const episode = (n: number, overrides: Record<string, unknown> = {}) => ({
  episode_number: n,
  title: `Episode title ${n}`,
  air_date: '2025-04-13',
  runtime_minutes: 52,
  still_path: `/still${n}.jpg`,
  overview: `What happens in episode ${n}.`,
  ...overrides,
});

const LONG_TITLE =
  'The One Where Everybody Finally Remembers What Happened at the Lake House That Summer';

/** Renders at a given window, as an Android phone of that width at that text size would. */
const renderAt = async (width: number, fontScale = 1, episodes = [episode(1), episode(2)]) => {
  const rn = jest.requireActual('react-native') as typeof import('react-native');
  jest
    .spyOn(rn, 'useWindowDimensions')
    .mockReturnValue({ width, height: 800, scale: 2.625, fontScale });
  return renderWithProviders(<EpisodeRail episodes={episodes} seasonLabel="Season 2" />);
};

afterEach(() => jest.restoreAllMocks());

/**
 * Android-sized layouts (founder hotfix, 2026-11-07): the small 320pt phone, the common
 * 360pt one and the 412pt Pixel. Each card is a readable still with the next one peeking
 * in at the right edge, which is the rail's only sign that it scrolls.
 */
describe('the episode rail at Android widths', () => {
  it.each([
    [320, 196],
    [360, 222],
    [412, 240],
  ])('at %ipt draws %ipt cards that leave the next one peeking', async (width, expected) => {
    expect(railCardWidth(width)).toBe(expected);
    await renderAt(width);

    const card = StyleSheet.flatten(
      screen.getByTestId('episode-card-1').props.style as never,
    ) as { width: number };
    expect(card.width).toBe(expected);
    // Gutter, one card and a gap still leave part of the second card on screen.
    const visibleOfNext = width - theme.layout.gutter - expected - theme.space[3];
    expect(visibleOfNext).toBeGreaterThan(expected * 0.2);
    expect(visibleOfNext).toBeLessThan(expected);
  });

  it('keeps every still in the same 16:9 frame, with or without an image', async () => {
    await renderAt(360, 1, [episode(1), episode(2, { still_path: null })]);

    const frames = screen.getAllByTestId('episode-frame', { includeHiddenElements: true });
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(StyleSheet.flatten(frame.props.style).aspectRatio).toBe(
        theme.layout.aspect.backdrop,
      );
    }
    expect(
      within(screen.getByTestId('episode-card-2')).getByTestId('episode-still-missing', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
  });

  it('falls back to the frame when a still fails to load', async () => {
    await renderAt(360, 1, [episode(1)]);

    await fireEvent(
      screen.getByTestId('episode-still', { includeHiddenElements: true }),
      'error',
      { nativeEvent: { error: 'HTTP 404' } },
    );
    expect(screen.getByTestId('episode-still-missing', { includeHiddenElements: true })).toBeTruthy();
  });

  it('holds a long title to one line at the largest text size, and shows it whole in the sheet', async () => {
    await renderAt(320, 2, [episode(1, { title: LONG_TITLE })]);

    const onCard = screen.getByText(LONG_TITLE);
    expect(onCard.props.numberOfLines).toBe(1);
    expect(onCard.props.ellipsizeMode).toBe('tail');
    expect(screen.getByText('Episode 1').props.numberOfLines).toBe(1);

    await fireEvent.press(screen.getByTestId('episode-card-1'));
    const sheet = within(screen.getByTestId('episode-sheet'));
    expect(sheet.getByText(LONG_TITLE).props.numberOfLines).toBeUndefined();
    expect(sheet.getByText('What happens in episode 1.').props.numberOfLines).toBeUndefined();
  });

  it('bounds the sheet so a long synopsis at a large text size still scrolls to its end', async () => {
    await renderAt(320, 2, [episode(1)]);
    await fireEvent.press(screen.getByTestId('episode-card-1'));

    const scroller = screen.getByTestId('episode-sheet');
    expect(StyleSheet.flatten(scroller.props.style).maxHeight).toBe(560);
  });

  it('names the sheet for a screen reader, and closes on Done', async () => {
    await renderAt(360);
    await fireEvent.press(screen.getByTestId('episode-card-2'));

    expect(screen.getByLabelText('Season 2 · Episode 2, Episode title 2')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Episode title 2' })).toBeTruthy();
    await fireEvent.press(screen.getByText('Done'));
    expect(screen.queryByTestId('episode-sheet')).toBeNull();
  });

  it('draws nothing for an empty season', async () => {
    await renderAt(360, 1, []);
    expect(screen.queryByTestId('episode-rail')).toBeNull();
  });
});
