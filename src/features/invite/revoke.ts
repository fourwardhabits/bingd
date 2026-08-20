import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';

/**
 * The client half of `revoke_invite_link` (`20260819000500`).
 *
 * **This is a safety control and not a feature**, and the distinction is why it exists
 * in a run whose product scope was frozen. A personal invite link is reusable, has no
 * expiry, and is pasted into group chats — and before `20260819000500` it resolved to
 * nothing at all, so a leaked one was harmless. That migration makes it a live
 * attribution vector. The same change therefore owes the control that takes it back.
 * Independent review 26 named the omission.
 *
 * Revoking mints the replacement in the same transaction, because
 * `invite_tokens_one_live` permits exactly one live token and an account with none is a
 * state the Share control has no answer for. So the caller always gets a link back.
 */

export type RevokeOutcome =
  /** The old link is dead and this is its replacement. */
  | { outcome: 'revoked'; token: string; shortCode: string | null }
  /**
   * A replay. The link returned is the one that is live *now* — the server does not
   * rotate a second time, which would detach everybody given the link in between.
   */
  | { outcome: 'already_applied'; token: string | null }
  | { outcome: 'failed'; message: string; changed: boolean };

export async function revokeInviteLink(operationId: string): Promise<RevokeOutcome> {
  const { data, error } = await supabase.rpc('revoke_invite_link', {
    p_operation_id: operationId,
  });

  if (error) {
    return {
      outcome: 'failed',
      // `53400` is the tight per-day ceiling, and it is worth surfacing as itself:
      // somebody rotating their link repeatedly is doing something they should be told
      // has a limit, rather than being shown a generic failure.
      message:
        error.code === '53400'
          ? 'You have replaced your link several times today. Try again tomorrow.'
          : error.message,
      changed: classifyWrite(error) === 'unknown',
    };
  }

  const result = data as { status?: string; token?: string; short_code?: string } | null;

  if (!result?.token) {
    // Answered, but with nothing to share. The request reached the server, so whatever
    // it did is committed — the same reading every other writer here takes.
    return { outcome: 'failed', message: 'Your link could not be replaced.', changed: true };
  }

  return result.status === 'already_applied'
    ? { outcome: 'already_applied', token: result.token }
    : { outcome: 'revoked', token: result.token, shortCode: result.short_code ?? null };
}
