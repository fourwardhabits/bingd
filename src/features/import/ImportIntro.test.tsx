import { fireEvent } from '@testing-library/react-native';
import { Linking, StyleSheet, useWindowDimensions } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { Button } from '@/ui/components';
import { actionPairFitsRow } from '@/ui/components/ActionPair';
import { theme } from '@/ui/tokens';

import { IMDB_HOW_TO_STEPS, HOW_TO_STEPS } from './ExportHelp';
import { ImportIntro, INTRO_COPY } from './ImportIntro';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions');

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (event: unknown) => mockTrack(event) }));

/**
 * A service's page (QA 11-14, §7): a `title1` heading, the short copy, *Export* and
 * *Upload* as an `ActionPair`, and the help without a second export button. Jest lays
 * nothing out, so the 320 / 360 behaviour is pinned through `ActionPair`'s arithmetic (held
 * against the font file in `ActionPair.test.tsx`) and the tree it produces.
 */
const windowOf = (width: number, fontScale = 1) =>
  (useWindowDimensions as unknown as jest.Mock).mockReturnValue({
    width,
    height: 800,
    scale: 3,
    fontScale,
  });

const onPick = jest.fn();
const draw = (provider: 'imdb' | 'letterboxd', exit?: React.ReactNode) =>
  renderWithProviders(
    <ImportIntro provider={provider} surface="settings" onPick={onPick} exit={exit} />,
  );

const order = (view: Awaited<ReturnType<typeof draw>>) =>
  view
    .getAllByRole('button')
    .map((b) => b.props.testID as string | undefined)
    .filter((id) => id === 'import-intro-export' || id === 'import-intro-upload');

beforeEach(() => {
  windowOf(390);
  onPick.mockClear();
  mockTrack.mockClear();
});

describe.each(['imdb', 'letterboxd'] as const)('%s’s page', (provider) => {
  const copy = INTRO_COPY[provider];

  it('heads the page with title1, not display, as a header', async () => {
    const view = await draw(provider);
    const heading = view.getByRole('header', { name: copy.title });
    expect(StyleSheet.flatten(heading.props.style)).toMatchObject(theme.typography.title1);
    expect(StyleSheet.flatten(heading.props.style).fontSize).not.toBe(
      theme.typography.display.fontSize,
    );
  });

  it('Export opens the provider’s page and counts it; it never opens the picker', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const view = await draw(provider);
    await fireEvent.press(view.getByRole('button', { name: copy.export }));
    expect(openURL).toHaveBeenCalledWith(
      provider === 'imdb'
        ? 'https://www.imdb.com/list/ratings'
        : 'https://letterboxd.com/settings/data/',
    );
    openURL.mockRestore();
    expect(onPick).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_instructions_opened',
      props: { surface: 'settings', provider },
    });
  });

  it('Upload opens the existing picker', async () => {
    const view = await draw(provider);
    await fireEvent.press(view.getByRole('button', { name: copy.upload }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('keeps every help step and draws no second export button inside it', async () => {
    const view = await draw(provider);
    await fireEvent.press(view.getByRole('button', { name: 'Need help getting the file?' }));
    for (const step of provider === 'imdb' ? IMDB_HOW_TO_STEPS : HOW_TO_STEPS) {
      expect(view.getByText(step)).toBeTruthy();
    }
    expect(view.queryByRole('button', { name: 'Open your IMDb ratings' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Open Letterboxd’s export page' })).toBeNull();
    expect(view.getAllByRole('button', { name: copy.export })).toHaveLength(1);
  });

  /**
   * 320 and 360 at the default text size, and 320 at twice it: the labels do not both fit
   * equal halves there, so the pair stacks with the primary on top, full width, and the
   * labels are free to wrap rather than clip.
   */
  it.each([
    [320, 1],
    [360, 1],
    [320, 2],
  ])('stacks Upload above Export at %ipt (text ×%d), labels uncapped', async (width, scale) => {
    windowOf(width, scale);
    expect(actionPairFitsRow([copy.export, copy.upload], width, scale)).toBe(false);
    const view = await draw(provider);
    expect(order(view)).toEqual(['import-intro-upload', 'import-intro-export']);
    expect(
      StyleSheet.flatten(view.getByTestId('import-intro-actions').props.style).flexDirection,
    ).toBeUndefined();
    for (const label of [copy.export, copy.upload]) {
      expect(view.getByText(label).props.numberOfLines).toBeUndefined();
      expect(view.getByText(label).props.adjustsFontSizeToFit).toBe(false);
    }
    // The primary is still the Maroon fill when stacked.
    expect(
      StyleSheet.flatten(view.getByTestId('import-intro-upload').props.style),
    ).toMatchObject({ backgroundColor: theme.semantic.action });
  });

  it('keeps Not now under the pair on the onboarding step', async () => {
    const view = await draw(
      provider,
      <Button label="Not now" kind="secondary" onPress={() => {}} testID="not-now" />,
    );
    const ids = view.getAllByRole('button').map((b) => b.props.testID as string | undefined);
    expect(ids.indexOf('import-intro-upload')).toBeLessThan(ids.indexOf('not-now'));
    expect(ids.indexOf('import-intro-export')).toBeLessThan(ids.indexOf('not-now'));
  });
});

describe('side by side where both labels fit', () => {
  it('puts IMDb Export left and Upload IMDb file right on a 390pt phone', async () => {
    windowOf(390);
    expect(actionPairFitsRow(['IMDb Export', 'Upload IMDb file'], 390, 1)).toBe(true);
    const view = await draw('imdb');
    expect(order(view)).toEqual(['import-intro-export', 'import-intro-upload']);
    expect(
      StyleSheet.flatten(view.getByTestId('import-intro-actions').props.style),
    ).toMatchObject({ flexDirection: 'row' });
    expect(view.getByText('Upload IMDb file').props.numberOfLines).toBe(1);
  });

  it('keeps Letterboxd’s longer labels stacked on a phone rather than clipping them', () => {
    for (const width of [320, 360, 390, 430]) {
      expect(actionPairFitsRow(['Letterboxd Export', 'Upload Letterboxd file'], width, 1)).toBe(
        false,
      );
    }
    // An iPad-width window has room for both.
    expect(actionPairFitsRow(['Letterboxd Export', 'Upload Letterboxd file'], 768, 1)).toBe(
      true,
    );
  });
});
