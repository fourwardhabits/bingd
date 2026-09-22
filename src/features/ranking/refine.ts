import type { RankingCategory } from '@/features/collection/use-collection';
import { movementSentence } from '@/features/watch-history/watch-history';
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

/** The one-line reason a target was chosen (never a number, §G.3). */
export type RefineReason =
  'contradicted' | 'never_compared' | 'grown' | 'placed_long_ago' | 'neighbours';

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
};

export type RefineCandidates = { status: RefineStatus; targets: RefineTarget[] };

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
  'grown',
  'placed_long_ago',
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
      return { status: 'disabled', targets: [] };
    }
    throw error;
  }
  return parseCandidates(data);
}

export function parseCandidates(data: unknown): RefineCandidates {
  const body = (data ?? {}) as { status?: string; candidates?: Row[] };
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
    }));
  // `ready` with nothing in it would draw an entry that opens onto nothing.
  return {
    status: status === 'ready' && targets.length === 0 ? 'nothing_waiting' : status,
    targets,
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
    case 'grown':
      return target.confirmedSize
        ? `Last placed when you had ${target.confirmedSize} ${noun}`
        : 'Your list has grown around it';
    case 'placed_long_ago': {
      const when = monthYear(target.lastConfirmedAt);
      return when ? `Last placed ${when}` : 'Placed a long time ago';
    }
    case 'neighbours':
      return 'Titles around it were ranked after it';
    default:
      return null;
  }
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function monthYear(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The line Watch History prints for a `refine` placement (T5).
 *
 * A refine is **ranking evidence, never a viewing**: its ledger row has no
 * `watch_event_id`, so Watch History lists it with the unattached placements and never
 * as a watch row. What it says comes from the ledger's own outcome — `#196` printed
 * `Still #N` for every refine, which is false for one that moved the title. Owned here,
 * beside the rest of Refine, so the screen that draws it needs one call and nothing else.
 */
export function refinePlacementLine(placement: {
  outcome: string;
  position: number;
  fromPosition: number | null;
}): string {
  const outcome =
    placement.outcome === 'moved' || placement.outcome === 'kept' ? placement.outcome : 'unchanged';
  const sentence = movementSentence(
    { outcome, fromPosition: placement.fromPosition },
    placement.position,
  );
  return `Refined · ${sentence ?? `#${placement.position}`}`;
}
