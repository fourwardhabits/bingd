import {
  activityReaction,
  clusterKinds,
  formatCount,
  pickHighlightedReactor,
  summaryForms,
} from './reaction-summary';
import type { ReactionKind, ReactionSummary, Reactor } from './use-reactions';

/**
 * Who a post's reaction line names, and how it says it (founder, 2026-11-10).
 *
 * The founder's own ranking showed "1" beside a friend's heart. The line now says
 * "Priya likes this", and the rules below are the ones that decide which friend and
 * which words: affinity first when a score exists, then the most recent reaction, and
 * "like" only for likes.
 */

const person = (userId: string, name: string, kind: ReactionKind = 'love', reactedAt?: string): Reactor => ({
  userId,
  username: userId,
  name,
  avatarUri: null,
  kind,
  reactedAt: reactedAt ?? null,
});

const summary = (people: Reactor[], over: Partial<ReactionSummary> = {}): ReactionSummary => {
  const kinds = [...new Set(people.map((p) => p.kind))];
  return { total: people.length, mine: null, kinds, byKind: {}, people, ...over };
};

describe('whom the line names', () => {
  const priya = person('priya', 'Priya Raman', 'love', '2026-11-08T10:00:00Z');
  const theo = person('theo', 'Theo', 'love', '2026-11-09T10:00:00Z');
  const ana = person('ana', 'Ana', 'love', '2026-11-07T10:00:00Z');

  it('is the closest friend by affinity, whenever reacted', () => {
    const affinity = new Map([
      ['priya', 0.9],
      ['theo', 0.2],
    ]);
    expect(pickHighlightedReactor([theo, priya, ana], 'me', affinity)?.userId).toBe('priya');
  });

  it('breaks an affinity tie by the most recent reaction', () => {
    const affinity = new Map([
      ['priya', 0.5],
      ['ana', 0.5],
    ]);
    expect(pickHighlightedReactor([ana, priya], 'me', affinity)?.userId).toBe('priya');
  });

  it('ranks anyone with a score above anyone without one', () => {
    expect(pickHighlightedReactor([theo, ana], 'me', new Map([['ana', 0]]))?.userId).toBe('ana');
  });

  it('falls back to the most recent reaction when there is no affinity at all', () => {
    expect(pickHighlightedReactor([priya, theo, ana], 'me')?.userId).toBe('theo');
    expect(pickHighlightedReactor([priya, theo, ana], 'me', new Map())?.userId).toBe('theo');
  });

  it('agrees with itself when nothing tells two people apart', () => {
    const a = person('a-user', 'A');
    const b = person('b-user', 'B');
    expect(pickHighlightedReactor([b, a], 'me')?.userId).toBe('a-user');
    expect(pickHighlightedReactor([a, b], 'me')?.userId).toBe('a-user');
  });

  it('never names the viewer, who is "You"', () => {
    const me = person('me', 'Sai', 'love', '2026-11-10T10:00:00Z');
    expect(pickHighlightedReactor([me, ana], 'me')?.userId).toBe('ana');
    expect(pickHighlightedReactor([me], 'me')).toBeNull();
  });

  it('never names somebody without a name', () => {
    expect(pickHighlightedReactor([person('x', '  ')], 'me')).toBeNull();
  });
});

describe('what the line says', () => {
  it('names one person who liked it', () => {
    expect(summaryForms(summary([person('priya', 'Priya Raman')]), 'me')).toEqual([
      'Priya Raman likes this',
      'Priya Raman',
      'Priya likes this',
      'Priya',
      '1 like',
    ]);
  });

  it('names one and counts the rest', () => {
    const people = ['priya', 'theo', 'ana', 'kim'].map((id) => person(id, id === 'priya' ? 'Priya' : id));
    expect(summaryForms(summary(people), 'me', new Map([['priya', 1]]))).toEqual([
      'Priya and 3 others like this',
      'Priya and 3 others',
      '4 likes',
    ]);
  });

  it('says "reacted" as soon as anything but a like is present', () => {
    const people = [person('priya', 'Priya'), person('theo', 'Theo', 'funny')];
    expect(summaryForms(summary(people), 'me', new Map([['priya', 1]]))).toEqual([
      'Priya and 1 other reacted',
      'Priya and 1 other',
      '2 reactions',
    ]);
  });

  it('calls a lone laugh a reaction, not a like', () => {
    expect(summaryForms(summary([person('theo', 'Theo', 'funny')]), 'me')).toEqual([
      'Theo reacted',
      'Theo',
      '1 reaction',
    ]);
  });

  it('puts the viewer first when they reacted', () => {
    const me = person('me', 'Sai');
    expect(summaryForms(summary([me], { mine: 'love' }), 'me')).toEqual(['You like this', 'You', '1 like']);
    expect(summaryForms(summary([me, person('priya', 'Priya')], { mine: 'love' }), 'me')).toEqual([
      'You and Priya like this',
      'You and Priya',
      'You and 1 other like this',
      'You and 1 other',
      '2 likes',
    ]);
    const crowd = [me, person('priya', 'Priya'), person('theo', 'Theo'), person('ana', 'Ana')];
    expect(summaryForms(summary(crowd, { mine: 'love' }), 'me', new Map([['priya', 1]]))[0]).toBe(
      'You, Priya and 2 others like this',
    );
  });

  it('counts a reactor it cannot name without naming them', () => {
    // `reactions_read` let the row through but the profile did not resolve: counted, unnamed.
    expect(summaryForms(summary([person('priya', 'Priya')], { total: 3 }), 'me')).toEqual([
      'Priya and 2 others like this',
      'Priya and 2 others',
      '3 likes',
    ]);
    expect(summaryForms(summary([], { total: 2, kinds: ['love'] }), 'me')).toEqual(['2 likes']);
    expect(summaryForms(summary([], { total: 2, kinds: ['love'], mine: 'love' }), 'me')).toEqual([
      'You and 1 other like this',
      'You and 1 other',
      '2 likes',
    ]);
  });

  it('counts each person once: the total is the summary’s, never people plus mine', () => {
    const me = person('me', 'Sai');
    const forms = summaryForms(summary([me, person('priya', 'Priya')], { mine: 'love' }), 'me');
    expect(forms.at(-1)).toBe('2 likes');
  });

  it('says nothing for no reactions', () => {
    expect(summaryForms(summary([]), 'me')).toEqual([]);
  });

  it('keeps a large count readable', () => {
    expect(summaryForms(summary([], { total: 72, kinds: ['love'] }), 'me')).toEqual(['72 likes']);
    expect(formatCount(1)).toBe('1');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(12_345)).toBe('12K');
    expect(formatCount(2_480_000)).toBe('2.4M');
    const forms = summaryForms(summary([person('priya', 'Priya')], { total: 1235 }), 'me');
    expect(forms[0]).toBe('Priya and 1,234 others like this');
  });

  it('always ends in the shortest, nameless form', () => {
    const long = person('long', 'Maximiliana Wolfeschlegelsteinhausen-Bergerdorff');
    const forms = summaryForms(summary([long, person('b', 'B')]), 'me', new Map([['long', 1]]));
    expect(forms).toEqual([
      'Maximiliana Wolfeschlegelsteinhausen-Bergerdorff and 1 other like this',
      'Maximiliana Wolfeschlegelsteinhausen-Bergerdorff and 1 other',
      'Maximiliana and 1 other like this',
      'Maximiliana and 1 other',
      '2 likes',
    ]);
  });
});

describe('the glyphs beside it', () => {
  it('leads with the viewer’s kind, and shows three at most', () => {
    expect(clusterKinds(['love', 'funny', 'wow', 'moved'], 'moved')).toEqual(['moved', 'love', 'funny']);
    expect(clusterKinds(['love', 'funny', 'wow', 'moved'], null)).toEqual(['love', 'funny', 'wow']);
  });
});

describe('one post’s reaction props', () => {
  const handlers = { onToggle: jest.fn(), onOpenPicker: jest.fn(), onOpenDetail: jest.fn() };

  it('offers a heart on somebody else’s post', () => {
    const props = activityReaction({
      summary: summary([person('me', 'Sai', 'wow')], { mine: 'wow' }),
      viewerId: 'me',
      picker: 'PICKER',
      ...handlers,
    });
    expect(props.canReact).not.toBe(false);
    expect(props.mineGlyph).toBe('😮');
    expect(props.mineLabel).toBe('Wow');
    expect(props.onLongPress).toBe(handlers.onOpenPicker);
    expect(props.picker).toBe('PICKER');
    expect(props.summaryForms?.[0]).toBe('You reacted');
  });

  /**
   * Founder, 2026-11-11: an author can react to their own post. The builder no longer
   * knows whose post it is — there is nothing to tell apart — so the viewer's own post
   * gets the heart, the picker and the ordinary "You and …" sentence.
   */
  it('offers the heart and the picker on the viewer’s own post as well', () => {
    const props = activityReaction({
      summary: summary([person('priya', 'Priya')]),
      viewerId: 'me',
      picker: 'PICKER',
      ...handlers,
    });
    expect(props.canReact).not.toBe(false);
    expect(props.mineGlyph).toBeNull();
    expect(props.onPress).toBe(handlers.onToggle);
    expect(props.onLongPress).toBe(handlers.onOpenPicker);
    expect(props.picker).toBe('PICKER');
    expect(props.count).toBe(1);
    expect(props.summaryForms?.[0]).toBe('Priya likes this');
    expect(props.onPressSummary).toBe(handlers.onOpenDetail);
  });

  it('says "You and …" when the viewer reacted to their own post, counting them', () => {
    const props = activityReaction({
      summary: summary([person('me', 'Sai'), person('alex', 'Alex')], { mine: 'love' }),
      viewerId: 'me',
      ...handlers,
    });
    expect(props.count).toBe(2);
    expect(props.mineGlyph).toBe('❤️');
    expect(props.mineLabel).toBe('Liked');
    expect(props.summaryGlyphs).toEqual(['❤️']);
    expect(props.summaryForms?.[0]).toBe('You and Alex like this');
  });

  it('draws nothing for a post nobody has reacted to', () => {
    const props = activityReaction({ summary: undefined, viewerId: 'me', ...handlers });
    expect(props.count).toBe(0);
    expect(props.summaryForms).toEqual([]);
  });
});
