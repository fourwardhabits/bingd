import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { newOperationId } from '@/features/collection/writes';
import { diagnose } from '@/lib/diagnose';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * The six, in PRD §14's order. Stored as meanings rather than glyph names, so
 * swapping a thumb for a face is a copy change and never a data migration.
 */
export const REACTIONS = [
  { kind: 'love', label: 'Love', glyph: '❤️' },
  { kind: 'agree', label: 'Agree', glyph: '👍' },
  { kind: 'disagree', label: 'Disagree', glyph: '👎' },
  { kind: 'funny', label: 'Funny', glyph: '😂' },
  { kind: 'wow', label: 'Wow', glyph: '😮' },
  { kind: 'moved', label: 'Moved', glyph: '😢' },
] as const;

export type ReactionKind = (typeof REACTIONS)[number]['kind'];

/**
 * The one a plain tap gives.
 *
 * Named rather than inlined, because two places have to agree on it — the tap
 * handler and the control that decides whether the icon is filled — and a literal
 * `'love'` in both is the kind of pair that drifts.
 */
export const DEFAULT_REACTION: ReactionKind = 'love';

export const REACTION_LABEL: Record<ReactionKind, string> = Object.fromEntries(
  REACTIONS.map((r) => [r.kind, r.label]),
) as Record<ReactionKind, string>;

export const REACTION_GLYPH: Record<ReactionKind, string> = Object.fromEntries(
  REACTIONS.map((r) => [r.kind, r.glyph]),
) as Record<ReactionKind, string>;

/** One person's reaction, for the detail surface. */
export type Reactor = {
  userId: string;
  username: string;
  name: string;
  avatarUri: string | null;
  kind: ReactionKind;
};

export type ReactionSummary = {
  total: number;
  /** The signed-in user's own, or null. */
  mine: ReactionKind | null;
  /** Distinct kinds present, most common first. PRD §14 shows the glyphs, not a total. */
  kinds: ReactionKind[];
  /** How many chose each kind, for the detail surface's filters. */
  byKind: Partial<Record<ReactionKind, number>>;
  /**
   * Everyone who reacted, as far as this viewer is allowed to know.
   *
   * `reactions_read` requires `can_i_view` on both the reactor and the event's
   * actor, so this list is already the authorised one — a blocked reactor is absent
   * rather than anonymised, and nothing here filters a second time. Founder
   * decision, 2026-08-16: no friend-only name masking in v1; everyone the viewer may
   * see is named.
   */
  people: Reactor[];
};

const EMPTY: ReactionSummary = { total: 0, mine: null, kinds: [], byKind: {}, people: [] };

type ReactionRow = {
  feed_event_id: string;
  user_id: string;
  kind: ReactionKind;
  profiles:
    | { id: string; display_name: string | null; username: string; avatar_path: string | null }
    | { id: string; display_name: string | null; username: string; avatar_path: string | null }[]
    | null;
};

const one = <T>(value: T | T[] | null): T | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

/**
 * Reactions for the events on screen, in one round trip.
 *
 * There is deliberately no aggregate RPC. `reactions_read` already answers this per
 * viewer — it requires visibility of both the reactor and the event's actor — so a
 * blocked user's reaction is *absent* rather than counted anonymously. A definer
 * aggregate would have had to rebuild that rule, and would have had to get it right
 * a second time.
 *
 * The counting therefore happens here, over rows the database has already filtered.
 */
export function useReactions(eventIds: string[], viewerId: string) {
  const key = [...eventIds].sort().join(',');

  return useQuery({
    queryKey: ['reactions', viewerId, key],
    enabled: eventIds.length > 0,
    queryFn: async (): Promise<Map<string, ReactionSummary>> => {
      const { data, error } = await supabase
        .from('reactions')
        .select(
          'feed_event_id, user_id, kind, profiles:user_id(id, display_name, username, avatar_path)',
        )
        .in('feed_event_id', eventIds);
      if (error) throw error;

      const byEvent = new Map<string, ReactionSummary>();

      for (const row of (data ?? []) as unknown as ReactionRow[]) {
        const summary =
          byEvent.get(row.feed_event_id) ?? { ...EMPTY, kinds: [], byKind: {}, people: [] };
        summary.total += 1;
        if (row.user_id === viewerId) summary.mine = row.kind;
        summary.byKind[row.kind] = (summary.byKind[row.kind] ?? 0) + 1;

        const profile = one(row.profiles);
        const name = profile?.display_name || profile?.username;
        // A reactor whose profile did not resolve is counted and not named. The
        // count comes from the reaction row, which the viewer is authorised to see;
        // the name comes from a profile embed, whose own policy may withhold it.
        // Inventing "Someone" for the gap would be the feed's old bug in a new place.
        if (profile && name) {
          summary.people.push({
            userId: row.user_id,
            username: profile.username,
            name,
            avatarUri: avatarUri(profile.avatar_path),
            kind: row.kind,
          });
        }

        byEvent.set(row.feed_event_id, summary);
      }

      for (const summary of byEvent.values()) {
        summary.kinds = (Object.entries(summary.byKind) as [ReactionKind, number][])
          .sort((a, b) => b[1] - a[1])
          .map(([kind]) => kind);
        // The reader first, then alphabetical. On a surface that names people, the
        // one whose reaction can be changed from here belongs at the top.
        summary.people.sort((a, b) =>
          a.userId === viewerId ? -1 : b.userId === viewerId ? 1 : a.name.localeCompare(b.name),
        );
      }

      return byEvent;
    },
  });
}

export const emptyReactionSummary = () => EMPTY;

/**
 * Sets, changes or clears the viewer's reaction.
 *
 * Optimism is deliberately absent. A reaction is one round trip on a row the user is
 * looking at, and an optimistic count that rolls back is a worse experience than a
 * count that arrives a moment later — especially for `disagree`, where a flicker
 * between two states is a message being sent and unsent to a friend.
 */
export function useSetReaction(viewerId: string) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);

  const setReaction = async (feedEventId: string, kind: ReactionKind | null) => {
    if (pending) return { ok: false as const, message: null };
    setPending(feedEventId);

    const { error } = await supabase.rpc('set_reaction', {
      p_operation_id: newOperationId(),
      p_feed_event_id: feedEventId,
      p_kind: kind,
    });

    setPending(null);
    if (error) return { ok: false as const, message: diagnose(error) ?? error.message };

    await queryClient.invalidateQueries({ queryKey: ['reactions', viewerId] });
    return { ok: true as const, message: null };
  };

  return { setReaction, pending };
}
