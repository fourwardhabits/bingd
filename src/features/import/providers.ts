/**
 * The services bingd can import a history from (founder spec 2026-11-10).
 *
 * Two, deliberately: Letterboxd (a ZIP of CSVs, `read-archive.ts`) and IMDb (one ratings
 * CSV, `read-imdb.ts`). No Rotten Tomatoes. Everything after the reader — the upload, the
 * job, the poll, the summary — is shared, and the server learns which one a job is from
 * `import_create(p_provider)`.
 */
export type ImportProvider = 'letterboxd' | 'imdb';

export const IMPORT_PROVIDERS: readonly ImportProvider[] = ['letterboxd', 'imdb'];

/** The name a person reads. Never translated, never shortened: these are brands. */
export const PROVIDER_NAME: Record<ImportProvider, string> = {
  letterboxd: 'Letterboxd',
  imdb: 'IMDb',
};

/** Whatever a job or a payload says, folded to a provider; anything unknown is Letterboxd. */
export const asProvider = (value: unknown): ImportProvider =>
  value === 'imdb' ? 'imdb' : 'letterboxd';
