import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * People discovery (`20260826000500`, founder tranche 2026-08-26 §§10–15).
 *
 * Two suggestion lists behind one shape. Both are read entirely by the server: this
 * file sends a limit and receives identity plus one number, which is the constraint
 * stated as an interface — neither the follow graph nor anybody's ranking catalogue is
 * ever downloaded to be filtered here, and there is no client path that could start.
 *
 * **What is deliberately absent.** No contacts, no address book, no phone numbers. The
 * founder deferred all three explicitly and the requirements for ever building them are
 * written down in `docs/product/prd.md` rather than half-built here.
 */

export type PersonSuggestion = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** True when the account is private, so the control offers Request rather than Follow. */
  isPrivate: boolean;
  /**
   * The one line of context under the handle.
   *
   * Exactly one of the two, because the two sections answer different questions and a
   * row that showed both would be inviting a comparison between a percentage and a
   * count.
   */
  context: { kind: 'mutuals'; count: number } | { kind: 'match'; score: number };
};

type Row = {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  visibility: string;
};

const identity = (row: Row) => ({
  id: row.user_id,
  username: row.username,
  name: row.display_name || row.username,
  avatarUri: avatarUri(row.avatar_path),
  isPrivate: row.visibility === 'private',
});

/**
 * People followed by the people you follow, most shared connections first.
 *
 * **The number is a count and never a list of names.** `people_mutuals` could name them
 * — every edge it counts is one `follows_read` would admit to this caller individually
 * — but "Followed by Sarah and 2 others" puts a specific person's following list on
 * somebody else's screen as a claim, in something they can screenshot. The founder's
 * instruction was to fall back to a number if naming raised any doubt, and it does.
 *
 * Keyed by the viewer, like every viewer-relative key in this app. The answer is
 * *entirely* about who is asking, and a cache entry reachable from a second account
 * signed in on the same device is the defect reviews 6 and 10 each found somewhere else.
 *
 * A minute of `staleTime`, because a follow graph does not move between two taps and
 * this list is looked at by scrolling past it. `useSocialWrites` invalidates the key
 * whenever it does move, which is what makes a Follow performed *from this list* remove
 * the row rather than leave it sitting there saying Follow.
 */
export function usePeopleMutuals(viewerId: string, enabled = true) {
  return useQuery({
    queryKey: ['people-mutuals', viewerId],
    enabled: enabled && Boolean(viewerId),
    staleTime: 60_000,
    queryFn: async (): Promise<PersonSuggestion[]> => {
      const { data, error } = await supabase.rpc('people_mutuals', { p_limit: 10 });
      if (error) throw error;

      return ((data ?? []) as (Row & { mutual_count: number })[]).map((row) => ({
        ...identity(row),
        context: { kind: 'mutuals' as const, count: row.mutual_count },
      }));
    },
  });
}

/**
 * People whose rankings agree most with yours.
 *
 * **The number is `taste_match`'s own** and is not recomputed here or on the server's
 * side of this call: `people_taste_matches` invokes that function per candidate, so a
 * suggestion showing 87% and the same person's profile showing 87% are the same
 * arithmetic and cannot drift. The founder's rule for this screen was that Bingd has
 * one taste algorithm, and calling it is the only way to keep that true.
 *
 * A candidate with no score is not returned at all — below `taste.min_common` shared
 * titles the calculation refuses, and this screen says nothing rather than guessing.
 */
export function usePeopleTasteMatches(viewerId: string, enabled = true) {
  return useQuery({
    queryKey: ['people-taste-matches', viewerId],
    enabled: enabled && Boolean(viewerId),
    staleTime: 60_000,
    queryFn: async (): Promise<PersonSuggestion[]> => {
      const { data, error } = await supabase.rpc('people_taste_matches', { p_limit: 10 });
      if (error) throw error;

      return ((data ?? []) as (Row & { match_score: number })[]).map((row) => ({
        ...identity(row),
        context: { kind: 'match' as const, score: row.match_score },
      }));
    },
  });
}

/**
 * The two lists as one screen's worth of sections, with the order the founder asked for
 * and nothing that would draw an empty heading.
 *
 * Mutuals lead when there are any, because a shared connection is a stronger reason to
 * look at somebody than an agreement about films. With no mutuals, taste matches lead
 * rather than sitting under a heading with nothing above it.
 *
 * **Nobody appears twice.** Somebody can easily be both a friend of a friend and a good
 * taste match, and two rows for one person in one scroll is the list looking broken.
 * Mutuals win the duplicate, which follows from them leading.
 *
 * Separated from the component so the ordering rules are testable without a render.
 */
export function peopleSections(
  mutuals: PersonSuggestion[] | undefined,
  matches: PersonSuggestion[] | undefined,
): { title: string; people: PersonSuggestion[] }[] {
  const first = mutuals ?? [];
  const seen = new Set(first.map((person) => person.id));
  const second = (matches ?? []).filter((person) => !seen.has(person.id));

  return [
    { title: 'Mutuals', people: first },
    { title: 'Taste matches', people: second },
  ].filter((section) => section.people.length > 0);
}
