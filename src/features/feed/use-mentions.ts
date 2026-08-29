import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * Who the composer may offer when somebody types `@`.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A USER SEARCH, AND THE DIFFERENCE IS THE FEATURE
 *
 * `search_users` exists, and pointing this at it would have been one line. The
 * founder's rule for mentions is that typing `@` must not surface arbitrary accounts,
 * and the only version of that rule which cannot be got wrong on the client is one
 * where the client is never sent a stranger to filter out.
 *
 * So `mention_candidates` (20260830000100) builds the set from the two populations the
 * server will accept a mention from — the people this reader follows, and the people
 * already in this conversation — and applies `_can_mention` to each. A stranger is not
 * ranked low here. There is no row.
 *
 * That also means the empty query is meaningful and cheap: it is "everybody I could
 * name here", which is exactly what the list should show the instant the `@` is typed
 * and before anything follows it.
 *
 * ---------------------------------------------------------------------------
 * KEYED ON THE EVENT AND THE FRAGMENT, AND ON THE READER
 *
 * The event, because the participant half of the population is per-conversation. The
 * fragment, because it is a different question. The reader, for the reason every social
 * query in this app carries one: the answer genuinely differs between two accounts
 * looking at the same thread, and a key without it serves one person another's list
 * after a switch (reviews 6, 10 and 10b).
 *
 * `placeholderData` holds the previous fragment's rows while the next lands, so the
 * list does not blink to empty between keystrokes — the one place in this app that is
 * right, because the list is transient and a flicker under a moving thumb reads as the
 * control failing.
 */

export type MentionCandidate = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** In this conversation already, which is why they sort first. */
  participant: boolean;
};

type Row = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  participant: boolean;
};

export function useMentionCandidates(
  eventId: string | null,
  /** The text after the `@`, or null when no mention is being typed. */
  query: string | null,
  viewerId: string,
) {
  return useQuery({
    queryKey: ['mention-candidates', viewerId, eventId, query ?? ''],
    enabled: Boolean(eventId) && query !== null,
    // The follow list and the thread's participants both move slowly, and a mention is
    // typed in bursts. A minute of staleness costs somebody followed thirty seconds ago
    // not appearing until the next thread is opened.
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<MentionCandidate[]> => {
      const { data, error } = await supabase.rpc('mention_candidates', {
        p_feed_event_id: eventId as string,
        p_query: query ?? '',
      });
      if (error) throw error;

      return ((data ?? []) as Row[]).map((row) => ({
        id: row.id,
        username: row.username,
        name: row.display_name?.trim() || row.username,
        avatarUri: avatarUri(row.avatar_path),
        participant: row.participant,
      }));
    },
  });
}
