import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { track } from '@/lib/analytics';
import { posterUri } from '@/lib/images';
import { Sheet, SheetRow, Text, TitleRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { setWatchNext, useReconcileWatchNext } from './use-watch-next';
import { WATCH_NEXT_MAX } from './watch-next';
import { newOperationId } from './writes';

/** Enough of a Watchlist title to name it and draw its poster. */
export type WatchNextTitle = {
  mediaItemId: string;
  name: string;
  year: number | null;
  posterPath: string | null;
};

export type WatchNextSheetProps = {
  userId: string;
  /** The title that was pressed and held. */
  subject: WatchNextTitle;
  /** The pins, in slot order, resolved to titles the Watchlist can draw. */
  pinned: readonly WatchNextTitle[];
  onClose: () => void;
};

/**
 * The one control for Watch next, opened by pressing and holding a Watchlist title.
 *
 * Three states, decided from what is pinned rather than from anything the reader chose:
 *
 *   * **pinned** — one row, *Remove from Watch next*;
 *   * **room left** — one row, *Add to Watch next*;
 *   * **full** — the three pins as rows under *Replace one with …?*, so the swap is the
 *     next tap instead of a detour through unpinning something first. Chosen over
 *     disabling the action (a dead end) and over allowing a fourth (the server refuses
 *     one anyway).
 *
 * If the server turns out to know more than this sheet did — three pinned from another
 * device — the add is answered `full` with the server's pins, the cache takes them, and
 * the sheet redraws as the replace picker without closing.
 */
export function WatchNextSheet({ userId, subject, pinned, onClose }: WatchNextSheetProps) {
  const reconcile = useReconcileWatchNext(userId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server said full when this sheet's cache did not. */
  const [serverFull, setServerFull] = useState(false);
  /** One id per intent, held while its outcome is unknown (`use-recommend.ts` argues it). */
  const intent = useRef<string | null>(null);

  const isPinned = pinned.some((item) => item.mediaItemId === subject.mediaItemId);
  const full = !isPinned && (serverFull || pinned.length >= WATCH_NEXT_MAX);

  // Counted once per sheet that opens straight into the picker: how often the cap bites.
  const openedFull = useRef(full);
  useEffect(() => {
    if (openedFull.current) track({ name: 'watch_next_full_shown' });
  }, []);

  const run = async (present: boolean, replacing: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    intent.current ??= newOperationId();

    const result = await setWatchNext({
      operationId: intent.current,
      mediaItemId: subject.mediaItemId,
      present,
      replacing,
    });
    setBusy(false);
    reconcile(result);

    if (result.outcome === 'failed' && result.changed) {
      // Unknown: the id stays, so a second press replays rather than spends a new slot.
      setError(result.message);
      return;
    }
    intent.current = null;

    switch (result.outcome) {
      case 'ok':
        if (result.pinned) {
          track({
            name: 'watch_next_changed',
            props: {
              action: !present ? 'removed' : result.replaced ? 'replaced' : 'added',
              count_after: result.pinned.length,
            },
          });
        }
        onClose();
        return;
      case 'full':
        setServerFull(true);
        track({ name: 'watch_next_full_shown' });
        return;
      case 'not_on_watchlist':
        setError('That title is no longer on your Watchlist.');
        return;
      case 'failed':
        setError(result.message);
        return;
    }
  };

  return (
    <Sheet visible onClose={onClose} label={full ? 'Watch next is full' : subject.name}>
      <View style={styles.head}>
        <Text variant="headline" numberOfLines={2}>
          {full ? 'Watch next is full' : subject.name}
        </Text>
        {full ? (
          <Text variant="footnote" tone="secondary">
            {`Replace one with ${subject.name}?`}
          </Text>
        ) : null}
      </View>

      {full ? (
        <View testID="watch-next-replace">
          {pinned.map((item) => (
            <TitleRow
              key={item.mediaItemId}
              title={item.name}
              year={item.year}
              posterUri={posterUri(item.posterPath)}
              secondary="Replace"
              onPress={() => void run(true, item.mediaItemId)}
            />
          ))}
        </View>
      ) : (
        <SheetRow
          icon={isPinned ? 'bookmark' : 'bookmark-outline'}
          label={isPinned ? 'Remove from Watch next' : 'Add to Watch next'}
          onPress={busy ? undefined : () => void run(!isPinned, null)}
          disabledReason={busy ? 'Saving…' : undefined}
        />
      )}

      {error ? (
        <Text variant="footnote" tone="action" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[3],
    gap: theme.space[1],
  },
  error: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
});
