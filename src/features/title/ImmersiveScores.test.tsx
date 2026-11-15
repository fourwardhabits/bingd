import { fireEvent, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { brand, theme } from '@/ui/tokens';

import { ImmersiveScores } from './ImmersiveScores';
import { TitleActions } from './TitleActions';
import { TitleReviews } from './TitleReviews';

/**
 * The immersive title page's own pieces (Immersive Scroll experiment, 2026-11-04): the
 * compact score strip, the action cluster on artwork, and the reviews preview.
 */
describe('the immersive score strip', () => {
  /** Every string under a node, in tree order — nested Text included. */
  const textOf = (node: unknown): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    const element = node as { children?: unknown; props?: { children?: unknown } };
    return textOf(element.props?.children ?? element.children ?? []);
  };

  it('draws compact labels with the real rating counts, and real values', async () => {
    const view = await render(
      <ImmersiveScores
        you={{ score: 9.2 }}
        bingd={{ score: 8.7, ratingCount: 4 }}
        following={{ score: 7.9, ratingCount: 3 }}
      />,
    );

    const strip = within(view.getByTestId('immersive-scores'));
    expect(textOf(view.getByTestId('immersive-score-you-label').props.children)).toBe('Your score');
    expect(textOf(view.getByTestId('immersive-score-bingd-label').props.children)).toBe('bingd (4)');
    expect(textOf(view.getByTestId('immersive-score-following-label').props.children)).toBe(
      'Following (3)',
    );
    expect(strip.getByText('8.7')).toBeTruthy();
    expect(strip.getByText('7.9')).toBeTruthy();
    // The reader's own score is the one filled badge.
    expect(strip.getByLabelText('9.2 out of 10')).toBeTruthy();
    // No second line of explanation in the row any more.
    expect(strip.queryByText(/ratings$/)).toBeNull();
    // The count is a rating count, and is said as one.
    expect(view.getByLabelText('bingd score. 8.7 out of 10. 4 ratings')).toBeTruthy();
    expect(view.getByLabelText('People you follow. 7.9 out of 10. 3 ratings')).toBeTruthy();
  });

  /**
   * **Founder spec §8 (2026-11-13)**: yours filled Maroon with Parchment numerals; bingd and
   * Following outlined Maroon with Maroon numerals; nothing drawn as a circle without a
   * number in it. The circle is found from its numerals — the badge's own `View` is its
   * text's parent.
   */
  it('fills your score, and rings the community and Following scores in Maroon', async () => {
    const view = await render(
      <ImmersiveScores
        you={{ score: 9.2 }}
        bingd={{ score: 8.7, ratingCount: 4 }}
        following={{ score: 7.9, ratingCount: 3 }}
      />,
    );
    const circleOf = (value: string) => {
      const text = view.getByText(value);
      return {
        ring: StyleSheet.flatten(text.parent?.props.style),
        ink: StyleSheet.flatten(text.props.style).color,
      };
    };

    const mine = circleOf('9.2');
    expect(mine.ring.backgroundColor).toBe(theme.semantic.score);
    expect(mine.ink).toBe(theme.semantic.scoreInk);

    for (const value of ['8.7', '7.9']) {
      const other = circleOf(value);
      expect(other.ring.backgroundColor).toBeUndefined();
      expect(other.ring.borderColor).toBe(theme.semantic.score);
      expect(other.ring.borderWidth).toBeGreaterThan(0);
      expect(other.ink).toBe(theme.semantic.score);
    }
  });

  it('draws a dash, never an empty circle, where a score is unavailable', async () => {
    const view = await render(
      <ImmersiveScores
        you={{ score: null }}
        bingd={{ score: null, ratingCount: 1 }}
        following={{ score: null, ratingCount: 0 }}
      />,
    );
    const strip = within(view.getByTestId('immersive-scores'));
    expect(strip.getAllByText('—')).toHaveLength(3);
    // No ring and no disc anywhere in the strip.
    type Node = { props?: Record<string, unknown>; children?: unknown[] } | string | null;
    const circles: unknown[] = [];
    const walk = (node: Node) => {
      if (!node || typeof node === 'string') return;
      const style = StyleSheet.flatten(node.props?.style as never) as { borderRadius?: number } | undefined;
      if (style?.borderRadius === theme.radius.full) circles.push(node);
      for (const child of node.children ?? []) walk(child as Node);
    };
    walk(view.toJSON() as Node);
    expect(circles).toHaveLength(0);
  });

  it('shows a dash for a missing score and keeps the reason for screen readers', async () => {
    const view = await render(
      <ImmersiveScores
        you={{ score: null }}
        bingd={{ score: null, ratingCount: 0 }}
        following={{ score: null, ratingCount: 0 }}
      />,
    );

    const strip = within(view.getByTestId('immersive-scores'));
    expect(strip.getAllByText('—')).toHaveLength(3);
    expect(strip.queryAllByLabelText(/out of 10/)).toHaveLength(0);
    // The reasons are not printed…
    expect(strip.queryByText('Not ranked yet')).toBeNull();
    expect(strip.queryByText(/Not enough ratings/)).toBeNull();
    expect(strip.queryByText(/No ratings yet/)).toBeNull();
    // …they are what each column says.
    expect(view.getByLabelText('Your score. Not ranked yet')).toBeTruthy();
    expect(view.getByLabelText('bingd score. Not enough ratings yet. 0 ratings')).toBeTruthy();
    expect(
      view.getByLabelText('People you follow. No ratings yet from people you follow. 0 ratings'),
    ).toBeTruthy();
    expect(textOf(view.getByTestId('immersive-score-bingd-label').props.children)).toBe('bingd (0)');
    expect(textOf(view.getByTestId('immersive-score-following-label').props.children)).toBe(
      'Following (0)',
    );
  });

  it('never draws a count the server has not reported yet', async () => {
    const view = await render(
      <ImmersiveScores
        you={null}
        bingd={{ score: null, ratingCount: null, loading: true }}
        following={{ score: null, ratingCount: null, loading: true }}
      />,
    );
    expect(textOf(view.getByTestId('immersive-score-bingd-label').props.children)).toBe('bingd');
    expect(textOf(view.getByTestId('immersive-score-following-label').props.children)).toBe(
      'Following',
    );
    expect(view.queryByText(/\(0\)/)).toBeNull();
    expect(view.getByLabelText('bingd score. Loading')).toBeTruthy();
  });

  it('says Score loading for a ranked title whose number has not landed', async () => {
    const view = await render(
      <ImmersiveScores you={{ score: null, pending: true }} bingd={null} following={null} />,
    );
    expect(view.getByLabelText('Your score. Score loading')).toBeTruthy();
  });

  it('gives the three columns equal widths, each value and label centred', async () => {
    const view = await render(
      <ImmersiveScores
        you={{ score: 9.2, onPress: () => {} }}
        bingd={{ score: 8.7, ratingCount: 1234 }}
        following={{ score: null, ratingCount: 0 }}
      />,
    );
    for (const id of ['immersive-score-you', 'immersive-score-bingd', 'immersive-score-following']) {
      const cell = StyleSheet.flatten(view.getByTestId(id).props.style);
      // Basis 0 and the same grow: equal thirds whatever the label's length.
      expect(cell.flexBasis).toBe(0);
      expect(cell.flexGrow).toBe(1);
      expect(cell.alignItems).toBe('center');
      // Equal padding above and below.
      expect(cell.paddingVertical).toBeGreaterThan(0);
      expect(cell.paddingTop ?? cell.paddingVertical).toBe(cell.paddingBottom ?? cell.paddingVertical);
      const label = StyleSheet.flatten(view.getByTestId(`${id}-label`).props.style);
      expect(label.textAlign).toBe('center');
    }
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

      dims.mockReturnValue({ width: 360, height: 740, scale: 3, fontScale: 1.15 });
      const wider = await render(scores);
      expect(StyleSheet.flatten(wider.getByTestId('immersive-scores').props.style).flexDirection).toBe('row');

      // Stacked, a label may wrap but is never truncated to one line.
      dims.mockReturnValue({ width: 320, height: 640, scale: 2, fontScale: 2 });
      const largest = await render(scores);
      expect(largest.getByTestId('immersive-score-following-label').props.numberOfLines).toBe(2);
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

  it('reads Log rewatch for a ranked title when asked, and Ranked otherwise', async () => {
    const edit = await render(
      <TitleActions
        tone="artwork"
        rank={{ ranked: true, label: 'Log rewatch', accessibilityLabel: 'Log', onPress: () => {} }}
        save={icon}
        recommend={icon}
      />,
    );
    expect(within(edit.getByTestId('title-action-ranked')).getByText('Log rewatch')).toBeTruthy();

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

/**
 * **A series' season average in the personal slot** (WS-TVC, founder spec t168u §2;
 * FU1113-B; UI refinement B1, 2026-11-15): the same `ScoreCircle` as every other metric,
 * outlined, labelled "Your score" with a quieter "Season average" line under it — no
 * `AVG` in the circle, no "Average of N ranked seasons" paragraph. The season count is
 * only spoken.
 */
describe('the season average in Your score', () => {
  /** Every string under a node, nested Text included. */
  const textOf = (node: unknown): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    const element = node as { children?: unknown; props?: { children?: unknown } };
    return textOf(element.props?.children ?? element.children ?? []);
  };
  /** The circle's own node: `ScoreBadge` puts the spoken value on the drawn circle. */
  const circle = (view: Awaited<ReturnType<typeof render>>, value: string) =>
    StyleSheet.flatten(view.getByLabelText(`${value} out of 10`).props.style);

  it('whole-show only: the filled circle, labelled Your score', async () => {
    const view = await render(<ImmersiveScores you={{ score: 9.2 }} bingd={null} following={null} />);
    expect(circle(view, '9.2').backgroundColor).toBe(theme.semantic.score);
    expect(textOf(view.getByTestId('immersive-score-you-label').props.children)).toBe('Your score');
    expect(view.queryByText('Season average')).toBeNull();
    expect(view.queryByTestId('immersive-score-you-caption')).toBeNull();
  });

  it('seasons only: the outlined circle, labelled Your score over Season average, with no paragraph and no AVG', async () => {
    const view = await render(
      <ImmersiveScores
        you={{ score: null, average: { score: 8.7, count: 3 } }}
        bingd={null}
        following={null}
      />,
    );
    const ring = circle(view, '8.7');
    expect(ring.borderColor).toBe(theme.semantic.score);
    expect(ring.borderWidth).toBe(2);
    expect(ring.backgroundColor).toBeUndefined();
    // The number alone inside the circle.
    expect(view.getByText('8.7')).toBeTruthy();
    expect(view.queryByText(/AVG/)).toBeNull();
    // Two lines (B1, 2026-11-15; was the one line "Your score (SN avg)"): the label is
    // "Your score", as for an explicit score, and "Season average" is the caption under it.
    expect(textOf(view.getByTestId('immersive-score-you-label').props.children)).toBe('Your score');
    expect(textOf(view.getByTestId('immersive-score-you-caption').props.children)).toBe(
      'Season average',
    );
    expect(view.queryByText(/SN avg/)).toBeNull();
    expect(view.queryByText('Season Average')).toBeNull();
    expect(view.queryByText(/ranked seasons?$/)).toBeNull();
    // The count survives for a screen reader.
    expect(
      view.getByLabelText(
        /^Your score, season average\. Average of 3 ranked seasons\. 8\.7 out of 10/,
      ),
    ).toBeTruthy();
  });

  it('sets the second line quieter and smaller than the label, both centred under the circle', async () => {
    const view = await render(
      <ImmersiveScores
        you={{ score: null, average: { score: 8.7, count: 3 } }}
        bingd={{ score: 8.4, ratingCount: 12 }}
        following={{ score: null, ratingCount: 0 }}
      />,
    );
    const label = StyleSheet.flatten(view.getByTestId('immersive-score-you-label').props.style);
    const caption = StyleSheet.flatten(view.getByTestId('immersive-score-you-caption').props.style);
    // The label is the strip's own label treatment, the same as bingd's.
    const bingd = StyleSheet.flatten(view.getByTestId('immersive-score-bingd-label').props.style);
    expect(label.fontSize).toBe(bingd.fontSize);
    expect(label.color).toBe(bingd.color);
    expect(label.color).toBe(theme.text.secondary);
    // The second line is one step down in size and ink.
    expect(caption.fontSize).toBe(theme.typography.caption.fontSize);
    expect(caption.fontSize as number).toBeLessThan(label.fontSize as number);
    expect(caption.color).toBe(theme.text.tertiary);
    expect(label.textAlign).toBe('center');
    expect(caption.textAlign).toBe('center');
    // Neither is cut to one line.
    expect(view.getByTestId('immersive-score-you-caption').props.numberOfLines).not.toBe(1);
  });

  it('stacks before "Season average" would break onto a third line, and not otherwise', async () => {
    const rn = jest.requireActual('react-native') as typeof import('react-native');
    const dims = jest.spyOn(rn, 'useWindowDimensions');
    const withAverage = (
      <ImmersiveScores
        you={{ score: null, average: { score: 8.7, count: 3 } }}
        bingd={{ score: 8.4, ratingCount: 128 }}
        following={{ score: 7.9, ratingCount: 3 }}
      />
    );
    const explicit = (
      <ImmersiveScores
        you={{ score: 9.2, average: { score: 8.7, count: 3 } }}
        bingd={{ score: 8.4, ratingCount: 128 }}
        following={{ score: 7.9, ratingCount: 3 }}
      />
    );
    const direction = (view: Awaited<ReturnType<typeof render>>) =>
      StyleSheet.flatten(view.getByTestId('immersive-scores').props.style).flexDirection;
    try {
      // 320pt at 1x: a third of the strip is narrower than "Season average", so the strip
      // takes its row layout and the two lines sit beside the circle.
      dims.mockReturnValue({ width: 320, height: 640, scale: 2, fontScale: 1 });
      const narrow = await render(withAverage);
      expect(direction(narrow)).toBe('column');
      expect(textOf(narrow.getByTestId('immersive-score-you-label').props.children)).toBe('Your score');
      expect(textOf(narrow.getByTestId('immersive-score-you-caption').props.children)).toBe(
        'Season average',
      );
      // The explicit score at the same width keeps three columns: the earlier stack is the
      // season average's alone.
      const explicitNarrow = await render(explicit);
      expect(direction(explicitNarrow)).toBe('row');
      expect(explicitNarrow.queryByTestId('immersive-score-you-caption')).toBeNull();

      // 375pt at 1x: both lines fit a third, so three columns.
      dims.mockReturnValue({ width: 375, height: 812, scale: 3, fontScale: 1 });
      expect(direction(await render(withAverage))).toBe('row');

      // 375pt at a large text size: stacked again.
      dims.mockReturnValue({ width: 375, height: 812, scale: 3, fontScale: 1.3 });
      expect(direction(await render(withAverage))).toBe('column');

      // 320pt at 2x text: stacked, and the lines may wrap but are never truncated.
      dims.mockReturnValue({ width: 320, height: 640, scale: 2, fontScale: 2 });
      const largest = await render(withAverage);
      expect(direction(largest)).toBe('column');
      expect(largest.getByTestId('immersive-score-you-label').props.numberOfLines).toBe(2);
      expect(largest.getByTestId('immersive-score-you-caption').props.numberOfLines).toBe(2);
    } finally {
      dims.mockRestore();
    }
  });

  it('says "1 ranked season" for one, to a screen reader', async () => {
    const view = await render(
      <ImmersiveScores you={{ score: null, average: { score: 9, count: 1 } }} bingd={null} following={null} />,
    );
    expect(view.getByLabelText(/Average of 1 ranked season\./)).toBeTruthy();
  });

  it('show and seasons: the explicit score wins, filled, and the average is ignored', async () => {
    const view = await render(
      <ImmersiveScores you={{ score: 9.5, average: { score: 8.1, count: 2 } }} bingd={null} following={null} />,
    );
    expect(circle(view, '9.5').backgroundColor).toBe(theme.semantic.score);
    expect(view.queryByLabelText('8.1 out of 10')).toBeNull();
    expect(textOf(view.getByTestId('immersive-score-you-label').props.children)).toBe('Your score');
    expect(view.queryByText('Season average')).toBeNull();
    expect(view.queryByTestId('immersive-score-you-caption')).toBeNull();
    expect(view.getByLabelText(/^Your score\. 9\.5 out of 10/)).toBeTruthy();
    expect(view.queryByText(/AVG/)).toBeNull();
  });

  it('switches to the filled circle when an explicit ranking is added after the average', async () => {
    const view = await render(
      <ImmersiveScores you={{ score: null, average: { score: 8.7, count: 3 } }} bingd={null} following={null} />,
    );
    expect(circle(view, '8.7').backgroundColor).toBeUndefined();

    await view.rerender(
      <ImmersiveScores you={{ score: 9.1, average: { score: 8.7, count: 3 } }} bingd={null} following={null} />,
    );
    expect(circle(view, '9.1').backgroundColor).toBe(theme.semantic.score);
    expect(textOf(view.getByTestId('immersive-score-you-label').props.children)).toBe('Your score');
    expect(view.queryByTestId('immersive-score-you-caption')).toBeNull();
    expect(view.queryByLabelText('8.7 out of 10')).toBeNull();
  });

  it('keeps the unranked state when there is neither', async () => {
    const view = await render(<ImmersiveScores you={{ score: null }} bingd={null} following={null} />);
    expect(view.queryByText(/AVG/)).toBeNull();
    expect(view.getByLabelText(/Not ranked yet/)).toBeTruthy();
  });
});
