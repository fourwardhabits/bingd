import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { today } from '@/features/collection/dates';
import { taggableWith, useTaggablePeople } from '@/features/collection/use-companions';
import { useTitleNote } from '@/features/collection/use-title-note';
import { track } from '@/lib/analytics';
import { theme } from '@/ui/tokens';
import {
  BucketChoices,
  Poster,
  Sheet,
  Text,
  type BucketChoicesProps,
} from '@/ui/components';

import { WatchDetailsRows } from './WatchDetailsRows';
import { logRewatch, newOperationId } from './writes';
import type { WatchBasis } from './watch-history';

type BucketId = Parameters<BucketChoicesProps['onSelect']>[0];

export type LogAnotherWatchSheetProps = {
  open: boolean;
  title: string;
  mediaItemId: string;
  /** The log sheet's header: the poster and "2024 · Movie". */
  posterUri?: string | null;
  subtitle?: string | null;
  onClose: () => void;
  /**
   * The watch is saved and the reader chose how it felt this time. The caller opens the
   * ordinary comparisons for that band, tied to this viewing.
   */
  onRank: (watchEventId: string, bucket: BucketId) => void;
  onSaved: () => void;
  /**
   * iOS has finished dismissing this sheet, forwarded from `Sheet`. The hand-off to the
   * comparisons is to another modal, which may not be presented until this one has gone
   * (`Sheet.onDismissed`), which is why the caller keeps this mounted while it leaves.
   */
  onDismissed?: () => void;
};

/**
 * *Log another watch* — **the ordinary log sheet, in rewatch mode** (founder QA,
 * 2026-09-21).
 *
 * The previous version was a sparse form of its own, and read as a second product flow.
 * This is the log sheet's layout, piece for piece: the poster header with Close, **How was
 * it?** with the same three bands (`BucketChoices`), then the same optional rows — Who I
 * watched with, Note, Watch date (`WatchDetailsRows`) — all closed by default.
 *
 * ---------------------------------------------------------------------------
 * THE TRANSACTION
 *
 * Choosing a band is the act. It (1) saves the new watch with its details in one call
 * (`log_rewatch_with_details`), then (2) opens the ordinary comparisons for that band,
 * tied to this viewing (`rank_again` with its id). Backing out, closing, killing the app
 * or never finishing leaves the watch saved and the ranking exactly as it was: the session
 * runs over the existing placement and commits only when it completes (20260826000500).
 * There is no Re-check / Keep-at-#N step, and nothing assumes last time's band.
 */
export function LogAnotherWatchSheet({
  open,
  title,
  mediaItemId,
  posterUri = null,
  subtitle = null,
  onClose,
  onRank,
  onSaved,
  onDismissed,
}: LogAnotherWatchSheetProps) {
  const profile = useCurrentProfile();
  const people = useTaggablePeople(profile.id);

  const [date, setDate] = useState<string | null>(today());
  // Whether the reader touched the date: untouched means the sheet's own default stands,
  // which is exactly what `today_default` records.
  const [chosen, setChosen] = useState(false);
  const [companions, setCompanions] = useState<string[]>([]);
  // The title's one note, with its two claims — the same object the log sheet writes
  // (founder, 2026-09-25). Committing a bucket is this sheet's commit, so it flushes there.
  const titleNote = useTitleNote(mediaItemId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const basis = ((): Exclude<WatchBasis, 'diary'> => {
    if (date === null) return 'none';
    return chosen ? 'reader' : 'today_default';
  })();

  const choose = async (bucket: BucketId) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    await titleNote.flush();
    const result = await logRewatch({
      operationId: newOperationId(),
      mediaItemId,
      watchedOn: date,
      basis,
      companionIds: companions,
    });
    setSaving(false);

    if (result.outcome === 'failed' || !result.watchEventId) {
      setError(result.outcome === 'failed' ? result.message : 'Could not save this watch.');
      return;
    }

    track({ name: 'watch_logged', props: { kind: 'rewatch', basis, surface: 'title' } });
    track({ name: 'rewatch_decision', props: { choice: 'recheck' } });
    onSaved();
    onRank(result.watchEventId, bucket);
  };

  return (
    <Sheet visible={open} onClose={onClose} onDismissed={onDismissed} label={`Log another watch of ${title}`}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" bounces={false}>
        <View style={styles.header}>
          <Poster uri={posterUri} title={title} size="xs" />
          <View style={styles.headerText}>
            <Text variant="headline" numberOfLines={2}>
              {title}
            </Text>
            <Text variant="footnote" tone="tertiary">
              {['Another watch', subtitle].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={theme.space[3]}>
            <Text variant="callout" tone="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        <View style={styles.buckets}>
          <Text variant="title2" style={styles.prompt}>
            How was it?
          </Text>
          <BucketChoices
            selected={null}
            onSelect={(bucket) => void choose(bucket)}
            testID="rewatch-bucket-choices"
          />
        </View>

        {error ? (
          <Text variant="footnote" tone="action" style={styles.status} testID="rewatch-error">
            {error}
          </Text>
        ) : null}

        <WatchDetailsRows
          date={date}
          onDate={(iso) => {
            setDate(iso);
            setChosen(true);
          }}
          people={taggableWith(people.data ?? [], [])}
          peopleLoading={people.isPending}
          companionIds={companions}
          onToggleCompanion={(id) =>
            setCompanions((current) =>
              current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
            )
          }
          titleNote={titleNote}
        />
      </ScrollView>
    </Sheet>
  );
}

// The log sheet's own measurements, so the two sheets are the same shape.
const styles = StyleSheet.create({
  content: { paddingBottom: theme.space[4], gap: theme.space[4] },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
  headerText: { flex: 1, gap: 2 },
  buckets: { gap: theme.space[3], paddingHorizontal: theme.layout.gutter },
  prompt: { textAlign: 'center' },
  status: { paddingHorizontal: theme.layout.gutter, textAlign: 'center' },
});
