import { fireEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { RECALL_EPISODES_FIRST_PAGE, TitleRecallSheet } from './TitleRecallSheet';

/**
 * The recall sheet's two halves, which are one component and two different answers.
 *
 * The sheet exists for one question — *which one was that?* — and until the memory-aid
 * pass it answered it with the same six fields for a film and for a season. That is the
 * right set for a film and close to useless for a season, because a season comparison is
 * routinely Season 1 against Season 4 of one show: the poster is the same artwork with a
 * different number, the genres and the certification are inherited from the parent, and
 * the cast are the same people in every season. What separates two seasons is what
 * happened in them, so a season gets its episodes and a film gets its backdrop.
 *
 * Rendered directly rather than through `RankingSheet`. The comparison's own coverage
 * lives in `ranking-controls.test.tsx` and proves the control opens *this* component;
 * everything below is about what the component then draws, and driving it through a
 * whole ranking session to assert a cast line would be a session test wearing a
 * disguise.
 *
 * **Two things are asserted over the rendered tree rather than through a query**, and
 * both for the same reason `TitleHero.test.tsx` gives: an image that is deliberately
 * silent to a screen reader has no role and no label to find it by, and the claim being
 * made is about the URL the app built. `imagesIn` walks for them.
 */

const mockRecallRead = jest.fn();
const mockCreditsRead = jest.fn();
const mockEpisodes = jest.fn();

/**
 * The two reads this sheet makes, discriminated the way `ranking-controls.test.tsx`
 * discriminates them: `useCredits` reaches `media_cache` through a second `eq` and a
 * `maybeSingle`, and it awaits an unfiltered `select` first, which is the `then`.
 */
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => mockRecallRead(),
          eq: () => ({ maybeSingle: () => mockCreditsRead() }),
        }),
        then: (resolve: (value: unknown) => unknown) => resolve({ count: 1, error: null }),
      }),
    }),
  },
}));

// `useSeasonEpisodes`' fallback fetch. In the app it is usually never called, because a
// season page seeds the same cache key on mount; here there is no page, so every season
// test goes through it and this is the whole episode path.
jest.mock('@/lib/tmdb-adapter', () => ({
  fetchSeasonEpisodes: (...args: unknown[]) => mockEpisodes(...args),
}));

const LONG_SYNOPSIS =
  'Two seasoned professionals circle each other across a city that belongs to neither of ' +
  'them, one building a crew for a last score and the other refusing to go home, until a ' +
  'coffee shop puts them at the same table for the only conversation either will get.';

const movieRow = (over: Record<string, unknown> = {}) => ({
  data: {
    id: 'film-1',
    kind: 'movie',
    title: 'Heat',
    season_number: null,
    release_date: '1995-12-15',
    runtime_minutes: 170,
    episode_count: null,
    overview: LONG_SYNOPSIS,
    poster_path: '/poster.jpg',
    backdrop_path: '/backdrop.jpg',
    genres: ['Crime'],
    original_language: 'en',
    certification: 'R',
    parent: null,
    ...over,
  },
  error: null,
});

const seasonRow = (over: Record<string, unknown> = {}) => ({
  data: {
    id: 'season-1',
    kind: 'season',
    // What TMDB actually writes in `media_items.title` for a season, which is the whole
    // reason `compactName` has to be given the parent.
    title: 'Season 1',
    season_number: 1,
    release_date: '2007-10-12',
    runtime_minutes: 22,
    episode_count: 21,
    overview: LONG_SYNOPSIS,
    poster_path: '/season.jpg',
    // Never populated by the provider for a season, and never borrowed from the parent.
    backdrop_path: null,
    genres: null,
    original_language: 'en',
    certification: null,
    parent: {
      title: 'Wizards of Waverly Place',
      genres: ['Comedy'],
      original_language: 'en',
      certification: 'TV-G',
    },
    ...over,
  },
  error: null,
});

/** A `credits` facet payload, as `creditsFacet` writes one. */
const credits = (payload: Record<string, unknown>) => ({ data: { payload }, error: null });

const SIX_NAMES = [
  { id: 1, name: 'Al Pacino' },
  { id: 2, name: 'Robert De Niro' },
  { id: 3, name: 'Val Kilmer' },
  { id: 4, name: 'Jon Voight' },
  { id: 5, name: 'Tom Sizemore' },
  { id: 6, name: 'Diane Venora' },
];

const episode = (number: number, over: Record<string, unknown> = {}) => ({
  episode_number: number,
  title: `Episode title ${number}`,
  air_date: '2007-10-12',
  runtime_minutes: 22,
  still_path: `/still-${number}.jpg`,
  overview: `Something happens in episode ${number}.`,
  ...over,
});

const episodes = (count: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: count }, (_, index) => episode(index + 1, over));

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string | null;

/**
 * Every loaded image URL in the tree.
 *
 * `expo-image` normalises `source` into an array before it reaches the native view,
 * which is the seam `LogScreen.test.tsx` documents. Walked rather than queried because
 * the backdrop is `accessibilityElementsHidden` on purpose — it is a cue and not content
 * — so no ordinary query can reach it, and asserting the whole URL asserts `backdropUri`
 * and `stillUri` picked the right size bucket as well.
 */
function imagesIn(node: Node, out: string[] = []): string[] {
  if (!node || typeof node === 'string') return out;
  const [source] = (node.props?.source as { uri?: string }[] | undefined) ?? [];
  if (source?.uri) out.push(source.uri);
  for (const child of node.children ?? []) imagesIn(child as Node, out);
  return out;
}

type Flat = { type: string; props: Record<string, unknown> };

/** Every node in the rendered tree, so a prop can be asserted where no query reaches. */
function nodesIn(node: Node, out: Flat[] = []): Flat[] {
  if (!node || typeof node === 'string') return out;
  out.push({ type: node.type ?? '', props: node.props ?? {} });
  for (const child of node.children ?? []) nodesIn(child as Node, out);
  return out;
}

/**
 * Matching nodes **with the chain of ancestors above each one**.
 *
 * Both claims below are about where a node sits rather than about the node: that the
 * backdrop is *inside* a subtree hidden from assistive technology, and that the skeleton
 * is *inside* the same negative margin the episode rows get. A tree-wide "some node
 * carries this prop" is satisfied by the `Sheet`'s own handle and scrim, which is how
 * both of these first shipped asserting nothing at all.
 */
function findAll(
  node: Node,
  match: (node: Flat) => boolean,
  ancestors: Flat[] = [],
  out: { node: Flat; ancestors: Flat[] }[] = [],
): { node: Flat; ancestors: Flat[] }[] {
  if (!node || typeof node === 'string') return out;
  const self: Flat = { type: node.type ?? '', props: node.props ?? {} };
  if (match(self)) out.push({ node: self, ancestors });
  for (const child of node.children ?? []) {
    findAll(child as Node, match, [...ancestors, self], out);
  }
  return out;
}

/** The backdrop, found by the URL the sheet built for it, and everything above it. */
const backdropIn = (view: { toJSON: () => unknown }) =>
  findAll(view.toJSON() as Node, (node) => {
    const [source] = (node.props.source as { uri?: string }[] | undefined) ?? [];
    return Boolean(source?.uri?.includes('/w780/'));
  })[0];

const open = async () => {
  const onClose = jest.fn();
  const view = await renderWithProviders(
    <TitleRecallSheet mediaItemId="title-1" onClose={onClose} />,
  );
  return { ...view, onClose };
};

beforeEach(() => {
  mockRecallRead.mockReset();
  mockCreditsRead.mockReset();
  mockEpisodes.mockReset();
  mockRecallRead.mockResolvedValue(movieRow());
  mockCreditsRead.mockResolvedValue(
    credits({ cast: SIX_NAMES, crew: [{ id: 9, name: 'Michael Mann', job: 'Director' }] }),
  );
  mockEpisodes.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// A film
// ---------------------------------------------------------------------------

describe('a film', () => {
  it('draws its one backdrop, at the card bucket', async () => {
    const view = await open();
    await view.findByText('Heat');

    // `backdropUri(path, 'card')` is w780. The poster is w500 and sits beside it, so the
    // assertion is that *both* are there and that the backdrop is the backdrop.
    await waitFor(() =>
      expect(imagesIn(view.toJSON() as Node)).toContain(
        'https://image.tmdb.org/t/p/w780/backdrop.jpg',
      ),
    );
  });

  it('keeps the backdrop silent, invert-safe, and not a control', async () => {
    const view = await open();
    await view.findByText('Heat');
    await waitFor(() => expect(backdropIn(view)).toBeDefined());

    const backdrop = backdropIn(view)!;
    expect(backdrop.node.props.accessibilityIgnoresInvertColors).toBe(true);

    // A cue, not content: the title beside it already names the film, so announcing
    // "image" would add a stop to a screen reader's path and say nothing at it. Asserted
    // over the backdrop's **own** ancestors — the Sheet's handle and scrim are hidden
    // too, so a tree-wide search for the pair proves nothing about this image.
    expect(
      backdrop.ancestors.some(
        (node) =>
          node.props.accessibilityElementsHidden === true &&
          node.props.importantForAccessibility === 'no-hide-descendants',
      ),
    ).toBe(true);

    // And nothing in the sheet offers to open it. A fullscreen viewer would be a third
    // native Modal inside the ranking's own, which is the presentation this sheet exists
    // without.
    expect(view.queryByLabelText(/backdrop|image|photo/i)).toBeNull();
    expect(
      nodesIn(view.toJSON() as Node).filter((node) => node.props.accessibilityRole === 'button')
        .length,
    ).toBe(
      // "Back to ranking" and the synopsis's own expander. Nothing else is pressable.
      2,
    );
  });

  it('draws no placeholder where a backdrop is missing', async () => {
    mockRecallRead.mockResolvedValue(movieRow({ backdrop_path: null }));

    const view = await open();
    await view.findByText('Heat');

    // The poster survives; nothing 16:9 replaces the absent one. A framed grey box is
    // the failure mode `stillUri` and `profileUri` both exist to avoid.
    const uris = imagesIn(view.toJSON() as Node);
    expect(uris).toContain('https://image.tmdb.org/t/p/w500/poster.jpg');
    expect(uris.some((uri) => uri.includes('/w780/'))).toBe(false);
  });

  it('names three of the cast and not six', async () => {
    const view = await open();

    // The line was six names joined by commas, which reads as prose rather than as a
    // cue. Asserted as the whole string so a fourth name cannot creep back in.
    await waitFor(() =>
      expect(view.getByText('With Al Pacino, Robert De Niro, Val Kilmer')).toBeTruthy(),
    );
    expect(view.queryByText(/Jon Voight/)).toBeNull();
  });

  it('still credits its director', async () => {
    const view = await open();

    // The TV half of this change stops reading `director`. A film must keep reading it,
    // and this is the assertion that says the fix was not applied one condition too wide.
    await waitFor(() => expect(view.getByText('Directed by Michael Mann')).toBeTruthy());
  });

  it('clamps a long synopsis to three lines and offers to open it', async () => {
    const view = await open();

    // `ClampedText` draws the whole string under `numberOfLines` until its measurement
    // lands, and jest lays nothing out — so the clamp is carried on the visible `Text`
    // and is exactly what is assertable here. **Three, not the title page's four**: this
    // is a reminder inside a decision rather than a page to read.
    const synopsis = await waitFor(() => view.getByLabelText('Expand description'));
    expect(synopsis.props.accessibilityState.expanded).toBe(false);

    const clamped = nodesIn(view.toJSON() as Node).filter(
      (node) => node.props.numberOfLines === 3,
    );
    expect(clamped).toHaveLength(1);
  });

  it('opens the synopsis in place when it is pressed', async () => {
    const view = await open();
    const synopsis = await waitFor(() => view.getByLabelText('Expand description'));

    await fireEvent.press(synopsis);

    // In place: still one sheet, and the control has become its own opposite rather than
    // handing over to anything. A second presentation is the one thing this sheet must
    // never do.
    await waitFor(() => expect(view.getByLabelText('Collapse description')).toBeTruthy());
    expect(view.getByText('Back to ranking')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// A season
// ---------------------------------------------------------------------------

describe('a season', () => {
  beforeEach(() => {
    mockRecallRead.mockResolvedValue(seasonRow());
    mockEpisodes.mockResolvedValue(episodes(3));
  });

  it('says which show it is, and not just "Season 1"', async () => {
    const view = await open();

    // `media_items.title` for a season is the bare words "Season 1", and the sheet was
    // printing them: a reader pressing Details to find out *which show this was* got a
    // poster and a season number. The parent has been selected since the sheet shipped
    // and was never passed to `compactName`.
    await waitFor(() =>
      expect(view.getByText('Wizards of Waverly Place, S1')).toBeTruthy(),
    );
    expect(view.queryByText('Season 1')).toBeNull();
  });

  it('credits a true Creator', async () => {
    mockCreditsRead.mockResolvedValue(
      credits({
        cast: SIX_NAMES,
        crew: [
          { id: 7, name: 'An Episode Director', job: 'Director' },
          { id: 8, name: 'Todd J. Greenwald', job: 'Creator' },
        ],
      }),
    );

    const view = await open();

    await waitFor(() =>
      expect(view.getByText('Created by Todd J. Greenwald')).toBeTruthy(),
    );
  });

  it('never passes an episode director off as the show’s creator', async () => {
    // The exact payload a TMDB season carries: a `Director` credit, which is the person
    // who directed *one episode of nine*, and no `Creator` at all. The sheet read
    // `director` for both kinds and labelled it "Created by", so this rendered "Created
    // by An Episode Director" in the one place on screen a reader cannot check it. The
    // founder's rule for this line is that `TV-G · 21 episodes` beats a false person.
    mockCreditsRead.mockResolvedValue(
      credits({
        cast: SIX_NAMES,
        crew: [
          { id: 7, name: 'An Episode Director', job: 'Director' },
          { id: 10, name: 'A Producer', job: 'Executive Producer' },
        ],
      }),
    );

    const view = await open();
    await view.findByText('Wizards of Waverly Place, S1');

    expect(view.queryByText('Created by An Episode Director')).toBeNull();
    expect(view.queryByText(/^Created by/)).toBeNull();
  });

  it('omits the line entirely when there is no Creator', async () => {
    mockCreditsRead.mockResolvedValue(credits({ cast: SIX_NAMES, crew: [] }));

    const view = await open();
    await view.findByText('Wizards of Waverly Place, S1');

    // Absent, not "Created by —" and not a blank row. The identity line above it is
    // still there, which is the half that carries the information.
    expect(view.queryByText(/Created by/)).toBeNull();
    expect(view.getByText('2007')).toBeTruthy();
  });

  it('drops the cast line once the episodes have arrived', async () => {
    const view = await open();
    await view.findByText('Wizards of Waverly Place, S1');

    // Six series regulars are the same six people in Season 1 and in Season 4, so on the
    // one surface built to tell those apart the line says nothing at all.
    await waitFor(() => expect(view.getByText('1 · Episode title 1')).toBeTruthy());
    expect(view.queryByText(/^With /)).toBeNull();
  });

  it('shows six episodes and offers the rest by count', async () => {
    mockEpisodes.mockResolvedValue(episodes(21));

    const view = await open();

    await waitFor(() => expect(view.getByText('1 · Episode title 1')).toBeTruthy());
    expect(view.getByText('6 · Episode title 6')).toBeTruthy();
    expect(view.queryByText('7 · Episode title 7')).toBeNull();
    // The count is in the label as well as the text, so a screen reader hears what it is
    // being offered rather than "show all, button".
    expect(view.getByLabelText('Show all 21 episodes')).toBeTruthy();
  });

  it('offers nothing more when the season is exactly one page long', async () => {
    mockEpisodes.mockResolvedValue(episodes(RECALL_EPISODES_FIRST_PAGE));

    const view = await open();

    // Six episodes and six drawn. `>` rather than `>=`: a "Show all 6 episodes" control
    // over six visible episodes promises something that is already on screen.
    await waitFor(() => expect(view.getByText('6 · Episode title 6')).toBeTruthy());
    expect(view.queryByLabelText(/Show all/)).toBeNull();
  });

  it('reveals the rest in place', async () => {
    mockEpisodes.mockResolvedValue(episodes(21));

    const view = await open();
    const showAll = await waitFor(() => view.getByLabelText('Show all 21 episodes'));

    await fireEvent.press(showAll);

    // The whole season, in the sheet that was already open. No second presentation and
    // no navigation: this is a `<Modal>` inside the ranking's own, and a third one is the
    // shape of the freeze `Sheet`'s notes describe.
    await waitFor(() => expect(view.getByText('21 · Episode title 21')).toBeTruthy());
    expect(view.getByText('Back to ranking')).toBeTruthy();
    expect(view.queryByLabelText('Show all 21 episodes')).toBeNull();
  });

  it('draws an episode with no still as text alone', async () => {
    mockEpisodes.mockResolvedValue(episodes(3, { still_path: null }));

    const view = await open();

    await waitFor(() => expect(view.getByText('1 · Episode title 1')).toBeTruthy());
    // The row keeps its number, its name and its synopsis. What it does not grow is a
    // framed grey box where the picture would be.
    expect(view.getByText('Something happens in episode 1.')).toBeTruthy();
    expect(imagesIn(view.toJSON() as Node).some((uri) => uri.includes('/w300/'))).toBe(false);
  });

  it('draws an episode with no synopsis and no name without inventing either', async () => {
    mockEpisodes.mockResolvedValue(episodes(3, { title: null, overview: null }));

    const view = await open();

    // The number becomes the name rather than the row rendering a blank line, and no
    // "TBA" appears under it.
    await waitFor(() => expect(view.getByText('Episode 1')).toBeTruthy());
    expect(view.queryByText(/Something happens/)).toBeNull();
    // The still is still the strongest cue and is still drawn.
    expect(imagesIn(view.toJSON() as Node)).toContain(
      'https://image.tmdb.org/t/p/w300/still-1.jpg',
    );
  });

  it('falls back to the cast when the provider lists no episodes', async () => {
    mockEpisodes.mockResolvedValue([]);

    const view = await open();

    // A season whose episode list is empty must not end up with *less* than the sheet
    // showed before this change. The cast is a weak cue and it is better than nothing.
    await waitFor(() =>
      expect(view.getByText('With Al Pacino, Robert De Niro, Val Kilmer')).toBeTruthy(),
    );
    expect(view.queryByText(/Episode title/)).toBeNull();
  });

  it('falls back to the cast when the episode fetch fails', async () => {
    mockEpisodes.mockRejectedValue(new Error('BG429'));

    const view = await open();

    // The same fallback, and emphatically not an error banner: the comparison behind
    // this sheet is still perfectly answerable, and the reader did not ask for a report
    // on the provider's hourly ceiling.
    await waitFor(() =>
      expect(view.getByText('With Al Pacino, Robert De Niro, Val Kilmer')).toBeTruthy(),
    );
    expect(view.queryByText('Could not load this title')).toBeNull();
  });

  it('borrows no backdrop from the series it belongs to', async () => {
    const view = await open();
    await view.findByText('Wizards of Waverly Place, S1');

    // One image identical across every season of the show, sitting directly above
    // episode stills that are not, is the opposite of what this sheet is for. The hero
    // borrows the parent's; this must not.
    expect(imagesIn(view.toJSON() as Node).some((uri) => uri.includes('/w780/'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What a film never does
// ---------------------------------------------------------------------------

describe('the episode path', () => {
  it('is never taken for a film', async () => {
    const view = await open();
    await view.findByText('Heat');
    await waitFor(() => expect(view.getByText('Directed by Michael Mann')).toBeTruthy());

    // `useSeasonEpisodes` is enabled off the row's `kind`, so a film must not spend a
    // provider request — or a row in `tmdb_request_log` — on a list it has no use for.
    expect(mockEpisodes).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Nothing at all
// ---------------------------------------------------------------------------

describe('a row the provider never filled in', () => {
  it('says so once rather than rendering an empty sheet', async () => {
    mockRecallRead.mockResolvedValue(
      movieRow({ overview: null, backdrop_path: null, poster_path: null }),
    );
    mockCreditsRead.mockResolvedValue({ data: null, error: null });

    const view = await open();

    await waitFor(() =>
      expect(view.getByText('We do not have a description for this one yet.')).toBeTruthy(),
    );
  });

  it('stays quiet while a season is still fetching its episodes', async () => {
    mockRecallRead.mockResolvedValue(
      seasonRow({ overview: null, poster_path: null }),
    );
    mockCreditsRead.mockResolvedValue(credits({ cast: SIX_NAMES, crew: [] }));
    // A promise that never settles: the render under test is the one where the episodes
    // are on their way.
    mockEpisodes.mockReturnValue(new Promise(() => {}));

    const view = await open();
    await view.findByText('Wizards of Waverly Place, S1');

    // Neither the cast line nor the "no description" sentence, because both would be
    // replaced a beat later by the list that is actually coming. Saying the wrong thing
    // for one frame is worse than saying nothing for one frame.
    expect(view.queryByText(/^With /)).toBeNull();
    expect(view.queryByText('We do not have a description for this one yet.')).toBeNull();

    // And a skeleton in their place rather than a gap, so the section claims that
    // something is coming. `SkeletonRow` is hidden from assistive technology, which is
    // why it is reached by testID rather than by a query.
    expect(view.getAllByTestId('skeleton-row', { includeHiddenElements: true }).length).toBe(2);

    // **Inside the episodes' own negative margin**, which is the whole of a defect an
    // independent review found: `SkeletonRow` insets itself by a gutter exactly as
    // `EpisodeRow` does, so left in the padded flow the placeholder sat a gutter inside
    // the rows it stands for and the section slid sideways when they arrived.
    const skeleton = findAll(
      view.toJSON() as Node,
      (node) => node.props.testID === 'skeleton',
    )[0];
    expect(skeleton).toBeDefined();
    expect(
      skeleton!.ancestors.some(
        (node) =>
          (StyleSheet.flatten(node.props.style) as { marginHorizontal?: number })
            ?.marginHorizontal === -theme.layout.gutter,
      ),
    ).toBe(true);
  });
});
