import { readFileSync } from 'fs';

import { readImdbCsv } from './read-imdb';

/**
 * **Private, opt-in validation against a real IMDb export** (founder spec 2026-11-10, §3, §11).
 *
 * Skipped unless `IMDB_PRIVATE_SAMPLE` names a file. The founder's sample is somebody else's
 * viewing history: it must never be committed, copied into the repo, or pasted anywhere. Keep
 * it outside the checkout and run:
 *
 *   IMDB_PRIVATE_SAMPLE=/path/outside/repo/ratings.csv npx jest imdb-private-sample
 *
 * Prints counts only, never a title, id or rating.
 */
const path = process.env.IMDB_PRIVATE_SAMPLE;
const run = path ? it : it.skip;

describe('a private IMDb sample', () => {
  run('parses and reports counts only', () => {
    const result = readImdbCsv(new Uint8Array(readFileSync(path!)));
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const { counts } = result.preview.normalised;
    // eslint-disable-next-line no-console -- an opt-in local report, never run in CI
    console.log(
      JSON.stringify(
        {
          parsedTitles: counts.titles,
          eligibleMovies: counts.movies,
          tvShowsRecognisedNotAdded: counts.tvShows,
          episodesUnsupported: counts.episodes,
          otherUnsupported: counts.otherUnsupported,
          rated: counts.rated,
          malformed: counts.malformed,
          invalidIds: counts.invalidIds,
          invalidRatings: counts.invalidRatings,
          duplicates: counts.duplicates,
          damaged: counts.damaged,
          pages: result.preview.pages.length,
        },
        null,
        2,
      ),
    );
    expect(counts.titles).toBeGreaterThan(0);
  });
});
