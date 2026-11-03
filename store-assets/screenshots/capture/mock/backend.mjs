// A localhost stand-in for the Supabase backend, used only by the capture stage.
//
// Every person here is fictional. No real member, no real account, no cast or crew names:
// the only real-world facts are film and TV titles, years, genres and the TMDB image paths
// the app loads posters from. Artwork is fetched at capture time and never stored in git.
//
// The catalogue is short on purpose. App Review Guideline 2.3.8 asks that screenshots suit a
// 4+ rating whatever the app's own rating, so titles with violent or adult key art are left
// out altogether rather than sorted out of view. Every title here has a poster.
//
// Control: setScenario('established' | 'newuser'), or POST /__scenario {"name":"..."}.
// GET /__log returns calls this mock did not recognise, which is how a new backend call on
// a redesigned branch shows up in capture.json instead of as a quietly empty screen.
import http from 'node:http';

/** The clock every scene runs on, in the mock and in the browser. See capture/browser.mjs. */
export const FIXED_NOW = Date.parse('2026-10-15T18:00:00Z');

export const VIEWER = '00000000-0000-4000-8000-000000000001';
export const VIEWER_EMAIL = 'alex@example.com';
const uid = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const mid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let scenario = 'established';
const unhandled = new Map();

export const people = [
  { id: uid(2), username: 'mayawatches', display_name: 'Maya Chen', bio: 'Crying at animated films since 1998.' },
  { id: uid(3), username: 'theo.okafor', display_name: 'Theo Okafor', bio: 'Will defend Tenet.' },
  { id: uid(4), username: 'priyan', display_name: 'Priya Nair', bio: null },
  { id: uid(5), username: 'jonahr', display_name: 'Jonah Reed', bio: null },
  { id: uid(6), username: 'sofia_a', display_name: 'Sofia Alvarez', bio: null },
  { id: uid(7), username: 'samw', display_name: 'Sam Whitfield', bio: null },
  { id: uid(8), username: 'dani.k', display_name: 'Dani Kim', bio: null },
].map((p) => ({ ...p, avatar_path: null, status: 'active', visibility: 'public', link_instagram: null, link_tiktok: null, link_youtube: null, link_x: null, link_website: null }));

export const me = { id: VIEWER, username: 'alexr', display_name: 'Alex Rivera', bio: 'Rewatching everything twice.', avatar_path: null, visibility: 'public', link_instagram: null, link_tiktok: null, link_youtube: null, link_x: null, link_website: null };

const M = (title, date, genres, runtime, cert, poster, backdrop = null, overview = '', lang = 'en') => ({ title, release_date: date, genres, runtime_minutes: runtime, certification: cert, poster_path: poster, backdrop_path: backdrop, overview, original_language: lang, kind: 'movie' });

const movies = [
  M('Spirited Away', '2001-07-20', ['Animation', 'Family', 'Fantasy'], 125, 'PG', '/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg', '/Ab8mkHmkYADjU7wQiOkia9BzGvS.jpg', 'A ten-year-old wanders into a world of spirits and must work in a bathhouse to free her parents.', 'ja'),
  M('Coco', '2017-11-22', ['Animation', 'Family', 'Fantasy'], 105, 'PG', '/gGEsBPAijhVUFoiNpgZXqRVWJt2.jpg', null, 'Aspiring musician Miguel enters the Land of the Dead to find his great-great-grandfather.'),
  M('Interstellar', '2014-11-07', ['Adventure', 'Drama', 'Science Fiction'], 169, 'PG-13', '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', '/xJHokMbljvjADYdit5fK5VQsXEG.jpg', 'A team of explorers travels through a wormhole in space in an attempt to ensure humanity survives.'),
  M('Inception', '2010-07-16', ['Action', 'Science Fiction', 'Adventure'], 148, 'PG-13', '/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg', '/s3TBrRGB1iav7gFOCNx3H31MoES.jpg', 'A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea into the mind of a chief executive.'),
  M('Zootopia', '2016-03-04', ['Animation', 'Adventure', 'Family'], 108, 'PG', '/hlK0e0wAQ3VLuJcsfIYPvb4JVud.jpg', null, 'A rookie bunny cop and a con artist fox team up to uncover a conspiracy.'),
  M('La La Land', '2016-12-09', ['Comedy', 'Drama', 'Romance'], 129, 'PG-13', '/uDO8zWDhfWwoFdKS4fzkUJt0Rf0.jpg', null, 'A jazz musician and an aspiring actress fall in love while pursuing their dreams in Los Angeles.'),
  M('Spider-Man: Into the Spider-Verse', '2018-12-14', ['Animation', 'Action', 'Adventure'], 117, 'PG', '/iiZZdoQBEYBv6id8su7ImL0oCbD.jpg', null, 'Teen Miles Morales becomes the Spider-Man of his universe and joins Spider-People from other dimensions.'),
  M('Knives Out', '2019-11-27', ['Comedy', 'Crime', 'Mystery'], 131, 'PG-13', '/pThyQovXQrw2m0s9x82twj48Jq4.jpg', null, 'A detective investigates the death of the patriarch of an eccentric, combative family.'),
  M('The Dark Knight', '2008-07-18', ['Action', 'Crime', 'Drama'], 152, 'PG-13', '/qJ2tW6WMUDux911r6m7haRef0WH.jpg', '/nMKdUUepR0i5zn0y1T4CsSB5chy.jpg', 'Batman raises the stakes in his war on crime, and meets a criminal mastermind who wants to watch the city burn.'),
  M('Oppenheimer', '2023-07-21', ['Drama', 'History'], 181, 'R', '/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg', '/rLb2cwF3Pazuxaj0sRXQ037tGI1.jpg', 'The story of the physicist at the centre of the development of the atomic bomb.'),
  M('Parasite', '2019-05-30', ['Comedy', 'Thriller', 'Drama'], 133, 'R', '/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg', '/TU9NIjwzjoKPwQHoHshkFcQUCG.jpg', 'A jobless family schemes its way into the household of the wealthy Parks, one hire at a time.', 'ko'),
  M('Everything Everywhere All at Once', '2022-03-25', ['Action', 'Adventure', 'Science Fiction'], 140, 'R', '/w3LxiVYdWWRvEVdn5RYq6jIqkb1.jpg', null, 'A laundromat owner discovers she must connect with parallel universe versions of herself.'),
  // Not ranked by the viewer from here on: see RANKED_MOVIE_COUNT.
  M('Barbie', '2023-07-21', ['Comedy', 'Adventure'], 114, 'PG-13', '/iuFNMS8U5cb6xfzi51Dbkovj7vM.jpg', '/ctMserH8g2SeOAnCw5gFjdQF8mo.jpg', 'Barbie and Ken leave the perfect world of Barbie Land for the real one.'),
  M('The Matrix', '1999-03-31', ['Action', 'Science Fiction'], 136, 'R', '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg', '/fNG7i7RqMErkcqhohV2a6cV1Ehy.jpg', 'A hacker learns from mysterious rebels about the true nature of his reality.'),
  M('Whiplash', '2014-10-10', ['Drama', 'Music'], 107, 'R', '/7fn624j5lj3xTme2SgiLCeuedmO.jpg', null, 'A promising young drummer enrolls at a cut-throat conservatory under an instructor who will stop at nothing.'),
  M('Mad Max: Fury Road', '2015-05-15', ['Action', 'Adventure', 'Science Fiction'], 121, 'R', '/hA2ple9q4qnwxp3hKVNhroipsir.jpg', null, 'In a post-apocalyptic wasteland, a woman rebels against a tyrant with the help of a drifter named Max.'),
  M('Avengers: Endgame', '2019-04-26', ['Adventure', 'Science Fiction', 'Action'], 181, 'PG-13', '/ulzhLuWrPK07P1YkdWQLZnQh1JL.jpg', null, 'The remaining Avengers take one final stand to undo Thanos’s actions.'),
  M('Shrek', '2001-05-18', ['Animation', 'Comedy', 'Fantasy'], 90, 'PG', '/iB64vpL3dIObOtMZgX3RqdVdQDc.jpg', null, 'An ogre goes on a quest to rescue a princess so that he can get his swamp back.'),
  M('Forrest Gump', '1994-07-06', ['Comedy', 'Drama', 'Romance'], 142, 'PG-13', '/arw2vcBveWOVZr6pxd9XTd1TdQa.jpg', null, 'A man with a low IQ accomplishes great things, always returning to his childhood sweetheart.'),
  M('Titanic', '1997-12-19', ['Drama', 'Romance'], 194, 'PG-13', '/9xjZS2rlVxm8SFx8kPC3aIGCOYQ.jpg', null, 'A seventeen-year-old aristocrat falls in love with a kind but poor artist aboard the ill-fated R.M.S. Titanic.'),
  M('Avatar', '2009-12-18', ['Action', 'Adventure', 'Science Fiction'], 162, 'PG-13', '/gKY6q7SjCkAU6FqvqWybDYgUKIF.jpg', null, 'A paraplegic Marine is dispatched to the moon Pandora on a unique mission.'),
  M('Twilight', '2008-11-21', ['Fantasy', 'Drama', 'Romance'], 122, 'PG-13', '/3Gkb6jm6962ADUPaCBqzz9CTbn9.jpg', null, 'A teenager falls in love with a mysterious classmate who turns out to be a vampire.'),
  M('The Shawshank Redemption', '1994-09-23', ['Drama', 'Crime'], 142, 'R', '/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg', null, 'A banker sentenced to life in Shawshank prison finds solace and eventual redemption.'),
];

/** The first N of `movies` are the viewer's ranked list; the rest feed the watchlist and For You. */
const RANKED_MOVIE_COUNT = 12;

const S = (title, date, genres, cert, poster, backdrop, seasons, overview) => ({ title, release_date: date, genres, certification: cert, poster_path: poster, backdrop_path: backdrop, kind: 'series', overview, original_language: 'en', seasons });
const series = [
  S('Stranger Things', '2016-07-15', ['Drama', 'Mystery', 'Sci-Fi & Fantasy'], 'TV-14', '/49WJfeN0moxb9IPfGn8AIqMGskD.jpg', '/56v2KjBlU4XaOv9rVYEQypROD7P.jpg', [8, 9, 8, 9], 'A boy vanishes and a small town uncovers a mystery of secret experiments.'),
  S('Severance', '2022-02-18', ['Drama', 'Mystery', 'Sci-Fi & Fantasy'], 'TV-MA', '/lFf6LLrQjYldcZItzOkGmMMigP7.jpg', null, [9, 10], 'Office workers undergo a procedure that surgically divides their memories between work and life.'),
  S('The Bear', '2022-06-23', ['Drama', 'Comedy'], 'TV-MA', '/sHFlbKS3WLqMnp9t2ghADIJFnuQ.jpg', null, [8, 10, 10], 'A young chef returns to Chicago to run his family’s sandwich shop.'),
  S('Arcane', '2021-11-06', ['Animation', 'Sci-Fi & Fantasy'], 'TV-14', '/fqldf2t8ztc9aiwn3k6mlX3tvRT.jpg', null, [9, 9], 'Sisters fight on rival sides of a war between two cities.'),
  S('The Office', '2005-03-24', ['Comedy'], 'TV-14', '/qWnJzyZhyy74gjpSjIXWmuk0ifX.jpg', null, [6, 22, 25], 'A mockumentary on a group of office workers.'),
  S('Friends', '1994-09-22', ['Comedy', 'Drama'], 'TV-14', '/f496cm9enuEsZkSPzCwnTESEK5s.jpg', null, [24, 24], 'Six friends navigate life and love in Manhattan.'),
  S('Succession', '2018-06-03', ['Drama'], 'TV-MA', '/7HW47XbkNQ5fiwQFYGWdw9gs144.jpg', null, [10, 10, 9, 10], 'The Roy family fights for control of a global media empire.'),
  S('Fleabag', '2016-07-21', ['Comedy', 'Drama'], 'TV-MA', '/27vEYsRKa3eAniwmoccOoluEXQ1.jpg', null, [6, 6], 'A dry-witted woman navigates life and love in London.'),
];

const ago = (mins) => new Date(FIXED_NOW - mins * 60000).toISOString();

const media = [];
const add = (o) => { const row = { id: mid(media.length + 1), season_number: null, parent_id: null, parent: null, episode_count: null, provenance: 'tmdb', tmdb_id: 1000 + media.length, fetched_at: ago(0), popularity: 100 - media.length, ...o }; media.push(row); return row; };
movies.forEach((m) => add(m));
series.forEach((s) => {
  const { seasons, ...rest } = s;
  const parent = add({ ...rest, runtime_minutes: null });
  const embed = { id: parent.id, title: parent.title, poster_path: parent.poster_path, backdrop_path: parent.backdrop_path, genres: parent.genres, original_language: parent.original_language, certification: parent.certification };
  seasons.forEach((eps, i) => {
    const y = Number(parent.release_date.slice(0, 4)) + i;
    add({ kind: 'season', title: `Season ${i + 1}`, season_number: i + 1, release_date: `${y}-${parent.release_date.slice(5)}`, poster_path: parent.poster_path, backdrop_path: null, genres: null, original_language: null, certification: null, episode_count: eps, overview: parent.overview, runtime_minutes: null, parent_id: parent.id, parent: embed });
  });
});
const byId = (id) => media.find((m) => m.id === id);
const byTitle = (t, season = null) => {
  const found = media.find((m) => (season ? m.parent?.title === t && m.season_number === season : m.title === t));
  if (!found) throw new Error(`Mock has no title "${t}"${season ? ` season ${season}` : ''}`);
  return found;
};

/** The id a scene URL needs, looked up by name so reordering the fixtures cannot break a scene. */
export const titleId = (title, season = null) => byTitle(title, season).id;

const embedMedia = (m) => ({ title: m.title, season_number: m.season_number, release_date: m.release_date, poster_path: m.poster_path, genres: m.genres, runtime_minutes: m.runtime_minutes, kind: m.kind, original_language: m.original_language, parent_id: m.parent_id, parent: m.parent, certification: m.certification, episode_count: m.episode_count });

const moviesRanked = movies.slice(0, RANKED_MOVIE_COUNT).map((m) => byTitle(m.title));
const bucketOfMovie = (i) => (i < 9 ? 'loved' : i < 11 ? 'fine' : 'not_for_me');
const tvRanked = [['Stranger Things', 1], ['Severance', 1], ['The Bear', 2], ['Arcane', 1], ['The Office', 2], ['Friends', 1], ['Succession', 4], ['Fleabag', 2], ['Severance', 2], ['The Bear', 1], ['Stranger Things', 3], ['The Office', 3], ['Stranger Things', 2], ['The Office', 1], ['Friends', 2], ['Fleabag', 1]].map(([t, s]) => byTitle(t, s));
const myRankings = [
  ...moviesRanked.map((m, i) => ({ user_id: VIEWER, media_item_id: m.id, bucket: bucketOfMovie(i), position: i + 1, category: 'movies', created_at: ago(1000 + i * 700) })),
  ...tvRanked.map((m, i) => ({ user_id: VIEWER, media_item_id: m.id, bucket: i < 9 ? 'loved' : 'fine', position: i + 1, category: 'tv_seasons', created_at: ago(1500 + i * 900) })),
];
const watchlistIds = ['Forrest Gump', 'The Shawshank Redemption', 'Shrek', 'Titanic', 'Twilight', 'Avatar'].map((t) => byTitle(t).id).concat([byTitle('Succession', 1).id, byTitle('The Bear', 3).id]);

const rankRow = (user_id, m, bucket, position, category) => ({ user_id, media_item_id: m.id, bucket, position, category, created_at: ago(60) });
const friendRankings = (u) => moviesRanked.slice(0, 18).map((m, i) => rankRow(u, m, i < 12 ? 'loved' : 'fine', i + 1, 'movies'));

const ev = (id, type, actor, m, minsAgo, payload = {}) => ({ id, type, actor_id: actor.id, media_item_id: m?.id ?? null, created_at: ago(minsAgo), causal_at: ago(minsAgo), causal_step: 1, payload, media_items: m ? { ...embedMedia(m) } : null, profiles: { username: actor.username, display_name: actor.display_name, avatar_path: actor.avatar_path } });
const [maya, theo, priya, jonah, sofia, sam] = people;
const feedEvents = () => [
  ev('e1', 'title_ranked', maya, byTitle('Spirited Away'), 12, { position: 3, score: 9.2, bucket: 'loved', category: 'movies' }),
  ev('e2', 'title_ranked', theo, byTitle('Severance', 1), 45, { position: 2, score: 9.6, bucket: 'loved', category: 'tv_seasons' }),
  ev('e3', 'follow_added', priya, null, 80, { followed: [{ id: jonah.id }], count: 3 }),
  ev('e4', 'watchlist_added', jonah, byTitle('Interstellar'), 130, {}),
  ev('e5', 'award_earned', sofia, null, 200, { award: 'movie-muncher', tier: 'silver', award_name: 'Movie Muncher', tier_label: 'Silver' }),
  ev('e6', 'title_ranked', sam, byTitle('Barbie'), 300, { position: 41, score: 5.8, bucket: 'fine', category: 'movies' }),
  ev('e7', 'title_logged', maya, byTitle('Coco'), 420, { bucket: 'loved' }),
  ev('e8', 'ranking_batch', theo, null, 700, { count: 6, category: 'movies' }),
  ev('e9', 'title_ranked', priya, byTitle('Whiplash'), 1300, { position: 1, score: 10, bucket: 'loved', category: 'movies' }),
];

const trendingMovieIds = () => ['Spirited Away', 'Zootopia', 'Knives Out', 'Barbie', 'Avatar', 'Titanic', 'Shrek', 'Coco'].map((t) => byTitle(t).id);
const trendingTvIds = () => ['Stranger Things', 'Severance', 'The Bear', 'Arcane', 'The Office', 'Friends'].map((t) => byTitle(t).id);
const forYouIds = (kind) => media.filter((m) => m.kind === kind && !moviesRanked.includes(m)).map((m) => m.id);

const notes = () => [
  { id: 'n1', kind: 'follow_request', created_at: ago(30), read_at: null, actor_id: sam.id, actor_username: sam.username, actor_display_name: sam.display_name, actor_avatar_path: null, media_item_id: null, media_title: null, media_kind: null, series_title: null, subject_type: null, subject_id: null, payload: null },
  { id: 'n2', kind: 'reaction', created_at: ago(70), read_at: null, actor_id: maya.id, actor_username: maya.username, actor_display_name: maya.display_name, actor_avatar_path: null, media_item_id: byTitle('Coco').id, media_title: 'Coco', media_kind: 'movie', series_title: null, subject_type: 'feed_event', subject_id: 'e1', subject_activity_type: 'title_ranked', payload: null },
  { id: 'n3', kind: 'comment', created_at: ago(200), read_at: null, actor_id: theo.id, actor_username: theo.username, actor_display_name: theo.display_name, actor_avatar_path: null, media_item_id: byTitle('Inception').id, media_title: 'Inception', media_kind: 'movie', series_title: null, subject_type: 'feed_event', subject_id: 'e1', subject_activity_type: 'title_ranked', comment_excerpt: 'Top 3?? We need to talk.', payload: null },
  { id: 'n4', kind: 'recommendation', created_at: ago(1600), read_at: ago(1500), actor_id: priya.id, actor_username: priya.username, actor_display_name: priya.display_name, actor_avatar_path: null, media_item_id: byTitle('Severance', 1).id, media_title: 'Season 1', media_kind: 'season', series_title: 'Severance', subject_type: null, subject_id: null, payload: null, viewer_ranked: false },
  { id: 'n5', kind: 'follow', created_at: ago(3000), read_at: ago(2900), actor_id: jonah.id, actor_username: jonah.username, actor_display_name: jonah.display_name, actor_avatar_path: null, media_item_id: null, media_title: null, media_kind: null, series_title: null, subject_type: null, subject_id: null, payload: { mutual: true } },
  { id: 'n6', kind: 'award_earned', created_at: ago(9000), read_at: ago(8900), actor_id: null, actor_username: null, actor_display_name: null, actor_avatar_path: null, media_item_id: null, media_title: null, media_kind: null, series_title: null, subject_type: null, subject_id: null, payload: { award: 'movie-muncher', tier: 'bronze', award_name: 'Movie Muncher', tier_label: 'Bronze' } },
];

const friends = () => (scenario === 'newuser' ? [] : [maya, theo, priya, jonah, sofia]);
const follows = () => friends().flatMap((p) => [
  { follower_id: VIEWER, followee_id: p.id, state: 'approved', created_at: ago(90000), profiles: p, public_profiles: p, followee: p, follower: me },
  { follower_id: p.id, followee_id: VIEWER, state: 'approved', created_at: ago(90000), profiles: p, public_profiles: p, followee: me, follower: p },
]);

const withMedia = (rows) => rows.map((r) => ({ ...r, media_items: embedMedia(byId(r.media_item_id)) }));
const newUser = () => scenario === 'newuser';
const firstRun = newUser;

const rankState = { answers: 0, placed: [] };
const place = (id, bucket, score) => { rankState.placed.push({ id, bucket, score }); };

const tables = {
  profiles: () => [me, ...people],
  public_profiles: () => [me, ...people],
  media_items: () => media,
  rankings: (q) => {
    const u = q.user_id;
    if (u && u !== VIEWER) return withMedia(friendRankings(u));
    if (newUser()) return withMedia(rankState.placed.map((r, i) => ({ user_id: VIEWER, media_item_id: r.id, bucket: r.bucket, position: i + 1, category: 'movies', created_at: ago(5 - i) })));
    if (rankState.placed.length) {
      const extra = rankState.placed[0];
      const shifted = myRankings.map((r) => (r.category === 'movies' && r.position >= 4 ? { ...r, position: r.position + 1 } : r));
      return withMedia([...shifted, { user_id: VIEWER, media_item_id: extra.id, bucket: 'loved', position: 4, category: 'movies', created_at: ago(1) }]);
    }
    return withMedia(myRankings);
  },
  user_media: (q) => {
    if (newUser()) return [];
    if (q.user_id && q.user_id !== VIEWER) return withMedia(friendRankings(q.user_id).map((r) => ({ ...r, watched_on: '2026-08-14' })));
    // Everything logged is ranked, or the Collection leads with an unranked-titles card.
    return withMedia(myRankings.map((r) => ({ user_id: VIEWER, media_item_id: r.media_item_id, bucket: r.bucket, watched_on: '2026-10-12', created_at: r.created_at, note: null })));
  },
  logged_collection: () => [],
  watchlist: () => (newUser() ? [] : withMedia(watchlistIds.map((id, i) => ({ user_id: VIEWER, media_item_id: id, created_at: ago(2000 + i * 100) })))),
  follows,
  feed_events: () => (newUser() ? [] : feedEvents()),
  provider_list_cache: () => [
    { list_key: 'trending.movie.day', payload: { ids: trendingMovieIds() }, fetched_at: ago(30), expires_at: ago(-300) },
    { list_key: 'trending.series.day', payload: { ids: trendingTvIds() }, fetched_at: ago(30), expires_at: ago(-300) },
    { list_key: 'trending.movie.week', payload: { ids: forYouIds('movie') }, fetched_at: ago(30), expires_at: ago(-300) },
    { list_key: 'trending.series.week', payload: { ids: forYouIds('series') }, fetched_at: ago(30), expires_at: ago(-300) },
  ],
  award_unlocks: () => (newUser() ? [] : [{ user_id: VIEWER, award_key: 'season-snacker', tier_key: 'bronze', value_at_unlock: 15, earned_at: ago(9000) }, { user_id: VIEWER, award_key: 'invite-instigator', tier_key: 'bronze', value_at_unlock: 3, earned_at: ago(12000) }]),
  watch_tags: () => [],
  recommendation_feedback: () => [],
  watch_goals: () => (newUser() ? [] : [{ category: 'movies', target: 25 }, { category: 'tv_seasons', target: 20 }]),
  invite_attributions: () => (newUser() ? [] : [maya, theo, priya].map((p) => ({ invitee_id: p.id, inviter_id: VIEWER, activated_at: ago(90000), invitee: p }))),
  comments: () => [],
  title_recommendations: () => [],
  ranking_placements: () => [],
  import_jobs: () => [],
  person_cache: () => [],
  reactions: () => (newUser() ? [] : [{ feed_event_id: 'e1', user_id: theo.id, kind: 'love', profiles: { id: theo.id, display_name: theo.display_name, username: theo.username, avatar_path: null } }, { feed_event_id: 'e1', user_id: priya.id, kind: 'fire', profiles: { id: priya.id, display_name: priya.display_name, username: priya.username, avatar_path: null } }]),
  watch_events: () => (newUser() ? [] : [...moviesRanked, ...tvRanked].map((m, i) => ({ id: 'w' + i, user_id: VIEWER, media_item_id: m.id, watched_on: '2026-' + String(1 + (i % 10)).padStart(2, '0') + '-14', media_items: { kind: m.kind, title: m.title, poster_path: m.poster_path } }))),
  media_cache: (q) => {
    const facet = q.facet;
    const expires_at = ago(-6000);
    const ids = (q.media_item_id ?? '').startsWith('in.(') ? q.media_item_id.slice(4, -1).split(',').map((s) => s.replace(/"/g, '')) : null;
    if (facet === 'similar' && ids) return ids.map((media_item_id) => ({ media_item_id, facet, expires_at, payload: { ids: forYouIds('movie').slice(0, 12) } }));
    const id = q.media_item_id;
    // Empty on purpose: a cast list is real people's names, and no scene needs one.
    if (facet === 'credits') return [{ media_item_id: id, facet, expires_at, payload: { cast: [], crew: [] } }];
    if (facet === 'similar') return [{ media_item_id: id, facet, expires_at, payload: { ids: forYouIds('movie').slice(0, 12) } }];
    if (facet === 'videos') return [{ media_item_id: id, facet, expires_at, payload: { results: [] } }];
    return [];
  },
};

const leaderboardRows = () => [
  { user_id: priya.id, username: priya.username, display_name: priya.display_name, avatar_path: null, visibility: 'public', metric_count: 41, rank: 1, is_you: false, viewable: true, match_percent: 91, shared_count: 37 },
  { user_id: VIEWER, username: me.username, display_name: me.display_name, avatar_path: null, visibility: 'public', metric_count: 34, rank: 2, is_you: true, viewable: true, match_percent: null, shared_count: null },
  { user_id: maya.id, username: maya.username, display_name: maya.display_name, avatar_path: null, visibility: 'public', metric_count: 28, rank: 3, is_you: false, viewable: true, match_percent: 84, shared_count: 22 },
  { user_id: theo.id, username: theo.username, display_name: theo.display_name, avatar_path: null, visibility: 'public', metric_count: 15, rank: 4, is_you: false, viewable: true, match_percent: 62, shared_count: 11 },
  { user_id: jonah.id, username: jonah.username, display_name: jonah.display_name, avatar_path: null, visibility: 'public', metric_count: 9, rank: 5, is_you: false, viewable: true, match_percent: null, shared_count: 3 },
];
const suggestion = (p, extra) => ({ id: p.id, user_id: p.id, username: p.username, display_name: p.display_name, avatar_path: null, visibility: 'public', follow_state: 'none', ...extra });

const sent = (id, actor, m, minsAgo, message) => ({ id, sender_id: actor.id, sender_username: actor.username, sender_display_name: actor.display_name, sender_avatar_path: null, media_item_id: m.id, media_kind: m.kind, media_title: m.title, series_title: m.parent?.title ?? null, poster_path: m.poster_path, release_date: m.release_date, genres: m.genres, original_language: m.original_language, runtime_minutes: m.runtime_minutes, recommended_at: ago(minsAgo), opened_at: null, message });

const rpc = {
  starter_movies: () => movies.slice(0, 18).map((m) => { const r = byTitle(m.title); return { id: r.id, media_item_id: r.id, title: r.title, release_date: r.release_date, poster_path: r.poster_path, kind: 'movie', tier: 'core' }; }),
  public_scores: (b) => {
    const rows = [];
    const ids = b.p_media_item_ids ?? [];
    const score = { [byTitle('Spirited Away').id]: [9.2, 3, 'loved', 'movies'], [byTitle('Severance', 1).id]: [9.6, 2, 'loved', 'tv_seasons'], [byTitle('Barbie').id]: [5.8, 41, 'fine', 'movies'], [byTitle('Whiplash').id]: [10, 1, 'loved', 'movies'] };
    for (const f of [maya, theo, priya, jonah, sofia, sam]) for (const id of ids.length ? ids : Object.keys(score)) if (score[id]) rows.push({ user_id: f.id, media_item_id: id, category: score[id][3], bucket: score[id][2], position: score[id][1], score: score[id][0] });
    return rows;
  },
  public_notes: () => [{ user_id: theo.id, media_item_id: byTitle('Severance', 1).id, body: 'Episode three broke me.', text: 'Episode three broke me.', note: 'Episode three broke me.', has_spoilers: false, spoilers: false }],
  feed_watch_scores: () => [],
  activity_comment_counts: () => [{ feed_event_id: 'e1', count: 3 }],
  activity_comments: () => [{ id: 'c1', feed_event_id: 'e1', author_id: theo.id, parent_id: null, body: 'Top 3?? We need to talk.', has_spoilers: false, created_at: ago(9), edited_at: null, deleted_at: null, username: theo.username, display_name: theo.display_name, avatar_path: null, reaction_count: 0, reacted_by_me: false, reaction_kinds: [], my_reaction: null, mentions: [] }, { id: 'c2', feed_event_id: 'e1', author_id: priya.id, parent_id: 'c1', body: 'The score alone earns it.', has_spoilers: false, created_at: ago(5), edited_at: null, deleted_at: null, username: priya.username, display_name: priya.display_name, avatar_path: null, reaction_count: 1, reacted_by_me: false, reaction_kinds: ['love'], my_reaction: null, mentions: [] }],
  my_notifications: () => (newUser() ? [] : notes()),
  my_notification_preferences: () => ['social', 'follows', 'follow_accepted', 'comments', 'reactions', 'watch_tags', 'recommendations', 'invites', 'achievements', 'awards', 'ranking_nudges', 'streaks', 'reminders'].map((category) => ({ category, enabled: true })),
  my_blocks: () => [],
  list_view: () => ({ id: 'l1', title: 'Movies that ruined my weekend', description: 'In the best way.', order_style: 'ranked', item_count: 6, updated_at: ago(600), is_owner: true, shareable_by_viewer: true, visibility: 'public', hidden: false, owner: { id: VIEWER, username: me.username, display_name: me.display_name, avatar_path: null, profile_visible: true } }),
  list_items_page: () => moviesRanked.slice(0, 6).map((m, i) => ({ media_item_id: m.id, kind: 'movie', title: m.title, year: Number(m.release_date.slice(0, 4)), poster_path: m.poster_path, season_number: null, parent_title: null, position: i + 1, ordinal: i + 1, viewer_seen: true, viewer_watchlisted: false })),
  my_lists: () => (newUser() ? [] : [
    { id: 'l1', title: 'Movies that ruined my weekend', item_count: 6, order_style: 'ranked', visibility: 'public', hidden: false, updated_at: ago(600), posters: moviesRanked.slice(0, 4).map((m) => m.poster_path) },
    { id: 'l2', title: 'Date night, no notes', item_count: 4, order_style: 'unordered', visibility: 'public', hidden: false, updated_at: ago(6000), posters: moviesRanked.slice(10, 14).map((m) => m.poster_path) },
  ]),
  profile_lists: () => (newUser() ? [] : [{ id: 'l1', title: 'Movies that ruined my weekend', item_count: 6, order_style: 'ranked', updated_at: ago(600), posters: moviesRanked.slice(0, 4).map((m) => m.poster_path) }]),
  profile_title_counts: () => (newUser() ? { movies: 0, tv: 0 } : { movies: moviesRanked.length, tv: tvRanked.length }),
  profile_identity: (b) => { const p = [me, ...people].find((x) => x.username === b.p_username); return p ? [p] : []; },
  taste_match: () => [{ score: 87, common_count: 34, min_common: 5 }],
  community_score: () => [{ score: 8.4, rating_count: 128, ratings: 128, count: 128, min_ratings: 3 }],
  following_score: () => [{ score: 9.1, rating_count: 3, count: 3 }],
  following_ratings: () => [],
  title_recommendations_for_me: () => [],
  title_reviews_v2: () => [],
  title_review_count: () => 0,
  // Unranked titles only: the app drops a recommendation once the viewer has ranked it.
  recommendations_to_me: () => (newUser() ? [] : [sent('r1', priya, byTitle('Arcane', 2), 1600, 'You will lose your mind.'), sent('r2', maya, byTitle('Shrek'), 4300, null), sent('r3', theo, byTitle('The Matrix'), 9000, 'Still holds up.'), sent('r4', sofia, byTitle('Whiplash'), 12000, null), sent('r5', jonah, byTitle('Stranger Things', 4), 15000, 'Finish it this weekend.'), sent('r6', maya, byTitle('Avatar'), 21000, null)]),
  recommendation_requests: () => [],
  recommendation_exposure_within: () => [],
  recommendation_exposure: () => [],
  social_candidates: () => [],
  note_recommendations_shown: () => null,
  leaderboard: () => (newUser() ? [] : leaderboardRows()),
  my_leaderboard_standing: () => [{ metric_count: 34, rank: 2, entrants: 5 }],
  people_mutuals: () => (newUser() ? [] : [suggestion(sofia, { mutual_count: 3, mutual_names: ['Maya Chen', 'Theo Okafor'] }), suggestion(sam, { mutual_count: 1, mutual_names: ['Priya Nair'] })]),
  people_taste_matches: () => (newUser() ? [] : [suggestion(people[6], { match_score: 89, match_percent: 89, score: 89, common_count: 21, shared_count: 21 })]),
  people_starter_suggestions: () => [maya, theo, priya, jonah].map((p, i) => suggestion(p, { shared_count: 4 - i, ranked_count: 120 - i * 20 })),
  mutuals_with: () => [],
  follow_activity_people: () => [{ event_id: 'e3', feed_event_id: 'e3', user_id: jonah.id, id: jonah.id, username: jonah.username, display_name: jonah.display_name, avatar_path: null, total: 1 }],
  follow_state_with: (b) => (b.p_user_ids ?? []).map((id) => { const f = friends().some((x) => x.id === id); return { user_id: id, following: f ? 'approved' : 'none', followed_by: f ? 'approved' : 'none', blocked: false }; }),
  search_titles: (b) => { const q = (b.p_query ?? '').toLowerCase(); return media.filter((m) => m.kind !== 'season' && m.title.toLowerCase().includes(q)).slice(0, 25).map((m) => ({ id: m.id, kind: m.kind, title: m.title, release_date: m.release_date, poster_path: m.poster_path, provenance: 'tmdb', genres: m.genres, runtime_minutes: m.runtime_minutes })); },
  search_users: (b) => { const q = (b.p_query ?? '').toLowerCase(); return people.filter((p) => p.display_name.toLowerCase().includes(q)).map((p) => suggestion(p, {})); },
  username_available: () => true,
  group_picks: () => ({ effective_member_count: 3, picks: ['Knives Out', 'Coco', 'Zootopia', 'La La Land', 'Shrek', 'Interstellar'].map((t, i) => ({ community_score: i % 3 === 2 ? null : 8.6 - i * 0.2, media_item_id: byTitle(t).id, group_score: 8.9 - i * 0.3, score: 8.9 - i * 0.3, saves: 3 - (i % 3), popularity: 100 - i, on_watchlist_count: 1 })) }),
  top_rated_titles: () => media.filter((m) => m.kind === 'movie').slice(0, 15).map((m, i) => ({ media_item_id: m.id, score: 9.4 - i * 0.1, rating_count: 200 - i * 9 })),
  invited_signup_count: () => 3,
  my_lists_for_title: () => [],
  list_viewer_progress: () => [],
  ranking_backlog: () => [],
  refine_candidates: () => [],
  import_status: () => null,
  report_device_context: () => null,
  mark_notifications_read: () => null,
  set_bucket: () => ({ ok: true, bucket: 'loved' }),
  log_watched: () => ({ ok: true }),
  log_title: () => ({ ok: true }),
  rank_start: (b) => { rankState.answers = 0; rankState.subject = b.p_media_item_id; rankState.count = (rankState.count ?? 0) + 1; if (firstRun() && rankState.count === 1) { place(b.p_media_item_id, 'loved', 10); return { done: true, position: 1, category: 'movies', bucket: 'loved', score: 10, adjustable: false }; } if (firstRun()) return { session_id: 'mock-session', pivot: rankState.placed[0].id, skipped: false };
    return { session_id: 'mock-session', pivot: byTitle('Interstellar').id === b.p_media_item_id ? byTitle('Inception').id : byTitle('Interstellar').id, skipped: false }; },
  rank_answer: () => { rankState.answers += 1; if (firstRun()) { place(rankState.subject, 'loved', 10 - rankState.count * 0.5); return { done: true, position: rankState.count, category: 'movies', bucket: 'loved', score: 10 - rankState.count * 0.5, adjustable: false }; } const pivots = ['Coco', 'Spider-Man: Into the Spider-Verse', 'Zootopia']; if (rankState.answers >= 3) { place(rankState.subject, 'loved', 8.9); return { done: true, position: 4, category: 'movies', bucket: 'loved', score: 8.9, adjustable: false }; } return { session_id: 'mock-session', pivot: byTitle(pivots[rankState.answers - 1]).id, skipped: false }; },
  rank_back: () => ({ session_id: 'mock-session', pivot: byTitle('Inception').id, skipped: false }),
  rank_skip: () => ({ session_id: 'mock-session', pivot: byTitle('Coco').id, skipped: true }),
  rank_cancel: () => null,
};

/** The fixture answers the capture test reads, without a server. */
export const fixtures = { tables, rpc };

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,HEAD,OPTIONS', 'access-control-expose-headers': 'content-range' };
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...cors, ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const note = (k) => unhandled.set(k, (unhandled.get(k) ?? 0) + 1);

function applyFilters(rows, url) {
  let out = rows;
  for (const [k, raw] of url.searchParams) {
    if (['select', 'limit', 'order', 'offset', 'or', 'and'].includes(k)) continue;
    if (k.includes('.')) continue;
    const m = raw.match(/^(not\.)?(eq|in|gt|gte|lt|lte|is|neq|ilike)\.(.*)$/s);
    if (!m) continue;
    const [, , op, val] = m;
    if (!(out[0] && k in out[0])) continue;
    if (op === 'eq') out = out.filter((r) => String(r[k]) === val);
    if (op === 'in') { const set = val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')); out = out.filter((r) => set.includes(String(r[k]))); }
    if (op === 'is' && val === 'null') out = out.filter((r) => r[k] == null);
    if (op === 'gt') out = out.filter((r) => String(r[k]) > val);
  }
  out = [...out].sort((a, b) => (a.media_item_id && b.media_item_id ? String(a.media_item_id).localeCompare(String(b.media_item_id)) : 0));
  const limit = Number(url.searchParams.get('limit'));
  return limit ? out.slice(0, limit) : out;
}

function handle(req, res, port) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204);
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
    if (p === '/__scenario') { scenario = body.name; rankState.answers = 0; rankState.count = 0; rankState.placed = []; return send(res, 200, { scenario }); }
    if (p === '/__log') return send(res, 200, Object.fromEntries(unhandled));
    if (p.startsWith('/auth/v1/')) {
      if (p.endsWith('/user')) return send(res, 200, { id: VIEWER, aud: 'authenticated', role: 'authenticated', email: VIEWER_EMAIL, app_metadata: {}, user_metadata: {}, created_at: ago(99999) });
      if (p.endsWith('/logout')) return send(res, 204);
      return send(res, 200, {});
    }
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.slice('/rest/v1/rpc/'.length);
      const h = rpc[fn];
      if (!h) { note(`rpc:${fn} ${raw.slice(0, 120)}`); return send(res, 200, []); }
      return send(res, 200, h(body) ?? null);
    }
    if (p.startsWith('/rest/v1/')) {
      const t = p.slice('/rest/v1/'.length);
      const q = Object.fromEntries([...url.searchParams].map(([k, v]) => [k, v.replace(/^eq\./, '')]));
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 200, []);
      let rows = [];
      if (tables[t]) rows = applyFilters(tables[t](q), url); else note(`table:${t} ${url.search.slice(0, 120)}`);
      const headers = { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` };
      if (req.method === 'HEAD') return send(res, 200, undefined, headers);
      if ((req.headers.accept ?? '').includes('vnd.pgrst.object')) return rows[0] ? send(res, 200, rows[0], headers) : send(res, 406, { code: 'PGRST116', message: 'no rows', details: '0 rows' });
      return send(res, 200, rows, headers);
    }
    if (p.startsWith('/functions/v1/')) {
      if (p.endsWith('/push-sender')) return send(res, 200, {});
      const a = body.action;
      if (a === 'watch-providers') return send(res, 200, { region: 'US', link: null, providers: [{ provider_id: 8, name: 'Netflix', logo_path: null, offers: ['stream'] }, { provider_id: 9, name: 'Prime Video', logo_path: null, offers: ['rent', 'buy'] }, { provider_id: 350, name: 'Apple TV', logo_path: null, offers: ['rent', 'buy'] }, { provider_id: 384, name: 'Max', logo_path: null, offers: ['stream'] }] });
      if (a === 'season-episodes') return send(res, 200, { id: body.mediaItemId, episodes: Array.from({ length: 9 }, (_, i) => ({ episode_number: i + 1, name: `Episode ${i + 1}`, air_date: '2023-01-' + String(15 + i).padStart(2, '0'), runtime: 58, still_path: null, overview: 'Fixture synopsis for layout review.' })) });
      if (a === 'search') return send(res, 200, { results: [] });
      if (a === 'search-people') return send(res, 200, { results: [] });
      if (a === 'detail' || a === 'similar') return send(res, 200, { id: body.mediaItemId, written: 0 });
      note('fn:' + p + ' ' + raw.slice(0, 140));
      return send(res, 200, {});
    }
    if (p.startsWith('/storage/')) return send(res, 404, { message: 'none' });
    note(`other:${req.method} ${p}`);
    return send(res, 404, {});
  });
}

/** Binds to loopback only. Resolves once listening; `stop()` closes every open socket. */
export function startMock(port) {
  const server = http.createServer((req, res) => handle(req, res, port));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      setScenario: (name) => { scenario = name; rankState.answers = 0; rankState.count = 0; rankState.placed = []; },
      unhandled: () => Object.fromEntries(unhandled),
      stop: () => new Promise((done) => { server.close(done); server.closeAllConnections(); }),
    }));
  });
}
