#!/usr/bin/env node
/**
 * One Letterboxd import through STAGING's real pipeline, timed from the outside.
 *
 *   node supabase/tests/perf/import-staging-run.mjs --size 24 [--provider 3] [--unknown 1] [--keep]
 *
 * What `import-scale.mjs` cannot prove, because it stands in for them: pg_cron's real cadence,
 * pg_net's real post, the deployed Edge Function, real TMDB latency and rate limits, and the
 * lifecycle notification written on a real project. This creates a throwaway account (the
 * staging QA cohort's marker, `qa_bench_*`), stages a deterministic archive through the same
 * RPCs the phone uses, calls `import_ready`, and then does what the phone does not have to:
 * nothing but watch, from a service-role connection, until the job ends. The phone can be
 * closed for the whole of it, and here it is.
 *
 * **Staging only, and refused otherwise**: every request goes through the cohort's `connect()`
 * (host, both keys' `ref` claim, the lane config and `environment_name()` must all say staging).
 * Keys live in this process's memory and are never printed or written.
 *
 * **TMDB is used sparingly on purpose.** Most rows are films staging's catalogue already has
 * (the cached / local path). `--provider` real films that are NOT in the catalogue go to TMDB
 * once each; `--unknown` made-up titles go to TMDB and come back empty. A 2,500-row run beyond
 * the catalogue's ~1,400 distinct dated films re-references catalogue films under distinct
 * Letterboxd URIs, which exercises the same match and apply path; it is labelled so.
 */
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const SIZE = Number(option('--size', '24'));
const PROVIDER = Number(option('--provider', String(Math.max(1, Math.round(SIZE * 0.04)))));
const UNKNOWN = Number(option('--unknown', String(Math.max(1, Math.round(SIZE * 0.01)))));
const KEEP = args.includes('--keep');
const COHORT = new URL('../../../scripts/staging/qa-cohort.mjs', import.meta.url);

/** Real films, mostly older or non-English, chosen to be absent from a young catalogue. */
const REAL_FILMS = [
  ['Tokyo Story', 1953], ['Ugetsu', 1953], ['Sansho the Bailiff', 1954], ['Ikiru', 1952],
  ['The Hidden Fortress', 1958], ['High and Low', 1963], ['Red Beard', 1965], ['Dersu Uzala', 1975],
  ['Kagemusha', 1980], ['Ran', 1985], ['Late Spring', 1949], ['Floating Weeds', 1959],
  ['An Autumn Afternoon', 1962], ['Harakiri', 1962], ['Onibaba', 1964], ['Woman in the Dunes', 1964],
  ['The Human Condition I: No Greater Love', 1959], ['Pather Panchali', 1955], ['Aparajito', 1956],
  ['The World of Apu', 1959], ['Charulata', 1964], ['The Music Room', 1958], ['Nayakan', 1987],
  ['Pyaasa', 1957], ['Mother India', 1957], ['Sholay', 1975], ['Deewaar', 1975],
  ['The 400 Blows', 1959], ['Breathless', 1960], ['Jules and Jim', 1962], ['Contempt', 1963],
  ['Pierrot le Fou', 1965], ['Band of Outsiders', 1964], ['Cleo from 5 to 7', 1962],
  ['Le Samourai', 1967], ['Army of Shadows', 1969], ['The Umbrellas of Cherbourg', 1964],
  ['Playtime', 1967], ['Mon Oncle', 1958], ['Les Diaboliques', 1955], ['The Wages of Fear', 1953],
  ['Rififi', 1955], ['Pickpocket', 1959], ['Au Hasard Balthazar', 1966], ['Mouchette', 1967],
  ['The Rules of the Game', 1939], ['Grand Illusion', 1937], ['L\'Atalante', 1934],
  ['Children of Paradise', 1945], ['Hiroshima Mon Amour', 1959], ['Last Year at Marienbad', 1961],
  ['La Dolce Vita', 1960], ['8½', 1963], ['Nights of Cabiria', 1957], ['La Strada', 1954],
  ['L\'Avventura', 1960], ['L\'Eclisse', 1962], ['Red Desert', 1964], ['The Leopard', 1963],
  ['Rocco and His Brothers', 1960], ['Il Sorpasso', 1962], ['The Battle of Algiers', 1966],
  ['Accattone', 1961], ['Mamma Roma', 1962], ['The Gospel According to St. Matthew', 1964],
  ['Wild Strawberries', 1957], ['The Seventh Seal', 1957], ['Persona', 1966], ['Cries and Whispers', 1972],
  ['Fanny and Alexander', 1982], ['Winter Light', 1963], ['Through a Glass Darkly', 1961],
  ['Scenes from a Marriage', 1974], ['Autumn Sonata', 1978], ['The Virgin Spring', 1960],
  ['Ordet', 1955], ['Day of Wrath', 1943], ['Vampyr', 1932], ['The Passion of Joan of Arc', 1928],
  ['M', 1931], ['Metropolis', 1927], ['Nosferatu', 1922], ['The Cabinet of Dr. Caligari', 1920],
  ['Wings of Desire', 1987], ['Paris, Texas', 1984], ['Alice in the Cities', 1974],
  ['Aguirre, the Wrath of God', 1972], ['Fitzcarraldo', 1982], ['Stroszek', 1977],
  ['The Marriage of Maria Braun', 1979], ['Ali: Fear Eats the Soul', 1974], ['Andrei Rublev', 1966],
  ['Solaris', 1972], ['Mirror', 1975], ['Stalker', 1979], ['Ivan\'s Childhood', 1962],
  ['Come and See', 1985], ['The Cranes Are Flying', 1957], ['Ballad of a Soldier', 1959],
  ['Man with a Movie Camera', 1929], ['Battleship Potemkin', 1925], ['Closely Watched Trains', 1966],
  ['Daisies', 1966], ['The Firemen\'s Ball', 1967], ['Knife in the Water', 1962], ['Ashes and Diamonds', 1958],
  ['Man of Marble', 1977], ['The Decalogue', 1989], ['Three Colors: Blue', 1993], ['Three Colors: Red', 1994],
  ['The Double Life of Veronique', 1991], ['Werckmeister Harmonies', 2000], ['Satantango', 1994],
  ['A Brighter Summer Day', 1991], ['Yi Yi', 2000], ['A City of Sadness', 1989],
  ['Chungking Express', 1994], ['Fallen Angels', 1995], ['Happy Together', 1997], ['Days of Being Wild', 1990],
  ['Raise the Red Lantern', 1991], ['Farewell My Concubine', 1993], ['To Live', 1994],
  ['Black Girl', 1966], ['Touki Bouki', 1973], ['Xala', 1975], ['Yeelen', 1987],
  ['Memories of Underdevelopment', 1968], ['I Am Cuba', 1964], ['Black God, White Devil', 1964],
  ['Pixote', 1980], ['Los Olvidados', 1950], ['Viridiana', 1961], ['The Exterminating Angel', 1962],
  ['The Spirit of the Beehive', 1973], ['Cria Cuervos', 1976], ['Taste of Cherry', 1997],
  ['Close-Up', 1990], ['Where Is the Friend\'s House?', 1987], ['The Cow', 1969], ['A Separation', 2011],
];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // The staging QA cohort owns the guard; this reuses it rather than keeping a second copy.
  const { connect } = await import(COHORT.href);
  const api = await connect();
  const run = randomBytes(3).toString('hex');
  const r = rng(SIZE * 31 + 7);

  // ---------------------------------------------------------------------------
  // The archive
  // ---------------------------------------------------------------------------
  const catalogue = await api.rows(
    `media_items?kind=eq.movie&tmdb_id=not.is.null&release_date=not.is.null&select=id,title,release_date&order=id.asc&limit=2000`,
  );
  const inCatalogue = new Set(catalogue.map((m) => `${m.title.toLowerCase()}|${m.release_date.slice(0, 4)}`));
  const providerFilms = REAL_FILMS.filter(([title, year]) => !inCatalogue.has(`${title.toLowerCase()}|${year}`))
    .slice(0, PROVIDER);
  const watchlistCount = Math.max(1, Math.floor(SIZE / 10));
  const localCount = Math.max(0, SIZE - providerFilms.length - UNKNOWN);

  const rows = [];
  const uri = (slug) => `https://letterboxd.com/film/bench-${run}-${slug}/`;
  const watched = (name, year, slug) => {
    const diary = r() < 0.4;
    const viewings = diary ? 1 + Math.floor(r() * 3) : 0;
    const rated = r() < 0.6;
    const watches = Array.from({ length: viewings }, (_, v) => ({
      diaryUri: `https://boxd.it/bench${run}${slug}v${v}`,
      watchedOn: `${2016 + ((rows.length + v) % 9)}-0${1 + (v % 9)}-1${v}`,
      isRewatch: v > 0,
    }));
    rows.push({
      kind: 'watched',
      correlation: uri(slug),
      name,
      year,
      filmUri: uri(slug),
      rating: rated ? [1, 2, 2.5, 3, 3.5, 4, 4.5, 5][Math.floor(r() * 8)] : null,
      bucket: rated ? (r() < 0.5 ? 'loved' : r() < 0.7 ? 'fine' : 'not_for_me') : null,
      watchedOn: watches.at(-1)?.watchedOn ?? null,
      watches,
    });
  };
  let reused = 0;
  for (let i = 0; i < localCount; i += 1) {
    const film = catalogue[i % catalogue.length];
    if (i >= catalogue.length) reused += 1;
    watched(film.title, Number(film.release_date.slice(0, 4)), `l${i}`);
  }
  providerFilms.forEach(([title, year], i) => watched(title, year, `p${i}`));
  for (let i = 0; i < UNKNOWN; i += 1) watched(`Qqzx Unmade Bench Film ${run} ${i}`, 2003, `u${i}`);
  for (let i = 0; i < watchlistCount; i += 1) {
    const film = catalogue[(catalogue.length - 1 - i + catalogue.length) % catalogue.length];
    rows.push({
      kind: 'watchlist',
      correlation: uri(`w${i}`),
      name: film.title,
      year: Number(film.release_date.slice(0, 4)),
      filmUri: uri(`w${i}`),
      rating: null,
      bucket: null,
      watchedOn: null,
      watches: [],
    });
  }

  // ---------------------------------------------------------------------------
  // The account
  // ---------------------------------------------------------------------------
  const email = `qa-cohort+bench_${run}@example.com`;
  const password = `Qa-${randomBytes(24).toString('base64url')}-9z`;
  const created = await api.service('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { qa_cohort: 'bench' } }),
  });
  if (!created.ok) throw new Error(`could not create bench account: ${created.status}`);
  const userId = created.body.id;
  const token = await api.signIn(email, password);
  const profile = await api.rpc(token, 'create_profile', {
    p_username: `qa_bench_${run}`,
    p_display_name: 'QA · Import bench',
    p_date_of_birth: '1990-01-01',
  });
  if (!profile.ok) throw new Error(`create_profile failed: ${profile.status}`);

  const summary = { run, size: SIZE, rows: rows.length, local: localCount, reusedCatalogueFilms: reused,
    provider: providerFilms.length, unknown: UNKNOWN, watchlist: watchlistCount };

  try {
    // -------------------------------------------------------------------------
    // What the phone does
    // -------------------------------------------------------------------------
    const t0 = performance.now();
    const job = await api.rpc(token, 'import_create', {});
    const jobId = job.body;
    for (let i = 0; i < rows.length; i += 500) {
      const page = await api.rpc(token, 'import_stage', { p_job_id: jobId, p_rows: rows.slice(i, i + 500) });
      if (!page.ok) throw new Error(`import_stage failed: ${page.status}`);
    }
    const ready = await api.rpc(token, 'import_ready', { p_job_id: jobId });
    if (!ready.ok) throw new Error(`import_ready failed: ${ready.status}`);
    const staged = performance.now();
    summary.stageSeconds = +((staged - t0) / 1000).toFixed(1);
    summary.readyAt = new Date().toISOString();

    // -------------------------------------------------------------------------
    // And then nothing but watching. The phone could be closed from here.
    // -------------------------------------------------------------------------
    const timeline = [];
    let last = null;
    let applyingAt = null;
    for (;;) {
      const [j] = await api.rows(
        `import_jobs?id=eq.${jobId}&select=status,counts,created_at,completed_at,attempts,failures,last_error`,
      );
      const elapsed = +((performance.now() - staged) / 1000).toFixed(1);
      if (j.status !== last) {
        timeline.push({ at: elapsed, status: j.status });
        last = j.status;
        if (j.status === 'applying' && applyingAt === null) applyingAt = elapsed;
      }
      if (j.completed_at) {
        summary.status = j.status;
        summary.counts = j.counts;
        summary.lastError = j.last_error;
        summary.wallSeconds = elapsed;
        break;
      }
      if (elapsed > 3600) throw new Error('bench job did not finish within an hour');
      await sleep(SIZE > 500 ? 2000 : 1000);
    }
    summary.timeline = timeline;
    summary.finishedAt = new Date().toISOString();

    const notes = await api.rows(
      `notifications?recipient_id=eq.${userId}&select=type,payload`,
    );
    summary.notifications = notes.map((n) => n.type).sort();
    const feed = await api.count('feed_events', `actor_id=eq.${userId}`);
    summary.feedEvents = feed;
    summary.userMedia = await api.count('user_media', `user_id=eq.${userId}`);
    summary.watchlistRows = await api.count('watchlist', `user_id=eq.${userId}`);
    summary.importedWatches = await api.count('imported_watches', `user_id=eq.${userId}`);
    summary.liveRows = await api.count('import_rows', `job_id=eq.${jobId}&status=in.(pending,matched,applied)`);
    summary.jobId = jobId;
  } finally {
    if (!KEEP) {
      const gone = await api.rpc(token, 'delete_account', {});
      if (!gone.ok) await api.service(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
      summary.cleanedUp = true;
    }
    console.log(JSON.stringify(summary));
  }
}

main().catch((error) => {
  console.error(`import-staging-run: ${error.message}`);
  process.exitCode = 1;
});
