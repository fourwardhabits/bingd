import { useInfiniteQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * Followers and Following, as lists somebody can search (`20260826000600` §5).
 *
 * ---------------------------------------------------------------------------
 * THE PRIVACY IS THE SERVER'S, AND THERE IS NONE HERE
 *
 * `followers_of` and `following_of` are `security invoker`, so `follows_read` decides
 * which edges come back and `profiles_read` decides which of them can be named. That is
 * the rule `20260813001900` wrote down and this app has enforced since: an approved edge
 * is visible only to a viewer who can see *both* ends of it. A private account the
 * reader cannot view yields an empty list; a blocked account is absent from one rather
 * than counted in it.
 *
 * So this file adds no gate of its own, and the absence is deliberate rather than an
 * omission. A client-side filter over a server list is a second place for the rule to
 * live, and the second place is the one that gets it wrong.
 */

export type ListedPerson = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** True when the account is private, so the control offers Request rather than Follow. */
  isPrivate: boolean;
};

export type FollowListKind = 'followers' | 'following';

/**
 * How many rows one page is.
 *
 * Fifty rather than thirty, because a page here is a scroll rather than a screen: the
 * founder's instruction was not to hardcode "first 30 forever" when the server count can
 * exceed what came back, and a bigger page means the second request is rarer for the
 * accounts that will ever have one. The server caps a request at a hundred whatever this
 * says.
 */
const PAGE = 50;

type Row = {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  visibility: string;
};

/**
 * One person's followers, or the people they follow, a page at a time.
 *
 * ---------------------------------------------------------------------------
 * THE SEARCH GOES TO THE SERVER, AND THAT IS THE POINT
 *
 * Filtering the loaded page here would have been less code and is wrong in a way that
 * only shows up on the accounts that need it: with two pages loaded and eight hundred
 * followers, a client-side filter searches the fifty rows in hand and reports "no
 * results" for somebody who is definitely there. `p_query` searches the whole list
 * server-side and still cannot reach outside it — the function's `from` clause is
 * `follows`, so there is no path from this box to the user directory (founder part M).
 *
 * The query is part of the key, so two searches are two cached lists rather than one
 * list being overwritten, and clearing the box is instant rather than a refetch.
 *
 * ---------------------------------------------------------------------------
 * KEYED BY THE VIEWER AS WELL AS THE SUBJECT
 *
 * What a reader may see of one person's followers genuinely differs between accounts —
 * a private follower is visible to some viewers and not others — so a key without the
 * account serves one reader another's list after a switch on a shared device. Reviews 6,
 * 10 and 10b were each this defect somewhere else.
 */
export function useFollowList({
  kind,
  userId,
  viewerId,
  query,
  enabled = true,
}: {
  kind: FollowListKind;
  userId: string | null;
  viewerId: string;
  query: string;
  enabled?: boolean;
}) {
  const trimmed = query.trim();

  return useInfiniteQuery({
    queryKey: ['follow-list', kind, viewerId, userId, trimmed],
    enabled: enabled && Boolean(userId),
    initialPageParam: 0,
    // A minute, like `usePeopleMutuals`: a follow graph does not move between two taps,
    // and `useSocialWrites` invalidates this prefix whenever it does — which is what
    // makes an Unfollow performed *from this sheet* redraw the row rather than leave it
    // claiming to still follow.
    staleTime: 60_000,
    queryFn: async ({ pageParam }): Promise<ListedPerson[]> => {
      const { data, error } = await supabase.rpc(
        kind === 'followers' ? 'followers_of' : 'following_of',
        {
          p_user_id: userId as string,
          p_query: trimmed || null,
          p_limit: PAGE,
          p_offset: pageParam,
        },
      );
      if (error) throw error;

      return ((data ?? []) as Row[]).map((row) => ({
        id: row.user_id,
        username: row.username,
        name: row.display_name || row.username,
        avatarUri: avatarUri(row.avatar_path),
        isPrivate: row.visibility === 'private',
      }));
    },
    /**
     * A short page is the last page.
     *
     * There is no total to compare against and asking for one would be a second round
     * trip per page to learn something the page itself already implies. The cost of
     * getting it wrong in this direction is one empty request at the end of a list whose
     * length happens to be a multiple of fifty; the cost the other way is a list that
     * silently stops.
     */
    getNextPageParam: (last, all) =>
      last.length < PAGE ? undefined : all.reduce((n, page) => n + page.length, 0),
  });
}

/** Every page flattened, which is what the list renders. */
export const peopleIn = (pages: ListedPerson[][] | undefined): ListedPerson[] =>
  (pages ?? []).flat();
