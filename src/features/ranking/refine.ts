import type { RankingCategory } from '@/features/collection/use-collection';
import { supabase } from '@/lib/supabase';

import type { PlacedMovement } from './session';

/**
 * Refine your rankings (T5, `20261019000100`; calibration epic §G, §H).
 *
 * The server decides WHICH titles are worth a second look (`refine_candidates`, from the
 * reader's own pairwise evidence) and HOW each one is searched (a `refine` session from
 * where it already sits). What lives here is the part that is about one sitting: how many
 * targets a round holds, when it pauses for a checkpoint, and when it stops offering more.
 * Pure, so the stopping rules are unit-tested rather than inferred from a screen.
 */

/** Why there is nothing to refine, in the server's words. `ready` means there is. */
export type RefineStatus = 'ready' | 'nothing_waiting' | 'too_small' | 'rested' | 'disabled';

/**
 * The one-line reason a target was chosen (never a number, §G.3). There is no age reason:
 * how long ago a title was placed is not evidence it is misplaced (founder, 2026-09-21).
 */
export type RefineReason = 'contradicted' | 'never_compared' | 'crossed' | 'grown' | 'neighbours';

/** Why the server offered a title, for analytics only (unified design §5). Never drawn. */
export type RefineSignals = {
  gap: boolean;
  contradicted: boolean;
  crossed: boolean;
  /** Cleared the card threshold as well as the candidate one. */
  strong: boolean;
};

/**
 * Whether Collection may invite a Refine sitting (unified design §5): the server's answer,
 * with the counts behind it so the thresholds can be tuned from real use. `count` is the
 * number the card may name (at most five).
 */
export type RefineCta = {
  show: boolean;
  count: number;
  qualifying: number;
  strong: number;
  /** Placements needed after Not now before the card may return (§6). */
  resurfaceAfter: number;
};

const NO_CTA: RefineCta = { show: false, count: 0, qualifying: 0, strong: 0, resurfaceAfter: 3 };

export type RefineTarget = {
  mediaItemId: string;
  title: string;
  posterPath: string | null;
  kind: 'movie' | 'season';
  position: number;
  /** The session this title was left in, which comes back first (§H.6 "kill / resume"). */
  resume: boolean;
  reason: RefineReason;
  lastConfirmedAt: string | null;
  confirmedSize: number | null;
  signals: RefineSignals;
};

export type RefineCandidates = {
  status: RefineStatus;
  targets: RefineTarget[];
  cta: RefineCta;
  /** New placements in the medium (never backfill or refine), for Not now (§6). */
  placementsTotal: number;
};

type Row = {
  media_item_id: string;
  title: string;
  poster_path: string | null;
  kind: string | null;
  position: number;
  resume: boolean;
  reason: string;
  last_confirmed_at: string | null;
  confirmed_size: number | null;
  signals?: Partial<Record<keyof RefineSignals, boolean>>;
};

const STATUSES = new Set<RefineStatus>([
  'ready',
  'nothing_waiting',
  'too_small',
  'rested',
  'disabled',
]);
const REASONS = new Set<RefineReason>([
  'contradicted',
  'never_compared',
  'crossed',
  'grown',
  'neighbours',
]);

/**
 * The next targets, or why there are none.
 *
 * **A backend without the function reads as `disabled`, not as an error.** The client can
 * ship ahead of the migration (an OTA before `20261019000100` is applied), and on that
 * backend the right behaviour is the one the flag gives: no entry, nothing to open.
 */
export async function refineCandidates(
  category: RankingCategory,
  options: { limit?: number; seed?: number; recent?: readonly string[] } = {},
): Promise<RefineCandidates> {
  const { data, error } = await supabase.rpc('refine_candidates', {
    p_category: category,
    p_limit: options.limit ?? 5,
    p_seed: options.seed ?? 0,
    p_recent: [...(options.recent ?? [])],
  });
  if (error) {
    // PGRST202: PostgREST found no such function (an older backend). 42883: Postgres did.
    if (error.code === 'PGRST202' || error.code === '42883') {
      return { status: 'disabled', targets: [], cta: NO_CTA, placementsTotal: 0 };
    }
    throw error;
  }
  return parseCandidates(data);
}

export function parseCandidates(data: unknown): RefineCandidates {
  const body = (data ?? {}) as {
    status?: string;
    candidates?: Row[];
    placements_total?: number;
    cta?: {
      show?: boolean;
      count?: number;
      qualifying?: number;
      strong?: number;
      resurface_after?: number;
    };
  };
  const status = STATUSES.has(body.status as RefineStatus)
    ? (body.status as RefineStatus)
    : 'disabled';
  const targets = (Array.isArray(body.candidates) ? body.candidates : [])
    .filter((row) => typeof row?.media_item_id === 'string' && typeof row.title === 'string')
    .map((row): RefineTarget => ({
      mediaItemId: row.media_item_id,
      title: row.title,
      posterPath: row.poster_path ?? null,
      kind: row.kind === 'season' ? 'season' : 'movie',
      position: Number(row.position),
      resume: Boolean(row.resume),
      reason: REASONS.has(row.reason as RefineReason)
        ? (row.reason as RefineReason)
        : 'neighbours',
      lastConfirmedAt: row.last_confirmed_at ?? null,
      confirmedSize: typeof row.confirmed_size === 'number' ? row.confirmed_size : null,
      signals: {
        gap: Boolean(row.signals?.gap),
        contradicted: Boolean(row.signals?.contradicted),
        crossed: Boolean(row.signals?.crossed),
        strong: Boolean(row.signals?.strong),
      },
    }));
  const cta = body.cta ?? {};
  const count = (value: unknown, fallback = 0) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  // `ready` with nothing in it would draw an entry that opens onto nothing.
  const settled = status === 'ready' && targets.length === 0 ? 'nothing_waiting' : status;
  return {
    status: settled,
    targets,
    cta: {
      // An invitation onto an empty sitting is the thing the card exists not to be.
      show: settled === 'ready' ? Boolean(cta.show) : false,
      count: count(cta.count),
      qualifying: count(cta.qualifying),
      strong: count(cta.strong),
      resurfaceAfter: count(cta.resurface_after, NO_CTA.resurfaceAfter),
    },
    placementsTotal: count(body.placements_total),
  };
}

/** "I don't remember it well": rests the title for 180 days. Its ranking is untouched. */
export async function refineSnooze(mediaItemId: string): Promise<void> {
  const { error } = await supabase.rpc('refine_snooze', { p_media_item_id: mediaItemId });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// The sitting
// ---------------------------------------------------------------------------

/**
 * **The stopping rules for one sitting**, which are the client's half of "finite" (the
 * server holds the rest: a daily ceiling, per-title rests, and an evidence rule that
 * empties the pool).
 *
 *   ROUND_TARGETS   a round is five titles (§H.1.3)
 *   ROUND_ANSWERS   ... or twelve answers, checked when a title finishes, so a title
 *                   that is genuinely moving is finished rather than cut off (§H.5)
 *   MAX_ROUNDS      after the third round the checkpoint offers Done only
 */
export const ROUND_TARGETS = 5;
export const ROUND_ANSWERS = 12;
export const MAX_ROUNDS = 3;

export type RefinedTitle = {
  mediaItemId: string;
  title: string;
  position: number;
  movement: PlacedMovement | null;
  answers: number;
  /**
   * What the round's summary draws (founder, 2026-09-22): the poster, and the score the
   * placement earned — the server's own number, from `Placed`, which is the one written
   * to the collection. Optional because the pure stopping rules above are tested without
   * a placement, and because a backend that answers no score must summarise anyway.
   *
   * There is deliberately **no previous score**: nothing in the session captures one, and
   * the founder's rule is not to invent it. The movement the summary shows is the ordinal
   * pair, which is a fact the server did return.
   */
  posterPath?: string | null;
  score?: number | null;
  bucket?: string | null;
};

export type Sitting = {
  round: number;
  /** This round's finished titles, in order. What the checkpoint lists. */
  finished: RefinedTitle[];
  /** Answers given in this round. */
  answers: number;
  /** Every title this sitting has shown, for `p_recent`. Never repeats inside a sitting. */
  shown: string[];
  /** Totals for `refine_session_ended`. */
  totals: { targets: number; moved: number; answers: number };
};

export const newSitting = (): Sitting => ({
  round: 1,
  finished: [],
  answers: 0,
  shown: [],
  totals: { targets: 0, moved: 0, answers: 0 },
});

export const markShown = (sitting: Sitting, mediaItemId: string): Sitting =>
  sitting.shown.includes(mediaItemId)
    ? sitting
    : { ...sitting, shown: [...sitting.shown, mediaItemId] };

export function recordFinished(sitting: Sitting, title: RefinedTitle): Sitting {
  const moved = title.movement?.outcome === 'moved' ? 1 : 0;
  return {
    ...markShown(sitting, title.mediaItemId),
    finished: [...sitting.finished, title],
    answers: sitting.answers + title.answers,
    totals: {
      targets: sitting.totals.targets + 1,
      moved: sitting.totals.moved + moved,
      answers: sitting.totals.answers + title.answers,
    },
  };
}

/** Whether the round has reached its checkpoint. */
export const atCheckpoint = (sitting: Sitting) =>
  sitting.finished.length >= ROUND_TARGETS || sitting.answers >= ROUND_ANSWERS;

/** Whether the checkpoint may offer "5 more" (it also needs the server to have more). */
export const mayContinue = (sitting: Sitting) => sitting.round < MAX_ROUNDS;

export const nextRound = (sitting: Sitting): Sitting => ({
  ...sitting,
  round: sitting.round + 1,
  finished: [],
  answers: 0,
});

/**
 * The optional line under a target (§H.3), or null. Honest and relative: it says what the
 * evidence is, never a confidence number.
 */
export function reasonLine(
  target: Pick<RefineTarget, 'reason' | 'lastConfirmedAt' | 'confirmedSize'>,
  medium: RankingCategory,
): string | null {
  const noun = medium === 'movies' ? 'movies' : 'seasons';
  switch (target.reason) {
    case 'contradicted':
      return 'One of your answers disagrees with where it sits';
    case 'never_compared':
      return 'Never compared with the titles around it';
    case 'crossed':
      return 'Titles near it have moved past it since';
    case 'grown':
      return target.confirmedSize
        ? `Last placed when you had ${target.confirmedSize} ${noun}`
        : 'Your list has grown around it';
    case 'neighbours':
      return 'Titles around it were ranked after it';
    default:
      return null;
  }
}
