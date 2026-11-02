import { bandSizes, formatScore, scoreFor, type Bucket } from '@/features/collection/score';
import type { RankedEntry } from '@/features/collection/use-collection';

/**
 * Where a person who receives the card can start. The home page, because it carries the
 * ranking demo and both store buttons. Not an invite link: a card is posted to strangers
 * as often as it is sent to a friend, and a personal invite in a public post would attach
 * every stranger who used it to the sender.
 */
export const FIRST_FIVE_SHARE_URL = 'https://bingd.app';

export type FirstFiveRow = {
  mediaItemId: string;
  /** 1 to 5, the reader's own order. */
  rank: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  score: number;
  bucket: Bucket;
};

/**
 * The reader's first five, as the payoff and the share card both draw them.
 *
 * One derivation for both surfaces, so a shared image cannot disagree with the screen it
 * was shared from. Band sizes come from the whole list and not from the five rows: a score
 * is a position within a band, so counting only the rows drawn would change the number.
 */
export function firstFiveRows(entries: readonly RankedEntry[], count: number): FirstFiveRow[] {
  const sizes = bandSizes(entries);

  return [...entries]
    .sort((a, b) => a.position - b.position)
    .slice(0, count)
    .map((entry, index) => ({
      mediaItemId: entry.mediaItemId,
      rank: index + 1,
      title: entry.title,
      year: entry.year,
      posterPath: entry.posterPath,
      score: scoreFor(entry.bucket, entry.position, sizes),
      bucket: entry.bucket,
    }));
}

/**
 * The same list as words, for when no image can be made.
 *
 * Written as a message rather than a report, because the person reading it did not ask
 * for it and may never have heard of bingd.
 */
export function firstFiveMessage(rows: readonly FirstFiveRow[]): string {
  const lines = rows.map((row) => {
    const year = row.year ? ` (${row.year})` : '';
    return `${row.rank}. ${row.title}${year}, ${formatScore(row.score)}`;
  });

  return [
    'My First Five on bingd',
    '',
    ...lines,
    '',
    `What’s your first five? Rank yours free: ${FIRST_FIVE_SHARE_URL}`,
  ].join('\n');
}

/** What a screen reader hears for the preview, which is an image in every other sense. */
export function firstFiveSpokenSummary(rows: readonly FirstFiveRow[]): string {
  const spoken = rows
    .map((row) => `${row.rank}, ${row.title}, ${formatScore(row.score)}`)
    .join('. ');
  return `Preview of your First Five card. ${spoken}.`;
}
