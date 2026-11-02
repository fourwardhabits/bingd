import { fireEvent, waitFor } from '@testing-library/react-native';
import { Share, StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { FIRST_FIVE_CARD_SIZE, FirstFiveCard } from './FirstFiveCard';
import { FirstFiveShareSheet } from './FirstFiveShareSheet';
import type { FirstFiveRow } from './first-five';

const mockCaptureRef = jest.fn();
const mockReleaseCapture = jest.fn();
const mockShareAsync = jest.fn();
const mockIsAvailable = jest.fn();
const mockTrack = jest.fn();

jest.mock('react-native-view-shot', () => ({
  captureRef: (...args: unknown[]) => mockCaptureRef(...args),
  releaseCapture: (...args: unknown[]) => mockReleaseCapture(...args),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: () => mockIsAvailable(),
  shareAsync: (...args: unknown[]) => mockShareAsync(...args),
}));
jest.mock('@/lib/analytics', () => ({ track: (event: unknown) => mockTrack(event) }));

const rows: FirstFiveRow[] = [
  { mediaItemId: 'a', rank: 1, title: 'The Dark Knight', year: 2008, posterPath: '/a.jpg', score: 10, bucket: 'loved' },
  { mediaItemId: 'b', rank: 2, title: 'Spirited Away', year: 2001, posterPath: '/b.jpg', score: 9.3, bucket: 'loved' },
  { mediaItemId: 'c', rank: 3, title: 'Parasite', year: null, posterPath: null, score: 8.5, bucket: 'loved' },
  { mediaItemId: 'd', rank: 4, title: 'Inception', year: 2010, posterPath: '/d.jpg', score: 5.4, bucket: 'fine' },
  { mediaItemId: 'e', rank: 5, title: 'Interstellar', year: 2014, posterPath: '/e.jpg', score: 2, bucket: 'not_for_me' },
];

const onClose = jest.fn();

const open = () =>
  renderWithProviders(<FirstFiveShareSheet rows={rows} username="alexr" onClose={onClose} />);

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAvailable.mockResolvedValue(true);
  mockCaptureRef.mockResolvedValue('file:///cache/card.png');
  mockShareAsync.mockResolvedValue(undefined);
  jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
});

describe('the card', () => {
  it('prints the reader’s own five, their handle, and where a stranger goes next', async () => {
    const view = await renderWithProviders(<FirstFiveCard rows={rows} username="alexr" />);

    expect(view.getAllByTestId('first-five-card-row')).toHaveLength(5);
    expect(view.getByText('My First Five')).toBeTruthy();
    expect(view.getByText('@alexr')).toBeTruthy();
    expect(view.getByText('The Dark Knight', { exact: false })).toBeTruthy();
    expect(view.getByText('10.0')).toBeTruthy();
    expect(view.getByText('Rank yours free at bingd.app')).toBeTruthy();
  });

  it('prints the name without its period everywhere but the wordmark', async () => {
    const view = await renderWithProviders(<FirstFiveCard rows={rows} username="alexr" />);

    expect(view.getByText('bingd.')).toBeTruthy();
    expect(view.queryByText(/bingd\. /)).toBeNull();
  });

  /** Artwork licensing is open, and an image view cannot be captured safely on Android. */
  it('contains no image of any kind', async () => {
    const view = await renderWithProviders(<FirstFiveCard rows={rows} username="alexr" />);

    const images = view.root?.queryAll((node) => /image/i.test(String(node.type))) ?? [];

    expect(images).toHaveLength(0);
  });

  it('is 4:5 and cannot be flattened away before it is captured', async () => {
    const view = await renderWithProviders(<FirstFiveCard rows={rows} username="alexr" />);
    const card = view.getByTestId('first-five-card');

    expect(card.props.collapsable).toBe(false);
    expect(StyleSheet.flatten(card.props.style)).toMatchObject(FIRST_FIVE_CARD_SIZE);
    expect(FIRST_FIVE_CARD_SIZE.width / FIRST_FIVE_CARD_SIZE.height).toBe(4 / 5);
  });

  /** An image of fixed size: a large text setting must not change the file somebody posts. */
  it('ignores the system text size', async () => {
    const view = await renderWithProviders(<FirstFiveCard rows={rows} username="alexr" />);

    const texts = view.root?.queryAll((node) => node.type === 'Text') ?? [];

    expect(texts.length).toBeGreaterThan(10);
    // A year is a span inside its title's line, so it inherits rather than sets this.
    for (const text of texts.filter((node) => !String(node.props.children).includes('\u00A0'))) {
      expect(text.props.allowFontScaling).toBe(false);
    }
  });
});

describe('sharing the image', () => {
  it('captures the card, opens the system sheet, then cleans up and closes', async () => {
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(mockShareAsync).toHaveBeenCalledTimes(1));
    expect(mockCaptureRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: 'png', result: 'tmpfile', useRenderInContext: true }),
    );
    expect(mockShareAsync).toHaveBeenCalledWith(
      'file:///cache/card.png',
      expect.objectContaining({ mimeType: 'image/png' }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockReleaseCapture).toHaveBeenCalledWith('file:///cache/card.png');
    expect(mockTrack).toHaveBeenCalledWith({ name: 'first_five_shared', props: { kind: 'image' } });
  });

  /** It is the person's list, in a cache folder, and nothing else will remove it soon. */
  it('releases the file even when the share sheet throws', async () => {
    mockShareAsync.mockRejectedValue(new Error('no'));
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(mockReleaseCapture).toHaveBeenCalledTimes(1));
  });

  it('does nothing twice when the button is pressed twice', async () => {
    let finish: () => void = () => {};
    mockShareAsync.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const view = await open();
    const share = view.getByRole('button', { name: 'Share' });

    await fireEvent.press(share);
    await waitFor(() => expect(mockShareAsync).toHaveBeenCalledTimes(1));
    await fireEvent.press(share);
    finish();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockCaptureRef).toHaveBeenCalledTimes(1);
  });

  it('closes without sharing from Not now', async () => {
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCaptureRef).not.toHaveBeenCalled();
  });
});

describe('when no image can be made', () => {
  const failed = async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(view.getByTestId('first-five-share-failed')).toBeTruthy());
    return view;
  };

  it('says so, stays open, and offers the words instead', async () => {
    mockCaptureRef.mockRejectedValue(new Error('capture failed'));
    const view = await failed();

    expect(view.getByRole('button', { name: 'Share as text' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith({ name: 'first_five_share_failed' });
  });

  it('does the same where the platform cannot share a file', async () => {
    mockIsAvailable.mockResolvedValue(false);
    await failed();

    expect(mockCaptureRef).not.toHaveBeenCalled();
  });

  it('sends the same list as a message, ending with where to start', async () => {
    mockCaptureRef.mockRejectedValue(new Error('capture failed'));
    const view = await failed();

    await fireEvent.press(view.getByRole('button', { name: 'Share as text' }));

    await waitFor(() => expect(Share.share).toHaveBeenCalledTimes(1));
    const { message } = (Share.share as jest.Mock).mock.calls[0][0] as { message: string };
    expect(message).toContain('1. The Dark Knight (2008), 10.0');
    expect(message).toContain('https://bingd.app');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockTrack).toHaveBeenCalledWith({ name: 'first_five_shared', props: { kind: 'text' } });
  });
});

describe('for a screen reader', () => {
  it('reads the list out rather than announcing an unnamed image', async () => {
    const view = await open();

    expect(view.getByLabelText(/^Preview of your First Five card\. 1, The Dark Knight/)).toBeTruthy();
  });
});
