import { render, within } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

import { theme } from '@/ui/tokens';

import { ACTION_DIVIDER, FeedCard, type FeedCardProps } from './FeedCard';
import { artworkHeight } from './feed-artwork';
import {
  avatarCapOffset,
  bindPhrase,
  headlineJoins,
  estimateHeadlineWidth,
  HEADLINE_AVATAR,
  HEADLINE_GAP,
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
      // The viewport is inset and clips (Feed QA polish): its edge, where a poster
      // disappears mid-swipe, is 12pt inside the card. The content carries no side
      // padding, which would scroll away with the posters.
      expect(style(scroll)).toMatchObject({
        marginHorizontal: FEED_CARD.inset,
        overflow: 'hidden',
      });
      const content = StyleSheet.flatten(scroll.props.contentContainerStyle) as ViewStyle;
      expect(content.paddingHorizontal ?? 0).toBe(0);
      expect(content.paddingLeft ?? 0).toBe(0);
      expect(content.paddingRight ?? 0).toBe(0);
      const posters = within(scroll).getAllByRole('button', { name: /, 2015/ });
      const widths = new Set(posters.map((poster) => style(poster).width));
      expect(widths.size).toBe(1);
      // The poster size #368 approved (three whole posters and 0.7 of a fourth after the
      // leading inset), and inside the inset viewport three whole posters and a partial
      // fourth still show: more than half of it, never all of it.
      const { gap, peek } = theme.layout.posterShelf;
      const width = [...widths][0] as number;
      const used = FEED_CARD.inset + 3 * width + 3 * gap + peek * width;
      expect(used).toBeLessThanOrEqual(feedCardInnerWidth(screen));
      expect(used).toBeGreaterThan(feedCardInnerWidth(screen) - 4);
      const viewport = feedCardInnerWidth(screen) - FEED_CARD.inset * 2;
      const fourth = (viewport - 3 * width - 3 * gap) / width;
      expect(fourth).toBeGreaterThan(0.5);
      expect(fourth).toBeLessThan(1);
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
    expect(within(view.getByTestId('feed-card-like')).getByText('Like (4)')).toBeTruthy();
    expect(within(view.getByTestId('feed-card-comment')).getByText('Comment (2)')).toBeTruthy();

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

  /**
   * Optical, not mathematical (Feed QA polish): the avatar's top meets the cap height of
   * the headline's first line, from Inter's own metrics, at the reader's text size; and it
   * is the same 32pt, so a one-line post is no taller.
   */
  it.each([
    [1, 5],
    [1.3, 6],
  ])(
    'drops the avatar to the first line’s cap height at %fx text (%ipt)',
    async (fontScale, offset) => {
      expect(avatarCapOffset(fontScale)).toBe(offset);
      for (const uri of ['https://example.com/a.jpg', null]) {
        for (const onPressActor of [jest.fn(), undefined]) {
          mockWindow = { ...mockWindow, width: 320, fontScale };
          const view = await render(
            <FeedCard {...base} actorAvatarUri={uri} onPressActor={onPressActor} />,
          );
          const avatar = view.getByTestId('feed-card-avatar', { includeHiddenElements: true });
          expect(style(avatar).marginTop).toBe(offset);
        }
      }
      // Never taller than a one-line headline block: 20pt line, 2pt, 16pt time line.
      const { subhead, caption } = theme.typography;
      const block =
        ((subhead.lineHeight as number) + 2 + (caption.lineHeight as number)) * fontScale;
      expect(offset + theme.layout.avatar[HEADLINE_AVATAR]).toBeLessThanOrEqual(block);
    },
  );

  it('computes the offset from Inter’s metrics, not a constant', () => {
    // 14/20: 1.53pt of leading above 16.94pt of font, capitals 3.38pt under the ascender.
    expect(avatarCapOffset(1)).toBe(5);
    expect(avatarCapOffset(2)).toBe(10);
  });

  /** A rail post's headline as one string, every NBSP kept. */
  const headline = async (
    title: string,
    year: number | null,
    more: number,
    extra: Partial<FeedCardProps> = {},
  ) => {
    const view = await render(
      <FeedCard
        {...base}
        actorName="Suraj"
        title={title}
        year={year}
        rail={{
          total: more + 1,
          tiles: [],
          loading: true,
          onPressTile: jest.fn(),
          onPressAll: jest.fn(),
        }}
        tailAction={{ connector: '+', label: `${more} more`, onPress: jest.fn() }}
        {...extra}
      />,
    );
    return { view, said: sentenceOf(view.getByTestId('feed-card-headline')) };
  };

  it('keeps a short title whole and breaks before it, never inside it (the QA case)', async () => {
    mockWindow = { ...mockWindow, width: 320 };
    const { said } = await headline('Nathan for You', 2013, 3);
    // Not "Nathan for" / "You (2013) + 3 more": the title and its year are one unit, so
    // the line breaks before the title, and at 320pt the count, which would make that unit
    // a hair wider than the line, is free to follow on the next.
    expect(said).toBe(
      `Suraj ranked Nathan${NBSP}for${NBSP}You${NBSP}(2013) +${NBSP}3${NBSP}more`,
    );
    // At 360pt the whole of it fits a line, so all of it is one unit.
    mockWindow = { ...mockWindow, width: 360 };
    const wide = await headline('Nathan for You', 2013, 3);
    expect(wide.said).toBe(
      `Suraj ranked Nathan${NBSP}for${NBSP}You${NBSP}(2013)${NBSP}+${NBSP}3${NBSP}more`,
    );
  });

  it('breaks between the year and "+ N more" when title, year and count cannot share a line', async () => {
    mockWindow = { ...mockWindow, width: 360 };
    const { said, view } = await headline('Portrait of a Lady on Fire', 2019, 3, {
      tail: 'to their watchlist',
    });
    expect(said).toBe(
      `Suraj ranked Portrait${NBSP}of${NBSP}a${NBSP}Lady${NBSP}on${NBSP}Fire${NBSP}(2019) +${NBSP}3${NBSP}more to their watchlist`,
    );
    // The link is still exactly "3 more" to a screen reader, pressed as one.
    expect(view.getByTestId('feed-card-tail-link').props.accessibilityLabel).toBe('3 more');
  });

  it('lets a title too long for any line wrap at its own words, the year and count as one unit', async () => {
    mockWindow = { ...mockWindow, width: 320 };
    const { said } = await headline(
      'The Lord of the Rings: The Fellowship of the Ring',
      2001,
      15,
    );
    // Ordinary spaces inside the title, and never "Ring (2001) + 15 more" bound together:
    // the last word is not dragged onto the next line by what follows it.
    expect(said).toBe(
      `Suraj ranked The Lord of the Rings: The Fellowship of the Ring (2001)${NBSP}+${NBSP}15${NBSP}more`,
    );
  });

  it('applies the same rule to a plain "+ N more" with no list to open', async () => {
    const { said } = await headline('Kaiju No. 8', null, 0, {
      rail: null,
      tailAction: null,
      tail: '+ 15 more to their watchlist',
    });
    expect(said).toContain(
      `Kaiju${NBSP}No.${NBSP}8${NBSP}+${NBSP}15${NBSP}more to their watchlist`,
    );
  });

  /**
   * Realistic titles at the founder's two Android widths, at default and 130% text. No
   * title is special-cased; every one is held to the same four properties.
   */
  const TITLES: [string, number | null, number][] = [
    ['Dune', 2021, 2],
    ['Past Lives', 2023, 12],
    ['Nathan for You', 2013, 3],
    ['The Last of Us, S1', 2023, 1],
    ['Portrait of a Lady on Fire', 2019, 3],
    ['Everything Everywhere All at Once', 2022, 5],
    ['The Lord of the Rings: The Fellowship of the Ring', 2001, 15],
    ['Shōgun', null, 4],
    ['Kaiju No. 8', null, 15],
  ];
  const lineWidth = (screen: number) =>
    feedCardContentWidth(screen) - theme.layout.avatar[HEADLINE_AVATAR] - HEADLINE_GAP;

  describe.each([
    [320, 1],
    [360, 1],
    [320, 1.3],
    [360, 1.3],
  ])('at %ipt and %fx text', (screen, fontScale) => {
    const font = theme.typography.subhead.fontSize * fontScale;
    it.each(TITLES)('%s (%s) + %i more', async (title, year, more) => {
      mockWindow = { ...mockWindow, width: screen, fontScale };
      const { said } = await headline(title, year, more);
      const width = lineWidth(screen);
      const phrase = bindPhrase(`+ ${more} more`);
      // 1. "+ N more" is always one unit.
      expect(said).toContain(phrase);
      // 2. A title that fits on a line is drawn whole; one that does not wraps normally.
      const whole = estimateHeadlineWidth(title, font) * 1.05 <= width;
      expect(said).toContain(whole ? bindPhrase(title) : title);
      // 3. Nothing bound is wider than the line, so nothing is broken mid-word.
      for (const run of said.split(' ')) {
        expect(estimateHeadlineWidth(run, font)).toBeLessThanOrEqual(width);
      }
      // 4. Never the title's last word alone with the year or the count.
      if (!whole) {
        const last = title.split(' ').pop()!;
        expect(said).not.toContain(`${last}${NBSP}`);
      }
    });
  });
});

describe('headlineJoins', () => {
  const font = theme.typography.subhead.fontSize;

  it('breaks before a short title, between year and count, or after a long title', () => {
    // Fits whole with everything.
    expect(
      headlineJoins({
        title: 'Dune',
        year: 2021,
        countPhrase: '+ 2 more',
        lineWidth: 218,
        fontSize: font,
      }),
    ).toEqual({ title: 'Dune', beforeYear: NBSP, beforeCount: NBSP });
    // Title and year fit; the count goes to the next line.
    expect(
      headlineJoins({
        title: 'Portrait of a Lady on Fire',
        year: 2019,
        countPhrase: '+ 3 more',
        lineWidth: 258,
        fontSize: font,
      }),
    ).toEqual({
      title: bindPhrase('Portrait of a Lady on Fire'),
      beforeYear: NBSP,
      beforeCount: ' ',
    });
    // Too long for a line: ordinary spaces, and the year and count as one unit.
    expect(
      headlineJoins({
        title: 'The Lord of the Rings: The Fellowship of the Ring',
        year: 2001,
        countPhrase: '+ 15 more',
        lineWidth: 218,
        fontSize: font,
      }),
    ).toEqual({
      title: 'The Lord of the Rings: The Fellowship of the Ring',
      beforeYear: ' ',
      beforeCount: NBSP,
    });
    // No count at all: the title and year rules alone.
    expect(
      headlineJoins({
        title: 'Oppenheimer',
        year: 2023,
        countPhrase: null,
        lineWidth: 218,
        fontSize: font,
      }),
    ).toEqual({ title: 'Oppenheimer', beforeYear: NBSP, beforeCount: ' ' });
  });

  it('measures with Inter’s own advance widths', () => {
    // From the TTFs' hmtx tables: the SemiBold title is 165.6pt at 14pt and the Regular
    // year 45.9pt. The table takes the wider weight per character, so it never reads less
    // than either and never more than a couple of percent over.
    const title = estimateHeadlineWidth('Portrait of a Lady on Fire', font);
    const year = estimateHeadlineWidth(' (2019)', font, 'regular');
    expect(title).toBeGreaterThanOrEqual(165.6);
    expect(title).toBeLessThan(165.6 * 1.02);
    expect(year).toBeGreaterThanOrEqual(45.8);
    expect(year).toBeLessThan(45.9 * 1.02);
    expect(
      headlineJoins({
        title: 'Portrait of a Lady on Fire',
        year: 2019,
        countPhrase: null,
        lineWidth: 218,
        fontSize: font,
      }).beforeYear,
    ).toBe(NBSP);
  });

  it('binds the phrase internally and recognises a plain count tail', () => {
    expect(bindPhrase('+ 5 more')).toBe(`+${NBSP}5${NBSP}more`);
    expect(splitCountTail('+ 5 more to their watchlist')).toEqual({
      phrase: '+ 5 more',
      rest: ' to their watchlist',
    });
    expect(splitCountTail('and 1 other')).toEqual({ phrase: 'and 1 other', rest: '' });
    expect(splitCountTail('to their watchlist')).toBeNull();
  });
});
