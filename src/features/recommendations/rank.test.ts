import {
  buildSlate,
  CONFIDENT_AT,
  diversify,
  franchiseKey,
  headlineFor,
  maxPerAnchor,
  maxPerFranchise,
  maxPerGenre,
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

/**
 * Freshness: the same relevance, arranged differently.
 *
 * The founder's report was that For You showed essentially the same recommendations
 * every visit. It did, and nothing was broken: `diversify` was a deterministic top-k, so
 * with the rankings and the provider cache unchanged there was exactly one answer.
 *
 * The seed adds a *presentation* axis and nothing else. What has to stay true is
 * everything the three ceilings and the scoring already guaranteed — the founder's rule
 * is that relevance stays primary and this is not a shuffle — so most of what follows
 * asserts the constraints across a hundred seeds rather than asserting that one seed
 * produces one particular list.
 */
describe('a seeded arrangement', () => {
  /** A pool with a real score gradient: sixty candidates, each a little less popular. */
  const pool = (count = 60) =>
    Array.from({ length: count }, (_, index) =>
      scoreCandidate(
        candidate({
          mediaItemId: `c${index}`,
          title: `Candidate ${index}`,
          genres: [['Drama', 'Comedy', 'Horror', 'Action', 'Crime'][index % 5]!],
          popularity: 900 - index * 14,
        }),
        [],
        tasteFrom([]),
      ),
    );

  const ids = (list: readonly { mediaItemId: string }[]) => list.map((item) => item.mediaItemId);

  it('is the strict score order when there is no seed', () => {
    // Seed 0 is the default and it is the behaviour every other test in this file was
    // written against. Freshness had to be opt-in or it would have silently rewritten
    // what "the best twenty" means.
    const strict = diversify(pool(), 20);
    const unseeded = diversify(pool(), 20, 0);
    expect(ids(unseeded)).toEqual(ids(strict));
  });

  it('gives the same wall for the same seed, every time', () => {
    // Rule A. A visit is stable, so the arrangement cannot be a function of anything but
    // the seed — no `Math.random`, no clock, no insertion order.
    const once = diversify(pool(), 20, 7);
    const twice = diversify(pool(), 20, 7);
    expect(ids(twice)).toEqual(ids(once));
  });

  it('gives a different wall for a different seed', () => {
    const a = diversify(pool(), 20, 7);
    const b = diversify(pool(), 20, 8);
    expect(ids(b)).not.toEqual(ids(a));
  });

  it('changes the top of the wall, not merely the tail', () => {
    // "Avoids showing an identical top set whenever adequate alternatives exist". A
    // reordering that left the first six posters alone would look, to the founder,
    // exactly like the bug being fixed.
    const first = new Set(ids(diversify(pool(), 20, 7)).slice(0, 6));
    const second = ids(diversify(pool(), 20, 8)).slice(0, 6);
    expect(second.some((id) => !first.has(id))).toBe(true);
  });

  it('draws only from the high-quality pool while the ceilings leave room', () => {
    /**
     * The relevance guarantee, and the reason this is sampling rather than shuffling.
     *
     * The pool is the top `3 × limit` by score. With a limit of 20 that is the best 60
     * of the 300 below, so the worst a lucky draw can do is promote the 60th-best
     * candidate. Asserted over a hundred seeds, because the whole point of a stochastic
     * rule is that one sample proves nothing.
     *
     * **This was called "never reaches outside the high-quality pool", and independent
     * review 29 was right that the fixture cannot support that name.** These candidates
     * spread across five genres and share no franchise, so the ceilings never bite and
     * the greedy pass never needs the tail. Where they do bite it reaches past sixty —
     * with a seed and without one alike — which is what
     * `what the exploration pool bounds` asserts below.
     */
    const candidates = pool(300);
    const ranked = [...candidates].sort(
      (a, b) => b.explanation.total - a.explanation.total,
    );
    const eligible = new Set(ids(ranked.slice(0, 60)));

    for (let seed = 1; seed <= 100; seed += 1) {
      for (const id of ids(diversify(candidates, 20, seed))) {
        expect([seed, id, eligible.has(id)]).toEqual([seed, id, true]);
      }
    }
  });

  it('keeps every diversity ceiling across a hundred seeds', () => {
    // The ceilings are hard and the ordering is what varies. A reordering that let a
    // franchise or a genre through would be the "twenty sequels" failure arriving by a
    // new route.
    const candidates = pool(300);
    for (let seed = 1; seed <= 100; seed += 1) {
      const slate = diversify(candidates, 20, seed);
      expect(slate.length).toBeLessThanOrEqual(20);

      const perGenre = new Map<string, number>();
      for (const item of slate) {
        const primary = item.genres[0];
        if (primary) perGenre.set(primary, (perGenre.get(primary) ?? 0) + 1);
      }
      for (const [genre, count] of perGenre) {
        expect([seed, genre, count <= 8]).toEqual([seed, genre, true]);
      }
    }
  });

  it('draws no duplicates', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const drawn = ids(diversify(pool(), 20, seed));
      expect([seed, drawn.length]).toEqual([seed, new Set(drawn).size]);
    }
  });

  it('still leads with the best title when there genuinely is a best title', () => {
    /**
     * "Relevance remains primary", measured rather than asserted — and measured on the
     * pool shape where the phrase means something.
     *
     * An **anchored** pool has a steep head: a handful of titles the reader's own
     * favourites point at, scoring several times what the popularity tail does. That is
     * the case where burying the best title would be a real loss, so that is the case
     * the temperature was tuned against, and the claim is that the top-scoring candidate
     * still leads the wall most of the time.
     *
     * The first draft measured this on a popularity-only pool and against the bottom
     * *thirty* of sixty, and it failed — correctly, on both counts. Those scores differ
     * by thousandths, so no title is distinctly best and sampling rightly treats them as
     * interchangeable; and comparing ten candidates against thirty would have been an
     * unfair count even if it had passed.
     *
     * The finding underneath it stood, though, and it moved the constant twice: the
     * temperature was 0.25, tuned against a hand-built pool with a steeper head than the
     * real scorer produces. It is 0.12, measured against this one.
     */
    const anchor: Anchor = {
      mediaItemId: 'loved',
      title: 'Loved',
      score: 9,
      similarIds: Array.from({ length: 10 }, (_, index) => `c${index}`),
    };
    const candidates = Array.from({ length: 60 }, (_, index) =>
      scoreCandidate(
        candidate({
          mediaItemId: `c${index}`,
          title: `Candidate ${index}`,
          genres: [['Drama', 'Comedy', 'Horror', 'Action', 'Crime'][index % 5]!],
          popularity: 900 - index * 14,
        }),
        [anchor],
        tasteFrom([]),
      ),
    );

    const byScore = [...candidates].sort((a, b) => b.explanation.total - a.explanation.total);
    const best = byScore[0]!.mediaItemId;
    const topTen = new Set(ids(byScore.slice(0, 10)));

    let bestLeads = 0;
    let ledFromOutsideTopTen = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const lead = diversify(candidates, 20, seed)[0]?.mediaItemId;
      if (lead === best) bestLeads += 1;
      if (lead && !topTen.has(lead)) ledFromOutsideTopTen += 1;
    }

    // The single best candidate leads about half of all visits — against 1-in-60 if
    // this were a shuffle. Asserted with margin, because it is a measured rate.
    expect(bestLeads).toBeGreaterThan(100);
    // And the tail essentially never leads: exploration inside the pool, not a lottery.
    // Measured at roughly 1%; the bound is loose so a scorer tweak reports rather than
    // flakes.
    expect(ledFromOutsideTopTen).toBeLessThan(30);
  });

  it('leaves an all-equal pool alone rather than inventing an order', () => {
    // No spread means no near-tie to break, and a hash is not a reason to prefer one
    // title over another. The strict order stands.
    const flat = Array.from({ length: 30 }, (_, index) =>
      scoreCandidate(candidate({ mediaItemId: `f${index}`, popularity: null }), [], tasteFrom([])),
    );
    expect(ids(diversify(flat, 20, 9))).toEqual(ids(diversify(flat, 20, 0)));
  });

  it('degrades to the strict order when there is barely a pool', () => {
    // Twenty candidates for twenty slots: there is nothing to choose between, so a
    // refresh honestly changes very little. The founder's "whenever adequate
    // alternatives exist" cuts both ways.
    const scarce = pool(20);
    expect(new Set(ids(diversify(scarce, 20, 5)))).toEqual(new Set(ids(diversify(scarce, 20, 0))));
  });
});

/**
 * What the exploration pool bounds — independent review 29 and 29b.
 *
 * `rank.ts` claimed nothing outside the top `3 × limit` could be drawn. That is false:
 * `diversify` runs one greedy pass with hard ceilings over the whole sequence, so when
 * the caps reject the head it fills from the tail.
 *
 * **Round 29b then found the first attempt at these tests vacuous, and it was right.**
 * They passed `limit: 200`, which makes the pool all two hundred candidates and the
 * "outside the pool" split at index 60 meaningless; and they used popularities of
 * `900 - index`, every one of which saturates `POPULARITY_CEILING` (500) to an identical
 * score, so `spread <= 0` disabled the seeded path entirely. A green test that never ran
 * the code under test is worse than no test, and it is the same shape of mistake as the
 * claim it was written to pin down.
 *
 * Fixed here: **`limit: 20`, so the pool really is the top sixty**, and popularities
 * strictly under the ceiling so the scores strictly decrease and the sampler runs.
 */
describe('what the exploration pool bounds', () => {
  const ids = (scored: readonly { mediaItemId: string }[]) => scored.map((s) => s.mediaItemId);
  /** Position in the original score order, recovered from the id. With `limit: 20` the
   *  exploration pool is the top sixty, so `< 60` is exactly the pool boundary. */
  const inPool = (id: string) => Number(id.slice(1)) < 60;

  /** Strictly decreasing and well under `POPULARITY_CEILING`, so the scores have spread. */
  const popularity = (index: number) => 400 - index * 1.5;

  /**
   * The first sixty share one genre and one franchise, so the franchise ceiling rejects
   * all but two of the pool and the greedy pass is forced into the tail — the case the
   * overstated claim said could not happen.
   */
  const constrained = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      scoreCandidate(
        candidate({
          mediaItemId: `x${index}`,
          title: index < 60 ? `Saga: Part ${index}` : `Standalone ${index}`,
          genres: index < 60 ? ['Drama'] : ['Comedy'],
          popularity: popularity(index),
        }),
        [],
        emptyTaste,
      ),
    );

  /** Five genres, no shared franchise: the ceilings never bite. */
  const roomy = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      scoreCandidate(
        candidate({
          mediaItemId: `x${index}`,
          title: `Title ${index}`,
          genres: [['Drama', 'Comedy', 'Horror', 'Action', 'Crime'][index % 5]!],
          popularity: popularity(index),
        }),
        [],
        emptyTaste,
      ),
    );

  it('keeps the wall inside the pool while the ceilings leave room', () => {
    // The guarantee doing its work: over a hundred seeds, nothing below the best sixty
    // is ever drawn, because the greedy pass never needs to look that far.
    const scored = roomy(200);
    for (let seed = 1; seed <= 100; seed += 1) {
      expect([seed, ids(diversify(scored, 20, seed)).every(inPool)]).toEqual([seed, true]);
    }
  });

  it('reaches the tail with a seed and without one alike', () => {
    // What review 29 found: the pool is not a bound on what the greedy pass may select.
    // Asserted both ways because the point is that the seed did not introduce it —
    // `diversify` has always filled from further down when the ceilings reject the head.
    // It is *not* a claim that the two reach it under identical conditions; they need
    // not, since order decides which pool members are rejected.
    const scored = constrained(200);
    const fromTail = (seed: number) => ids(diversify(scored, 20, seed)).filter((id) => !inPool(id));

    expect(fromTail(0).length).toBeGreaterThan(0);
    expect(fromTail(7).length).toBeGreaterThan(0);
  });

  it('never draws a title from outside the pool ahead of one inside it', () => {
    /**
     * **This is the whole guarantee, and it is the only one of this shape that holds.**
     *
     * `explore` permutes the pool and leaves every lower-scoring candidate behind all of
     * it, so the greedy pass meets the pool first and the tail only after. What that does
     * *not* promise is the next test.
     */
    const scored = constrained(200);
    for (let seed = 1; seed <= 100; seed += 1) {
      const wall = ids(diversify(scored, 20, seed));
      const inside = wall.flatMap((id, index) => (inPool(id) ? [index] : []));
      const outside = wall.flatMap((id, index) => (inPool(id) ? [] : [index]));
      expect([seed, inside.length > 0, outside.length > 0]).toEqual([seed, true, true]);
      expect([seed, Math.max(...inside) < Math.min(...outside)]).toEqual([seed, true]);
    }
  });

  it('does change which titles are chosen, because order spends the ceilings', () => {
    /**
     * **The claim review 29b killed, kept as a test so it cannot come back.**
     *
     * An earlier round asserted the selected set was identical with and without a seed.
     * It is not, and it cannot be: the ceilings are spent in the order they are met, so
     * a different arrangement of the pool leaves different quota for what follows. That
     * is not relevance leaking — every candidate involved is still inside the pool or
     * still in strict score order behind it — but the *set* genuinely moves, and saying
     * otherwise was how the top-60 claim got overstated in the first place.
     */
    const scored = constrained(200);
    const walls = [0, 1, 7, 4242].map((seed) => JSON.stringify([...ids(diversify(scored, 20, seed))].sort()));
    expect(new Set(walls).size).toBeGreaterThan(1);
  });

  it('can return a shorter wall than strict order, because the ceilings intersect', () => {
    /**
     * **The second false claim, found by review 29c, kept as a test so it cannot return.**
     *
     * An earlier round asserted the wall never gets shorter, over a fixture where the
     * length was invariant by construction — every pool candidate shared one genre and
     * one franchise, so every permutation accepted exactly two. It executed `explore`
     * and still could not see the behaviour it was named for.
     *
     * This is the reviewer's counterexample, run against the real scorer: two genres
     * (`Drama`/`Comedy`) across two franchises (`Yankee`/`Xray`) at `limit: 5`, where
     * the genre ceiling is 2 and the franchise ceiling is 2. Strict order takes four.
     * Seed 76 takes three, because it meets `AX1` early and spends Drama's second slot
     * on a franchise that then blocks `BX2`.
     */
    const spec: [string, string, string][] = [
      ['AY1', 'Drama', 'Yankee'],
      ['AY2', 'Drama', 'Yankee'],
      ['BX1', 'Comedy', 'Xray'],
      ['BX2', 'Comedy', 'Xray'],
      ['AX1', 'Drama', 'Xray'],
      ['AX2', 'Drama', 'Xray'],
    ];
    const scored = spec.map(([id, genre, franchise], index) =>
      scoreCandidate(
        candidate({
          mediaItemId: id,
          title: `${franchise}: ${id}`,
          genres: [genre],
          popularity: 400 - index * 20,
        }),
        [],
        emptyTaste,
      ),
    );

    expect(maxPerGenre(5)).toBe(2);
    expect(maxPerFranchise()).toBe(2);
    expect(diversify(scored, 5, 0)).toHaveLength(4);
    expect(diversify(scored, 5, 76)).toHaveLength(3);
  });

  it('can shorten a wall the candidates could have filled, so scarcity is not the excuse', () => {
    /**
     * **Review 29d, and it killed the mitigation rather than the finding.**
     *
     * The round before this said the shortening "needs a pool that cannot fill the wall
     * in the first place". It does not. Add one unconstrained candidate to the six
     * above — its own genre, its own franchise — and strict order fills all five slots
     * while seed 76 still returns four. The wall was fillable; the ordering lost a row.
     *
     * What is actually required is that the intersecting ceilings be near-binding. That
     * is a much narrower condition than "any pool", and much broader than "a pool that
     * was already too small", which is why it is asserted here rather than described.
     */
    const spec: [string, string, string][] = [
      ['AY1', 'Drama', 'Yankee'],
      ['AY2', 'Drama', 'Yankee'],
      ['BX1', 'Comedy', 'Xray'],
      ['BX2', 'Comedy', 'Xray'],
      ['AX1', 'Drama', 'Xray'],
      ['AX2', 'Drama', 'Xray'],
      ['CZ1', 'Action', 'Zulu'],
    ];
    const scored = spec.map(([id, genre, franchise], index) =>
      scoreCandidate(
        candidate({
          mediaItemId: id,
          title: `${franchise}: ${id}`,
          genres: [genre],
          popularity: 400 - index * 20,
        }),
        [],
        emptyTaste,
      ),
    );

    // Strict order fills the wall, so this set is not "too small to fill it".
    expect(diversify(scored, 5, 0)).toHaveLength(5);
    expect(diversify(scored, 5, 76)).toHaveLength(4);

    // And it is uncommon rather than typical, even here. Measured at 41 in 2,000 — about
    // one seed in fifty — and bracketed tightly enough to protect that number: `< 200`
    // was the first bound and review 29e was right that it would survive a fivefold
    // regression and leave the prose false. A change that moves this legitimately should
    // update both the bound and the sentence that quotes it.
    let shortened = 0;
    for (let seed = 1; seed <= 2000; seed += 1) {
      if (diversify(scored, 5, seed).length < 5) shortened += 1;
    }
    expect(shortened).toBeGreaterThanOrEqual(20);
    expect(shortened).toBeLessThanOrEqual(70);
  });

  it('does not move the wall length on any of five realistic pool shapes', () => {
    /**
     * **The measurement, in the suite rather than in a comment.**
     *
     * 29d could not reproduce the "2,000 seeds on five realistic shapes" claim from the
     * prose around it, and was right not to accept it — an empirical claim with no
     * harness is an assertion. These are the five shapes, and they run.
     *
     * The condition for shortening is near-binding intersecting ceilings. Every shape
     * here gives the caps slack, which is the state For You is in whenever it has enough
     * candidates to show a wall at all.
     */
    const genres = [
      'Drama', 'Comedy', 'Horror', 'Action', 'Crime', 'Thriller', 'Romance', 'Sci-Fi',
      'Fantasy', 'Mystery', 'War', 'Music', 'Family', 'History', 'Animation', 'Western',
      'Documentary', 'Adventure',
    ];
    const build = (count: number, genreOf: (i: number) => string, titleOf: (i: number) => string,
      step: number) =>
      Array.from({ length: count }, (_, index) =>
        scoreCandidate(
          candidate({
            mediaItemId: `c${index}`,
            title: titleOf(index),
            genres: [genreOf(index)],
            popularity: 400 - index * step,
          }),
          [],
          emptyTaste,
        ),
      );

    const shapes: [string, ReturnType<typeof build>][] = [
      ['60 candidates, eighteen genres', build(60, (i) => genres[i % 18]!, (i) => `Film ${i}`, 3)],
      ['200 candidates, eighteen genres', build(200, (i) => genres[i % 18]!, (i) => `Film ${i}`, 1.5)],
      ['200 candidates, five genres', build(200, (i) => genres[i % 5]!, (i) => `Film ${i}`, 1.5)],
      [
        '200 candidates, franchise-heavy',
        build(200, (i) => genres[i % 18]!, (i) => `Saga${Math.floor(i / 3)}: Part ${i}`, 1.5),
      ],
      ['25 candidates for a wall of 20', build(25, (i) => genres[i % 6]!, (i) => `Film ${i}`, 8)],
    ];

    for (const [name, scored] of shapes) {
      expect([name, diversify(scored, 20, 0).length]).toEqual([name, 20]);
      for (let seed = 1; seed <= 200; seed += 1) {
        expect([name, seed, diversify(scored, 20, seed).length]).toEqual([name, seed, 20]);
      }
    }
  });
});
