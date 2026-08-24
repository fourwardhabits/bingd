import { supabase } from '@/lib/supabase';

/**
 * The subjects this client can report.
 *
 * A subset of `report_subject`, deliberately. The enum also carries `display_name`,
 * `username`, `list`, `list_title` and `watch_tag`, and those have no button anywhere
 * — a value in the enum is a thing the operator can file by hand, not a promise that
 * every surface offers one. These three are the surfaces a person actually reads
 * somebody else's writing on.
 *
 * `review` and not `note`: the user-facing object is a Review (20260817000800), and
 * the stored subject uses the same word so that an operator reading `moderation_queue`
 * sees what the reporter saw. A **private** note is absent from both, and that is not
 * an omission — a private note has exactly one reader, so there is nobody to report it
 * and no route through which to try.
 */
export type ReportSubject = 'profile' | 'comment' | 'review';

/** The backend taxonomy, `reports_known_reason`. Eight values, closed. */
export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'hate_speech'
  | 'sexual_content'
  | 'impersonation'
  | 'self_harm'
  | 'illegal_content'
  | 'other';

/**
 * The reasons, in the order they are offered.
 *
 * **The values are the database's and the labels are the reader's**, which is the one
 * rule this list follows. `hate_speech` is what `reports_known_reason` accepts and
 * "Hate speech" is what a person picking a reason understands; inventing a ninth
 * category here — or renaming one — would produce reports the triage process has no
 * column for.
 *
 * Ordered by how often each is the right answer rather than alphabetically, with
 * `self_harm` deliberately high: it is the one where a delay costs the most, and a
 * person looking for it is not in a state to read a list twice. "Something else" is
 * last because it is the fallback, and a fallback offered first is the one everybody
 * picks.
 */
export const REPORT_REASONS: {
  value: ReportReason;
  label: string;
  icon: 'ban-outline' | 'chatbubble-ellipses-outline' | 'alert-circle-outline' | 'eye-off-outline' | 'person-outline' | 'heart-outline' | 'warning-outline' | 'ellipsis-horizontal-circle-outline';
}[] = [
  { value: 'harassment', label: 'Harassment or bullying', icon: 'chatbubble-ellipses-outline' },
  { value: 'hate_speech', label: 'Hate speech', icon: 'alert-circle-outline' },
  { value: 'self_harm', label: 'Self-harm or suicide', icon: 'heart-outline' },
  { value: 'sexual_content', label: 'Sexual content', icon: 'eye-off-outline' },
  { value: 'impersonation', label: 'Pretending to be someone', icon: 'person-outline' },
  { value: 'illegal_content', label: 'Illegal content', icon: 'warning-outline' },
  { value: 'spam', label: 'Spam or a scam', icon: 'ban-outline' },
  { value: 'other', label: 'Something else', icon: 'ellipsis-horizontal-circle-outline' },
];

export type ReportResult = { ok: true } | { ok: false; message: string };

/**
 * SQLSTATEs rather than messages, for the reason `writes.ts` gives: the messages are
 * written for whoever reads the logs, they get reworded, and matching on them fails
 * silently when they do.
 */
const CODES = {
  /** Self-report, refused by `report()` itself. */
  invalidInput: '22023',
  /** `assert_can_write` on a suspended account. */
  suspended: '42501',
  unauthenticated: '28000',
  /** The subject is gone — deleted, or a note that is no longer public. */
  notFound: 'P0002',
  /** The daily ceiling in `app_config`. */
  rateLimited: '53400',
} as const;

/**
 * Files one report.
 *
 * **The receipt is deliberately uninformative and this function does not improve on
 * it.** `report()` answers `{done, received}` whether the row was inserted or the
 * reporter had already filed the same complaint, because saying which would tell them
 * whether an earlier report of theirs is still open — a fact about the moderation
 * queue, and not their business. So there is one success state here, and the sentence
 * the user reads after it is the same either way.
 *
 * No operation id: `report()` takes none, and it does not need one. Replaying a report
 * is harmless because `reports_one_open_per_reporter` makes the second one a no-op at
 * the database rather than in a guard the client has to get right.
 */
export async function submitReport(input: {
  subject: ReportSubject;
  subjectId: string;
  reason: ReportReason;
}): Promise<ReportResult> {
  const { error } = await supabase.rpc('report', {
    p_subject_type: input.subject,
    p_subject_id: input.subjectId,
    p_reason: input.reason,
  });

  if (!error) return { ok: true };

  switch ((error as { code?: string }).code) {
    case CODES.notFound:
      // A stale row. The client was showing something the server no longer has —
      // deleted, or a note its author has since made private. Saying so is both true
      // and the least alarming reading, and it is emphatically not a crash.
      return { ok: false, message: 'That has already been removed.' };
    case CODES.invalidInput:
      return { ok: false, message: 'You cannot report your own content.' };
    case CODES.rateLimited:
      return {
        ok: false,
        message: 'You have reported a lot today. Please try again tomorrow.',
      };
    case CODES.suspended:
      return { ok: false, message: 'Your account cannot make changes right now.' };
    case CODES.unauthenticated:
      return { ok: false, message: 'Your session expired. Sign in again.' };
    default:
      return { ok: false, message: 'Could not send that report. Try again.' };
  }
}
