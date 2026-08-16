import {
  buildSlate,
  CONFIDENT_AT,
  diversify,
  headlineFor,
  scoreCandidate,
  tasteFrom,
  type Anchor,
  type Candidate,
  type Taste,
} from './rank';

/**
 * For You, V1.
 *
 * The decision named three failures by name — twenty sequels from one rating,
 * overfitting one favourite, and generic Trending presented as personalised — so most
 * of what is tested here is that those three cannot happen, rather than that a
 * plausible list comes out.
 */

const candidate = (over: Partial<Candidate> & { mediaItemId: string }): Candidate => ({
  title: over.mediaItemId,
  year: 2024,
  posterPath: null,
  kind: 'movie',
  genres: ['Drama'],
  language: 'en',
  popularity: 10,
  ...over,
});

const anchor = (over: Partial<Anchor> & { mediaItemId: string }): Anchor => ({
  title: over.mediaItemId,
  score: 9,
  similarIds: [],
  ...over,
});

const emptyTaste: Taste = { genres: new Map(), languages: new Map(), sampleSize: 0 };

const scoreOf = (id: string, slate: { mediaItemId: string; explanation: { total: number } }[]) =>
  slate.find((item) => item.mediaItemId === id)?.explanation.total ?? 0;

describe('taste from your own rankings', () => {
  it('weights a genre by how highly you scored the films in it', () => {
    const taste = tasteFrom([
      { score: 9.5, genres: ['Sci-fi'], language: 'en' },
      { score: 2, genres: ['Horror'], language: 'en' },
    ]);

    expect(taste.genres.get('Sci-fi')).toBe(1);
    expect(taste.genres.get('Horror')!).toBeLessThan(0.5);
  });

  it('never gives a genre negative affinity', () => {
    // A handful of rankings and a subtraction rule is one bad night out from
    // excluding a genre entirely, and the user can never see why.
    const taste = tasteFrom([{ score: 0, genres: ['Horror'], language: 'en' }]);

    expect(taste.genres.get('Horror')!).toBeGreaterThan(0);
  });

  it('is on the same scale for six rankings and for forty', () => {
    const few = tasteFrom([{ score: 9, genres: ['Drama'], language: 'en' }]);
    const many = tasteFrom(
      Array.from({ length: 40 }, () => ({ score: 9, genres: ['Drama'], language: 'en' })),
    );

    expect(few.genres.get('Drama')).toBe(1);
    expect(many.genres.get('Drama')).toBe(1);
  });

  it('has nothing to say about someone who has ranked nothing', () => {
    const taste = tasteFrom([]);

    expect(taste.genres.size).toBe(0);
    expect(taste.sampleSize).toBe(0);
  });
});

describe('scoring one candidate', () => {
  it('rewards a title an anchor is associated with', () => {
    const anchors = [anchor({ mediaItemId: 'inception', similarIds: ['tenet'] })];

    expect(scoreCandidate(candidate({ mediaItemId: 'tenet' }), anchors, emptyTaste).explanation.total)
      .toBeGreaterThan(
        scoreCandidate(candidate({ mediaItemId: 'other' }), anchors, emptyTaste).explanation.total,
      );
  });

  it('rewards the first association more than the twentieth', () => {
    const ids = Array.from({ length: 20 }, (_, index) => `film-${index}`);
    const anchors = [anchor({ mediaItemId: 'a', similarIds: ids })];

    const first = scoreCandidate(candidate({ mediaItemId: 'film-0' }), anchors, emptyTaste);
    const last = scoreCandidate(candidate({ mediaItemId: 'film-19' }), anchors, emptyTaste);

    expect(first.explanation.total).toBeGreaterThan(last.explanation.total);
  });

  it('rewards two anchors agreeing over one anchor insisting', () => {
    const agreed = scoreCandidate(
      candidate({ mediaItemId: 'x' }),
      [
        anchor({ mediaItemId: 'a', similarIds: ['pad', 'x'] }),
        anchor({ mediaItemId: 'b', similarIds: ['pad', 'x'] }),
      ],
      emptyTaste,
    );
    const insisted = scoreCandidate(
      candidate({ mediaItemId: 'x' }),
      [anchor({ mediaItemId: 'a', similarIds: ['x'] })],
      emptyTaste,
    );

    expect(agreed.explanation.total).toBeGreaterThan(insisted.explanation.total);
    expect(agreed.explanation.anchors).toHaveLength(2);
  });

  it('cannot be driven arbitrarily high by piling on anchors', () => {
    // The unbounded-sum failure. Twenty anchors all pointing at one franchise entry
    // must not let it out-score everything by a factor of twenty.
    const many = Array.from({ length: 20 }, (_, index) =>
      anchor({ mediaItemId: `a-${index}`, similarIds: ['x'] }),
    );

    const scored = scoreCandidate(candidate({ mediaItemId: 'x' }), many, emptyTaste);

    expect(scored.explanation.total).toBeLessThanOrEqual(1);
  });

  it('takes the strongest genre match rather than the average', () => {
    const taste = tasteFrom([{ score: 10, genres: ['Sci-fi'], language: 'en' }]);
    const mixed = scoreCandidate(
      candidate({ mediaItemId: 'x', genres: ['Sci-fi', 'Documentary', 'Musical'] }),
      [],
      taste,
    );

    expect(mixed.explanation.genre).toEqual({ genre: 'Sci-fi', affinity: 1 });
  });

  it('bounds the popularity prior so an outlier cannot flatten the rest', () => {
    const huge = scoreCandidate(candidate({ mediaItemId: 'x', popularity: 50_000 }), [], emptyTaste);
    const big = scoreCandidate(candidate({ mediaItemId: 'y', popularity: 500 }), [], emptyTaste);

    expect(huge.explanation.popularity).toBe(1);
    expect(big.explanation.popularity).toBe(1);
  });
});

describe('what a recommendation is allowed to claim', () => {
  it('does not say "because you loved" about a title that scored on popularity', () => {
    // The claim has to follow the arithmetic. This is the whole mechanism: `lead` is
    // read off the weighted terms, so a sentence cannot outrun the score.
    const scored = scoreCandidate(candidate({ mediaItemId: 'x', popularity: 400 }), [], emptyTaste);

    expect(scored.explanation.lead).toBe('popular');
    expect(headlineFor(scored.explanation, emptyTaste, (code) => code)).toBe('Popular right now');
  });

  it('names the film when an anchor carried it', () => {
    const anchors = [anchor({ mediaItemId: 'inception', title: 'Inception', similarIds: ['x'] })];
    const scored = scoreCandidate(candidate({ mediaItemId: 'x', popularity: 1 }), anchors, emptyTaste);

    expect(scored.explanation.lead).toBe('anchors');
    expect(headlineFor(scored.explanation, emptyTaste, (code) => code)).toBe(
      'Because you loved Inception',
    );
  });

  it('names both films when two anchors agreed', () => {
    const anchors = [
      anchor({ mediaItemId: 'a', title: 'Arrival', similarIds: ['x'] }),
      anchor({ mediaItemId: 'b', title: 'Blade Runner 2049', similarIds: ['x'] }),
    ];
    const scored = scoreCandidate(candidate({ mediaItemId: 'x', popularity: 1 }), anchors, emptyTaste);

    expect(headlineFor(scored.explanation, emptyTaste, (code) => code)).toBe(
      'Because you loved Arrival and Blade Runner 2049',
    );
  });

  it('will not assert a taste built from two films', () => {
    const thin: Taste = {
      genres: new Map([['Drama', 1]]),
      languages: new Map(),
      sampleSize: CONFIDENT_AT - 1,
    };
    const scored = scoreCandidate(candidate({ mediaItemId: 'x', popularity: 0 }), [], thin);

    expect(scored.explanation.lead).toBe('genre');
    // The signal is real but the sample is not worth a sentence, so it falls back to
    // the weaker true claim rather than telling somebody what they like.
    expect(headlineFor(scored.explanation, thin, (code) => code)).toBe('Popular right now');
  });

  it('asserts it once there is enough of it', () => {
    const confident: Taste = {
      genres: new Map([['Drama', 1]]),
      languages: new Map(),
      sampleSize: CONFIDENT_AT,
    };
    const scored = scoreCandidate(candidate({ mediaItemId: 'x', popularity: 0 }), [], confident);

    expect(headlineFor(scored.explanation, confident, (code) => code)).toBe(
      'More drama, which you rank highly',
    );
  });
});

describe('eligibility', () => {
  it('never recommends something already in the collection', () => {
    const slate = buildSlate({
      candidates: [candidate({ mediaItemId: 'seen' }), candidate({ mediaItemId: 'new' })],
      anchors: [],
      taste: emptyTaste,
      exclude: new Set(['seen']),
    });

    expect(slate.map((item) => item.mediaItemId)).toEqual(['new']);
  });

  it('never recommends an anchor back to the person it came from', () => {
    const slate = buildSlate({
      candidates: [candidate({ mediaItemId: 'inception' })],
      anchors: [anchor({ mediaItemId: 'inception', similarIds: [] })],
      taste: emptyTaste,
      exclude: new Set(),
    });

    expect(slate).toEqual([]);
  });

  it('shows one poster for a title several anchors suggested', () => {
    const slate = buildSlate({
      candidates: [candidate({ mediaItemId: 'x' }), candidate({ mediaItemId: 'x' })],
      anchors: [],
      taste: emptyTaste,
      exclude: new Set(),
    });

    expect(slate).toHaveLength(1);
  });
});

describe('diversity', () => {
  const scoredRun = (count: number, over: (index: number) => Partial<Candidate>) =>
    Array.from({ length: count }, (_, index) =>
      scoreCandidate(
        candidate({ mediaItemId: `m-${index}`, popularity: 100 - index, ...over(index) }),
        [],
        emptyTaste,
      ),
    );

  it('will not fill a slate with one genre when there is anything else', () => {
    const scored = [
      ...scoredRun(20, () => ({ genres: ['Action'] })),
      ...scoredRun(10, (index) => ({ genres: ['Drama'], popularity: 50 - index })).map((item) => ({
        ...item,
        mediaItemId: `d-${item.mediaItemId}`,
      })),
    ];

    const slate = diversify(scored, 10);

    // Four of ten is the ceiling, and the twenty Action titles all out-score every
    // Drama one — so without the constraint the wall would be Action end to end.
    expect(slate.filter((item) => item.genres[0] === 'Action')).toHaveLength(4);
    expect(slate.filter((item) => item.genres[0] === 'Drama')).toHaveLength(4);
    // Two genres cannot fill ten slots at 40% each, and the ceiling does not yield:
    // the wall ends at eight rather than the cap being quietly relaxed to fill it.
    expect(slate).toHaveLength(8);
  });

  it('will not let one favourite own the slate', () => {
    // "Twenty sequels because of one rating", stated as a constraint.
    const one = anchor({
      mediaItemId: 'marvel',
      similarIds: Array.from({ length: 20 }, (_, index) => `m-${index}`),
    });
    const slate = buildSlate({
      candidates: Array.from({ length: 20 }, (_, index) =>
        candidate({ mediaItemId: `m-${index}`, genres: [`Genre ${index}`] }),
      ),
      anchors: [one],
      taste: emptyTaste,
      exclude: new Set(),
      limit: 20,
    });

    const led = slate.filter((item) => item.explanation.anchors[0]?.mediaItemId === 'marvel');

    expect(led.length).toBeLessThanOrEqual(4);
  });

  it('returns a short wall rather than breaking its own ceiling', () => {
    // Twelve candidates, all one genre, for a wall of ten. The honest answer is four
    // — 40% of ten — and not ten with the cap quietly relaxed to reach it. The
    // version that filled the wall made "no genre above 40%" a claim the code could
    // break, which independent review caught in the assertions rather than the code.
    const scored = scoredRun(12, () => ({ genres: ['Action'] }));

    expect(diversify(scored, 10)).toHaveLength(4);
  });

  it('keeps the best title first', () => {
    const scored = scoredRun(5, () => ({}));
    const slate = diversify(scored, 5);

    expect(slate[0]?.mediaItemId).toBe('m-0');
    expect(scoreOf('m-0', slate)).toBeGreaterThan(scoreOf('m-4', slate));
  });
});
