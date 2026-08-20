import {
  buildSlate,
  CONFIDENT_AT,
  diversify,
  franchiseKey,
  headlineFor,
  maxPerAnchor,
  maxPerFranchise,
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

  /** How many slate entries any anchor at all lies behind — lead or otherwise. */
  const attributionsTo = (id: string, slate: readonly { explanation: { anchors: { mediaItemId: string }[] } }[]) =>
    slate.filter((item) => item.explanation.anchors.some((hit) => hit.mediaItemId === id)).length;

  it('lets no one favourite lie behind more than four of the twenty', () => {
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

    expect(attributionsTo('marvel', slate)).toBeLessThanOrEqual(maxPerAnchor());
  });

  it('counts a favourite that is not the loudest voice on the row', () => {
    // The failure independent review found at 08f, as a fixture. `favourite` points at
    // twelve titles; `other` points at eight of them from a better position, so on
    // those eight `other` is the recorded lead and `favourite` is second.
    //
    // Under a lead-only quota the wall is eight rows — four led by `favourite`, four
    // led by `other` — and `favourite` lies behind every one of them. It was never
    // named more than four times, and it decided twice that many. Counting only the
    // lead is a quota on how often a favourite is *quoted*, not on how much it
    // *decides*, and the founder decision asks for the second.
    const ids = Array.from({ length: 12 }, (_, index) => `f-${index}`);
    const slate = buildSlate({
      candidates: ids.map((id, index) => candidate({ mediaItemId: id, genres: [`Genre ${index}`] })),
      anchors: [
        anchor({ mediaItemId: 'favourite', score: 10, similarIds: ids }),
        anchor({ mediaItemId: 'other', score: 10, similarIds: ids.slice(4) }),
      ],
      taste: emptyTaste,
      exclude: new Set(),
      limit: 20,
    });

    // The fixture is only worth anything if `favourite` really is the second voice on
    // those rows — otherwise this passes for the wrong reason.
    const secondBilled = slate.filter(
      (item) => item.explanation.anchors[1]?.mediaItemId === 'favourite',
    );
    expect(secondBilled.length).toBeGreaterThan(0);

    expect(attributionsTo('favourite', slate)).toBeLessThanOrEqual(maxPerAnchor());
  });

  it('will not hand the wall to one franchise', () => {
    // Six entries of one series, all out-scoring everything else, and a wall with room
    // for all of them. `recommendations.md` §4 says at most two per twenty.
    const sequels = [
      'Spider-Man',
      'Spider-Man 2',
      'Spider-Man: Homecoming',
      'Spider-Man: Far From Home',
      'Spider-Man: No Way Home',
      'Spider-Man: Brand New Day',
    ];
    const scored = [
      ...sequels.map((title, index) =>
        scoreCandidate(
          candidate({ mediaItemId: `s-${index}`, title, popularity: 500 - index, genres: [`Genre ${index}`] }),
          [],
          emptyTaste,
        ),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        scoreCandidate(
          candidate({ mediaItemId: `o-${index}`, title: `Other ${index}`, popularity: 10, genres: [`Other ${index}`] }),
          [],
          emptyTaste,
        ),
      ),
    ];

    const slate = diversify(scored, 20);
    const franchise = slate.filter((item) => franchiseKey(item.title) === 'spider man');

    // Two, and exactly two: the cap holds, and it does not ban the sequel of a film
    // somebody loved. Banning them outright would be a different product decision and
    // not the one that was made.
    expect(franchise).toHaveLength(maxPerFranchise());
    expect(slate.length).toBeGreaterThan(maxPerFranchise());
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

describe('what counts as one franchise', () => {
  /**
   * The key is a proxy for TMDB's `belongs_to_collection`, which V1 cannot have: it
   * lives on a title's detail response, so keying on it would cost one provider
   * request per candidate against an architecture that budgets six per slate.
   *
   * What matters about a proxy is **which way it is wrong**, and that is what most of
   * these cases fix. It reads a *named* sequel marker, which means one thing wherever
   * it appears, and it never reads a bare number, which does not — so numbered sequels
   * are missed rather than unrelated films being dropped for a franchise the code
   * invented. The subtitle split is the exception: it is not a marker, it can join two
   * unrelated titles, and that case is stated and tested at the end rather than denied.
   */
  const same = (a: string, b: string) => franchiseKey(a) != null && franchiseKey(a) === franchiseKey(b);

  it('groups an entry carrying a named sequel marker', () => {
    expect(same('The Godfather', 'The Godfather Part II')).toBe(true);
    expect(same('It', 'It Chapter Two')).toBe(true);
    expect(same('Kill Bill: Vol. 1', 'Kill Bill: Vol. 2')).toBe(true);
    expect(same('Back to the Future Part II', 'Back to the Future Part III')).toBe(true);
  });

  it('groups entries that share a name and differ by subtitle', () => {
    expect(same('Spider-Man: No Way Home', 'Spider-Man: Brand New Day')).toBe(true);
    expect(same('Dune', 'Dune: Part Two')).toBe(true);
    expect(same('Mission: Impossible', 'Mission: Impossible — Fallout')).toBe(true);
    expect(same('Star Wars: Episode IV – A New Hope', 'Star Wars: Episode V – The Empire Strikes Back')).toBe(true);
  });

  it('reads through an article and an accent', () => {
    expect(franchiseKey('The Matrix')).toBe('matrix');
    expect(franchiseKey('Amélie')).toBe('amelie');
    expect(same('The Matrix', 'Matrix Reloaded')).toBe(false);
  });

  it('never reads a bare number as a sequel marker', () => {
    // Both counterexamples independent review produced, held as tests.
    //
    // 08g: stripping any trailing number made Apollo 11, 13 and 18 one franchise.
    // 08h: stripping one only when the unnumbered original was present made Room,
    // Room 237 and Room 203 one franchise — an unrelated 2015 drama supplying the
    // stem for a documentary about The Shining. The second rule reduced the false
    // positives without eliminating them, which is not the same thing.
    //
    // So a bare number is never a marker, and `Iron Man 2` is a documented miss. A
    // ceiling that drops an unrelated film is worse than one that misses a franchise.
    for (const numbered of ['Apollo 11', 'Apollo 13', 'Apollo 18', 'Room 237', 'Room 203']) {
      expect(franchiseKey(numbered)).toBe(numbered.toLowerCase());
    }
    expect(same('Apollo 13', 'Apollo 11')).toBe(false);
    expect(same('Room', 'Room 237')).toBe(false);
    expect(same('Blade Runner', 'Blade Runner 2049')).toBe(false);
    expect(same('Malcolm', 'Malcolm X')).toBe(false);
  });

  it('does not invent a franchise out of two unrelated films', () => {
    expect(same('Heat', 'Inception')).toBe(false);
    expect(same('The Magnificent Seven', 'The Magnificent Ambersons')).toBe(false);
    expect(same('Rogue One', 'Rogue Nation')).toBe(false);
  });

  it('says so when there is nothing to group on', () => {
    // One character left after the rules have run is a title they ate, not an identity.
    expect(franchiseKey('M')).toBeNull();
    expect(franchiseKey('9')).toBeNull();
    expect(franchiseKey('   ')).toBeNull();
  });

  it('misses the franchises it is documented to miss', () => {
    // Recorded as tests rather than as prose, so the limitation cannot quietly widen.
    // Every one of these is under-grouping: a franchise slips past the ceiling, and
    // nothing unrelated is dropped.
    expect(same('Iron Man', 'Iron Man 2')).toBe(false); // numbered sequel
    expect(same('Iron Man', 'Thor')).toBe(false); // shared universe
    expect(same('Batman Begins', 'The Dark Knight')).toBe(false); // renamed entry
    expect(same('The Fast and the Furious', 'Fast Five')).toBe(false); // retitled reboot
  });

  it('groups unrelated films that share a leading stem, and that is the known cost', () => {
    // The one direction the proxy can be wrong, asserted rather than denied.
    //
    // Two films with the same title get one key, and so does a film whose *subtitled*
    // title starts with somebody else's whole title — the second is the weaker case
    // and the honest name for what is shared is the leading stem, not the name.
    // Either way only the provider's collection id could separate them. The ceiling
    // is two of twenty, so this costs a row only when three or more collide.
    expect(same('Heat', 'Heat')).toBe(true);
    expect(same('Crash', 'Crash: A Different Story')).toBe(true);
  });
});
