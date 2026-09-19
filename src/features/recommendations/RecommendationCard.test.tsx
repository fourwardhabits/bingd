import { fireEvent } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { attributionOf, quoted, RecommendationCard } from './RecommendationCard';
import {
  headlineOf,
  seedFromSentToYou,
  type TitleRecommendation,
} from './use-title-recommendations';
import type { SentRecommendation } from './use-sent-to-you';

/**
 * The title page's recommendation card (20260929000100, founder F1).
 *
 * The rules pinned here are the approved ones: the newest note leads, "and N others"
 * counts everybody else, a card with nobody to list is not a button, and only a note can
 * be reported — a recommendation with no words has no writing in it.
 */

const HOUR = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const rec = (overrides: Partial<TitleRecommendation> = {}): TitleRecommendation => ({
  id: 'rec-1',
  senderId: 'ada-id',
  senderUsername: 'ada',
  senderName: 'Ada',
  senderAvatarUri: null,
  message: null,
  recommendedAt: ago(48),
  openedAt: null,
  ...overrides,
});

describe('which recommendation leads', () => {
  it('leads with the newest note, even when a note-less recommendation is newer', () => {
    const rows = [
      rec({ id: 'new', senderName: 'Bo', recommendedAt: ago(1) }),
      rec({ id: 'noted', message: 'The second half is insane.', recommendedAt: ago(5) }),
    ];
    expect(headlineOf(rows)?.id).toBe('noted');
  });

  it('falls back to the newest when nobody wrote anything', () => {
    expect(headlineOf([rec({ id: 'a' }), rec({ id: 'b' })])?.id).toBe('a');
  });

  it('counts everybody else, in words', () => {
    expect(attributionOf([rec()])).toMatch(/^Ada · /);
    expect(attributionOf([rec(), rec({ id: 'b' })])).toMatch(/^Ada and 1 other · /);
    expect(attributionOf([rec(), rec({ id: 'b' }), rec({ id: 'c' })])).toMatch(
      /^Ada and 2 others · /,
    );
  });

  it('seeds the page from every Sent to you row for that title, newest first', () => {
    const sent = (id: string, mediaItemId: string, recommendedAt: string) =>
      ({
        id,
        senderId: `${id}-sender`,
        senderUsername: id,
        senderName: id,
        senderAvatarUri: null,
        mediaItemId,
        kind: 'movie',
        title: 'Film',
        seriesTitle: null,
        posterPath: null,
        year: null,
        genres: [],
        language: null,
        runtimeMinutes: null,
        recommendedAt,
        openedAt: null,
        message: null,
      }) satisfies SentRecommendation;

    const seeded = seedFromSentToYou(
      [sent('old', 'film-1', ago(9)), sent('other', 'film-2', ago(1)), sent('new', 'film-1', ago(2))],
      'film-1',
    );
    expect(seeded.map((row) => row.id)).toEqual(['new', 'old']);
  });
});

describe('the card', () => {
  it('quotes the note under the attribution', async () => {
    const view = await renderWithProviders(
      <RecommendationCard
        rows={[rec({ message: 'You have to watch this before Saturday.' })]}
        onOpenAll={jest.fn()}
        onReport={jest.fn()}
      />,
    );
    expect(view.getByTestId('recommendation-note')).toHaveTextContent(
      quoted('You have to watch this before Saturday.'),
    );
    expect(view.getByText(/^Ada · /)).toBeTruthy();
  });

  it('says "Recommended by" in one line when there is no note', async () => {
    const view = await renderWithProviders(
      <RecommendationCard rows={[rec()]} onOpenAll={jest.fn()} onReport={jest.fn()} />,
    );
    expect(view.getByText(/^Recommended by Ada · /)).toBeTruthy();
    expect(view.queryByTestId('recommendation-note')).toBeNull();
  });

  it('opens the list when several people recommended it', async () => {
    const onOpenAll = jest.fn();
    const view = await renderWithProviders(
      <RecommendationCard
        rows={[rec({ message: 'Watch it.' }), rec({ id: 'b', senderName: 'Bo' })]}
        onOpenAll={onOpenAll}
        onReport={jest.fn()}
      />,
    );
    await fireEvent.press(view.getByTestId('recommendation-card'));
    expect(onOpenAll).toHaveBeenCalledTimes(1);
  });

  it('is not a button when there is nobody else to list', async () => {
    const view = await renderWithProviders(
      <RecommendationCard rows={[rec({ message: 'Watch it.' })]} onOpenAll={jest.fn()} onReport={jest.fn()} />,
    );
    expect(view.getByTestId('recommendation-card').props.accessibilityRole).toBe('text');
  });

  it('reports the note it shows, on a long press', async () => {
    const onReport = jest.fn();
    const view = await renderWithProviders(
      <RecommendationCard
        rows={[rec({ id: 'noted', message: 'Something unkind.' })]}
        onOpenAll={jest.fn()}
        onReport={onReport}
      />,
    );
    await fireEvent(view.getByTestId('recommendation-card'), 'longPress');
    expect(onReport).toHaveBeenCalledWith('noted');
  });

  it('offers no report when there is no note to report', async () => {
    const view = await renderWithProviders(
      <RecommendationCard rows={[rec()]} onOpenAll={jest.fn()} onReport={jest.fn()} />,
    );
    const card = view.getByTestId('recommendation-card');
    expect(card.props.accessibilityActions).toBeUndefined();
    expect(card.props.onLongPress).toBeUndefined();
  });
});
