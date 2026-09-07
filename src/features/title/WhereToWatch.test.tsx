import { fireEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { WhereToWatch } from './WhereToWatch';

/**
 * The availability block under the scores.
 *
 * Two properties carry most of this file. The first is that the block is **allowed to
 * be absent** — pending, failed and genuinely empty all draw nothing, because a card
 * apologising for a provider's missing data on every obscure film would make the page
 * worse than the block makes it better. The second is that a provider logo **opens
 * nothing**: TMDB's payload carries no deep link into Netflix or Max, so the only link
 * here is TMDB's own watch-options page and it is labelled as that.
 *
 * The rest is the shape of the data: a service offered two ways is one entry under two
 * headings, and the compact row counts it once.
 */

const mockFetch = jest.fn();
jest.mock('@/lib/tmdb-adapter', () => ({
  ...jest.requireActual('@/lib/tmdb-adapter'),
  fetchWatchProviders: (...args: unknown[]) => mockFetch(...args),
}));

// The device's own country. Mocked rather than left to the runner, because the region
// is part of the query key and part of the sheet's subtitle.
jest.mock('expo-localization', () => ({
  getLocales: () => [{ regionCode: 'US' }],
}));

// Opening the watch-options page is a handover to the operating system, and what is
// handed over is the assertion.
const mockOpenURL = jest.fn((..._args: unknown[]) => Promise.resolve(true));
jest.mock('react-native/Libraries/Linking/Linking', () => ({
  __esModule: true,
  default: {
    openURL: (...args: unknown[]) => mockOpenURL(...args),
    addEventListener: () => ({ remove: () => {} }),
    getInitialURL: () => Promise.resolve(null),
  },
}));

/**
 * The logos and the overflow count are deliberately hidden from the accessibility
 * tree — the row names them in one label instead, so a screen reader reads a sentence
 * rather than three unlabelled images. RNTL skips hidden elements by default, so the
 * queries that reach them have to opt in, and that opt-in is itself the evidence they
 * are hidden.
 */
const HIDDEN = { includeHiddenElements: true } as const;

const NETFLIX = {
  provider_id: 8,
  name: 'Netflix',
  logo_path: '/netflix.jpg',
  offers: ['stream'] as const,
};
const APPLE = {
  provider_id: 2,
  name: 'Apple TV',
  logo_path: '/apple.jpg',
  offers: ['rent', 'buy'] as const,
};
const AMAZON = {
  provider_id: 10,
  name: 'Amazon Video',
  logo_path: '/amazon.jpg',
  offers: ['buy'] as const,
};

const LINK = 'https://www.themoviedb.org/movie/27205/watch?locale=US';

const availability = (providers: unknown[], link: string | null = LINK) => ({
  region: 'US',
  link,
  providers,
});

beforeEach(() => {
  mockFetch.mockReset();
  mockOpenURL.mockReset();
  mockOpenURL.mockResolvedValue(true);
  mockFetch.mockResolvedValue(availability([NETFLIX, APPLE, AMAZON]));
});

const open = async () => {
  const view = await renderWithProviders(
    <WhereToWatch mediaItemId="film-1" titleName="Inception" />,
  );
  await waitFor(() => expect(view.getByTestId('where-to-watch')).toBeTruthy());
  return view;
};

describe('the collapsed row', () => {
  it('names itself, its source and the services behind it', async () => {
    const view = await open();

    // The app's section-heading treatment since 2026-09-05: small maroon caps, which is
    // what stops the block reading as a third unit inside the Scores section above it.
    expect(view.getByText('WHERE TO WATCH')).toBeTruthy();
    // TMDB's terms for this data are specific: the source must be attributed as
    // JustWatch. The logos are the data, so the line travels with them.
    expect(view.getByText('via JustWatch')).toBeTruthy();
    expect(view.getByTestId('provider-logo-8', HIDDEN)).toBeTruthy();
  });

  it('draws the logo TMDB published rather than a poster', async () => {
    const view = await open();

    // expo-image normalises `source` into an array of sources before it reaches the
    // host component, which is why this reads [0] rather than the prop as written.
    expect(view.getByTestId('provider-logo-8', HIDDEN).props.source[0].uri).toBe(
      'https://image.tmdb.org/t/p/w92/netflix.jpg',
    );
    expect(view.getByTestId('provider-logo-8', HIDDEN).props.contentFit).toBe('contain');
  });

  it('falls back to an initial for a service with no logo, not a blank tile', async () => {
    mockFetch.mockResolvedValue(availability([{ ...NETFLIX, logo_path: null }]));
    const view = await open();

    expect(view.queryByTestId('provider-logo-8', HIDDEN)).toBeNull();
    expect(view.getByText('N', HIDDEN)).toBeTruthy();
  });

  it('shows three services and counts the rest', async () => {
    mockFetch.mockResolvedValue(
      availability([
        NETFLIX,
        APPLE,
        AMAZON,
        { provider_id: 337, name: 'Disney Plus', logo_path: '/d.jpg', offers: ['stream'] },
        { provider_id: 384, name: 'Max', logo_path: '/m.jpg', offers: ['stream'] },
      ]),
    );
    const view = await open();

    expect(view.getByTestId('provider-logo-8', HIDDEN)).toBeTruthy();
    expect(view.getByTestId('provider-logo-2', HIDDEN)).toBeTruthy();
    expect(view.getByTestId('provider-logo-10', HIDDEN)).toBeTruthy();
    expect(view.queryByTestId('provider-logo-337', HIDDEN)).toBeNull();
    expect(view.getByText('+2', HIDDEN)).toBeTruthy();
  });

  it('does not count when everything already fits', async () => {
    mockFetch.mockResolvedValue(availability([NETFLIX, APPLE]));
    const view = await open();

    expect(view.queryByText(/^\+/)).toBeNull();
  });

  it('is one accessibility stop that says what it will open', async () => {
    // The logos are hidden from the tree below and named in the label instead, so a
    // screen reader reads one sentence rather than three unlabelled images.
    const view = await open();

    expect(
      view.getByLabelText('Where to watch. Netflix, Apple TV and Amazon Video.'),
    ).toBeTruthy();
    expect(view.getByTestId('where-to-watch').props.accessibilityHint).toBe(
      'Opens the full list of services',
    );
  });

  it('says how many more when it is counting', async () => {
    mockFetch.mockResolvedValue(
      availability([
        NETFLIX,
        APPLE,
        AMAZON,
        { provider_id: 337, name: 'Disney Plus', logo_path: '/d.jpg', offers: ['stream'] },
      ]),
    );
    const view = await open();

    expect(
      view.getByLabelText('Where to watch. Netflix, Apple TV, Amazon Video and 1 more.'),
    ).toBeTruthy();
  });
});

/**
 * The whole of this feature's failure story.
 *
 * Availability is useful and not critical, so it is the one block on the title page
 * allowed to be absent. A retry banner, a skeleton or an empty-state card would each
 * make a page that renders perfectly well without it look like it is missing something.
 */
describe('when there is nothing to say', () => {
  it('draws nothing at all while the request is in flight', async () => {
    let settle: (value: unknown) => void = () => {};
    mockFetch.mockReturnValue(new Promise((resolve) => (settle = resolve)));

    const view = await renderWithProviders(
      <WhereToWatch mediaItemId="film-1" titleName="Inception" />,
    );
    expect(view.queryByTestId('where-to-watch')).toBeNull();
    expect(view.queryByText('Where to watch')).toBeNull();

    settle(availability([NETFLIX]));
    await waitFor(() => expect(view.getByTestId('where-to-watch')).toBeTruthy());
  });

  it('draws nothing when the provider has no availability for this market', async () => {
    mockFetch.mockResolvedValue(availability([], null));
    const view = await renderWithProviders(
      <WhereToWatch mediaItemId="film-1" titleName="Inception" />,
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(view.queryByTestId('where-to-watch')).toBeNull();
  });

  it('draws nothing when the request fails, and says nothing about the failure', async () => {
    mockFetch.mockRejectedValue(new Error('BG502'));
    const view = await renderWithProviders(
      <WhereToWatch mediaItemId="film-1" titleName="Inception" />,
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(view.queryByTestId('where-to-watch')).toBeNull();
    expect(view.queryByText(/BG502|could not|try again/i)).toBeNull();
  });

  it('asks nothing at all without a title', async () => {
    await renderWithProviders(<WhereToWatch mediaItemId={null} titleName="" />);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('the sheet', () => {
  const openSheet = async () => {
    const view = await open();
    await fireEvent.press(view.getByTestId('where-to-watch'));
    await waitFor(() => expect(view.getByText('STREAM')).toBeTruthy());
    return view;
  };

  it('groups the services by how they offer the title', async () => {
    const view = await openSheet();

    expect(view.getByText('STREAM')).toBeTruthy();
    expect(view.getByText('RENT')).toBeTruthy();
    expect(view.getByText('BUY')).toBeTruthy();
  });

  it('lists a service under every category it is really in, from one entry', async () => {
    // Apple TV rents and sells almost everything, which is TMDB's ordinary shape. The
    // sheet shows it twice because both facts are true; the row above counts it once.
    const view = await openSheet();

    expect(view.getAllByLabelText('Apple TV, Rent')).toHaveLength(1);
    expect(view.getAllByLabelText('Apple TV, Buy')).toHaveLength(1);
    expect(view.getByLabelText('Netflix, Stream')).toBeTruthy();
    expect(view.queryByLabelText('Netflix, Rent')).toBeNull();
  });

  it('omits a heading nothing falls under', async () => {
    mockFetch.mockResolvedValue(availability([NETFLIX]));
    const view = await open();
    await fireEvent.press(view.getByTestId('where-to-watch'));

    await waitFor(() => expect(view.getByText('STREAM')).toBeTruthy());
    expect(view.queryByText('RENT')).toBeNull();
    expect(view.queryByText('BUY')).toBeNull();
  });

  it('says which market it is answering for', async () => {
    const view = await openSheet();
    expect(view.getByText('Availability in US.')).toBeTruthy();
  });

  it('carries the attribution TMDB requires for this data', async () => {
    const view = await openSheet();
    expect(view.getByText('Availability data provided by JustWatch.')).toBeTruthy();
  });

  it('lets a long service name wrap rather than truncating it', async () => {
    // "Amazon Prime Video with Ads" is a real name, and an ellipsis would leave the
    // reader guessing which of two similar services this row is.
    mockFetch.mockResolvedValue(
      availability([
        { provider_id: 9, name: 'Amazon Prime Video with Ads', logo_path: null, offers: ['stream'] },
      ]),
    );
    const view = await open();
    await fireEvent.press(view.getByTestId('where-to-watch'));

    const name = await view.findByText('Amazon Prime Video with Ads');
    expect(name.props.numberOfLines).toBe(2);
  });

  it('closes on Done', async () => {
    const view = await openSheet();
    await fireEvent.press(view.getByText('Done'));

    await waitFor(() => expect(view.queryByText('STREAM')).toBeNull());
  });

  it('closes on the Android hardware back button', async () => {
    // `Sheet` hides its scrim from the accessibility tree on the understanding that
    // back and the Done control are both real exits. This is the one of the two that
    // no test can reach by pressing something.
    const view = await openSheet();
    // There is no query for "the Modal" and no element inside it that back presses:
    // Sheet routes the gesture through the Modal's own onRequestClose, so the element
    // has to be found by type and the event dispatched at it.
    const modal = view.root!.queryAll((node) => node.type === 'Modal')[0];
    await fireEvent(modal!, 'requestClose');

    await waitFor(() => expect(view.queryByText('STREAM')).toBeNull());
  });
});

describe('nothing here leaves the app', () => {
  /**
   * **`View watch options` was removed on 2026-09-05** (founder), and these tests are
   * what stop it coming back by accident.
   *
   * It opened TMDB's own watch-options page for the title in the reader's market — the
   * only real link this data comes with — and the ruling is that a real link to the wrong
   * place is still the wrong place. It sent somebody out of bingd. to a web page that
   * then sent them somewhere else, and it did not do the thing its position implied: it
   * did not open the film on the service they had just tapped, because TMDB publishes no
   * such link.
   */
  it('offers no action out of the sheet, even when TMDB published a link', async () => {
    const view = await open();
    await fireEvent.press(view.getByTestId('where-to-watch'));

    await waitFor(() => expect(view.getByText('STREAM')).toBeTruthy());
    expect(view.queryByText('View watch options')).toBeNull();
    expect(mockOpenURL).not.toHaveBeenCalled();
    // Done is still there, so the sheet is never a room with no door.
    expect(view.getByText('Done')).toBeTruthy();
  });

  it('hands nothing to the operating system from anywhere on the sheet', async () => {
    // The whole surface, not just the footer that used to hold the action.
    const view = await open();
    await fireEvent.press(view.getByTestId('where-to-watch'));

    await fireEvent.press(await view.findByLabelText('Netflix, Stream'));
    await fireEvent.press(view.getByText('Availability data provided by JustWatch.'));
    await fireEvent.press(view.getByText('Where to watch'));

    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  it('never turns a service into a destination', async () => {
    // TMDB carries no deep link into Netflix or Max, so a logo opens nothing.
    // Manufacturing one from a service name would be a guess the reader would read as
    // a promise. Pressing a provider row must hand nothing to the operating system.
    const view = await open();
    await fireEvent.press(view.getByTestId('where-to-watch'));

    const row = await view.findByLabelText('Netflix, Stream');
    await fireEvent.press(row);
    expect(mockOpenURL).not.toHaveBeenCalled();
  });
});

describe('what it costs', () => {
  it('asks once, and opening and closing the sheet asks nothing more', async () => {
    // The block is not gated behind a tab, so it mounts with the page. That is only
    // affordable if reading it is free after the first request — see the staleness
    // window on `useWatchProviders`.
    const view = await open();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('film-1', 'US');

    await fireEvent.press(view.getByTestId('where-to-watch'));
    await waitFor(() => expect(view.getByText('STREAM')).toBeTruthy());
    await fireEvent.press(view.getByText('Done'));
    await waitFor(() => expect(view.queryByText('STREAM')).toBeNull());

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not re-ask after a failure', async () => {
    // Every attempt is a fresh TMDB request charged to this reader's hourly ceiling,
    // and this block is the one thing on the page allowed to be missing. Spending
    // three requests to fail three times is the wrong trade in both directions.
    mockFetch.mockRejectedValue(new Error('BG502'));
    await renderWithProviders(<WhereToWatch mediaItemId="film-1" titleName="Inception" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * **The block is its own section, and the credit is still on it** (founder, physical
 * Android, 2026-09-05).
 *
 * The row sat directly under the two score units with a `callout` label in full ink —
 * a row's weight rather than a section's — so it read as a third thing inside Scores.
 * The fix is the app's own section treatment, which separates it at no cost in height.
 *
 * The attribution moves with it and does not go behind the sheet. TMDB's terms for this
 * data name a third party and require the source to be attributed wherever it is shown;
 * the logos on this row *are* the data. Demoting it is allowed and hiding it is not.
 */
describe('the section treatment', () => {
  const flat = (node: { props: { style?: unknown } }) =>
    StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

  it('uses the app section heading rather than a row label', async () => {
    const view = await open();
    const heading = view.getByText('WHERE TO WATCH');

    // The same token and tone `SectionHeader` uses everywhere else. Written by hand here
    // only because SectionHeader owns a 44pt full-width row, and this heading has to
    // share a line with the logos.
    expect(flat(heading).fontFamily).toBe(theme.typography.sectionHeader.fontFamily);
    expect(flat(heading).fontSize).toBe(theme.typography.sectionHeader.fontSize);
    expect(flat(heading).color).toBe(theme.semantic.action);
  });

  it('keeps the JustWatch credit on the collapsed surface, demoted', async () => {
    const view = await open();
    const credit = view.getByText('via JustWatch');

    expect(flat(credit).fontStyle).toBe('italic');
    expect(flat(credit).color).toBe(theme.text.tertiary);
    // Subordinate to the heading it sits under, which is the whole of "demoted".
    expect(Number(flat(credit).fontSize)).toBeLessThanOrEqual(
      theme.typography.sectionHeader.fontSize,
    );
  });

  it('still spells the credit out in full inside the sheet', async () => {
    // Two surfaces, two treatments, one obligation. Removing either would leave a
    // JustWatch-sourced list somewhere with no source on it.
    const view = await open();
    await fireEvent.press(view.getByTestId('where-to-watch'));

    expect(await view.findByText('Availability data provided by JustWatch.')).toBeTruthy();
  });

  it('opens with a heading and air rather than a hairline', async () => {
    /**
     * **The rule is gone** (founder, 2026-09-07).
     *
     * It was added on 2026-09-06 because the heading alone had not separated this block
     * from the two score units directly above it. Scores now carries a Maroon heading of
     * its own, so two headings and a section's worth of air do the separating — and
     * running the hairline as well is what left the whole page reading as a stack of
     * bordered bands. The title page's one remaining rule is above the tab row.
     */
    const view = await open();

    expect(view.queryByTestId('where-to-watch-divider')).toBeNull();
    // The air that replaced it lives on the row, which is the block's own top padding.
    expect(flat(view.getByTestId('where-to-watch')).paddingTop).toBe(theme.space[6]);
  });

  it('is a row and not a card, with no border of its own', async () => {
    // A border on the row itself would box the block, which is the card treatment this
    // is deliberately not — and it is the treatment removing the rule must not invite.
    const view = await open();
    const row = flat(view.getByTestId('where-to-watch'));

    expect(row.borderTopWidth).toBeUndefined();
    expect(row.borderBottomWidth).toBeUndefined();
    expect(row.borderWidth).toBeUndefined();
    expect(row.backgroundColor).toBeUndefined();
    expect(row.borderRadius).toBeUndefined();
  });
});
