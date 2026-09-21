import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { CompanionPicker } from '@/features/collection/CompanionPicker';
import { formatWatchDate, today } from '@/features/collection/dates';
import { taggableWith, useTaggablePeople } from '@/features/collection/use-companions';
import { WatchDatePicker } from '@/features/collection/WatchDatePicker';
import { track } from '@/lib/analytics';
import { theme } from '@/ui/tokens';
import {
  BucketChoices,
  Button,
  Field,
  Sheet,
  SheetRow,
  Text,
  type BucketChoicesProps,
} from '@/ui/components';

import { logRewatch, newOperationId } from './writes';
import type { WatchBasis } from './watch-history';

type BucketId = Parameters<BucketChoicesProps['onSelect']>[0];

/** The same ceiling `set_watch_tags` and `log_rewatch_with_details` enforce. */
const MAX_COMPANIONS = 10;

export type LogAnotherWatchSheetProps = {
  open: boolean;
  title: string;
  mediaItemId: string;
  onClose: () => void;
  /**
   * The watch is saved and the reader chose how it felt this time. The caller opens the
   * comparisons for that band, tied to this viewing.
   */
  onRank: (watchEventId: string, bucket: BucketId) => void;
  onSaved: () => void;
  /**
   * iOS has finished dismissing this sheet, forwarded straight from `Sheet`. The caller
   * needs it because the hand-off to the comparisons is to *another* modal, which may not be
   * presented until this one has finished going away (`Sheet`'s own `onDismissed`
   * contract). It is why the caller keeps this mounted with `open = false` for the length
   * of the slide-out instead of unmounting it on the tap.
   */
  onDismissed?: () => void;
};

/**
 * *Log another watch* — **the viewing, then the ordinary ranking entry** (founder QA,
 * 2026-09-21).
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THIS REPLACES, AND WHY
 *
 * It used to save the watch and then ask *Did it change your mind?* with *Re-check
 * placement* and *Keep at #7*. The founder retired that: it assumed the band the title had
 * last time was still right, and it ignored that other titles may have entered the ranking
 * since. So now:
 *
 *   1. **The viewing's details** — when, who with, a note — and *Save watch*. Once that
 *      succeeds the viewing exists, whatever happens next.
 *   2. **The normal ranking entry** — *How was it?* with the three bands and nothing
 *      preselected. A band opens the ordinary comparisons for it, tied to this viewing, so
 *      the placement and the feed post both belong to it.
 *
 * Closing at step 2, backing out of the comparisons, or killing the app leaves the watch
 * saved and the ranking exactly as it was: the comparison session runs *over* the existing
 * placement and commits only when it finishes (20260826000500). No new ranking algorithm —
 * this is `rank_again` with the chosen band and the viewing's id, which the server already
 * supports into a different band (`correction-is-not-a-ranking.test.mjs`).
 *
 * The details are private, like the date: a viewing's note and companions are diary lines
 * the owner alone can read. The title-level note (the review) is not written from here.
 */
export function LogAnotherWatchSheet({
  open,
  title,
  mediaItemId,
  onClose,
  onRank,
  onSaved,
  onDismissed,
}: LogAnotherWatchSheetProps) {
  const profile = useCurrentProfile();
  const people = useTaggablePeople(profile.id);

  const [date, setDate] = useState<string | null>(today());
  // Whether the reader touched the date at all: untouched means the sheet's own default
  // stands, which is exactly what `today_default` records.
  const [chosen, setChosen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [companions, setCompanions] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedEvent, setSavedEvent] = useState<string | null>(null);

  const close = () => {
    onClose();
  };

  const basis = ((): Exclude<WatchBasis, 'diary'> => {
    if (date === null) return 'none';
    return chosen ? 'reader' : 'today_default';
  })();

  const toggleCompanion = (id: string) =>
    setCompanions((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await logRewatch({
      operationId: newOperationId(),
      mediaItemId,
      watchedOn: date,
      basis,
      note: note.trim() ? note.trim() : null,
      companionIds: companions,
    });
    setSaving(false);

    if (result.outcome === 'failed' || !result.watchEventId) {
      setError(result.outcome === 'failed' ? result.message : 'Could not save this watch.');
      return;
    }

    track({ name: 'watch_logged', props: { kind: 'rewatch', basis, surface: 'title' } });
    onSaved();
    setSavedEvent(result.watchEventId);
  };

  /**
   * Step 2: the ordinary ranking entry. The same prompt and the same three bands the first
   * log uses, with **nothing selected** — the band is asked again, not assumed.
   */
  if (savedEvent) {
    return (
      <Sheet visible={open} onClose={close} onDismissed={onDismissed} label={`How was ${title}?`}>
        <View style={styles.body}>
          <Text variant="caption" tone="tertiary">
            Watch saved
          </Text>
          <Text variant="title2">How was it?</Text>
          <BucketChoices
            selected={null}
            onSelect={(bucket) => {
              track({ name: 'rewatch_decision', props: { choice: 'recheck' } });
              onRank(savedEvent, bucket);
            }}
            testID="rewatch-bucket-choices"
          />
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet visible={open} onClose={close} onDismissed={onDismissed} label="Log another watch">
      <View style={styles.body}>
        <Text variant="headline">Log another watch</Text>
        <Text variant="body" tone="secondary">
          {title}
        </Text>

        <SheetRow
          icon="calendar-outline"
          label="When?"
          // *Earlier*, the same word the log sheet uses for the choice that produces it.
          value={date === null ? 'Earlier' : formatWatchDate(date)}
          expanded={picking}
          onPress={() => setPicking((was) => !was)}
        />
        {picking ? (
          <WatchDatePicker
            value={date}
            anchor={date ?? today()}
            onChange={(iso) => {
              setDate(iso);
              setChosen(true);
              setPicking(false);
            }}
            onClear={() => {
              setDate(null);
              setChosen(true);
              setPicking(false);
            }}
          />
        ) : null}

        <Text variant="footnote" tone="secondary">
          Watched with
        </Text>
        <CompanionPicker
          people={taggableWith(people.data ?? [], [])}
          selected={companions}
          onToggle={toggleCompanion}
          max={MAX_COMPANIONS}
          loading={people.isPending}
        />

        <Field
          label="Note"
          hint="Only you can see notes on a watch."
          value={note}
          onChangeText={setNote}
          maxLength={1000}
          multiline
        />

        {error ? (
          <Text variant="caption" tone="action" testID="rewatch-error">
            {error}
          </Text>
        ) : null}

        <Button label="Save watch" disabled={saving} onPress={() => void save()} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: theme.layout.gutter, gap: theme.space[3] },
});
