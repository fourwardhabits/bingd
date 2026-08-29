import { applyMention, handlesIn, mentionFragment, resolveMentions } from './mentions';

/**
 * The text model behind @mentions.
 *
 * Pure, and tested apart from the composer, because the ways this goes wrong are all
 * about *boundaries* — where a handle starts, where it ends, and when the suggestion
 * list should stop being open — and each of those is a one-character question that a
 * rendering test would hide inside a keystroke.
 */

describe('mentionFragment', () => {
  it('opens on the @ itself, before anything is typed', () => {
    expect(mentionFragment('hey @', 5)).toEqual({ start: 4, query: '' });
  });

  it('reads the fragment as it grows', () => {
    expect(mentionFragment('hey @rav', 8)).toEqual({ start: 4, query: 'rav' });
  });

  it('opens at the very start of the text', () => {
    expect(mentionFragment('@ra', 3)).toEqual({ start: 0, query: 'ra' });
  });

  /**
   * The rule that stops an email address becoming a mention. It is also what makes a
   * handle inside a word — `me@you` — ordinary text.
   */
  it('needs whitespace before the @', () => {
    expect(mentionFragment('mail me@ravi', 12)).toBeNull();
  });

  it('closes on a space', () => {
    expect(mentionFragment('hey @ravi ', 10)).toBeNull();
  });

  /**
   * The cursor has to be at the end of the run. Moving back into finished text should
   * dismiss the list rather than leave it hovering over a name nobody is editing.
   */
  it('closes when the cursor moves away from the fragment', () => {
    const text = 'hey @ravi great';
    expect(mentionFragment(text, 9)).toEqual({ start: 4, query: 'ravi' });
    expect(mentionFragment(text, 15)).toBeNull();
  });

  it('takes the last @ when there are several', () => {
    expect(mentionFragment('@ravi and @abi', 14)).toEqual({ start: 10, query: 'abi' });
  });

  it('gives up past the longest a handle can be', () => {
    expect(mentionFragment(`@${'a'.repeat(25)}`, 26)).toBeNull();
  });

  it('is null for a cursor outside the text', () => {
    expect(mentionFragment('hey', 9)).toBeNull();
    expect(mentionFragment('hey', -1)).toBeNull();
  });
});

describe('applyMention', () => {
  it('replaces the fragment and leaves the cursor after a trailing space', () => {
    const result = applyMention('hey @rav', { start: 4, query: 'rav' }, 'ravi');
    expect(result.text).toBe('hey @ravi ');
    expect(result.cursor).toBe(10);
  });

  it('keeps the tail of a sentence being edited in the middle', () => {
    const result = applyMention('hey @rav great film', { start: 4, query: 'rav' }, 'ravi');
    expect(result.text).toBe('hey @ravi great film');
    expect(result.cursor).toBe(10);
  });

  it('does not double the space when one is already there', () => {
    const result = applyMention('@ra done', { start: 0, query: 'ra' }, 'ravi');
    expect(result.text).toBe('@ravi done');
  });

  it('works from a bare @', () => {
    expect(applyMention('hey @', { start: 4, query: '' }, 'ravi').text).toBe('hey @ravi ');
  });

  /** Inserting a handle must not leave the fragment live, or the list reopens on itself. */
  it('leaves no live fragment behind it', () => {
    const { text, cursor } = applyMention('hey @rav', { start: 4, query: 'rav' }, 'ravi');
    expect(mentionFragment(text, cursor)).toBeNull();
  });
});

describe('handlesIn', () => {
  it('finds one, several, and neither twice', () => {
    expect(handlesIn('@ravi hi')).toEqual(['ravi']);
    expect(handlesIn('@ravi and @abisola').sort()).toEqual(['abisola', 'ravi']);
    expect(handlesIn('@ravi @ravi')).toEqual(['ravi']);
  });

  it('ends the handle where the charset does', () => {
    expect(handlesIn('thanks @ravi.')).toEqual(['ravi']);
    expect(handlesIn('@ravi, @abisola!').sort()).toEqual(['abisola', 'ravi']);
  });

  it('ignores an @ inside a word', () => {
    expect(handlesIn('write to me@ravi')).toEqual([]);
  });

  it('ignores something too short to be a handle', () => {
    expect(handlesIn('@ab hi')).toEqual([]);
  });

  it('folds case, because the database stores handles lowercase', () => {
    expect(handlesIn('@Ravi')).toEqual(['ravi']);
  });

  /**
   * The trailing boundary, found by independent review 68.
   *
   * A handle is at most 24 characters, so a 24-character name followed by another handle
   * character used to match its first 24 and resolve to that person — the author typed
   * past the name and it counted anyway. It is the one place the length bound and the
   * boundary rule meet, and it only bites at exactly the maximum.
   */
  it('does not match a maximum-length handle that the text runs past', () => {
    const max = 'a'.repeat(24);
    expect(handlesIn(`@${max}`)).toEqual([max]);
    expect(handlesIn(`@${max}x`)).toEqual([]);
  });

  it('does not match a short handle that the text runs past either', () => {
    // Already true before the lookahead — `{3,24}` is greedy — but asserted so the two
    // cases are one rule rather than two behaviours that happen to agree.
    expect(handlesIn('@ravindra')).toEqual(['ravindra']);
  });
});

describe('resolveMentions', () => {
  const known = new Map([
    ['ravi', 'id-ravi'],
    ['abisola', 'id-abisola'],
  ]);

  it('sends the ids for handles still in the text', () => {
    expect(resolveMentions('@ravi great', known)).toEqual(['id-ravi']);
  });

  /**
   * The rule that keeps this client from ever looking a stranger up. A handle nobody
   * picked has no id, so it is ordinary text and notifies nobody.
   */
  it('drops a handle that was never chosen from the suggestions', () => {
    expect(resolveMentions('@nobody hello', known)).toEqual([]);
  });

  /** Deleting the handle is how a mention is removed. There is no second gesture. */
  it('drops somebody picked and then deleted from the text', () => {
    expect(resolveMentions('great film', known)).toEqual([]);
  });

  it('handles several, once each', () => {
    expect(resolveMentions('@ravi @abisola @ravi', known).sort()).toEqual([
      'id-abisola',
      'id-ravi',
    ]);
  });
});
