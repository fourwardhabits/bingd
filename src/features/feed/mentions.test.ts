import {
  applyMention,
  handlesIn,
  mentionFragment,
  resolveMentions,
  segmentMentions,
} from './mentions';

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

/**
 * What a finished comment looks like on screen — the half the founder could see was
 * missing, because a mention that worked and a mention that did not were the same glyphs.
 *
 * The population is deliberately `activity_comments.mentions`, never a re-parse: the
 * server has already decided who this comment names and which of them this reader may be
 * shown, so the only question left here is where in the string those names sit.
 */
describe('segmentMentions', () => {
  const ravi = { id: 'id-ravi', username: 'ravi', handle: 'ravi' };
  const abisola = { id: 'id-abisola', username: 'abisola', handle: 'abisola' };

  /** Joining the spans back must reproduce the body exactly, or something is lost. */
  const rejoin = (text: string, mentions: Parameters<typeof segmentMentions>[1]) =>
    segmentMentions(text, mentions)
      .map((span) => span.text)
      .join('');

  it('lifts one name out of a sentence and leaves the rest alone', () => {
    expect(segmentMentions('@ravi thoughts?', [ravi])).toEqual([
      { kind: 'mention', text: '@ravi', id: 'id-ravi', username: 'ravi' },
      { kind: 'text', text: ' thoughts?' },
    ]);
  });

  it('ends the name where the handle charset does, not at the punctuation', () => {
    expect(segmentMentions('ask @ravi.', [ravi])).toEqual([
      { kind: 'text', text: 'ask ' },
      { kind: 'mention', text: '@ravi', id: 'id-ravi', username: 'ravi' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('links the same person twice when the body names them twice', () => {
    const spans = segmentMentions('@ravi and @ravi again', [ravi]);
    expect(spans.filter((span) => span.kind === 'mention')).toHaveLength(2);
    expect(rejoin('@ravi and @ravi again', [ravi])).toBe('@ravi and @ravi again');
  });

  it('links several distinct people in one body', () => {
    const spans = segmentMentions('@ravi @abisola both', [ravi, abisola]);
    expect(spans.filter((span) => span.kind === 'mention').map((span) => span.text)).toEqual([
      '@ravi',
      '@abisola',
    ]);
  });

  /**
   * The whole of the safety argument, in one assertion. A handle the server did not
   * confirm — nobody by that name, somebody this reader has blocked, a tombstone that
   * reports no mentions at all — is prose, and prose is what it is drawn as.
   */
  it('leaves an unconfirmed handle as ordinary text', () => {
    expect(segmentMentions('@stranger hello', [ravi])).toEqual([
      { kind: 'text', text: '@stranger hello' },
    ]);
  });

  it('draws nothing as a link when the comment names nobody', () => {
    expect(segmentMentions('@ravi thoughts?', [])).toEqual([
      { kind: 'text', text: '@ravi thoughts?' },
    ]);
  });

  /** An email address is not a mention, here for the same reason it is not one upstream. */
  it('does not lift a handle out of an email address', () => {
    const confirmed = { id: 'id-example', username: 'example', handle: 'example' };
    expect(segmentMentions('mail me@example.com', [confirmed])).toEqual([
      { kind: 'text', text: 'mail me@example.com' },
    ]);
  });

  /**
   * The rename case, and it is the reason the ledger carries two spellings. The body
   * still says `@ravi`, so `@ravi` is what lights up — but the tap has to reach the
   * person, who is called something else now.
   */
  it('lights up the frozen spelling and navigates to the current one', () => {
    expect(segmentMentions('@ravi thoughts?', [{ id: 'id-ravi', username: 'ravi_2', handle: 'ravi' }])).toEqual([
      { kind: 'mention', text: '@ravi', id: 'id-ravi', username: 'ravi_2' },
      { kind: 'text', text: ' thoughts?' },
    ]);
  });

  it('matches whatever case the author typed', () => {
    expect(segmentMentions('@Ravi thoughts?', [ravi])[0]).toEqual({
      kind: 'mention',
      text: '@Ravi',
      id: 'id-ravi',
      username: 'ravi',
    });
  });

  /**
   * A body is a paragraph, not a line. The spans have to survive newlines untouched, or
   * a mention on the second line of a comment would silently swallow the break before it.
   */
  it('keeps a name on a later line, and the break before it', () => {
    const body = ['first line', '@ravi second'].join('\n');
    expect(segmentMentions(body, [ravi])).toEqual([
      { kind: 'text', text: 'first line\n' },
      { kind: 'mention', text: '@ravi', id: 'id-ravi', username: 'ravi' },
      { kind: 'text', text: ' second' },
    ]);
  });

  it('reproduces the body exactly, whatever it contains', () => {
    for (const body of [
      '@ravi',
      '@@ravi',
      'a @ravi b @abisola c',
      '@ @ @@ @ra @ravi',
      'ends on a name @ravi',
      '  @ravi  ',
    ]) {
      expect(rejoin(body, [ravi, abisola])).toBe(body);
    }
  });

  it('does not crash on malformed or empty text', () => {
    expect(segmentMentions('', [ravi])).toEqual([]);
    expect(segmentMentions('@', [ravi])).toEqual([{ kind: 'text', text: '@' }]);
    expect(segmentMentions('@@@@', [ravi])).toEqual([{ kind: 'text', text: '@@@@' }]);
  });

  /** A ledger row with no frozen spelling is what a pre-20260830000100 row looks like. */
  it('works from the current handle alone when no frozen spelling was stored', () => {
    expect(segmentMentions('@ravi hi', [{ id: 'id-ravi', username: 'ravi', handle: null }])[0]).toMatchObject({
      kind: 'mention',
      id: 'id-ravi',
    });
  });
});
