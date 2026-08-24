import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { invalidateAfterCollectionChange } from '@/features/collection/invalidate';
import { mustReconcile, newOperationId, setBucket } from '@/features/collection/writes';
import { track } from '@/lib/analytics';
import { theme } from '@/ui/tokens';
import { BucketChoices, Poster, Sheet, Text, type BucketId } from '@/ui/components';

export type TasteSubject = {
  id: string;
  title: string;
  year: number | null;
  posterUri?: string | null;
};

/**
 * "How was it?", and nothing else.
 *
 * This is deliberately **not** `LogSheet`, which asks the same question. LogSheet is the
 * logging surface, and logging means "I watched this": when it saves a bucket for a title
 * with no date, it follows up with `log_watched` for today, because the row it is showing
 * says "Today" and a sheet must not display a date it never stored.
 *
 * That is right for the Log tab and wrong here. The founder's decision is explicit — the
 * first five films may be anything the person has ever seen, and stamping them as watched
 * today would put five films they saw years ago into this year's Goals. `set_bucket`
 * writes no date, `goals.ts` refuses to count a null one, so going straight to it is what
 * makes the rule true rather than a promise. Nothing about the *ranking* is duplicated:
 * the comparisons that follow are the real `RankingSheet`.
 *
 * No note, no date field, no companions. Somebody four films from having an account they
 * can use is not writing a review, and every field offered here is a reason to stop.
 */
export function TasteBucketSheet({
  subject,
  onClose,
  onChosen,
}: {
  subject: TasteSubject | null;
  onClose: () => void;
  /** Fired once the bucket is saved, to hand the title to the comparison sheet. */
  onChosen: (bucket: BucketId) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const profile = useCurrentProfile();

  if (!subject) return null;

  const choose = async (bucket: BucketId) => {
    if (saving) return;
    setSaving(true);
    setProblem(null);

    const result = await setBucket({
      operationId: newOperationId(),
      mediaItemId: subject.id,
      bucket,
    });

    setSaving(false);

    /**
     * **Reconciled on an unknown outcome as well as on a commit**, which is the rule
     * every writer in this app now follows (`lib/write-outcome.ts`).
     *
     * `set_bucket` creates the `user_media` row, so a call that commits and loses its
     * reply has put a title in the collection that nothing here has been told about.
     * The person retries, the sheet closes on the second attempt, and the caches that
     * describe the first one — the collection, the log state, the awards — were never
     * refreshed. Retrying is safe on its own terms: `set_bucket` assigns rather than
     * accumulates, so a second attempt at the same bucket is the same row.
     */
    if (mustReconcile(result)) {
      invalidateAfterCollectionChange(queryClient, profile.id, subject.id);
    }

    if (result.outcome === 'failed') {
      // Kept on screen rather than closed. The title is still the one they picked, and
      // the retry is one tap on the same three buttons.
      setProblem(result.message);
      return;
    }

    // The same rule as the log sheet's: `ok` only. `already_applied` is one intent
    // replayed, and the retry this sheet deliberately invites is exactly how it happens.
    // Movies only — the flow does not offer a season (`app/onboarding/taste.tsx`).
    if (result.outcome === 'ok') {
      track({
        name: 'title_logged',
        props: {
          media_kind: 'movie',
          surface: 'onboarding',
          bucket: bucket === 'notForMe' ? 'not_for_me' : bucket,
        },
      });
    }

    onChosen(bucket);
  };

  return (
    <Sheet visible onClose={onClose} label="How was it?">
      <View style={styles.body}>
        <Text variant="title2">How was it?</Text>

        <View style={styles.subject}>
          <Poster uri={subject.posterUri} title={subject.title} size="sm" />
          <View style={styles.subjectText}>
            <Text variant="headline" numberOfLines={2}>
              {subject.title}
            </Text>
            {subject.year ? (
              <Text variant="footnote" tone="secondary">
                {subject.year}
              </Text>
            ) : null}
          </View>
        </View>

        {/* The same control the Log tab shows, not a second one that resembles it.
            Nothing is pre-selected: this sheet asks the question once and closes on
            the answer, so a filled circle would be describing a choice nobody made. */}
        <BucketChoices
          selected={null}
          onSelect={(bucket) => void choose(bucket)}
          testID="bucket-choices"
        />

        {problem ? (
          <Text variant="footnote" tone="secondary">
            {problem}
          </Text>
        ) : null}

        {/* Said once, here, because it is the thing a new user is most likely to be
            wrong about — and being wrong about it makes them pick only recent films. */}
        <Text variant="footnote" tone="tertiary">
          Anything you have ever seen. It does not have to be recent.
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  /**
   * The gutter every other sheet body observes. Its absence is why the heading sat
   * flush against the left edge of the sheet — `Sheet` pads its foot for the home
   * indicator and nothing else, on purpose, because its children pad themselves.
   *
   * `paddingTop` clears the drag handle. Handle, question, title, choices, note:
   * the order is the order it is read in, and the gap between them is one token
   * rather than five, so nothing here needs a fixed offset to land correctly on a
   * particular phone.
   */
  body: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
    gap: theme.space[4],
  },
  subject: { flexDirection: 'row', gap: theme.space[3], alignItems: 'center' },
  subjectText: { flex: 1, gap: theme.space[1] },
});
