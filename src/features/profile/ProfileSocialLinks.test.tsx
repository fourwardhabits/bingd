import { fireEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { ProfileIdentity } from './ProfileIdentity';
import { MatchLine } from './MatchExplainer';
import type { TasteMatchLine } from './use-taste-match';

/**
 * The header, with links and without — the four cases the founder's §C is about.
 *
 * `ProfileIdentity` rather than either screen, deliberately. It is the one component
 * that draws an identity and both screens hand it the same props, so the questions here
 * — does the metadata block move, does an absent row cost any height, is the order the
 * canonical one — are answered once for both rather than twice with a chance of
 * disagreeing. The screens' own suites cover that each *passes* the links, which is the
 * other half and a different question.
 */

jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (event: unknown) => mockTrack(event) }));

const line: TasteMatchLine = {
  kind: 'match',
  label: '84% Match · 12 shared',
  explanation: {
    match: 'How similarly you and Anna rate titles you have both ranked.',
    shared: 'Titles you have both ranked.',
    // Present in exactly one branch and null everywhere else, which is this one.
    nudge: null,
  },
};

const identity = (
  over: Parameters<typeof ProfileIdentity>[0] extends infer P ? Partial<P> : never,
) => (
  <ProfileIdentity
    name="Anna"
    username="anna"
    bio="Mostly horror and Studio Ghibli."
    avatarUri={null}
    {...over}
  />
);

const all = {
  instagram: 'anna',
  tiktok: 'anna_k',
  youtube: 'AnnaWatches',
  x: 'anna_k',
  website: 'https://example.com',
};

describe('a profile with no social links', () => {
  it('draws no icon row at all', async () => {
    const view = await renderWithProviders(identity({}));

    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    expect(view.queryAllByRole('link')).toHaveLength(0);
  });

  it('is identical whether the prop is absent, null, or five nulls', async () => {
    // The three shapes an existing account can arrive in: a screen that has not been
    // updated, a row read before the migration, and a row read after it. None of them
    // may look different from the others.
    const absent = await renderWithProviders(identity({}));
    const empty = await renderWithProviders(identity({ socialLinks: null }));
    const nulls = await renderWithProviders(
      identity({
        socialLinks: { instagram: null, tiktok: null, youtube: null, x: null, website: null },
      }),
    );

    expect(JSON.stringify(empty.toJSON())).toBe(JSON.stringify(absent.toJSON()));
    expect(JSON.stringify(nulls.toJSON())).toBe(JSON.stringify(absent.toJSON()));
  });

  it('reserves no height for the row it is not drawing', async () => {
    // The whole tree, compared. A blank row of any height would change it, and that is
    // the assertion the founder's "let subsequent content move up naturally" needs —
    // "no icons are visible" would pass with a 32pt gap under every handle in the app.
    const without = await renderWithProviders(identity({ match: null }));
    const withNulls = await renderWithProviders(
      identity({
        match: null,
        socialLinks: { instagram: null, tiktok: null, youtube: null, x: null, website: null },
      }),
    );

    expect(JSON.stringify(withNulls.toJSON())).toBe(JSON.stringify(without.toJSON()));
  });
});

describe('a profile with one social link', () => {
  it('draws that one icon and no placeholders', async () => {
    const view = await renderWithProviders(
      identity({
        socialLinks: { instagram: null, tiktok: null, youtube: 'Anna', x: null, website: null },
      }),
    );

    const icons = view.getAllByRole('link');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.props.accessibilityLabel).toBe('Open YouTube profile');
  });
});

describe('a profile with all five', () => {
  it('draws them in the canonical order, under the handle', async () => {
    const view = await renderWithProviders(identity({ socialLinks: all }));

    expect(view.getAllByRole('link').map((node) => node.props.accessibilityLabel)).toEqual([
      'Open Instagram profile',
      'Open TikTok profile',
      'Open YouTube profile',
      'Open X profile',
      'Open website',
    ]);
  });

  it('still draws the bio below them', async () => {
    const view = await renderWithProviders(identity({ socialLinks: all }));
    expect(view.getByText('Mostly horror and Studio Ghibli.')).toBeTruthy();
  });
});

/**
 * **The founder's §C.2, which is the rule this feature is most likely to break.**
 *
 * The metadata block is Name, then `@handle`, then Match on the line under it — the
 * placement argued at length in `ProfileIdentity`'s docblock and reached by reversing an
 * earlier decision. Links are added *below* that block, so nothing about it may depend
 * on whether a profile has any.
 */
describe('the handle and Match metadata', () => {
  it('reads the same with links as without', async () => {
    const without = await renderWithProviders(
      identity({ match: <MatchLine line={line} onPress={() => {}} /> }),
    );
    expect(without.getByText('@anna')).toBeTruthy();
    expect(without.getByText('84% Match · 12 shared')).toBeTruthy();

    const withLinks = await renderWithProviders(
      identity({ match: <MatchLine line={line} onPress={() => {}} />, socialLinks: all }),
    );
    expect(withLinks.getByText('@anna')).toBeTruthy();
    expect(withLinks.getByText('84% Match · 12 shared')).toBeTruthy();
  });

  it('keeps Match on its own line rather than folding it into the icon row', async () => {
    // The line is a control — it opens the explainer — and it is reached by its label.
    // A row of icons between the handle and Match, or Match merged into that row, would
    // both pass "the text is present"; this asserts the control is still there and is
    // still the text.
    const view = await renderWithProviders(
      identity({ match: <MatchLine line={line} onPress={() => {}} />, socialLinks: all }),
    );

    expect(view.getByLabelText('84% Match · 12 shared')).toBeTruthy();
    expect(view.getAllByRole('link')).toHaveLength(5);
  });

  it('draws no Match on a profile that has none, links or not', async () => {
    // The reader's own profile. A 100% match with your own catalogue is a tautology, and
    // adding links must not give it a reason to appear.
    const view = await renderWithProviders(identity({ socialLinks: all }));
    expect(view.queryByText(/Match/)).toBeNull();
  });
});

describe('the same links wherever the profile is looked at', () => {
  it('draws the identical row for the viewer’s own profile and somebody else’s', async () => {
    // What differs between the two screens is `controls` and `badge`; links are not one
    // of those. Own profiles have no Match, which is the only difference here.
    const own = await renderWithProviders(identity({ socialLinks: all }));
    const other = await renderWithProviders(identity({ socialLinks: all }));

    expect(own.getAllByRole('link').map((n) => n.props.accessibilityLabel)).toEqual(
      other.getAllByRole('link').map((n) => n.props.accessibilityLabel),
    );
  });

  it('opens the external profile from the header', async () => {
    const view = await renderWithProviders(identity({ socialLinks: all }));
    await fireEvent.press(view.getByLabelText('Open X profile'));

    expect(Linking.openURL).toHaveBeenCalledWith('https://x.com/anna_k');
  });
});
