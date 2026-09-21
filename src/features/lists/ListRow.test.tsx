import { renderWithProviders } from '@/test-utils/render';

import { ListRow } from './ListRow';
import { coverLayout, ListCover } from './ListCover';
import type { MyListSummary } from './types';

/**
 * The My lists row, and the cover it carries.
 *
 * The row contract is §I's: **one row, three facts, no controls.** Each of the three
 * assertions below is a thing that was decided rather than a thing that happened —
 * `Numbered` appears only when the list is, the chip is a word and not a bare glyph, and
 * `Updated <date>` is line three because it is also the sort key.
 */

const summary = (over: Partial<MyListSummary> = {}): MyListSummary => ({
  id: 'a',
  title: 'Best breakup movies',
  itemCount: 14,
  orderStyle: 'unranked',
  visibility: 'private',
  hidden: false,
  updatedAt: '2026-09-12T10:00:00Z',
  posterUris: [],
  ...over,
});

const open = (list: MyListSummary) =>
  renderWithProviders(<ListRow list={list} onPress={() => {}} />);

/**
 * The cover's own elements, which are **deliberately hidden from assistive technology**.
 *
 * Every fact a cover carries is in the text beside it, and a screen reader meeting four
 * unlabelled images before the list's name would be meeting the row's least useful part
 * first. RNTL honours `accessibilityElementsHidden` by default, so finding them at all
 * needs `includeHiddenElements` — and that this is necessary is itself the assertion
 * that the cover is hidden.
 */
const hidden = (
  view: Awaited<ReturnType<typeof renderWithProviders>>,
  testID: string,
) => view.queryAllByTestId(testID, { includeHiddenElements: true });

describe('the row', () => {
  it('names the list, counts it, and dates it', async () => {
    const view = await open(summary());
    view.getByText('Best breakup movies');
    view.getByText('14 titles');
    view.getByText(/^Updated /);
  });

  it('says Numbered only when the list is', async () => {
    const plain = await open(summary());
    expect(plain.queryByText('Numbered')).toBeNull();

    const numbered = await open(summary({ orderStyle: 'ranked' }));
    numbered.getByText('Numbered');
  });

  it('draws the visibility as a word, never a bare glyph', async () => {
    // §I. A padlock beside a list name could mean private, locked or spoiler-hidden;
    // the three words are the picker's own, so the chip is recognisable as the choice.
    for (const [visibility, word] of [
      ['private', 'Only you'],
      ['link', 'Anyone with the link'],
      ['public', 'Public'],
    ] as const) {
      const view = await open(summary({ visibility }));
      view.getByText(word);
    }
  });

  it('says a moderation-hidden list is hidden, in place of its mode', async () => {
    const view = await open(summary({ visibility: 'public', hidden: true }));
    view.getByText('Hidden');
    expect(view.queryByText('Public')).toBeNull();
  });

  it('carries no controls at all', async () => {
    // No swipe-to-delete, no overflow, no long press (§D, §Q.6). The row is one button.
    const view = await open(summary());
    expect(view.getAllByRole('button')).toHaveLength(1);
  });

  it('is spoken as one sentence rather than as four results', async () => {
    const view = await open(summary({ orderStyle: 'ranked', visibility: 'link' }));
    view.getByLabelText('Best breakup movies. 14 titles. Numbered. Anyone with the link. Updated Sep 12');
  });
});

describe('the cover (founder QA, 2026-09-21)', () => {
  const uris = (n: number) => Array.from({ length: n }, (_, i) => `https://x/${i + 1}.jpg`);

  it('picks the layout from the poster count', () => {
    expect(coverLayout(0)).toBe('empty');
    expect(coverLayout(1)).toBe('single');
    expect(coverLayout(3)).toBe('single');
    expect(coverLayout(4)).toBe('mosaic');
    expect(coverLayout(9)).toBe('mosaic');
  });

  it('draws one to three posters as the first poster, full cover', async () => {
    const view = await renderWithProviders(<ListCover posterUris={uris(3)} size={64} />);
    expect(hidden(view, 'list-cover-poster')).toHaveLength(1);
    expect(hidden(view, 'list-cover-empty')).toHaveLength(0);
  });

  it('draws four or more as a 2×2 mosaic of the first four', async () => {
    const view = await renderWithProviders(<ListCover posterUris={uris(5)} size={64} />);
    expect(hidden(view, 'list-cover-poster')).toHaveLength(4);
  });

  it('draws a neutral placeholder for a list with nothing in it', async () => {
    const view = await renderWithProviders(<ListCover posterUris={[]} size={64} />);
    expect(hidden(view, 'list-cover-empty')).toHaveLength(1);
    expect(hidden(view, 'list-cover-poster')).toHaveLength(0);
    // Still a shape: a transparent square would leave the row's lines unattached.
    expect(hidden(view, 'list-cover')).toHaveLength(1);
  });
});
