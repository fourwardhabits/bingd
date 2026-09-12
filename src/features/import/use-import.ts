/**
 * The importer's state machine: pick, read, preview, upload, watch.
 *
 * ---------------------------------------------------------------------------
 * WHY A MACHINE AND NOT A PILE OF BOOLEANS
 *
 * This flow has a genuine sequence — nothing may be uploaded before a preview exists, and a
 * preview is meaningless once the upload has begun — and every one of its steps can fail in
 * a way the person has to be told about. Expressed as `loading`/`error`/`done` flags that
 * would be a set of states most of which are nonsense, and the screen would have to guess
 * which combination it was looking at.
 *
 * So: one `phase`, and the data each phase owns travels with it.
 *
 *   idle -> reading -> previewing -> uploading -> working -> done
 *                \                       \           \
 *                 -> failed               -> failed   -> failed
 *
 * ---------------------------------------------------------------------------
 * THE UPLOAD IS RESUMABLE BECAUSE THE SERVER MADE IT SO
 *
 * `import_create` returns the job already open rather than refusing a second one, and
 * `import_rows_once` makes re-posting a page free. So a dropped connection mid-upload is
 * recoverable by starting again — the pages that landed cost nothing the second time. That
 * is why a failure here offers "Try again" rather than "start over", and why this hook keeps
 * the preview rather than discarding it on error.
 *
 * ---------------------------------------------------------------------------
 * AND THE PERSON MAY LEAVE
 *
 * After `import_ready` the work happens on a `pg_cron` tick with no client attached. The
 * polling below is a courtesy, not a mechanism: closing the app does not stop an import and
 * does not lose one. The screen says so, and `import_completed`'s docblock records that this
 * makes the completion count a deliberate undercount.
 */

import { File } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';

import { track, type ImportSelectOutcome, type ImportSurface } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';

import { DEFAULT_LIMITS } from './archive';
import { readArchive, type ArchivePreview, type ReadFailure } from './read-archive';
import type { StagingRow } from './payload';

/**
 * What the server says about a job, as `import_status` returns it.
 *
 * **All seven values `import_jobs_known_status` permits, not the five this pipeline
 * writes.** `parsing` and `preview` are from the original 2026-08-13 table and nothing
 * reaches them today, but the check constraint still admits them, and a union that omitted
 * them would make the cast below a lie — which matters because the code that consumes it
 * treats "not a terminal state" as "keep waiting". Listing them keeps that reasoning
 * exhaustive rather than accidentally correct.
 */
export type ImportJobStatus = {
  readonly status: 'pending' | 'parsing' | 'matching' | 'preview' | 'applying' | 'done' | 'failed';
  readonly counts: ImportCounts;
  readonly completedAt: string | null;
};

/**
 * The summary `_import_settle` writes.
 *
 * Every field optional, because a job that has not settled has only some of them and a
 * client that assumed otherwise would render zeroes as though they were answers.
 */
export type ImportCounts = {
  readonly staged?: number;
  readonly applied?: number;
  readonly ambiguous?: number;
  readonly unmatched?: number;
  readonly stragglers?: number;
  readonly watched?: number;
  readonly watchlist?: number;
  readonly viewings?: number;
};

export type ImportFailure =
  /** The archive could not be read. Carries the reason the screen apologises with. */
  | { readonly kind: 'archive'; readonly reason: ReadFailure['reason'] }
  /** A file was handed over and could not even be opened. */
  | { readonly kind: 'unreadable' }
  /** The server refused or the connection went. Recoverable: the job survives. */
  | { readonly kind: 'upload' }
  /** The worker gave up on the job. Not recoverable by retrying the same archive. */
  | { readonly kind: 'server' }
  /**
   * An import for this account is already running, so this one cannot start.
   *
   * Its own kind because it used to arrive dressed as `upload` — `import_stage` raises
   * `22023` against a job the worker has claimed, `start()` caught every error the same
   * way, and the screen said "your connection dropped, trying again picks up where it
   * stopped". Both halves of that were false, and every retry failed identically until the
   * running job settled. Nothing is wrong here and there is nothing to retry; the answer is
   * to go and look at the import that is already happening.
   */
  | { readonly kind: 'already_running' }
  /**
   * The import is running and this client has lost sight of it.
   *
   * Not a failed import — the work carries on either way. It is the screen admitting it
   * cannot say what is happening, which is the honest end to a poll that has come back with
   * nothing for a solid minute, and is strictly better than a spinner with no buttons.
   */
  | { readonly kind: 'unknown' };

export type ImportPhase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'reading' }
  | { readonly phase: 'previewing'; readonly preview: ArchivePreview }
  | {
      readonly phase: 'uploading';
      readonly preview: ArchivePreview;
      /** Pages sent so far, so the screen can show real progress rather than a spinner. */
      readonly sent: number;
      readonly total: number;
    }
  | { readonly phase: 'working'; readonly status: ImportJobStatus }
  | { readonly phase: 'done'; readonly status: ImportJobStatus }
  | { readonly phase: 'failed'; readonly failure: ImportFailure; readonly preview?: ArchivePreview };

/** How often the job is asked about while somebody is watching. */
const POLL_MS = 2_000;

/**
 * Stops a long read from dropping the frame that says it started.
 *
 * `unzipSync` and the CSV parse are synchronous and, on a ten-thousand-film export, take
 * long enough to notice. Yielding the thread first lets React commit and draw the spinner;
 * without it the screen stays on the *previous* state for the whole read and the person
 * sees nothing happen at all — which reads as a dead button, so they press it again.
 *
 * A macrotask rather than `InteractionManager.runAfterInteractions`, which React Native has
 * deprecated in favour of exactly this advice. One turn of the event loop is all that is
 * wanted here: the commit has already been scheduled by the `setState` above, and the
 * spinner itself animates on the native thread once drawn, so it keeps moving even while
 * JavaScript is busy.
 */
const yieldFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const failureOutcome = (reason: ReadFailure['reason']): ImportSelectOutcome => reason;

type JobRow = { status: string; counts: ImportCounts | null; completed_at: string | null };

const asStatus = (row: JobRow): ImportJobStatus => ({
  status: row.status as ImportJobStatus['status'],
  counts: row.counts ?? {},
  completedAt: row.completed_at,
});

/**
 * One job's progress, or `null` if it could not be read.
 *
 * **Total, and the `try` is what makes that true rather than the comment.** Both callers
 * treat `null` as "ask again later"; a throw instead would reject the poll, and the poll is
 * the only thing that ever leaves the `working` screen — which has no buttons on it. The
 * same shape of hole that `readArchive` closed, one layer up.
 */
async function readJob(jobId: string): Promise<ImportJobStatus | null> {
  try {
    const { data, error } = await supabase.rpc('import_status', { p_job_id: jobId }).maybeSingle();
    if (error || data === null) return null;
    return asStatus(data as JobRow);
  } catch {
    return null;
  }
}

/**
 * The caller's open import, if one exists.
 *
 * Read straight from the table rather than through an RPC: `import_jobs_own` is a `select`
 * policy for `user_id = auth.uid()`, so RLS already answers whose job this is and a definer
 * function would add nothing but a migration.
 *
 * **This is what makes "you can close the app and come back" true.** The `working` screen
 * says exactly that, and without this, coming back meant a fresh hook at `idle` with no job
 * id — the running import invisible, and the next attempt to start one walking into
 * `import_create` adopting it and `import_stage` refusing.
 *
 * **Total for a sharper reason than `readJob`.** Its one caller is an effect that runs on
 * open and cannot await anything, so a throw here is an unhandled rejection rather than a
 * failed read — and the recovery it powers is a convenience. Not finding a running import
 * costs somebody one screen; crashing the screen that was about to offer it costs them the
 * importer.
 */
async function findLiveJob(): Promise<{ id: string; status: ImportJobStatus } | null> {
  try {
    const { data, error } = await supabase
      .from('import_jobs')
      .select('id, status, counts, completed_at')
      .is('completed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || data === null) return null;
    const row = data as JobRow & { id: string };
    return { id: row.id, status: asStatus(row) };
  } catch {
    return null;
  }
}

export function useImport(surface: ImportSurface) {
  const [state, setState] = useState<ImportPhase>({ phase: 'idle' });
  const jobRef = useRef<string | null>(null);
  /**
   * Guards every `setState` after an await. A person who backs out of the importer mid-read
   * has unmounted this hook, and a late resolve would otherwise set state on nothing —
   * or worse, restart polling for a screen that is gone.
   */
  const alive = useRef(true);
  /** One upload at a time. See `start`. */
  const uploading = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Picks up an import that is already running, once, on open.
   *
   * Only from `idle`, so it can never interrupt somebody who has already started reading a
   * file. A `pending` job is deliberately ignored: that is a half-staged archive from an
   * upload that did not finish, and the person is here to choose a file, not to be told
   * about a job they cannot see the contents of. `reset()` clears those up anyway.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const live = await findLiveJob();
      if (cancelled || !alive.current || live === null) return;
      if (live.status.status === 'pending') return;

      jobRef.current = live.id;
      setState((current) =>
        current.phase === 'idle'
          ? live.status.status === 'done'
            ? { phase: 'done', status: live.status }
            : { phase: 'working', status: live.status }
          : current,
      );
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const settle = useCallback((next: ImportPhase) => {
    if (alive.current) setState(next);
  }, []);

  /**
   * Opens the system picker and reads whatever comes back.
   *
   * **`mimeTypes` is deliberately unset**, which means every file is selectable. A narrower
   * filter is the obvious choice and is the wrong one here: a ZIP arrives from Letterboxd
   * by email and through a browser download, and the MIME type it carries by the time it
   * reaches Files or Drive varies by all three. A filter that greys out the correct file is
   * an unrecoverable dead end — there is no "show me everything anyway" — whereas a wrong
   * pick is answered with a sentence that says what to do instead. The validation is in the
   * bytes, where it can be tested, rather than in a picker's idea of a file type.
   *
   * **That choice is what makes the size check below load-bearing rather than defensive.**
   * If every file is selectable then the plausible mis-tap is a video, and `looksLikeZip`
   * cannot run until the file has been read into memory. So the size is checked first, from
   * the picker's own metadata, before anything is allocated.
   */
  const pick = useCallback(async () => {
    settle({ phase: 'reading' });

    let bytes: Uint8Array;
    try {
      const picked = await File.pickFileAsync();
      if (picked.canceled) {
        track({ name: 'import_archive_selected', props: { outcome: 'cancelled' } });
        settle({ phase: 'idle' });
        return;
      }

      // **The size is checked before the file is read, not after.** `inspect`'s bomb guard
      // runs on what the archive *declares*, which is no use at all if the whole file is
      // already resident by the time it runs — and because the picker deliberately filters
      // nothing, the likely mis-tap is a video out of Photos rather than an exotic attack.
      // `size` costs nothing: the picker has already stat'd the file.
      if (picked.result.size > DEFAULT_LIMITS.maxTotalBytes) {
        track({ name: 'import_archive_selected', props: { outcome: 'too_large' } });
        settle({ phase: 'failed', failure: { kind: 'archive', reason: 'too_large' } });
        return;
      }

      await yieldFrame();
      bytes = await picked.result.bytes();
    } catch {
      track({ name: 'import_archive_selected', props: { outcome: 'unreadable' } });
      settle({ phase: 'failed', failure: { kind: 'unreadable' } });
      return;
    }

    // `readArchive` is total and cannot throw, which is what keeps this out of the
    // spinner-with-no-buttons state. The guard is here as well because "cannot throw" is a
    // property of that function that a later edit could quietly take away.
    let result;
    try {
      result = readArchive(bytes);
    } catch {
      result = { ok: false, reason: 'unexpected' } as const;
    }

    if (!result.ok) {
      track({ name: 'import_archive_selected', props: { outcome: failureOutcome(result.reason) } });
      settle({ phase: 'failed', failure: { kind: 'archive', reason: result.reason } });
      return;
    }

    track({ name: 'import_archive_selected', props: { outcome: 'ok' } });
    settle({ phase: 'previewing', preview: result.preview });
  }, [settle]);

  /**
   * Back to the start, keeping nothing — **including on the server**.
   *
   * Forgetting the job id locally is not abandoning the job. `import_create` finds an open
   * job by `user_id` and adopts a `pending` one for an hour, so a half-staged archive left
   * behind by a failed upload would be adopted by the *next* import and the two would be
   * applied as one collection. Two taps after a dropped connection, and a person ends up
   * with films from an archive they explicitly walked away from.
   *
   * So the job is discarded first and the local state cleared regardless of the answer: if
   * the call fails, the worst case is the old behaviour, and blocking "Start over" on a
   * network round trip would strand somebody on an error screen with no way off it.
   */
  const reset = useCallback(() => {
    const jobId = jobRef.current;
    jobRef.current = null;
    settle({ phase: 'idle' });

    if (jobId !== null) {
      void supabase.rpc('import_discard', { p_job_id: jobId });
    }
  }, [settle]);

  /**
   * Sends the preview and hands the job to the worker.
   *
   * Pages go up one at a time rather than in parallel. They are inserts against one job with
   * a unique index across `(job_id, kind, correlation)`, so concurrent pages would contend
   * on that index for no gain, and a serial loop is the only way to report honest progress.
   */
  const start = useCallback(
    async (preview: ArchivePreview) => {
      // **One upload at a time.** `Button` has no press guard, so two taps in a frame would
      // otherwise run two staging loops against the same job: their `settle` calls would
      // interleave and make progress jump backwards, and `import_started` would be counted
      // twice, inflating the one distribution nobody currently has.
      if (uploading.current) return;
      uploading.current = true;

      const pages = preview.pages;
      settle({ phase: 'uploading', preview, sent: 0, total: pages.length });

      try {
        const { data: jobId, error: createError } = await supabase.rpc('import_create');
        if (createError || typeof jobId !== 'string') throw createError ?? new Error('no job');
        jobRef.current = jobId;

        // **Ask what we were given before staging onto it.** `import_create` adopts any open
        // job, including one the worker is already draining — and `import_stage` refuses a
        // job that is no longer `pending` with a `22023` that used to surface as "your
        // connection dropped. Trying again picks up where it stopped", which was false twice
        // over and failed identically on every retry. Reading the status first turns that
        // dead end into the only sensible outcome: show the import that is already running.
        //
        // Before `import_started`, so the event counts imports that actually began.
        const existing = await readJob(jobId);
        if (existing !== null && existing.status !== 'pending') {
          settle(
            existing.status === 'done'
              ? { phase: 'done', status: existing }
              : { phase: 'working', status: existing },
          );
          return;
        }

        track({
          name: 'import_started',
          props: {
            films: preview.rows.length,
            viewings: preview.normalised.counts.watches,
          },
        });

        for (const [index, page] of pages.entries()) {
          const { error } = await supabase.rpc('import_stage', {
            p_job_id: jobId,
            p_rows: page as StagingRow[],
          });
          if (error) throw error;
          settle({ phase: 'uploading', preview, sent: index + 1, total: pages.length });
        }

        const { error: readyError } = await supabase.rpc('import_ready', { p_job_id: jobId });
        if (readyError) throw readyError;
      } catch (error) {
        // `22023` from `import_stage` is "this import is no longer accepting rows" — the
        // worker claimed the job between the status read above and this page. Rare, but it
        // is the same dead end, and it must not be reported as a connection problem.
        const refused = (error as { code?: string } | null)?.code === '22023';
        settle(
          refused
            ? { phase: 'failed', failure: { kind: 'already_running' } }
            : // The job survives a failure here and `import_rows_once` makes the pages
              // already sent free to re-send, so the preview is kept and "Try again" is a
              // real offer.
              { phase: 'failed', failure: { kind: 'upload' }, preview },
        );
        return;
      } finally {
        uploading.current = false;
      }

      settle({
        phase: 'working',
        status: { status: 'matching', counts: {}, completedAt: null },
      });
    },
    [settle],
  );

  /**
   * Watches the job until it settles.
   *
   * Only while `working`, and it stops on the first terminal answer. There is no timeout and
   * no give-up: an import that is taking a long time is still an import, and the screen's
   * own copy already says the app may be closed.
   */
  useEffect(() => {
    if (state.phase !== 'working') return;
    const jobId = jobRef.current;
    if (jobId === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Consecutive polls that came back with nothing.
     *
     * **A read that fails forever must not wait forever.** This used to reschedule
     * unconditionally on both an error and a null row, and the `working` screen has no
     * buttons on it — so an account whose job had vanished, or a device that had lost the
     * network for good, sat on "Matching your films" until it was force-quit.
     *
     * Generous, because the work really is on the server and a blip really is a blip: at two
     * seconds a poll this is a little over a minute of uninterrupted silence before the
     * screen admits it does not know. Any successful read resets it.
     */
    let blind = 0;
    const BLIND_LIMIT = 30;

    const poll = async () => {
      const status = await readJob(jobId);

      if (cancelled) return;

      if (status === null) {
        blind += 1;
        if (blind >= BLIND_LIMIT) {
          settle({ phase: 'failed', failure: { kind: 'unknown' } });
          return;
        }
        timer = setTimeout(() => void poll(), POLL_MS);
        return;
      }

      blind = 0;

      if (status.status === 'done') {
        track({
          name: 'import_completed',
          props: {
            applied: status.counts.applied ?? 0,
            // `stragglers` counts as unresolved here for the same reason it does on the
            // summary screen: a row nobody placed is unresolved to the person, whatever the
            // worker's internal reason for not placing it.
            unresolved:
              (status.counts.ambiguous ?? 0) +
              (status.counts.unmatched ?? 0) +
              (status.counts.stragglers ?? 0),
          },
        });
        settle({ phase: 'done', status });
        return;
      }

      if (status.status === 'failed') {
        settle({ phase: 'failed', failure: { kind: 'server' } });
        return;
      }

      settle({ phase: 'working', status });
      timer = setTimeout(() => void poll(), POLL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `state.phase` and nothing else — the effect reads only that and `jobRef`, so this is
    // exhaustive as well as deliberate. Depending on the polled `status` would tear down and
    // rebuild the loop on every tick, stacking a fresh timer each time.
  }, [state.phase, settle]);

  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    track({ name: 'import_opened', props: { surface } });
  }, [surface]);

  return { state, pick, start, reset } as const;
}
