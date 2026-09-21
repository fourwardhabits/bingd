import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { formatWatchDate, today } from '@/features/collection/dates';
import { WatchDatePicker } from '@/features/collection/WatchDatePicker';
import { track } from '@/lib/analytics';
import { theme } from '@/ui/tokens';
import { Button, Sheet, SheetRow, Text } from '@/ui/components';

import { logRewatch, newOperationId } from './writes';
import type { WatchBasis } from './watch-history';

export type LogAnotherWatchSheetProps = {
  open: boolean;
  title: string;
  mediaItemId: string;
  /** Null when the title is seen but unranked — there is then no placement to re-check. */
  position: number | null;
  onClose: () => void;
  /** The reader chose *Re-check placement*. The caller opens the ranking sheet. */
  onRecheck: (watchEventId: string) => void;
  onSaved: () => void;
};

/**
 * *Log another watch* — **the act, and then the optional second half** (§J.3).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY THE ORDER IS THE WHOLE FIX
 *
 * On main, *Log another watch* is `rankAgain(newWatch: true)`: a forced full re-rank
 * that records **no watch and no date** (§C.3.2). A reader who wanted to say "I watched
 * Heat again last night" was made to answer six comparisons, and at the end of it the
 * app knew nothing about the viewing — only that a ranking had been re-done.
 *
 * So: the watch first, and it is complete on its own. Save and close, and the viewing is
 * recorded. The re-check is offered afterwards, costs about two comparisons when nothing
 * changed (§F.3), and reaches the **same** feed activity rather than a second one (§K).
 *
 * ---------------------------------------------------------------------------
 * THE WHEN ROW IS THREE CHOICES, AND TODAY IS ONE TAP
 *
 * Today · Earlier · Pick a date, defaulting to Today (§D.6 path 1). *Earlier* is the only
 * new word in the vocabulary, and it replaces "I don't remember" — a viewing whose timing
 * nobody recorded is an answer, not a failure to finish.
 *
 * The basis follows the tap and is never inferred: `today_default` when the sheet offered
 * Today and the reader kept it, `reader` when they chose, `none` for *Earlier*. That
 * distinction is what §C.3.8 was missing and what §M.7's later cleanup needs in order to
 * find a fabricated date at all.
 */
export function LogAnotherWatchSheet({
  open,
  title,
  mediaItemId,
  position,
  onClose,
  onRecheck,
  onSaved,
}: LogAnotherWatchSheetProps) {
  const [date, setDate] = useState<string | null>(today());
  // Whether the reader has touched the row at all. Untouched means the sheet's own
  // default is what stands, which is exactly what `today_default` records.
  const [chosen, setChosen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ eventId: string; count: number } | null>(null);

  const reset = () => {
    setDate(today());
    setChosen(false);
    setPicking(false);
    setSaved(null);
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const basis = ((): Exclude<WatchBasis, 'diary'> => {
    if (date === null) return 'none';
    return chosen ? 'reader' : 'today_default';
  })();

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await logRewatch({
      operationId: newOperationId(),
      mediaItemId,
      watchedOn: date,
      basis,
    });
    setSaving(false);

    if (result.outcome === 'failed') {
      setError(result.message);
      return;
    }

    track({ name: 'watch_logged', props: { kind: 'rewatch', basis, surface: 'title' } });
    onSaved();
    setSaved({ eventId: result.watchEventId ?? '', count: result.watchCount ?? 2 });
  };

  if (!open) return null;

  /**
   * The result beat. *Did it change your mind?* is the question, and **Keep is not a
   * button** — it is what closing does, because the act is already complete. Making the
   * reader choose between two buttons would say the viewing is not saved until they
   * answer, which is the thing this sheet exists to stop being true.
   */
  if (saved) {
    return (
      <Sheet visible onClose={close} label={`Saved, your ${ordinal(saved.count)} watch`}>
        <View style={styles.body}>
          <Text variant="headline">{`Saved · your ${ordinal(saved.count)} watch`}</Text>
          <Text variant="body">Did it change your mind?</Text>
          {position !== null ? (
            <Text variant="caption" tone="tertiary">
              {`${title} is #${position} in your ranking.`}
            </Text>
          ) : null}

          {position !== null ? (
            <Button
              label="Re-check placement"
              onPress={() => {
                track({ name: 'rewatch_decision', props: { choice: 'recheck' } });
                onRecheck(saved.eventId);
                reset();
              }}
            />
          ) : null}

          <Button
            label={position === null ? 'Done' : `Keep at #${position}`}
            kind="secondary"
            onPress={() => {
              track({ name: 'rewatch_decision', props: { choice: 'keep' } });
              close();
            }}
          />
          {position !== null ? (
            <Text variant="caption" tone="tertiary" style={styles.hint}>
              A re-check is usually two comparisons.
            </Text>
          ) : null}
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet visible onClose={close} label="Log another watch">
      <View style={styles.body}>
        <Text variant="headline">Log another watch</Text>
        <Text variant="body" tone="secondary">{title}</Text>

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

/** "3rd", for the confirmation line. Small enough not to earn a library. */
function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const styles = StyleSheet.create({
  body: { padding: theme.layout.gutter, gap: theme.space[3] },
  hint: { textAlign: 'center' },
});
