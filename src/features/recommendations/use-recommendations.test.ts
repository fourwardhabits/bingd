import { shelvesFrom, type Recommendation, type Slate } from './use-recommendations';

const item = (rank: number, title: string, evidence: Recommendation['evidence']): Recommendation => ({
  mediaItemId: `id-${rank}`,
  rank,
  title,
  year: 2010,
  posterPath: null,
  evidence,
});

const slate = (...items: Recommendation[]): Slate => ({
  generatedAt: '2026-08-15T00:00:00Z',
  items,
});

/**
 * The grouping is where PRD §13's explanation-integrity requirement is actually
 * enforced on the client: a reason that cannot be stated is a recommendation
 * that is not shown.
 */
describe('shelvesFrom', () => {
  it('turns each distinct reason into a shelf', () => {
    const shelves = shelvesFrom(
      slate(
        item(1, 'Inception', { kind: 'content', because_title: 'Memento' }),
        item(2, 'Dune', { kind: 'fresh' }),
        item(3, 'Tenet', { kind: 'content', because_title: 'Memento' }),
      ),
    );

    expect(shelves.map((s) => s.title)).toEqual([
      'Because you loved Memento',
      'New this month',
    ]);
    expect(shelves[0]?.items).toHaveLength(2);
  });

  it('orders shelves by the strongest recommendation in each', () => {
    // Slate rank order, so the shelf containing the best recommendation leads.
    const shelves = shelvesFrom(
      slate(
        item(1, 'Dune', { kind: 'fresh' }),
        item(2, 'Inception', { kind: 'content', because_title: 'Memento' }),
      ),
    );

    expect(shelves[0]?.title).toBe('New this month');
  });

  it('counts endorsers rather than claiming a crowd', () => {
    const one = shelvesFrom(slate(item(1, 'Dune', { kind: 'social', endorser_count: 1 })));
    expect(one[0]?.title).toBe('Someone with similar taste loved this');

    const many = shelvesFrom(slate(item(1, 'Dune', { kind: 'social', endorser_count: 4 })));
    expect(many[0]?.title).toBe('4 people with similar taste loved this');
  });

  it('drops a recommendation whose reason cannot be stated', () => {
    // The alternative is a "Recommended for you" shelf, which is exactly the
    // unfalsifiable label PRD §13 exists to forbid. A slate is worth less than
    // the credibility of the entries that can explain themselves.
    const shelves = shelvesFrom(
      slate(
        // Content evidence with no title to point at.
        item(1, 'Dune', { kind: 'content' }),
        // A count of nobody.
        item(2, 'Alien', { kind: 'social', endorser_count: 0 }),
        item(3, 'Tenet', { kind: 'fresh' }),
      ),
    );

    expect(shelves).toHaveLength(1);
    expect(shelves[0]?.title).toBe('New this month');
  });

  it('does not dress a curated reason as a social one', () => {
    const shelves = shelvesFrom(slate(item(1, 'Dune', { kind: 'curated' })));
    expect(shelves[0]?.title).toBe('A good place to start');
  });

  it('survives evidence in a shape it does not know', () => {
    // `evidence` is jsonb written by a builder that ships separately from this
    // client, so an unknown kind is a version skew, not a crash.
    const shelves = shelvesFrom(
      slate(item(1, 'Dune', { kind: 'invented_later' } as unknown as Recommendation['evidence'])),
    );

    expect(shelves).toEqual([]);
  });

  it('has no shelves before there is a slate', () => {
    expect(shelvesFrom(null)).toEqual([]);
    expect(shelvesFrom(undefined)).toEqual([]);
  });
});
