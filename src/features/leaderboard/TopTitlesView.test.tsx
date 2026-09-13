import { fireEvent, render, screen } from '@testing-library/react-native';

import type { TopRatedItem } from '@/features/recommendations/use-top-rated';

import { TopTitlesView } from './TopTitlesView';
import { rankTopTitles, type TopTitle } from './use-top-titles';

/**
 * The Top Titles board, drawn (founder, 2026-09-13).
 *
 * What is pinned is the list of things the founder named for a row — rank, poster, title,
 * the bingd. score and how many ratings it rests on, a tap into the title — and the list of
 * things they ruled out: no medal, no timeframe, no confidence label. The server decides
 * eligibility and order; the component is asserted to draw what it is given, in that order.
 */

const item = (over: Partial<TopRatedItem> = {}): TopRatedItem => ({
  mediaItemId: 'm-1',
  title: 'Parasite',
  seriesTitle: null,
  seasonNumber: null,
  kind: 'movie',
  year: 2019,
  posterPath: '/p.jpg',
  genres: ['Thriller'],
  language: 'ko',
  runtimeMinutes: 132,
  score: null,
  bucket: null,
  watchedOn: null,
  addedAt: null,
  communityScore: 9.2,
  ratingCount: 12,
  ...over,
});

const draw = async (
  titles: TopTitle[] | undefined,
  over: Partial<Parameters<typeof TopTitlesView>[0]> = {},
) => {
  const onPressTitle = jest.fn();
  const onChangeMedium = jest.fn();
  // Awaited: `render` is asynchronous as of RNTL 14.
  await render(
    <TopTitlesView
      medium="movies"
      onChangeMedium={onChangeMedium}
      titles={titles}
      loading={false}
      failed={false}
      onPressTitle={onPressTitle}
      {...over}
    />,
  );
  return { onPressTitle, onChangeMedium };
};

describe('rankTopTitles', () => {
  it('numbers in the server order, and shares a number only when score and support both tie', () => {
    const ranked = rankTopTitles([
      item({ mediaItemId: 'a', communityScore: 9.2, ratingCount: 12 }),
      // Same score, fewer ratings: genuinely behind, because support is the second key.
      item({ mediaItemId: 'b', communityScore: 9.2, ratingCount: 8 }),
      // A true tie with the row above.
      item({ mediaItemId: 'c', communityScore: 9.2, ratingCount: 8 }),
      item({ mediaItemId: 'd', communityScore: 8.1, ratingCount: 30 }),
    ]);

    expect(ranked.map((row) => [row.mediaItemId, row.rank])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 2],
      // Competition ranking, as the people board's `rank()` reads: the next row skips.
      ['d', 4],
    ]);
  });

  it('never re-sorts what the server returned', () => {
    // Deliberately out of score order. If a sort crept in, `low` would move up.
    const ranked = rankTopTitles([
      item({ mediaItemId: 'low', communityScore: 5, ratingCount: 3 }),
      item({ mediaItemId: 'high', communityScore: 9, ratingCount: 3 }),
    ]);
    expect(ranked.map((row) => row.mediaItemId)).toEqual(['low', 'high']);
  });
});

describe('TopTitlesView', () => {
  it('draws the rank, the title, the bingd. score and the sample it rests on', async () => {
    await draw(rankTopTitles([item()]));

    const row = screen.getByRole('button', {
      name: 'Number 1, Parasite, 2019, bingd. score 9.2 out of 10, 12 ratings',
    });
    expect(row).toBeTruthy();
    expect(screen.getByText('12 ratings')).toBeTruthy();
    expect(screen.getByText('9.2')).toBeTruthy();
  });

  it('says one rating in the singular, as the title page does', async () => {
    await draw(rankTopTitles([item({ ratingCount: 1 })]));
    expect(screen.getByText('1 rating')).toBeTruthy();
  });

  it('names a season with its show, the way every compact surface does', async () => {
    await draw(
      rankTopTitles([
        item({
          mediaItemId: 's-2',
          kind: 'season',
          title: 'Season 2',
          seriesTitle: 'The Bear',
          seasonNumber: 2,
          year: 2023,
        }),
      ]),
      { medium: 'tv' },
    );
    expect(screen.getByText('The Bear, S2 (2023)')).toBeTruthy();
  });

  it('opens the title from anywhere on the row', async () => {
    const { onPressTitle } = await draw(rankTopTitles([item({ mediaItemId: 'm-42' })]));
    await fireEvent.press(screen.getByRole('button', { name: /^Number 1, Parasite/ }));
    expect(onPressTitle).toHaveBeenCalledWith('m-42');
  });

  it('draws the score as somebody else’s — an outlined ring, never the reader’s filled badge', async () => {
    /**
     * `ScoreBadge`'s outlined variant is the design system's one treatment for a score that
     * is not the reader's own. A filled badge here would read as "you gave this 9.2", which
     * is the confusion `screens.md` records as the reason Top Rated's poster wall carries no
     * score at all.
     */
    await draw(rankTopTitles([item()]));
    const badge = screen.getByLabelText('9.2 out of 10');
    const flat = Object.assign({}, ...[badge.props.style].flat(Infinity).filter(Boolean));
    expect(flat.borderWidth).toBeGreaterThan(0);
    expect(flat.backgroundColor ?? 'transparent').toBe('transparent');
  });

  it('offers Movies and TV, and nothing about a month', async () => {
    const { onChangeMedium } = await draw(rankTopTitles([item()]));

    expect(screen.getByText('Movies')).toBeTruthy();
    expect(screen.queryByText('This month')).toBeNull();
    expect(screen.queryByText('All time')).toBeNull();

    await fireEvent.press(screen.getByText('TV'));
    expect(onChangeMedium).toHaveBeenCalledWith('tv');
  });

  it('adds no medal, badge or confidence label to the top three', async () => {
    await draw(
      rankTopTitles([
        item({ mediaItemId: 'a', title: 'First', communityScore: 9.5 }),
        item({ mediaItemId: 'b', title: 'Second', communityScore: 9.1 }),
        item({ mediaItemId: 'c', title: 'Third', communityScore: 8.7 }),
      ]),
    );
    for (const word of [/medal/i, /gold/i, /trophy/i, /confiden/i, /verified/i, /top pick/i]) {
      expect(screen.queryByText(word)).toBeNull();
    }
  });

  it('shows the list skeleton while loading', async () => {
    await draw(undefined, { loading: true });
    expect(screen.getAllByTestId('skeleton-row', { includeHiddenElements: true }).length).toBeGreaterThan(0);
  });

  it('says so, without a threshold figure, when nothing clears the floor', async () => {
    await draw([]);
    expect(screen.getByText('Not enough ratings yet')).toBeTruthy();
    // The floor is the server's and moves with the community, so no number is quoted.
    expect(screen.queryByText(/\d/)).toBeNull();
  });

  it('fails quietly when the read fails', async () => {
    await draw(undefined, { failed: true });
    expect(screen.getByText('Could not load top titles')).toBeTruthy();
  });
});
