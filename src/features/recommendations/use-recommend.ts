import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { newOperationId } from '@/features/collection/writes';
import { diagnose } from '@/lib/diagnose';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * The send half of friend recommendations (20260817001300).
 *
 * The recipient rule is **mutual follow**, and it lives in the database. What lives
 * here is the same rule expressed as a query, so that the sheet offers only people the
 * server will accept — a picker that lets you choose somebody and then refuses is
 * worse than one that never offered them. The duplication is deliberate and the
 * server's copy is the one that decides; this one is a courtesy.
 */

export type Recipient = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
};

type ProfileShape = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  status: string;
};

const one = <T>(value: T | T[] | null): T | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

/**
 * Everybody the viewer and the other person follow, both ways, both approved.
 *
 * Two selects intersected rather than one join, because `follows_read` admits a row
 * only where the caller is a party to it — which is exactly what makes this safe to
 * run from the client at all. Neither query can see anybody else's graph.
 *
 * Blocks are not filtered here and do not need to be: `block` deletes both follow
 * rows, so a blocked person has no edges left to intersect. Suspension is filtered,
 * because a suspended account keeps its edges and should stop being offered.
 */
export function useRecommendRecipients(viewerId: string) {
  return useQuery({
    queryKey: ['recommend-recipients', viewerId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Recipient[]> => {
      const [following, followers] = await Promise.all([
        supabase
          .from('follows')
          .select('profiles:followee_id(id, username, display_name, avatar_path, status)')
          .eq('follower_id', viewerId)
          .eq('state', 'approved'),
        supabase
          .from('follows')
          .select('profiles:follower_id(id, username, display_name, avatar_path, status)')
          .eq('followee_id', viewerId)
          .eq('state', 'approved'),
      ]);

      if (following.error) throw following.error;
      if (followers.error) throw followers.error;

      const outgoing = new Map<string, ProfileShape>();
      for (const row of following.data ?? []) {
        const profile = one((row as { profiles: ProfileShape | ProfileShape[] | null }).profiles);
        if (profile) outgoing.set(profile.id, profile);
      }

      const mutuals: Recipient[] = [];
      for (const row of followers.data ?? []) {
        const profile = one((row as { profiles: ProfileShape | ProfileShape[] | null }).profiles);
        if (!profile || !outgoing.has(profile.id)) continue;
        if (profile.status !== 'active') continue;
        mutuals.push({
          id: profile.id,
          username: profile.username,
          name: profile.display_name || profile.username,
          avatarUri: avatarUri(profile.avatar_path),
        });
      }

      return mutuals.sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

/** A simple contains match over name and handle, for a list that has outgrown reading. */
export function filterRecipients(people: Recipient[], query: string): Recipient[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return people;
  return people.filter(
    (person) =>
      person.name.toLowerCase().includes(needle) ||
      person.username.toLowerCase().includes(needle),
  );
}

export type SendResult = { ok: true } | { ok: false; message: string };

/**
 * What the server says when it will not send.
 *
 * `recommend_title` returns its refusals rather than raising them, so that a refused
 * attempt still costs the sender a slot against the hourly ceiling — see the header of
 * `20260817001300`. The consequence here is that **a 200 is not a success**, and the
 * body has to be read.
 *
 * `not_mutual` covers a stranger, a one-way follow, a block in either direction and a
 * suspended account, all as one answer. The wording is about the relationship rather
 * than about the person, which is both the honest reading and the one that does not
 * tell somebody they have been blocked.
 */
const REFUSALS: Record<string, string> = {
  not_mutual: 'You can only recommend to people who follow you back.',
  yourself: 'You cannot recommend a title to yourself.',
  not_recommendable: 'You can recommend a film or a season, not a whole series.',
};

/**
 * Sending one.
 *
 * One recipient per call, which is the V1 shape: no multi-select, no send-to-all, no
 * message. Refusals arrive in the body and errors arrive as codes, and both become
 * sentences here rather than reaching the sheet as either.
 */
export function useRecommendTitle(viewerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      recipientId,
      mediaItemId,
    }: {
      recipientId: string;
      mediaItemId: string;
    }): Promise<SendResult> => {
      const { data, error } = await supabase.rpc('recommend_title', {
        p_operation_id: newOperationId(),
        p_recipient_id: recipientId,
        p_media_item_id: mediaItemId,
      });

      if (error) {
        switch (error.code) {
          case '53400':
            return {
              ok: false,
              message: 'You have sent a lot of recommendations today. Try again later.',
            };
          // assert_can_write. The only 42501 left on this path, now that a refused
          // recipient comes back in the body instead.
          case '42501':
            return { ok: false, message: 'Your account cannot make changes right now.' };
          default:
            return { ok: false, message: diagnose(error) ?? error.message };
        }
      }

      const result = data as { status?: string; reason?: string } | null;
      if (result?.status === 'refused') {
        return {
          ok: false,
          message: REFUSALS[result.reason ?? ''] ?? 'That recommendation could not be sent.',
        };
      }

      return { ok: true };
    },
    onSuccess: (result) => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: ['sent-to-you'] });
      void queryClient.invalidateQueries({ queryKey: ['recommend-recipients', viewerId] });
    },
  });
}

/**
 * The one reusable personal link, and the record that it was created.
 *
 * Returns null rather than throwing when the link cannot be minted. Sharing a title
 * with somebody who is not on Bingd is the point of the control; failing the whole
 * share because the growth instrumentation was unavailable would be the tail wagging
 * the dog.
 */
export async function createInviteLink(mediaItemId: string | null): Promise<string | null> {
  const { data, error } = await supabase.rpc('create_invite_link', {
    p_operation_id: newOperationId(),
    p_media_item_id: mediaItemId,
  });
  if (error) return null;

  const token = (data as { token?: string } | null)?.token;
  return token ? `https://bingd.app/i/${token}` : null;
}
