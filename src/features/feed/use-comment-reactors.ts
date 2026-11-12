import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

import { REACTIONS, type ReactionKind, type ReactionSummary, type Reactor } from './use-reactions';

/**
 * The people behind one comment's reaction cluster (founder tranche 2026-08-27 §18).
 *
 * `comment_reactors` (20260827000900) restates `activity_comments`' visibility gates
 * verbatim, so the identities returned are exactly the set that function counted for
 * this reader — the number on the row and the people in this sheet cannot disagree.
 * That is also why there is no residual "N more not shown" line for comments: unlike
 * the feed, where the count comes from reaction rows and the names from a separately
 * policied profile embed, here one definer function produces both.
 *
 * Fetched on open rather than with the thread: reactor identities are a drill-down a
 * minority of readers ask for, and `activity_comments` deliberately returns only
 * aggregates. The result is shaped as the feed's `ReactionSummary` so `ReactionDetail`
 * renders both surfaces — one list component, per the founder's "do not build three
 * separate implementations".
 */

type Row = {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  kind: string;
};

const isKind = (value: string): value is ReactionKind =>
  REACTIONS.some((reaction) => reaction.kind === value);

export function useCommentReactors(commentId: string | null, viewerId: string) {
  return useQuery({
    queryKey: ['comment-reactors', viewerId, commentId],
    enabled: Boolean(commentId),
    staleTime: 30_000,
    queryFn: async (): Promise<ReactionSummary> => {
      const { data, error } = await supabase.rpc('comment_reactors', {
        p_comment_id: commentId,
      });
      if (error) throw error;

      const people: Reactor[] = [];
      const byKind: Partial<Record<ReactionKind, number>> = {};
      let mine: ReactionKind | null = null;

      for (const row of (data ?? []) as Row[]) {
        // A seventh kind can only mean a newer server than this bundle. Skipped, not
        // crashed on — the same narrowing `use-comments` applies to the aggregate.
        if (!isKind(row.kind)) continue;
        byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
        if (row.user_id === viewerId) mine = row.kind;
        people.push({
          userId: row.user_id,
          username: row.username,
          name: row.display_name?.trim() || row.username,
          avatarUri: avatarUri(row.avatar_path),
          kind: row.kind,
        });
      }

      // The reader first, then alphabetical — the feed list's rule, applied here so
      // the two sheets read identically.
      people.sort((a, b) =>
        a.userId === viewerId ? -1 : b.userId === viewerId ? 1 : a.name.localeCompare(b.name),
      );

      return {
        total: people.length,
        mine,
        kinds: (Object.entries(byKind) as [ReactionKind, number][])
          .sort((a, b) => b[1] - a[1])
          .map(([kind]) => kind),
        byKind,
        people,
      };
    },
  });
}
