import {
  titleCountLabel,
  updatedLabel,
  VISIBILITY_CHIP,
  VISIBILITY_OPTION,
} from './types';
import { bulkWatchlistMessage } from './writes';
import { linkConsentBody } from './VisibilityPicker';
import { listShareMessage, listUrl } from './share';

/**
 * The strings, tested rather than inspected.
 *
 * Every one of these is a sentence the PRD is specific about, and every one is a place
 * where "near enough" is a different product: "my Watchlist" rather than "Watchlist" is
 * the §H boundary restated where a reader is standing, and the private-profile line in
 * the link consent copy is either true and reassuring or a promise the product is not
 * making, depending on one boolean.
 */

describe('updatedLabel', () => {
  const now = new Date('2026-09-20T12:00:00Z');

  it('says today, yesterday, then a date', () => {
    expect(updatedLabel('2026-09-20T09:00:00Z', now)).toBe('Updated today');
    expect(updatedLabel('2026-09-19T09:00:00Z', now)).toBe('Updated yesterday');
    expect(updatedLabel('2026-09-12T09:00:00Z', now)).toMatch(/^Updated Sep 12$/);
  });

  it('adds the year only when it is not this one', () => {
    // A year on every row is noise on the ninety-nine per cent of lists touched this
    // year, and its absence is what makes its presence mean something.
    expect(updatedLabel('2025-09-12T09:00:00Z', now)).toMatch(/2025/);
    expect(updatedLabel('2026-09-12T09:00:00Z', now)).not.toMatch(/2026/);
  });

  it('answers with nothing for a date it cannot read', () => {
    expect(updatedLabel('not a date', now)).toBe('');
  });
});

describe('titleCountLabel', () => {
  it('singularises, and names the empty list rather than saying zero', () => {
    expect(titleCountLabel(0)).toBe('No titles yet');
    expect(titleCountLabel(1)).toBe('1 title');
    expect(titleCountLabel(14)).toBe('14 titles');
  });
});

describe('the visibility vocabulary', () => {
  it('uses the picker’s own words, shortened, for the chips', () => {
    // §I: the chip has to be recognisable as the choice that was made, which is only
    // possible if it speaks the picker's language.
    expect(VISIBILITY_CHIP).toEqual({
      private: 'Only you',
      link: 'Link',
      public: 'Profile',
    });
    expect(VISIBILITY_OPTION.private).toBe('Only you');
    expect(VISIBILITY_OPTION.link).toBe('Anyone with the link');
    expect(VISIBILITY_OPTION.public).toBe('On your profile');
  });
});

describe('the link consent copy', () => {
  it('always leads with what the link grants', () => {
    expect(linkConsentBody(false)).toContain('Anyone with this link can view this list.');
    expect(linkConsentBody(true)).toContain('Anyone with this link can view this list.');
  });

  it('adds the reassurance only for a private profile, where it is true', () => {
    // On a public profile "they won't see your profile" would be said to somebody whose
    // profile anybody can already open — a promise the product is not making (§F.5).
    expect(linkConsentBody(true)).toContain("They won't see your profile");
    expect(linkConsentBody(false)).not.toContain("They won't see your profile");
  });
});

describe('the bulk watchlist confirmation', () => {
  it('names the number added', () => {
    expect(bulkWatchlistMessage({ added: 9, skippedSeen: 0 })).toBe(
      'Added 9 to your Watchlist.',
    );
  });

  it('mentions skipped titles only when something was skipped', () => {
    // "5 you've seen were skipped" under a list nobody has seen any of is a fact about
    // nothing.
    expect(bulkWatchlistMessage({ added: 9, skippedSeen: 5 })).toBe(
      "Added 9 to your Watchlist. 5 you've seen were skipped.",
    );
    expect(bulkWatchlistMessage({ added: 9, skippedSeen: 1 })).toBe(
      "Added 9 to your Watchlist. 1 you've seen was skipped.",
    );
  });

  it('says so plainly when there was nothing new', () => {
    expect(bulkWatchlistMessage({ added: 0, skippedSeen: 0 })).toBe('Nothing new to add.');
  });
});

describe('the share URL', () => {
  const id = '0f9c1e2a-3b4c-4d5e-8f60-112233445566';

  it('is the address AASA and assetlinks already claim', () => {
    expect(listUrl(id)).toBe(`https://bingd.app/lists/${id}`);
  });

  it('sends the title and the link, and not the description', () => {
    // A description can be a thousand characters, and a share body is not the place to
    // find that out.
    expect(listShareMessage('Best breakup movies', id)).toBe(
      `Best breakup movies on bingd\nhttps://bingd.app/lists/${id}`,
    );
  });
});
