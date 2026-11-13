/**
 * The IMDb file this app process last sent, held in memory for its summary. Never stored.
 *
 * The server deletes the rows it could not place anywhere (whole shows, episodes, other
 * types) when the job settles, so the only place their names still exist is the parse this
 * process made. Keeping it here, rather than in the hook, lets somebody press *Leave it
 * running*, come back from the notification, and still see which titles went where: the
 * screen unmounted, the process did not.
 *
 * **Memory only, on purpose.** Nothing here touches AsyncStorage, SecureStore or the file
 * system, so a restart forgets it and the summary falls back to its counts. One job at a
 * time: starting another replaces it. It is keyed by the job id, which is a per-account
 * UUID, so a summary for any other job, including another account's after a sign-out,
 * finds nothing.
 */

import type { ImdbTitle } from './imdb';

let remembered: { readonly jobId: string; readonly titles: readonly ImdbTitle[] } | null = null;

/** Called once the job this file is being sent into is known. */
export function rememberSessionImport(jobId: string, titles: readonly ImdbTitle[]): void {
  remembered = { jobId, titles };
}

/** The parsed titles for this job, if this process sent it; otherwise null. */
export function sessionImportFor(
  jobId: string | null | undefined,
): readonly ImdbTitle[] | null {
  return jobId != null && remembered?.jobId === jobId ? remembered.titles : null;
}

/** Forget it. For "Start over", and for tests that simulate a restart. */
export function forgetSessionImport(): void {
  remembered = null;
}
