import { AWARD_TRACKS, type AwardTrack } from './tracks';

/**
 * An award as a feed event and a notification carry it (20260828000100).
 *
 * The two names are the server's snapshot of `award_tiers` at the moment the tier was
 * crossed. They are the fallback rather than the source: a client that knows the track
 * resolves everything from `tracks.ts`, which is canonical, and a client that does not —
 * a bundle older than a track added later — has these to draw instead of a key.
 */
export type AwardRef = {
  key: string;
  tierKey: string;
  /** `award_name` in the payload: the family name, "Comment Gremlin". */
  name?: string | null;
  /** `tier_label` in the payload: the tier's own name, "Whisper". */
  tierLabel?: string | null;
};

/**
 * What an earned award is *called*, and what was actually done to earn it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 *
 * Three surfaces announce an award — the Awards sheet row, the feed post, and the
 * earner's own inbox row — and until 2026-08-29 they did not agree. The sheet titled the
 * row with the tier the reader had reached (`progress.ts`); the feed and the inbox both
 * printed `payload.award_name`, which is the *track's family name*. So a founder who
 * earned Whisper was congratulated for "Comment Gremlin" and then found a row headed
 * "Whisper", with nothing on either screen connecting the two.
 *
 * The founder's ruling is that all four surfaces derive the name from the same canonical
 * tier definition, and that the name is **the tier that was earned**. This module is that
 * definition applied once, so a fourth surface cannot re-derive it a fourth way.
 *
 * ---------------------------------------------------------------------------
 * THE METAL EXCEPTION, WHICH IS NOT AN EXCEPTION TO THE RULE
 *
 * A track whose tiers are metals keeps its family name — Movie Muncher, not "Bronze".
 * That is the same rule `progress.ts` has applied to the sheet since the tracks were
 * written, and it is the reason the founder's own example copy reads "Ravi earned the
 * Movie Muncher award": for those tracks the family name *is* the earned name, because
 * "Bronze" says nothing about what was done and three rows headed "Bronze" say less.
 * `AwardTrack.metalTiers` is the flag, and it lives beside the tiers rather than here.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND LINE
 *
 * "Bronze" was the whole of a feed row's subtitle, which is the other half of what the
 * founder found: a row that says an award was earned and then names a metal explains
 * nothing. The threshold copy — "Watched 25 movies", "Wrote 20 comments" — is the
 * explanation, and `tracks.ts` already holds it as `earned(threshold)` because that is
 * the sentence the Awards sheet prints under a finished track. It is read from there
 * rather than written out again in the feed and the inbox, which is what stops the two
 * from quoting different numbers for one tier.
 */
export type AwardAnnouncement = {
  /** The emphasised slot: "Whisper", "Movie Muncher". Never a track key. */
  title: string;
  /** "Wrote 20 comments". Null only for a track this bundle has never heard of. */
  achievement: string | null;
};

const TRACKS: ReadonlyMap<string, AwardTrack> = new Map(
  AWARD_TRACKS.map((track) => [track.key, track]),
);

/**
 * What to say about one earned tier.
 *
 * **Degrades to the payload rather than to a key.** A feed row can outlive the bundle
 * that understands it — a track added server-side, an old install — and the two failure
 * modes are not equal: printing `comment-gremlin` is showing somebody an internal key,
 * which the tracks file forbids in as many words. So an unknown track falls back to the
 * names the server sent, and an unknown *tier* of a known track falls back to the tier
 * label, which is the same string the payload would have carried anyway.
 *
 * The threshold sentence is dropped rather than guessed at in both cases. A second line
 * that names the wrong number is worse than no second line, and the row is still a
 * complete sentence without one.
 */
export function awardAnnouncement(
  award: AwardRef,
  /**
   * What to say when the payload names nothing either, and it differs by surface: the
   * inbox's sentence is "You earned …" and the feed's is "Abisola earned the … award",
   * so "a new Award" and "bingd. Award" are each wrong in the other's clause. Taken as
   * an argument rather than chosen here, because this function has no way to know which
   * sentence it is inside.
   */
  fallback = 'a new Award',
): AwardAnnouncement {
  const track = TRACKS.get(award.key);
  if (!track) {
    return { title: award.name ?? fallback, achievement: null };
  }

  const tier = track.tiers.find((candidate) => candidate.key === award.tierKey) ?? null;

  return {
    // See the header: the metal tracks are titled by the family, everything else by the
    // tier that was reached. Identical to `progress.ts`'s `title`, and asserted to be.
    title: track.metalTiers
      ? track.displayName
      : (tier?.label ?? award.tierLabel ?? track.displayName),
    achievement: tier ? track.earned(tier.threshold) : null,
  };
}
