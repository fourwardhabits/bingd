import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';

/**
 * The client half of `create_profile` (20260813002200). The server owns every rule;
 * this owns turning its answers into something a form can say.
 */

export type CreateProfileResult =
  | { outcome: 'created' }
  /** The caller already had a profile — a retried request. Continue into the app. */
  | { outcome: 'already_exists' }
  /** Under 13. The account has been deleted server-side; the session must be ended. */
  | { outcome: 'under_13' }
  | { outcome: 'username_taken' }
  | { outcome: 'invalid'; message: string }
  /**
   * `changed` means the profile may exist anyway: the request went unanswered rather
   * than being declined, and `create_profile` may have committed. The same flag, and
   * the same rule, as `collection/writes.ts` — see `lib/write-outcome.ts`.
   *
   * It matters here more than most places, because the screen the person is looking at
   * is the one thing standing between them and an account they already have. Retrying
   * does converge — the second attempt answers `already_exists` — but it should not
   * take a second attempt to find out.
   */
  | { outcome: 'failed'; message: string; changed?: boolean };

/**
 * SQLSTATEs, not messages. The database raises standard codes and the messages are
 * for humans reading logs; matching on message text breaks the first time someone
 * rewords one, and does so silently.
 */
const CODES = {
  profileExists: '42710',
  uniqueViolation: '23505',
  invalidInput: '22023',
  unauthenticated: '28000',
} as const;

export async function createProfile(input: {
  username: string;
  displayName?: string | null;
  dateOfBirth: string;
}): Promise<CreateProfileResult> {
  const { data, error } = await supabase.rpc('create_profile', {
    p_username: input.username,
    p_display_name: input.displayName ?? null,
    p_date_of_birth: input.dateOfBirth,
  });

  if (error) {
    switch (error.code) {
      case CODES.profileExists:
        return { outcome: 'already_exists' };
      case CODES.uniqueViolation:
        return { outcome: 'username_taken' };
      case CODES.invalidInput:
        return { outcome: 'invalid', message: 'Check your username and date of birth.' };
      case CODES.unauthenticated:
        return { outcome: 'failed', message: 'Your session expired. Sign in again.' };
      default:
        // Everything the four cases above do not name. Only a code this app raises on
        // purpose proves the insert did not happen.
        return {
          outcome: 'failed',
          message: error.message,
          changed: classifyWrite(error) === 'unknown',
        };
    }
  }

  // The age refusal arrives as a value rather than an error, because deleting the
  // account is the point and an exception would roll that back. See the migration.
  const result = data as { ok?: boolean; reason?: string } | null;
  if (result?.ok === false) {
    return result.reason === 'under_13'
      ? { outcome: 'under_13' }
      : { outcome: 'failed', message: 'Your account could not be created.' };
  }

  return { outcome: 'created' };
}

/**
 * Availability as the server computes it, so the form cannot promise a name the
 * insert will refuse. Returns `null` when the answer is unknown — offline, say —
 * which the UI must render as "not checked" rather than as either answer.
 */
export async function usernameAvailability(username: string): Promise<boolean | null> {
  const candidate = username.trim().toLowerCase();
  if (!candidate) return null;

  const { data, error } = await supabase.rpc('username_available', { p_username: candidate });
  if (error) return null;
  return Boolean(data);
}
