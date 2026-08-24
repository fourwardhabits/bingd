import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { Sheet, SheetRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import {
  REPORT_REASONS,
  submitReport,
  type ReportReason,
  type ReportSubject,
} from './report';

export type ReportSheetProps = {
  visible: boolean;
  onClose: () => void;
  subject: ReportSubject;
  /**
   * The subject's id: a profile id, a `comments.id`, or the `user_media.id` a review
   * lives on. Never an owner id — the owner is resolved server-side, which is what
   * stops a report being attributed to an account of the reporter's choosing.
   */
  subjectId: string;
  /** What the reader is reporting, for the heading. "review", "comment", "profile". */
  noun: string;
};

/**
 * Choose a reason; that is the whole flow.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO SUBMIT BUTTON
 *
 * The reason *is* the submission. A list of eight radio buttons followed by a Send
 * control is two decisions where there is one, and the second is a decision nobody has
 * information to make differently — having chosen "Harassment", there is no state in
 * which a person then wants to not send it. Tapping the reason files the report and
 * closes the sheet.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO FREE-TEXT BOX
 *
 * `report()` accepts an optional note and this does not send one. PRD §14 refused free
 * text on reactions for a reason that applies here with more force: an unbounded text
 * field pointed at the operator is a thing that has to be read, and at this cohort's
 * size everything it would say is already in the subject the report names. The column
 * stays, so an operator-side or later client-side note costs a parameter rather than a
 * migration.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE READER IS TOLD AFTERWARDS
 *
 * One sentence, and deliberately not a status. The server's receipt cannot distinguish
 * "filed" from "you already reported this", by design — so a confirmation that claimed
 * either would sometimes be false. "Thanks — we will take a look" is true in both
 * cases and promises nothing about a timeline the founder cannot keep.
 *
 * Reporting is **not** blocking and this sheet does not do both. They are different
 * acts with different consequences: a block is between two people and takes effect at
 * once, a report is a message to whoever runs Bingd. Bundling them would mean either
 * silently blocking somebody who only wanted to flag a comment, or asking a question
 * in a sheet whose job is finished. Block is where it has always been, on the profile.
 */
export function ReportSheet({ visible, onClose, subject, subjectId, noun }: ReportSheetProps) {
  const [busy, setBusy] = useState(false);

  const choose = (reason: ReportReason) => {
    if (busy) return;
    setBusy(true);

    void (async () => {
      const result = await submitReport({ subject, subjectId, reason });
      setBusy(false);
      onClose();

      if (result.ok) {
        Alert.alert('Thanks for telling us', 'We will take a look at this.');
      } else {
        Alert.alert('Could not report', result.message);
      }
    })();
  };

  return (
    <Sheet visible={visible} onClose={onClose} label={`Report this ${noun}`}>
      <View style={styles.head}>
        <Text variant="callout">Report this {noun}</Text>
        <Text variant="caption" tone="secondary">
          Only whoever runs bingd. sees this. The person you are reporting is not told.
        </Text>
      </View>

      <View style={styles.reasons}>
        {REPORT_REASONS.map((reason) => (
          <SheetRow
            key={reason.value}
            icon={reason.icon}
            label={reason.label}
            onPress={busy ? undefined : () => choose(reason.value)}
            disabledReason={busy ? 'Sending…' : undefined}
          />
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: {
    paddingHorizontal: theme.space[4],
    paddingTop: theme.space[2],
    paddingBottom: theme.space[3],
    gap: theme.space[1],
  },
  reasons: { paddingBottom: theme.space[2] },
});
