import { render, within } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

import { theme } from '@/ui/tokens';

import { ACTION_DIVIDER, FeedCard, type FeedCardProps } from './FeedCard';
import { artworkHeight } from './feed-artwork';
import {
  bindPhrase,
  countJoin,
  estimateHeadlineWidth,
  HEADLINE_AVATAR,
  HEADLINE_GAP,
  leadWord,
  NBSP,
  splitCountTail,
} from './FeedHeadline';
import { FEED_CARD, feedCardContentWidth, feedCardInnerWidth } from './FeedPostSurface';

/**
 * **The refined card feed** (founder spec 2026-11-22, "Refined Subtle Card Feed", Concept B).
 *
 * The card drawn directly, at the four phone widths the spec names, so its geometry is
 * asserted as numbers rather than as a screenshot: the hero's 3:2, the bookmark and the
 * score on its corners with whole 44pt targets, the rail's equal posters inside the card,
 * the headline's bound "+ N more", Like · Comment · Share with one count convention, and
 * no bookmark in the action row.
 */

let mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindow,
}));

const WIDTHS = [320, 360, 390, 430] as const;

const reaction = (extra: Partial<FeedCardProps['reaction']> = {}) => ({
  count: 0,
  onPress: jest.fn(),
  onLongPress: jest.fn(),
  ...extra,
});

const base: FeedCardProps = {
  actorName: 'Maya Chen',
  verb: 'ranked',
  title: 'Oppenheimer',
  year: 2023,
  timeLabel: '12m ago',
  artwork: { treatment: 'backdrop', uri: 'https://image.tmdb.org/t/p/w780/opp.jpg' },
  score: 9.2,
  bucket: 'loved',
  onPressTitle: jest.fn(),
  reaction: reaction(),
  onPressComments: jest.fn(),
  onPressSave: jest.fn(),
  onPressShare: jest.fn(),
};

const style = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as never) as ViewStyle;

/** The sentence as one string, every NBSP kept, from the headline's nested runs. */
const sentenceOf = (node: { props: { children?: unknown } }): string => {
  const walk = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : Array.isArray(value)
        ? value.map(walk).join('')
        : value && typeof value === 'object' && 'props' in value
          ? walk(
              (value as { props: { children?: unknown; label?: unknown } }).props.children ??
                (value as { props: { label?: unknown } }).props.label,
            )
          : '';
  return walk(node.props.children);
};

beforeEach(() => {
  mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
});

describe('the card surface', () => {
  it('is white on Paper, a 1pt hairline outline, the card radius, and no shadow', async () => {
    const view = await render(<FeedCard {...base} />);
    const card = style(view.getByTestId('feed-card'));
    expect(card).toMatchObject({
      backgroundColor: theme.surface.raised,
      borderWidth: 1,
      borderColor: theme.border.hairline,
      borderRadius: theme.radius.card,
      marginHorizontal: theme.layout.gutter,
    });
    expect(card.shadowOpacity ?? 0).toBe(0);
    expect(card.elevation ?? 0).toBe(0);
  });

  it('holds the artwork inside it, on its 12pt inset, not as a panel of its own', async () => {
    const view = await render(<FeedCard {...base} />);
    const hero = style(view.getByTestId('feed-card-hero'));
    expect(hero.marginHorizontal).toBe(FEED_CARD.inset);
    // One step inside the card's 12, so the corners nest.
    expect(hero.borderRadius).toBe(theme.radius.control);
  });
});

describe('the single title hero, 3:2', () => {
  it.each([
    [320, 262, 175],
    [360, 302, 201],
    [390, 332, 221],
    [430, 372, 248],
  ])('at %ipt: %ipt wide, %ipt tall', async (screen, width, height) => {
    mockWindow = { ...mockWindow, width: screen };
    expect(feedCardContentWidth(screen)).toBe(width);
    expect(artworkHeight(width)).toBe(height);
    const view = await render(<FeedCard {...base} />);
    expect(style(view.getByTestId('feed-card-hero')).height).toBe(height);
  });

  it.each(WIDTHS)(
    'at %ipt keeps the bookmark upper-right and the score bottom-right, 12pt in, unclipped',
    async (screen) => {
      mockWindow = { ...mockWindow, width: screen };
      const view = await render(<FeedCard {...base} />);
      const hero = view.getByTestId('feed-card-hero');
      const height = style(hero).height as number;
      const save = view.getByTestId('feed-card-save');
      const box = style(save);
      // The whole 44pt target, its glyph 4pt into its own top-right corner.
      expect(box.width).toBe(44);
      expect(box.height).toBe(44);
      expect(box.paddingTop).toBe(theme.space[1]);
      expect(box.paddingRight).toBe(theme.space[1]);
      // The holder sits 8pt in, so the glyph is 12pt in: the score's inset, mirrored.
      const slot = findPositioned(hero, 'feed-card-save');
      expect(slot.top).toBe(8);
      expect(slot.right).toBe(8);
      expect((slot.top as number) + 44).toBeLessThanOrEqual(height);
      const score = style(view.getByTestId('feed-card-score'));
      expect(score).toMatchObject({ position: 'absolute', right: 12, bottom: 12 });
      // The bookmark's box and the score's 52pt disc never meet.
      expect(8 + 44).toBeLessThan(height - 12 - 52);
    },
  );
});

/** The absolutely-positioned ancestor of `testID` inside `root`. */
function findPositioned(root: Parameters<typeof within>[0], testID: string) {
  let node = within(root).getByTestId(testID).parent;
  while (node && style(node).position !== 'absolute') node = node.parent;
  if (!node) throw new Error(`no positioned holder for ${testID}`);
  return style(node);
}

describe('grouped posts keep their rail', () => {
  const tiles = ['Dune', 'Arrival', 'Sicario', 'Enemy', 'Prisoners'].map((title, index) => ({
    id: `t${index}`,
    title,
    year: 2015,
    posterUri: `https://image.tmdb.org/t/p/w342/${index}.jpg`,
    score: index === 0 ? 8.1 : null,
    saved: index === 1,
  }));
  const rail = {
    total: 5,
    tiles,
    onPressTile: jest.fn(),
    onPressAll: jest.fn(),
    onToggleSave: jest.fn(),
  };

  it.each(WIDTHS)(
    'at %ipt scrolls inside the card, every poster the same size',
    async (screen) => {
      mockWindow = { ...mockWindow, width: screen };
      const view = await render(
        <FeedCard
          {...base}
          rail={rail}
          onPressSave={undefined}
          onPressShare={undefined}
          tailAction={{ connector: '+', label: '4 more', onPress: jest.fn() }}
        />,
      );
      const scroll = view.getByTestId('feed-card-rail-scroll');
      expect(scroll.props.horizontal).toBe(true);
      const content = StyleSheet.flatten(scroll.props.contentContainerStyle) as ViewStyle;
      expect(content.paddingHorizontal).toBe(FEED_CARD.inset);
      const posters = within(scroll).getAllByRole('button', { name: /, 2015/ });
      const widths = new Set(posters.map((poster) => style(poster).width));
      expect(widths.size).toBe(1);
      // Three whole posters and the peek of a fourth, after the leading inset.
      const { gap, peek } = theme.layout.posterShelf;
      const width = [...widths][0] as number;
      const used = FEED_CARD.inset + 3 * width + 3 * gap + peek * width;
      expect(used).toBeLessThanOrEqual(feedCardInnerWidth(screen));
      expect(used).toBeGreaterThan(feedCardInnerWidth(screen) - 4);
      // Every poster keeps the reader's bookmark; there is no hero and no collage.
      expect(within(scroll).getAllByTestId('poster-save')).toHaveLength(5);
      expect(view.queryByTestId('feed-card-hero')).toBeNull();
      // The author's score stays on its poster.
      expect(
        within(scroll).getByTestId('poster-score-pill', { includeHiddenElements: true }),
      ).toBeTruthy();
    },
  );

  it('offers no Share and no Save in the row for a group', async () => {
    const view = await render(
      <FeedCard {...base} rail={rail} onPressShare={jest.fn()} onPressSave={undefined} />,
    );
    expect(view.queryByTestId('feed-card-share')).toBeNull();
    expect(view.queryByTestId('feed-card-save')).toBeNull();
    expect(view.getByTestId('feed-card-like')).toBeTruthy();
    expect(view.getByTestId('feed-card-comment')).toBeTruthy();
  });
});

describe('the actions', () => {
  it('are Like · Comment · Share, labelled, with the bookmark only on the artwork', async () => {
    const view = await render(<FeedCard {...base} />);
    const row = view.getByTestId('feed-card-actions');
    expect(within(row).getByText('Like')).toBeTruthy();
    expect(within(row).getByText('Comment')).toBeTruthy();
    expect(within(row).getByText('Share')).toBeTruthy();
    expect(within(row).queryByTestId('feed-card-save')).toBeNull();
    expect(
      within(view.getByTestId('feed-card-hero')).getByTestId('feed-card-save'),
    ).toBeTruthy();
    expect(view.getAllByLabelText(/your watchlist/)).toHaveLength(1);
  });

  it('show both counts the same way once there is activity, and no zero without', async () => {
    const view = await render(
      <FeedCard {...base} reaction={reaction({ count: 4 })} commentCount={2} />,
    );
    expect(within(view.getByTestId('feed-card-like')).getByText('Like 4')).toBeTruthy();
    expect(within(view.getByTestId('feed-card-comment')).getByText('Comment 2')).toBeTruthy();

    const quiet = await render(<FeedCard {...base} />);
    expect(quiet.queryByText(/\b0\b/)).toBeNull();
  });

  it('draw the divider the constant asks for: none as shipped', async () => {
    const view = await render(<FeedCard {...base} />);
    if (ACTION_DIVIDER === 'none') {
      expect(view.queryByTestId('feed-card-divider')).toBeNull();
    } else {
      const divider = style(view.getByTestId('feed-card-divider'));
      expect(divider.backgroundColor).toBe(theme.border.hairline);
      expect(divider.backgroundColor).not.toBe(theme.semantic.action);
    }
  });
});

describe('the headline', () => {
  it('top-aligns the avatar with the first line', async () => {
    const view = await render(<FeedCard {...base} />);
    const avatar = view.getByTestId('feed-card-avatar', { includeHiddenElements: true });
    expect(style(avatar.parent!).alignItems).toBe('flex-start');
  });

  it('binds the year to the title and "+ N more" to the title’s last word', async () => {
    const view = await render(
      <FeedCard
        {...base}
        title="Dune: Part Two"
        year={2024}
        rail={{
          total: 6,
          tiles: [],
          loading: true,
          onPressTile: jest.fn(),
          onPressAll: jest.fn(),
        }}
        tailAction={{ connector: '+', label: '5 more', onPress: jest.fn() }}
        tail="to their watchlist"
      />,
    );
    const said = sentenceOf(view.getByTestId('feed-card-headline'));
    expect(said).toContain(`Two${NBSP}(2024)${NBSP}+${NBSP}5${NBSP}more to their watchlist`);
    // The words of the title still break normally.
    expect(said).toContain('Dune: Part');
    // The link is still exactly "5 more", spoken and pressed as one.
    expect(view.getByTestId('feed-card-tail-link').props.accessibilityLabel).toBe('5 more');
  });

  it.each(WIDTHS)('keeps "+ 15 more" with a long title at %ipt', async (screen) => {
    mockWindow = { ...mockWindow, width: screen };
    const view = await render(
      <FeedCard
        {...base}
        title="The Lord of the Rings: The Fellowship of the Ring"
        year={2001}
        rail={{
          total: 16,
          tiles: [],
          loading: true,
          onPressTile: jest.fn(),
          onPressAll: jest.fn(),
        }}
        tailAction={{ connector: '+', label: '15 more', onPress: jest.fn() }}
      />,
    );
    const said = sentenceOf(view.getByTestId('feed-card-headline'));
    expect(said).toContain(`Ring${NBSP}(2001)${NBSP}+${NBSP}15${NBSP}more`);
  });

  it('lets a single unbreakable word go to its own line rather than overflow at 320pt', async () => {
    mockWindow = { ...mockWindow, width: 320 };
    const word = 'Supercalifragilisticexpialidociously';
    const view = await render(
      <FeedCard
        {...base}
        title={word}
        year={2023}
        rail={{
          total: 16,
          tiles: [],
          loading: true,
          onPressTile: jest.fn(),
          onPressAll: jest.fn(),
        }}
        tailAction={{ connector: '+', label: '15 more', onPress: jest.fn() }}
      />,
    );
    const said = sentenceOf(view.getByTestId('feed-card-headline'));
    // The phrase stays one unit, but is free to start the next line.
    expect(said).toContain(`${word}${NBSP}(2023) +${NBSP}15${NBSP}more`);
  });

  it('applies the same rule to a plain "+ N more" with no list to open', async () => {
    const view = await render(
      <FeedCard
        {...base}
        title="Kaiju No. 8"
        year={null}
        tail="+ 15 more to their watchlist"
      />,
    );
    const said = sentenceOf(view.getByTestId('feed-card-headline'));
    expect(said).toContain(`8${NBSP}+${NBSP}15${NBSP}more to their watchlist`);
  });
});

describe('countJoin, the measured rule', () => {
  const lineWidth = (screen: number) =>
    feedCardContentWidth(screen) - theme.layout.avatar[HEADLINE_AVATAR] - HEADLINE_GAP;
  const font = theme.typography.subhead.fontSize;

  it.each(WIDTHS)(
    'joins an ordinary title at %ipt, and never binds what cannot fit',
    (screen) => {
      for (const title of [
        'Oppenheimer',
        'Dune: Part Two',
        'Everything Everywhere All at Once',
      ]) {
        const lead = leadWord(title, 2023);
        expect(countJoin(lead, '+ 15 more', lineWidth(screen), font)).toBe(NBSP);
        // At 130% text a long chunk may be released to the next line; when it is bound, it fits.
        const large = font * 1.3;
        if (countJoin(lead, '+ 15 more', lineWidth(screen), large) === NBSP) {
          expect(estimateHeadlineWidth(`${lead} + 15 more`, large)).toBeLessThanOrEqual(
            lineWidth(screen),
          );
        }
      }
    },
  );

  it('breaks before the phrase only when the bound chunk could not fit a line', () => {
    const lead = leadWord('Supercalifragilisticexpialidociously', 2023);
    const width = lineWidth(320);
    expect(estimateHeadlineWidth(`${lead} + 15 more`, font)).toBeGreaterThan(width);
    expect(countJoin(lead, '+ 15 more', width, font)).toBe(' ');
    // Unknown width: bound, as the common case is.
    expect(countJoin(lead, '+ 15 more', null, font)).toBe(NBSP);
  });

  it('binds the phrase internally and recognises a plain count tail', () => {
    expect(bindPhrase('+ 5 more')).toBe(`+${NBSP}5${NBSP}more`);
    expect(splitCountTail('+ 5 more to their watchlist')).toEqual({
      phrase: '+ 5 more',
      rest: ' to their watchlist',
    });
    expect(splitCountTail('and 1 other')).toEqual({ phrase: 'and 1 other', rest: '' });
    expect(splitCountTail('to their watchlist')).toBeNull();
    expect(leadWord('Kaiju No. 8')).toBe('8');
    expect(leadWord('Dune', 2021)).toBe('Dune (2021)');
  });
});
