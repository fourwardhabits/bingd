import { fireEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { ExportHelp, HOW_TO_STEPS, IMDB_HOW_TO_STEPS } from './ExportHelp';

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (event: unknown) => mockTrack(event) }));

/**
 * The export help, inline (IMP1113-UI). The copy is `HowToExportSheet`'s, moved verbatim,
 * and the assertions on it are that sheet's test's, kept: the four steps, numbered, no em
 * dash, IMDb's Export at the top right rather than in a menu. What changed is the container:
 * a collapsed disclosure rather than a sheet, so the sheet's layout assertions retired with
 * it (design-system.md, Layout invariants, notes that).
 */
beforeEach(() => mockTrack.mockClear());

const open = async (provider: 'letterboxd' | 'imdb') => {
  const view = await renderWithProviders(<ExportHelp provider={provider} surface="settings" />);
  expect(view.queryByText(String(1))).toBeNull();
  await fireEvent.press(view.getByRole('button', { name: 'Need help getting the file?' }));
  return view;
};

describe('the export help', () => {
  it('draws Letterboxd’s four steps, numbered, and the link to its export page', async () => {
    const view = await open('letterboxd');
    HOW_TO_STEPS.forEach((step, index) => {
      expect(view.getByText(step)).toBeTruthy();
      expect(view.getByText(String(index + 1))).toBeTruthy();
      expect(step).not.toMatch(/—/);
    });
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await fireEvent.press(view.getByRole('button', { name: 'Open Letterboxd’s export page' }));
    expect(openURL).toHaveBeenCalledWith('https://letterboxd.com/settings/data/');
    openURL.mockRestore();
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_instructions_opened',
      props: { surface: 'settings', provider: 'letterboxd' },
    });
  });

  it('says where IMDb puts Export: at the top right of Your Ratings, not in a menu', async () => {
    const view = await open('imdb');
    expect(view.getByText('Tap Export at the top right of Your Ratings.')).toBeTruthy();
    expect(view.queryByText(/menu/)).toBeNull();
    IMDB_HOW_TO_STEPS.forEach((step, index) => {
      expect(view.getByText(step)).toBeTruthy();
      expect(view.getByText(String(index + 1))).toBeTruthy();
      expect(step).not.toMatch(/—/);
    });
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await fireEvent.press(view.getByRole('button', { name: 'Open your IMDb ratings' }));
    expect(openURL).toHaveBeenCalledWith('https://www.imdb.com/list/ratings');
    openURL.mockRestore();
  });
});
