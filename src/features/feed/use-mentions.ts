import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * Who the composer may offer when somebody types `@`.
 *
 * ---------------------------------------------------------------------------
 * THE EMPTY QUERY AND A TYPED ONE ARE DIFFERENT QUESTIONS
 *
 * `mention_candidates` answers both, and `20260909000100` is why they diverge.
 *
 * Mentionable now means "anybody this reader could find in People search who can also
 * see this activity" — `can_discover_profile`, the same oracle the People tab runs on,
 * rather than the follow-plus-participant union `20260830000100` shipped. So a stranger
 * *is* nameable, and a composer that could not surface them would be claiming otherwise.
 *
 * But a bare `@` still offers only participants and follows. The list appears mid-word,
 * under a moving thumb, and what belongs there is the people this reader is likely to
 * mean — not a slice of the user table. Type enough of a name and the server unions in
 * discoverable profiles by prefix; until then it does not.
 *
 * So the empty query stays meaningful and cheap — "the people I am likely to mean here"
 * — and it is still the right thing to show the instant the `@` is typed.
 *
 * **The client does no filtering either way.** Every row that arrives is a row the write
 * will accept; `_can_mention` is applied server-side to all three populations, so the
 * suggestion list and the post cannot disagree. That property is asserted in
 * `comment-mentions.test.mjs` ("offers nobody the write would refuse") rather than
 * trusted.
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
