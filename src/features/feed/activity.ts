/**
 * What an activity *says*, in one place.
 *
 * Three surfaces render the same events — the Feed tab, your own profile, and
 * somebody else's — and until now each carried its own copy of the verb table. Two of
 * the three were already wrong by omission: `profile.tsx` read
 * `type === 'title_logged' ? 'watched' : 'ranked'`, so a `season_completed` event said
 * "ranked" there and "finished" in the feed, and a fourth type added anywhere would
 * have been mislabelled on two screens before anybody noticed.
 *
 * So the vocabulary lives here and the screens import it. Adding an event type is one
 * edit, and forgetting to add it is a type error rather than a wrong word.
 *
 * ---------------------------------------------------------------------------
 * THE SENTENCE
 *
 * Founder Feed finalization, 2026-08-20, item 1. A feed row used to set the actor on
 * one line and the title on the next:
 *
 *     [avatar] Suraj Kandukuri ranked
 *              21 (2008)
 *
 * which reads as two fields rather than one statement — the title looked like a
 * property of the row, not the object of the verb. The structure is now one sentence
 * that the layout wraps where it likes:
 *
 *     [avatar] Suraj Kandukuri ranked 21 (2008)
 *
 * A sentence is `verb` + the title + an optional `tail`, because not every activity
 * puts its object last. "Added Dune (2021) **to their watchlist**" needs words after
 * the title, and forcing it into the verb slot would give "Suraj added to their
 * watchlist Dune (2021)". The founder's instruction was to keep it grammatical rather
 * than to keep one template, so there are two slots and most types use one.
 */

import {
  effectiveCertification,
  effectiveGenres,
  type MetadataSubject,
} from '@/lib/media-metadata';

/**
 * The event types the activity surfaces render.
 *
 * Not every type in `feed_events_known_type`: `list_created`, `list_added`,
 * `milestone_reached` and `joined_from_invitation` are written by other features and
 * have no row treatment yet. This array is what the read filters on, so a type absent
 * from it is not fetched rather than fetched and dropped.
 */
export const ACTIVITY_TYPES = [
  'title_ranked',
  'title_logged',
  'season_completed',
  'watchlist_added',
  'award_earned',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * Which activities are claims about having *seen* the title.
 *
 * Used to decide whether a row may carry a note and watch companions, and the
 * distinction is not cosmetic. Both of those are attached by matching
 * (actor, media item) rather than by event id — a note is live so it can be retracted,
 * a tag is live so the tagged person can withdraw it — so a `watchlist_added` event
 * for a film its actor later watched, tagged and wrote about would otherwise render as
 *
 *     Suraj added Dune (2021) to their watchlist with Anna
 *     "Best thing I saw all year."
 *
 * attributing a review of a film to the moment somebody decided to watch it. A
 * watchlist add is an intention, and nothing about having watched it belongs on it.
 */
export const isWatchActivity = (type: ActivityType): boolean =>
  // An allow-list since award_earned arrived: the old `!== 'watchlist_added'`
  // shape silently promoted every future type to a watch claim, and an award is
  // not about any title at all.
  type === 'title_ranked' || type === 'title_logged' || type === 'season_completed';

/** The verb between the actor and the title — or, for an award, the award's name. */
const VERB: Record<ActivityType, string> = {
  title_ranked: 'ranked',
  title_logged: 'watched',
  season_completed: 'finished',
  watchlist_added: 'added',
  award_earned: 'earned',
};

/**
 * The words after the title, for the activities that need them.
 *
 * "their" rather than "his or her" or a name: the row is read by people who are not
 * the actor, the app asks nobody for a pronoun, and "added Dune to Suraj's watchlist"
 * repeats a name the sentence opened with.
 */
const TAIL: Partial<Record<ActivityType, string>> = {
  watchlist_added: 'to their watchlist',
};

export const verbFor = (type: ActivityType): string => VERB[type];
export const tailFor = (type: ActivityType): string | null => TAIL[type] ?? null;

// ---------------------------------------------------------------------------
// The subheading
// ---------------------------------------------------------------------------

/**
 * What a feed row prints under the sentence.
 *
 * Founder Feed finalization, item 7, which standardises a line that had drifted to
 * `148m · Sci-Fi` — one genre, no rating, and nothing at all for a season, whose row
 * carries neither genres nor a runtime of its own:
 *
 *     movie   PG-13 · 148m · Science Fiction · Adventure
 *     season  TV-MA · 8 episodes · Action · Animation
 *
 * **Rating first**, because it is what somebody scans before deciding whether to put a
 * thing on, and it is the order the title page already prints (`app/title/[id].tsx`).
 *
 * **A season is counted in episodes and never in minutes.** The founder ruled out both
 * halves of the alternative and the schema agrees with them: a season has no runtime,
 * and the only minutes anywhere near it are the parent series' `episode_run_time[0]`,
 * which describes *one episode*. Rendered in the slot a reader scans for "how long is
 * this", `50m` for a twenty-hour season is worse than a blank. So the fall-through
 * that genres and certification both use is deliberately absent for length.
 *
 * **A series shows no length at all**, for the same reason. Nothing is ranked at the
 * series level (PRD §10), but a whole show *can* be put on a watchlist, so the case is
 * real; a series-level episode total is explicitly not what the founder wants, and its
 * `runtime_minutes` is the per-episode figure. It gets `TV-MA · Drama · Thriller`.
 *
 * **Two genres maximum.** The line sits under a sentence in a column about 192pt wide
 * on a 360pt device; four genres wrap it and it is the subordinate element on the row.
 *
 * **Absent parts vanish with their separator.** Every segment is dropped before the
 * join rather than replaced, so there is no `Unknown · 148m`, no leading `· ` and no
 * `· ·` — and a row with nothing to say returns null and renders nothing, rather than
 * an empty line holding space open.
 */
export function activityMetadata(media: {
  kind: 'movie' | 'season' | 'series' | null;
  genres?: readonly string[] | null;
  certification?: string | null;
  runtimeMinutes?: number | null;
  episodeCount?: number | null;
  parent?: { genres?: readonly string[] | null; certification?: string | null } | null;
}): string | null {
  if (!media.kind) return null;

  const subject: MetadataSubject = {
    kind: media.kind,
    genres: media.genres,
    certification: media.certification,
    parent: media.parent ?? null,
  };

  const parts = [
    effectiveCertification(subject),
    lengthOf(media.kind, media.runtimeMinutes, media.episodeCount),
    ...effectiveGenres(subject).slice(0, 2),
  ].filter((part): part is string => Boolean(part));

  return parts.length ? parts.join(' · ') : null;
}

/** `148m`, `8 episodes`, `1 episode`, or nothing. */
function lengthOf(
  kind: 'movie' | 'season' | 'series',
  runtimeMinutes: number | null | undefined,
  episodeCount: number | null | undefined,
): string | null {
  if (kind === 'movie') {
    return positive(runtimeMinutes) ? `${Math.trunc(runtimeMinutes as number)}m` : null;
  }
  if (kind === 'season') {
    if (!positive(episodeCount)) return null;
    const count = Math.trunc(episodeCount as number);
    return `${count} ${count === 1 ? 'episode' : 'episodes'}`;
  }
  // A series. See the note above: neither number it could print is the truth.
  return null;
}

/**
 * A number worth printing.
 *
 * Zero is excluded on purpose and is not the same as null: a season TMDB reports as
 * having no episodes has not aired, and `0 episodes` in this line reads as a fact
 * about the show rather than as data nobody has yet.
 */
const positive = (value: number | null | undefined): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

// ---------------------------------------------------------------------------
// The two adapters every activity surface needs
//
// Both were private helpers at the bottom of `app/(tabs)/feed.tsx`, copied into
// `CommentThread` and about to be copied a third time into the activity page. `metadataFor`
// even carried a comment saying the rules live in this file "so that the three surfaces
// rendering an activity cannot drift apart on them" — while the adapter that calls those
// rules sat in one of the three. Moving them is that comment finished.
//
// `relativeTime` is the sharper case. Three copies of the same arithmetic had already
// been written, and they agreed only because they were copied carefully; the first one
// somebody rounds differently is two surfaces describing one instant two ways, on the
// same screen, since the thread page draws the card and the comments together.
// ---------------------------------------------------------------------------

/**
 * `PG-13 · 148m · Science Fiction · Adventure`, from an item the feed has already
 * resolved.
 *
 * The adapter and not the rule: a `FeedItem` has already inherited a season's genres and
 * certification from its parent series (`lib/media-metadata.ts`), so this only reshapes
 * what that produced for `activityMetadata` above.
 */
export function metadataFor(item: {
  kind: 'movie' | 'season' | 'series' | null;
  genres?: readonly string[] | null;
  certification?: string | null;
  runtimeMinutes?: number | null;
  episodeCount?: number | null;
}): string | null {
  return activityMetadata({
    kind: item.kind,
    genres: item.genres,
    certification: item.certification,
    runtimeMinutes: item.runtimeMinutes,
    episodeCount: item.episodeCount,
  });
}

/**
 * How long ago, in the words every activity surface uses.
 *
 * Minutes under an hour, hours under a day, days after that — and never "just now" or a
 * date. A floor of one minute rather than "0m ago", which reads as a bug.
 */
export function relativeTime(value: string): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
