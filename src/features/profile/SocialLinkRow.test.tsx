import { fireEvent } from '@testing-library/react-native';
import { Linking, StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { SocialLinkRow } from './SocialLinkRow';
import type { ProfileSocialLinks } from './social-links';

/**
 * The row under the handle: what it draws, what it opens, and what it reports.
 *
 * The three founder rules this has to hold are all statements about *absence* — no row
 * when there are none, no placeholders when there is one, and nothing in the analytics
 * event but the network — so most of what is asserted here is that something is not
 * there. Those are the assertions that rot silently, which is why each one says what it
 * is protecting.
 */

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (event: unknown) => mockTrack(event) }));

const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

beforeEach(() => {
  mockTrack.mockClear();
  openSpy.mockClear();
});

const links = (over: Partial<ProfileSocialLinks> = {}): ProfileSocialLinks => ({
  instagram: null,
  tiktok: null,
  youtube: null,
  x: null,
  website: null,
  ...over,
});

const all = links({
  instagram: 'suraj',
  tiktok: 'surajk',
  youtube: 'SurajWatches',
  x: 'suraj_k',
  website: 'https://example.com',
});

/**
 * The glyphs, as the flattened style each was drawn with.
 *
 * An icon font renders as a `Text` whose `fontFamily` is `ionicons`, so that is what
 * identifies one — walking the tree rather than reaching for an unsafe query, which is
 * how the rest of this suite inspects a drawing.
 */
const glyphStyles = (tree: unknown): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const element = node as {
      type?: string;
      props?: { style?: unknown };
      children?: unknown[];
    };
    const style = StyleSheet.flatten(element.props?.style as never) as Record<string, unknown>;
    if (element.type === 'Text' && style?.fontFamily === 'ionicons') out.push(style);
    (element.children ?? []).forEach(walk);
  };
  walk(tree);
  return out;
};
describe('a profile with no links', () => {
  it('renders nothing at all, not an empty row', async () => {
    // A zero-height row still occupies a slot in a `gap` layout, so an empty `View`
    // would put four points of nothing under every handle in the app. This is also
    // every account that existed before 20260921000100.
    const view = await renderWithProviders(<SocialLinkRow links={links()} />);
    expect(view.queryAllByRole('link')).toHaveLength(0);
  });

  it('renders nothing for a legacy profile with no link fields at all', async () => {
    // One render per test: this library's tree is not reusable across renders inside
    // a single test, so the three shapes get three tests rather than a loop.
    const view = await renderWithProviders(<SocialLinkRow links={null} />);
    expect(view.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('a profile with one link', () => {
  it('draws exactly one icon, with no placeholders for the four that are absent', async () => {
    const view = await renderWithProviders(
      <SocialLinkRow links={links({ tiktok: 'surajk' })} />,
    );

    const buttons = view.getAllByRole('link');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props.accessibilityLabel).toBe('Open TikTok profile');
  });

  it('opens the canonical profile URL for that network', async () => {
    const view = await renderWithProviders(
      <SocialLinkRow links={links({ tiktok: 'surajk' })} />,
    );
    await fireEvent.press(view.getByLabelText('Open TikTok profile'));

    expect(openSpy).toHaveBeenCalledWith('https://www.tiktok.com/@surajk');
  });
});

describe('a profile with all five', () => {
  it('draws them in the founder’s order', async () => {
    const view = await renderWithProviders(<SocialLinkRow links={all} />);

    expect(view.getAllByRole('link').map((node) => node.props.accessibilityLabel)).toEqual([
      'Open TikTok profile',
      'Open Instagram profile',
      'Open X profile',
      'Open YouTube profile',
      'Open website',
    ]);
  });

  it('keeps that order regardless of how the object was built', async () => {
    // The order is the list in `SOCIAL_NETWORKS`, not key insertion order — which is
    // what a row built from `Object.entries` would have been, and would have differed
    // between the two screens the moment one of them spread a partial.
    const shuffled = {
      website: 'https://example.com',
      x: 'suraj_k',
      instagram: 'suraj',
      youtube: 'SurajWatches',
      tiktok: 'surajk',
    };
    const view = await renderWithProviders(<SocialLinkRow links={shuffled} />);

    expect(view.getAllByRole('link').map((node) => node.props.accessibilityLabel)).toEqual([
      'Open TikTok profile',
      'Open Instagram profile',
      'Open X profile',
      'Open YouTube profile',
      'Open website',
    ]);
  });

  it.each([
    ['Open Instagram profile', 'https://www.instagram.com/suraj/'],
    ['Open TikTok profile', 'https://www.tiktok.com/@surajk'],
    ['Open YouTube profile', 'https://www.youtube.com/@SurajWatches'],
    ['Open X profile', 'https://x.com/suraj_k'],
    ['Open website', 'https://example.com'],
  ])('opens %s at %s, and always over https', async (label, url) => {
    // One press per test, deliberately. A second `fireEvent.press` in one test leaves
    // every later render in the file empty — the RNTL trap this suite has been bitten
    // by before — so "every icon opens https" is asserted one icon at a time.
    const view = await renderWithProviders(<SocialLinkRow links={all} />);
    await fireEvent.press(view.getByLabelText(label));

    expect(openSpy).toHaveBeenCalledWith(url);
    // Every branch of `socialLinkUrl` is `https://`, and the handle is only ever a path
    // segment. A row that could produce anything else is the whole risk this carries.
    expect(String(openSpy.mock.calls[0]?.[0]).startsWith('https://')).toBe(true);
  });
});

describe('a stored value that should never have been stored', () => {
  it('draws no icon for it, rather than a link somebody else chose', async () => {
    // `socialLinkUrl` re-checks the shape, so a row written by a client this app has
    // not shipped — or one predating the constraint — produces nothing.
    const view = await renderWithProviders(
      <SocialLinkRow links={links({ instagram: 'suraj', x: '../elsewhere' })} />,
    );

    expect(view.getAllByRole('link').map((node) => node.props.accessibilityLabel)).toEqual([
      'Open Instagram profile',
    ]);
  });

  it('draws no icon for a website that is not https', async () => {
    const view = await renderWithProviders(
      <SocialLinkRow links={links({ website: 'javascript:alert(1)' })} />,
    );
    expect(view.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('what the tap reports', () => {
  it('sends the network and nothing else', async () => {
    const view = await renderWithProviders(<SocialLinkRow links={all} />);
    await fireEvent.press(view.getByLabelText('Open X profile'));

    expect(mockTrack).toHaveBeenCalledWith({
      name: 'profile_social_link_opened',
      props: { network: 'x' },
    });
    // Spelled out as well as matched, because `toHaveBeenCalledWith` on an object
    // literal is the assertion people relax into `objectContaining` later.
    expect(Object.keys(mockTrack.mock.calls[0]?.[0].props)).toEqual(['network']);
  });

  it('carries no handle, URL or profile id', async () => {
    const view = await renderWithProviders(<SocialLinkRow links={all} />);
    await fireEvent.press(view.getByLabelText('Open Instagram profile'));

    const props = mockTrack.mock.calls[0]?.[0].props as Record<string, unknown>;
    for (const key of ['username', 'handle', 'url', 'link', 'profile_id', 'user_id']) {
      expect(props).not.toHaveProperty(key);
    }
  });

  it('reports nothing when the row is merely drawn', async () => {
    // A row that is drawn is not a row that was used, and the question this event
    // exists for is use.
    await renderWithProviders(<SocialLinkRow links={all} />);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('the drawing', () => {
  it('is monochrome, in the same tone an unselected glyph uses', async () => {
    // Five brand colours under somebody's name would be the loudest thing on the
    // profile, and none of that colour is about the person.
    const view = await renderWithProviders(<SocialLinkRow links={all} />);
    const icons = glyphStyles(view.toJSON());

    expect(icons).toHaveLength(5);
    for (const style of icons) {
      expect(style.color).toBe(theme.text.secondary);
      // And the founder's 20-22pt, taken from an existing token rather than invented.
      expect(style.fontSize).toBe(theme.layout.icon.sm);
    }
  });

  it('draws a 32pt cell and answers 44 x 44', async () => {
    // The arithmetic and the concession are argued in the component and pinned in
    // `touch-targets.test.tsx`; this is the half that belongs next to the component.
    const view = await renderWithProviders(<SocialLinkRow links={all} />);
    const cell = view.getAllByRole('link')[0];

    expect(StyleSheet.flatten(cell?.props.style).width).toBe(theme.layout.control.chipHeight);
    expect(StyleSheet.flatten(cell?.props.style).height).toBe(theme.layout.control.chipHeight);
    // Full width at the gutter since 2026-09-16, so the width no longer forces the
    // 40pt concession the name column did: 32 + 6 + 6 on every side.
    const slop = cell?.props.hitSlop;
    expect(theme.layout.control.chipHeight + slop.top + slop.bottom).toBe(theme.layout.minTapTarget);
    expect(theme.layout.control.chipHeight + slop.left + slop.right).toBe(theme.layout.minTapTarget);
  });
});
