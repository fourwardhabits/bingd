/**
 * The founder QA failure classes (spec §3, P0; 20261118000100), shared by the Edge
 * decision suite (`import-imdb-verified-match.test.mjs`) and the database suite
 * (`import-imdb-verified-id.test.mjs`), so both sides are asked about exactly the same set.
 *
 * TMDB 671 and 140607 are as staging (…rzyr) stores them. TMDB 556574 (Hamilton) is
 * reconstructed from public knowledge, not captured. Every other id (9000xx, tt90000xx) is
 * synthetic with a public film's title shape. No import file or user data is used.
 */
export const claim = (over = {}) => ({
  row_id: 'r1',
  name: 'Heat',
  year: 1995,
  imdb_id: 'tt0113277',
  title_type: 'Movie',
  original_title: null,
  ...over,
});

export const found = (over = {}) => ({
  movie_results: [],
  person_results: [],
  tv_results: [],
  tv_episode_results: [],
  tv_season_results: [],
  ...over,
});

export const film = (id, title, release_date, original_title = title) => ({
  id,
  title,
  original_title,
  release_date,
});
export const show = (id, name, first_air_date, original_name = name) => ({
  id,
  name,
  original_name,
  first_air_date,
});

// Each case: the IMDb row, the one /find hit TMDB gives for its id, and whether the SHARED
// media_items.imdb_id is written (20261118000200: only when the title agrees too, exactly or
// after punctuation, "&"/"and", a leading article or the original title). Every case links
// the row; `writes: false` is a verified id that won over a disagreeing display title.
export const VERIFIED_CASES = [
  {
    label: 'tt0241527, regional title: Sorcerer’s vs Philosopher’s Stone',
    row: claim({
      name: 'Harry Potter and the Sorcerer’s Stone',
      year: 2001,
      imdb_id: 'tt0241527',
    }),
    hit: film(671, "Harry Potter and the Philosopher's Stone", '2001-11-16'),
    writes: false,
  },
  {
    label: 'tt2488496, franchise prefix: Episode VII vs no episode number',
    row: claim({
      name: 'Star Wars: Episode VII - The Force Awakens',
      year: 2015,
      imdb_id: 'tt2488496',
    }),
    hit: film(140607, 'Star Wars: The Force Awakens', '2015-12-15'),
    writes: false,
  },
  {
    label: 'regional spelling: Pajamas vs Pyjamas',
    row: claim({ name: 'The Boy in the Striped Pajamas', year: 2008, imdb_id: 'tt9000001' }),
    hit: film(900001, 'The Boy in the Striped Pyjamas', '2008-09-12'),
    writes: false,
  },
  {
    label: 'series prefix on the IMDb side: The Divergent Series: Insurgent vs Insurgent',
    row: claim({ name: 'The Divergent Series: Insurgent', year: 2015, imdb_id: 'tt9000002' }),
    hit: film(900002, 'Insurgent', '2015-03-18'),
    writes: false,
  },
  {
    label: 'subtitle on the TMDB side: Fyre vs Fyre: The Greatest Party…',
    row: claim({ name: 'Fyre', year: 2019, imdb_id: 'tt9000003' }),
    hit: film(900003, 'Fyre: The Greatest Party That Never Happened', '2019-01-18'),
    writes: false,
  },
  {
    label: '& vs and: Fathers & Daughters',
    row: claim({ name: 'Fathers & Daughters', year: 2015, imdb_id: 'tt9000004' }),
    hit: film(900004, 'Fathers and Daughters', '2015-10-01'),
    writes: true,
  },
  {
    label: 'one-year territory gap on a verified id',
    row: claim({ name: 'Festival Year Film', year: 2008, imdb_id: 'tt9000005' }),
    hit: film(900005, 'Festival Year Film (Release Title)', '2009-01-09'),
    writes: false,
  },
];

export const VERIFIED_TV_CASES = [
  {
    label: 'TV variant title: a show IMDb names with a franchise prefix',
    row: claim({
      name: 'Franchise: The Series',
      year: 2022,
      imdb_id: 'tt9000006',
      title_type: 'TV Series',
    }),
    hit: show(900006, 'The Series', '2022-09-21'),
    writes: false,
  },
  {
    label: 'TV variant title: a mini-series named differently on each side',
    row: claim({
      name: 'The Long Night (Mini)',
      year: 2019,
      imdb_id: 'tt9000007',
      title_type: 'TV Mini Series',
    }),
    hit: show(900007, 'The Long Night', '2019-05-06'),
    writes: false,
  },
];

/** Verified ids whose titles agree once normalised: these DO write the shared id. */
export const MAPPING_CASES = [
  {
    label: 'punctuation only: Spider-Man: Into the Spider-Verse',
    row: claim({ name: 'Spider-Man: Into the Spider-Verse', year: 2018, imdb_id: 'tt9000008' }),
    hit: film(900008, 'Spiderman Into the Spiderverse', '2018-12-14'),
    writes: true,
  },
  {
    label: 'a leading article: The Long Goodbye Film vs Long Goodbye Film',
    row: claim({ name: 'Long Goodbye Film', year: 2011, imdb_id: 'tt9000009' }),
    hit: film(900009, 'The Long Goodbye Film', '2011-04-01'),
    writes: true,
  },
  {
    label: 'an alternate title: IMDb Original Title equals TMDB original title',
    row: claim({
      name: 'The Lives of Others',
      original_title: 'Das Leben der Anderen',
      year: 2006,
      imdb_id: 'tt9000010',
    }),
    hit: film(900010, 'Lives of Others', '2006-03-23', 'Das Leben der Anderen'),
    writes: true,
  },
];

/** The /find body a case's hit arrives in: tv_results for a TV row, movie_results otherwise. */
export const findFor = ({ row, hit }) =>
  /tv/i.test(row.title_type) ? found({ tv_results: [hit] }) : found({ movie_results: [hit] });
