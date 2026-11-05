import { fireEvent, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { brand } from '@/ui/tokens';

import { ImmersiveScores } from './ImmersiveScores';
import { TitleActions } from './TitleActions';
import { TitleReviews } from './TitleReviews';

/**
 * The immersive title page's own pieces (Immersive Scroll experiment, 2026-11-04): the
 * compact score strip, the action cluster on artwork, and the reviews preview.
 */
describe('the immersive score strip', () => {
  it('draws the three labels in one strip, with real values', async () => {
    const view = await render(
      <ImmersiveScores
        you={{ score: 9.2 }}
        bingd={{ score: 8.4, ratingCount: 128 }}
        following={{ score: 7.9, ratingCount: 3 }}
      />,
    );

    const strip = within(view.getByTestId('immersive-scores'));
    expect(strip.getByText('Your score')).toBeTruthy();
    expect(strip.getByText('bingd')).toBeTruthy();
    expect(strip.getByText('Following')).toBeTruthy();
    expect(strip.getByText('8.4')).toBeTruthy();
    expect(strip.getByText('128 ratings')).toBeTruthy();
    expect(strip.getByText('3 ratings')).toBeTruthy();
    // The reader's own score is the one filled badge.
    expect(strip.getByLabelText('9.2 out of 10')).toBeTruthy();
  });

  it('says why a score is missing, with a dash and never an empty circle', async () => {
    const view = await render(
      <ImmersiveScores
        you={{ score: null }}
        bingd={{ score: null, ratingCount: 0 }}
        following={{ score: null, ratingCount: 0 }}
      />,
    );

    const strip = within(view.getByTestId('immersive-scores'));
    expect(strip.getByText('Not ranked yet')).toBeTruthy();
    expect(strip.getByText('Not enough ratings')).toBeTruthy();
    expect(strip.getByText('No ratings yet')).toBeTruthy();
    expect(strip.getAllByText('–', { includeHiddenElements: true })).toHaveLength(3);
    expect(strip.queryAllByLabelText(/out of 10/)).toHaveLength(0);
  });

  it('says Score loading for a ranked title whose number has not landed', async () => {
    const view = await render(
      <ImmersiveScores you={{ score: null, pending: true }} bingd={null} following={null} />,
    );
    expect(view.getByText('Score loading')).toBeTruthy();
  });

  it('opens Following only when somebody is behind it', async () => {
    const onPressFollowing = jest.fn();
    const empty = await render(
      <ImmersiveScores
        you={null}
        bingd={null}
        following={{ score: null, ratingCount: 0 }}
        onPressFollowing={onPressFollowing}
      />,
    );
    expect(empty.queryByRole('button')).toBeNull();

    const real = await render(
      <ImmersiveScores
        you={null}
        bingd={null}
        following={{ score: 7.9, ratingCount: 3 }}
        onPressFollowing={onPressFollowing}
      />,
    );
    await fireEvent.press(real.getByTestId('immersive-score-following'));
    expect(onPressFollowing).toHaveBeenCalledTimes(1);
  });

  it('stacks into three rows on a narrow screen at a large text size, and not otherwise', async () => {
    const rn = jest.requireActual('react-native') as typeof import('react-native');
    const dims = jest.spyOn(rn, 'useWindowDimensions');
    const scores = (
      <ImmersiveScores
        you={{ score: 9.2 }}
        bingd={{ score: 8.4, ratingCount: 128 }}
        following={{ score: 7.9, ratingCount: 3 }}
      />
    );
    try {
      dims.mockReturnValue({ width: 320, height: 640, scale: 2, fontScale: 1.3 });
      const large = await render(scores);
      expect(StyleSheet.flatten(large.getByTestId('immersive-scores').props.style).flexDirection).toBe('column');

      dims.mockReturnValue({ width: 320, height: 640, scale: 2, fontScale: 1 });
      const ordinary = await render(scores);
      expect(StyleSheet.flatten(ordinary.getByTestId('immersive-scores').props.style).flexDirection).toBe('row');
    } finally {
      dims.mockRestore();
    }
  });

  it('draws nothing for a title with no scores at all, such as a series', async () => {
    const view = await render(<ImmersiveScores you={null} bingd={null} following={null} />);
    expect(view.queryByTestId('immersive-scores')).toBeNull();
  });
});

describe('the action cluster on artwork', () => {
  const icon = { accessibilityLabel: 'x', onPress: () => {} };

  it('reads Edit ranking for a ranked title when asked, and Ranked otherwise', async () => {
    const edit = await render(
      <TitleActions
        tone="artwork"
        rank={{ ranked: true, label: 'Edit ranking', accessibilityLabel: 'Edit', onPress: () => {} }}
        save={icon}
        recommend={icon}
      />,
    );
    expect(within(edit.getByTestId('title-action-ranked')).getByText('Edit ranking')).toBeTruthy();

    const original = await render(
      <TitleActions rank={{ ranked: true, accessibilityLabel: 'R', onPress: () => {} }} save={icon} recommend={icon} />,
    );
    expect(within(original.getByTestId('title-action-ranked')).getByText('Ranked')).toBeTruthy();
  });

  it('draws its glyphs in Parchment on artwork, and in the original ink on Paper', async () => {
    type Node = { props?: Record<string, unknown>; children?: unknown[] } | string | null;
    // An icon renders as text, so its ink is the first colour-and-size style under the control.
    const glyphColor = (view: Awaited<ReturnType<typeof render>>, id: string) => {
      const find = (node: Node, inside: boolean): unknown => {
        if (!node || typeof node === 'string') return undefined;
        const here = inside || node.props?.testID === id;
        const style = StyleSheet.flatten(node.props?.style as never) as { color?: unknown; fontSize?: number } | undefined;
        if (here && style?.color !== undefined && style?.fontSize !== undefined) return style.color;
        for (const child of node.children ?? []) {
          const found = find(child as Node, here);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      return find(view.toJSON() as Node, false);
    };
    const onArtwork = await render(
      <TitleActions tone="artwork" rank={null} save={icon} list={icon} recommend={icon} />,
    );
    const onPaper = await render(<TitleActions rank={null} save={icon} list={icon} recommend={icon} />);

    for (const id of ['title-action-save', 'title-action-list', 'title-action-recommend']) {
      expect(glyphColor(onArtwork, id)).toBe(brand.parchment);
      expect(glyphColor(onPaper, id)).not.toBe(brand.parchment);
    }
  });

  it('keeps Rank the filled Maroon control on artwork', async () => {
    const view = await render(
      <TitleActions
        tone="artwork"
        rank={{ ranked: false, accessibilityLabel: 'Rank it', onPress: () => {} }}
        save={icon}
        recommend={icon}
      />,
    );
    const style = StyleSheet.flatten(view.getByTestId('title-action-rank').props.style);
    expect(style.backgroundColor).toBe(brand.maroon);
  });
});

describe('the reviews preview', () => {
  const review = (n: number) => ({
    id: `r${n}`,
    userId: `u${n}`,
    username: `reader${n}`,
    name: `Reader ${n}`,
    avatarUri: null,
    text: `Review ${n}`,
    hasSpoilers: false,
    updatedAt: '2026-08-16T10:00:00.000Z',
    score: 8,
    reactionCount: 0,
    helpfulCount: 0,
    viewerHelpful: false,
  });
  const props = {
    loading: false,
    sort: 'top_desc' as const,
    onChangeSort: () => {},
    onToggleHelpful: () => {},
    maskedFor: () => false,
    onPressAuthor: () => {},
    viewerRanked: true,
    viewerHasReview: false,
    onWrite: () => {},
    noun: 'movie',
    viewerId: 'me',
  };

  it('shows only the first reviews and no sort control when limited', async () => {
    const reviews = [review(1), review(2), review(3)];
    const limited = await render(<TitleReviews {...props} reviews={reviews} limit={2} />);
    expect(limited.getByText('Review 1')).toBeTruthy();
    expect(limited.getByText('Review 2')).toBeTruthy();
    expect(limited.queryByText('Review 3')).toBeNull();
    expect(limited.queryByLabelText('Sort reviews')).toBeNull();

    const full = await render(<TitleReviews {...props} reviews={reviews} />);
    expect(full.getByText('Review 3')).toBeTruthy();
    expect(full.getByLabelText('Sort reviews')).toBeTruthy();
  });
});
