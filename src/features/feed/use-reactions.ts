import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { newOperationId } from '@/features/collection/writes';
import { supabase } from '@/lib/supabase';

/**
 * The six, in PRD §14's order. Stored as meanings rather than glyph names, so
 * swapping a thumb for a face is a copy change and never a data migration.
 */
export const REACTIONS = [
  { kind: 'love', label: 'Loved this', glyph: '❤️' },
  { kind: 'agree', label: 'Good take', glyph: '👍' },
  { kind: 'disagree', label: 'Bad take', glyph: '👎' },
  { kind: 'funny', label: 'Funny', glyph: '😂' },
  { kind: 'wow', label: 'Impressive or surprising', glyph: '😲' },
  { kind: 'moved', label: 'This moved me', glyph: '🥲' },
] as const;

export type ReactionKind = (typeof REACTIONS)[number]['kind'];

export const REACTION_LABEL: Record<ReactionKind, string> = Object.fromEntries(
  REACTIONS.map((r) => [r.kind, r.label]),
) as Record<ReactionKind, string>;

export const REACTION_GLYPH: Record<ReactionKind, string> = Object.fromEntries(
  REACTIONS.map((r) => [r.kind, r.glyph]),
) as Record<ReactionKind, string>;

export type ReactionSummary = {
  total: number;
  /** The signed-in user's own, or null. */
  mine: ReactionKind | null;
  /** Distinct kinds present, most common first. PRD §14 shows the glyphs, not a total. */
  kinds: ReactionKind[];
  /** At most two, for "Jerry and Beth". */
  names: string[];
  /** How many reactors beyond the named ones. */
  others: number;
};

const EMPTY: ReactionSummary = { total: 0, mine: null, kinds: [], names: [], others: 0 };

type ReactionRow = {
  feed_event_id: string;
  user_id: string;
  kind: ReactionKind;
  profiles: { display_name: string | null; username: string } | { display_name: string | null; username: string }[] | null;
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
        .select('feed_event_id, user_id, kind, profiles:user_id(display_name, username)')
        .in('feed_event_id', eventIds);
      if (error) throw error;

      const byEvent = new Map<string, ReactionSummary>();
      const counts = new Map<string, Map<ReactionKind, number>>();

      for (const row of (data ?? []) as unknown as ReactionRow[]) {
        const summary = byEvent.get(row.feed_event_id) ?? { ...EMPTY, kinds: [], names: [] };
        summary.total += 1;
        if (row.user_id === viewerId) summary.mine = row.kind;

        const profile = one(row.profiles);
        const name = profile?.display_name || profile?.username;
        // PRD §14: at most two names, then a residual count. "You" is not one of
        // them — a row that says "You and Beth" reads as though you are being
        // reported to yourself.
        if (name && row.user_id !== viewerId && summary.names.length < 2) {
          summary.names.push(name);
        }

        const perKind = counts.get(row.feed_event_id) ?? new Map<ReactionKind, number>();
        perKind.set(row.kind, (perKind.get(row.kind) ?? 0) + 1);
        counts.set(row.feed_event_id, perKind);

        byEvent.set(row.feed_event_id, summary);
      }

      for (const [eventId, summary] of byEvent) {
        summary.kinds = [...(counts.get(eventId) ?? new Map())]
          .sort((a, b) => b[1] - a[1])
          .map(([kind]) => kind);
        summary.others = Math.max(summary.total - summary.names.length, 0);
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
    if (error) return { ok: false as const, message: error.message };

    await queryClient.invalidateQueries({ queryKey: ['reactions', viewerId] });
    return { ok: true as const, message: null };
  };

  return { setReaction, pending };
}
