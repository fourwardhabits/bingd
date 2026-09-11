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

import { readArchive, type ArchivePreview, type ReadFailure } from './read-archive';
import type { StagingRow } from './payload';

/** What the server says about a job, as `import_status` returns it. */
export type ImportJobStatus = {
  readonly status: 'pending' | 'matching' | 'applying' | 'done' | 'failed';
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
  | { readonly kind: 'server' };

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

export function useImport(surface: ImportSurface) {
  const [state, setState] = useState<ImportPhase>({ phase: 'idle' });
  const jobRef = useRef<string | null>(null);
  /**
   * Guards every `setState` after an await. A person who backs out of the importer mid-read
   * has unmounted this hook, and a late resolve would otherwise set state on nothing —
   * or worse, restart polling for a screen that is gone.
   */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
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
   * pick is caught in the next twenty milliseconds by `looksLikeZip` and answered with a
   * sentence that says what to do instead. The validation is in the bytes, where it can be
   * tested, rather than in a picker's idea of a file type.
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
      await yieldFrame();
      bytes = await picked.result.bytes();
    } catch {
      track({ name: 'import_archive_selected', props: { outcome: 'unreadable' } });
      settle({ phase: 'failed', failure: { kind: 'unreadable' } });
      return;
    }

    const result = readArchive(bytes);
    if (!result.ok) {
      track({ name: 'import_archive_selected', props: { outcome: failureOutcome(result.reason) } });
      settle({ phase: 'failed', failure: { kind: 'archive', reason: result.reason } });
      return;
    }

    track({ name: 'import_archive_selected', props: { outcome: 'ok' } });
    settle({ phase: 'previewing', preview: result.preview });
  }, [settle]);

  /** Back to the start, keeping nothing. Used by "Choose a different file" and by Cancel. */
  const reset = useCallback(() => {
    jobRef.current = null;
    settle({ phase: 'idle' });
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
      const pages = preview.pages;
      settle({ phase: 'uploading', preview, sent: 0, total: pages.length });
      track({
        name: 'import_started',
        props: {
          films: preview.rows.length,
          viewings: preview.normalised.counts.watches,
        },
      });

      try {
        const { data: jobId, error: createError } = await supabase.rpc('import_create');
        if (createError || typeof jobId !== 'string') throw createError ?? new Error('no job');
        jobRef.current = jobId;

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
      } catch {
        // The job survives a failure here and `import_rows_once` makes the pages already
        // sent free to re-send, so the preview is kept and "Try again" is a real offer.
        settle({ phase: 'failed', failure: { kind: 'upload' }, preview });
        return;
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

    const poll = async () => {
      const { data, error } = await supabase
        .rpc('import_status', { p_job_id: jobId })
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        // A single failed poll is a network blip, not a failed import. The work is on the
        // server either way, so this keeps asking rather than reporting a failure that
        // would be this client's alone.
        timer = setTimeout(() => void poll(), POLL_MS);
        return;
      }

      const row = data as { status: string; counts: ImportCounts | null; completed_at: string | null } | null;
      if (row === null) {
        timer = setTimeout(() => void poll(), POLL_MS);
        return;
      }

      const status: ImportJobStatus = {
        status: row.status as ImportJobStatus['status'],
        counts: row.counts ?? {},
        completedAt: row.completed_at,
      };

      if (status.status === 'done') {
        track({
          name: 'import_completed',
          props: {
            applied: status.counts.applied ?? 0,
            unresolved: (status.counts.ambiguous ?? 0) + (status.counts.unmatched ?? 0),
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
