import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { queryKeys } from '@/lib/query';
import { useCurrentProfile } from '@/features/auth';
import { theme } from '@/ui/tokens';
import {
  BUCKETS,
  BucketChip,
  Button,
  Field,
  Poster,
  Text,
  type BucketId,
} from '@/ui/components';

import { logWatched, newOperationId, setBucket, today, type WriteResult } from './writes';

export type LoggableTitle = {
  id: string;
  title: string;
  year: number | null;
  posterUri: string | null;
  /** Decides the category line. A series is not loggable — log a season (AD-1). */
  kind: 'movie' | 'season';
  /** For a season, the series it belongs to, so the header is not just "Season 3". */
  seriesTitle?: string | null;
};

export type LogSheetProps = {
  title: LoggableTitle | null;
  onClose: () => void;
  /**
   * Called once the title is Logged, with the bucket that was chosen. The ranking flow
   * hangs off this — it is deliberately not started from inside the sheet, because
   * bucketing and ranking are separate acts (PRD §11) and this is the surface where a
   * user first sees that.
   */
  onFindWhereItLands?: (bucket: BucketId) => void;
};

/**
 * The bucket prompt (screens.md §4).
 *
 * A sheet rather than a screen, so what the user was looking at stays visible behind it.
 * The rule the architecture depends on and this component enforces: choosing a bucket
 * saves immediately, and comparisons begin only when the user asks for them.
 *
 * Writes are online-only today. The outbox in offline-sync.md is not built yet, so a
 * failed save says so and stays on screen with the choice intact rather than pretending
 * to have queued. Claiming otherwise would be worse than the gap.
 */
export function LogSheet({ title, onClose, onFindWhereItLands }: LogSheetProps) {
  if (!title) return null;

  // Keyed by the title, and unmounted entirely when there is none. Both matter: a sheet
  // that stays mounted between titles inherits the last one's bucket, its "Logged."
  // message and — worst of all — its unsaved note, which then gets filed against whatever
  // is on screen now. Clearing state by hand instead only covered the way out through
  // Close, and the way out through "Find where it lands" is the common one.
  return (
    <Sheet key={title.id} title={title} onClose={onClose} onFindWhereItLands={onFindWhereItLands} />
  );
}

function Sheet({
  title,
  onClose,
  onFindWhereItLands,
}: LogSheetProps & { title: LoggableTitle }) {
  const queryClient = useQueryClient();
  const profile = useCurrentProfile();

  const [bucket, setSelectedBucket] = useState<BucketId | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const close = onClose;

  const report = (result: WriteResult) => {
    if (result.outcome === 'ranked') {
      setProblem('You have already ranked this. Change it from your collection.');
      return false;
    }
    if (result.outcome === 'failed') {
      setProblem(result.message);
      return false;
    }
    return true;
  };

  const choose = async (chosen: BucketId) => {
    if (saving) return;

    setSelectedBucket(chosen);
    setSaving(true);
    setProblem(null);

    // One operation id per intent. If this call is retried it must carry the same one, or
    // the ledger cannot tell a retry from a second opinion.
    const operationId = newOperationId();
    const result = await setBucket({ operationId, mediaItemId: title.id, bucket: chosen });

    setSaving(false);
    if (!report(result)) {
      setSelectedBucket(null);
      return;
    }

    setSaved(true);
    // Surgical, per client.md §3: this bucket changed one person's collection and nothing
    // else. The feed refreshes on its own schedule rather than being blown away by it.
    void queryClient.invalidateQueries({ queryKey: queryKeys.collection(profile.id) });
  };

  const saveNote = async () => {
    if (!note.trim()) return;

    setSaving(true);
    setProblem(null);

    // The watch date goes with the note because both are the same act of logging: the
    // user is recording that they watched this, today, and what they thought.
    const result = await logWatched({
      operationId: newOperationId(),
      mediaItemId: title.id,
      watchedOn: today(),
      note: note.trim(),
    });

    setSaving(false);
    if (report(result)) setNote('');
  };

  const category = title.kind === 'movie' ? 'Movies' : 'TV seasons';
  const heading = title.seriesTitle ? `${title.seriesTitle}: ${title.title}` : title.title;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
      accessibilityViewIsModal
    >
      <SafeAreaView style={styles.sheet} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Poster uri={title.posterUri} title={title.title} size="md" />
            <View style={styles.headerText}>
              <Text variant="title2" numberOfLines={3}>
                {heading}
              </Text>
              <Text variant="footnote" tone="tertiary">
                {[title.year, category].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={close}
              hitSlop={theme.space[3]}
            >
              <Text variant="headline" tone="secondary">
                Close
              </Text>
            </Pressable>
          </View>

          <View style={styles.section} accessibilityRole="radiogroup">
            <Text variant="title2">How was it?</Text>
            <View style={styles.buckets}>
              {BUCKETS.map((option) => (
                <BucketChip
                  key={option.id}
                  bucket={option}
                  selected={bucket === option.id}
                  onPress={() => void choose(option.id)}
                />
              ))}
            </View>
            {saving ? (
              <Text variant="footnote" tone="tertiary">
                Saving…
              </Text>
            ) : null}
            {saved && !problem ? (
              <Text variant="footnote" tone="secondary">
                Logged. It is in your collection whether or not you rank it.
              </Text>
            ) : null}
            {problem ? (
              <Text variant="footnote" tone="action">
                {problem}
              </Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Field
              label="Private note"
              hint="Only you can read this."
              value={note}
              onChangeText={setNote}
              multiline
              maxLength={2000}
              onBlur={() => void saveNote()}
            />
          </View>

          <View style={styles.actions}>
            <Button
              label="Find where it lands"
              disabled={!saved || !bucket}
              disabledReason="Choose how you felt about it first."
              onPress={() => bucket && onFindWhereItLands?.(bucket)}
            />
            <Button label="Done" kind="secondary" onPress={close} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: theme.surface.base },
  content: {
    padding: theme.layout.gutter,
    gap: theme.layout.sectionGap,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space[3],
  },
  headerText: { flex: 1, gap: theme.space[1] },
  section: { gap: theme.space[4] },
  buckets: { flexDirection: 'row', gap: theme.space[3] },
  actions: { gap: theme.space[3] },
});
