import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCurrentProfile } from '@/features/auth';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { theme } from '@/ui/tokens';
import { Button, Poster, Text, type BucketId } from '@/ui/components';

import {
  rankAnswer,
  rankBack,
  rankCancel,
  rankSkip,
  rankStart,
  type SessionStep,
} from './session';

export type RankingSheetProps = {
  /** The title being placed, with the bucket the user already chose for it. */
  subject: { id: string; title: string; bucket: BucketId } | null;
  onClose: () => void;
  /** "Rank another" — closes this and sends the user back to search. */
  onRankAnother?: () => void;
};

/**
 * Comparison and reveal (screens.md §4).
 *
 * Two posters, one question, three controls. Deliberately bare: no year, no runtime, no
 * genre, because everything else is something the user reads instead of deciding.
 *
 * **The opponent's position is never shown.** Beli displays the incumbent's score and
 * Bingd does not display the equivalent ordinal — "this is my #2" is an anchor that
 * invites agreement rather than a judgement, and unanchored preference is the whole value
 * of the mechanic. Decided by the founder, 2026-08-13. The position is visible everywhere
 * else in the app, which is why this component fetches only titles.
 */
export function RankingSheet({ subject, onClose, onRankAnother }: RankingSheetProps) {
  if (!subject) return null;

  // Keyed by the title, so moving to a different one starts a genuinely new component
  // rather than leaving one session's answers counted against the next.
  return (
    <Session key={subject.id} subject={subject} onClose={onClose} onRankAnother={onRankAnother} />
  );
}

function Session({
  subject,
  onClose,
  onRankAnother,
}: RankingSheetProps & { subject: NonNullable<RankingSheetProps['subject']> }) {
  const queryClient = useQueryClient();
  const profile = useCurrentProfile();

  const [step, setStep] = useState<SessionStep | null>(null);
  // Starts true: the session is already being opened by the time anything renders.
  const [busy, setBusy] = useState(true);
  const [answered, setAnswered] = useState(0);

  const apply = useCallback(
    (next: SessionStep) => {
      setStep(next);
      if (next.state === 'placed') {
        // The position is the server's, and it changed this category and this collection.
        // Nothing else needs to know (client.md §3).
        void queryClient.invalidateQueries({
          queryKey: queryKeys.rankings(profile.id, next.category),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.collection(profile.id) });
      }
    },
    [profile.id, queryClient],
  );

  useEffect(() => {
    let live = true;
    void rankStart(subject.id, subject.bucket).then((next) => {
      if (!live) return;
      setBusy(false);
      apply(next);
    });

    return () => {
      live = false;
    };
  }, [subject, apply]);

  const act = async (run: () => Promise<SessionStep>, countsAsAnswer = false) => {
    if (busy) return;
    setBusy(true);
    const next = await run();
    setBusy(false);
    if (countsAsAnswer) setAnswered((n) => n + 1);
    apply(next);
  };

  const close = async () => {
    // Leave the session behind and rank_start would resume it mid-search the next time
    // this title came up, with no explanation for why the user was being asked again.
    if (step?.state === 'comparing') await rankCancel(step.sessionId);
    onClose();
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => void close()}
      accessibilityViewIsModal
    >
      <SafeAreaView style={styles.sheet} edges={['top', 'bottom', 'left', 'right']}>
        {step?.state === 'placed' ? (
          <Reveal
            position={step.position}
            category={step.category}
            adjustable={step.adjustable}
            title={subject.title}
            onDone={() => void close()}
            onRankAnother={() => {
              void close();
              onRankAnother?.();
            }}
          />
        ) : step?.state === 'comparing' ? (
          <Comparison
            subject={subject}
            pivotId={step.pivotId}
            skipped={step.skipped}
            answered={answered}
            busy={busy}
            onPick={(winnerId) =>
              void act(() => rankAnswer(step.sessionId, winnerId, subject.id), true)
            }
            onBack={() => void act(() => rankBack(step.sessionId, subject.id))}
            onSkip={() => void act(() => rankSkip(step.sessionId, subject.id))}
            onClose={() => void close()}
          />
        ) : step?.state === 'failed' ? (
          <Centred>
            <Text variant="title2" style={styles.centre}>
              {step.restart ? 'That session ended' : 'Could not rank'}
            </Text>
            <Text variant="body" tone="secondary" style={styles.centre}>
              {step.message}
            </Text>
            <Button label="Close" kind="secondary" onPress={() => void close()} />
          </Centred>
        ) : step?.state === 'ended' ? (
          <Centred>
            <Text variant="title2" style={styles.centre}>
              Still in your collection
            </Text>
            <Text variant="body" tone="secondary" style={styles.centre}>
              {subject.title} stays logged. You can rank it whenever you like.
            </Text>
            <Button label="Done" onPress={() => void close()} />
          </Centred>
        ) : (
          <Centred>
            <Text variant="body" tone="tertiary">
              Working out what to ask…
            </Text>
          </Centred>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function Comparison({
  subject,
  pivotId,
  skipped,
  answered,
  busy,
  onPick,
  onBack,
  onSkip,
  onClose,
}: {
  subject: { id: string; title: string };
  pivotId: string;
  skipped: boolean;
  answered: number;
  busy: boolean;
  onPick: (winnerId: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const { data: pivot } = useQuery({
    queryKey: queryKeys.title(pivotId),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('media_items')
        .select('id, title, poster_path')
        .eq('id', pivotId)
        .single();
      if (error) throw error;
      return data as { id: string; title: string; poster_path: string | null };
    },
  });

  return (
    <View style={styles.comparison}>
      <View style={styles.topBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          hitSlop={theme.space[3]}
        >
          <Text variant="headline" tone="secondary">
            Close
          </Text>
        </Pressable>
      </View>

      <Text variant="title2" style={styles.centre}>
        Which did you like more?
      </Text>

      <View style={styles.cards}>
        <Card
          title={subject.title}
          disabled={busy}
          onPress={() => onPick(subject.id)}
        />
        <Card
          title={pivot?.title ?? '…'}
          posterUri={pivot?.poster_path ?? null}
          disabled={busy || !pivot}
          onPress={() => pivot && onPick(pivot.id)}
        />
      </View>

      {/* Progress as a line of text, not a bar. The remaining count is an estimate from a
          binary search whose range only the server knows, and a bar would imply a
          precision the algorithm does not have (screens.md §4). */}
      <Text variant="footnote" tone="tertiary" style={styles.centre}>
        {skipped
          ? 'Try this one instead'
          : answered === 0
            ? 'A few comparisons to go'
            : 'Getting closer'}
      </Text>

      <View style={styles.controls}>
        <Button
          label="Back"
          kind="tertiary"
          onPress={onBack}
          disabled={busy}
          disabledReason="Waiting for the last answer to save."
        />
        {/* Beli offers "Too tough" and "Skip" as separate controls and both call the same
            thing. One control, because two buttons that do the same thing is a choice the
            user has to think about for no reason. */}
        <Button
          label="Too tough to call"
          kind="secondary"
          onPress={onSkip}
          disabled={busy}
          disabledReason="Waiting for the last answer to save."
        />
      </View>
    </View>
  );
}

function Card({
  title,
  posterUri,
  disabled,
  onPress,
}: {
  title: string;
  posterUri?: string | null;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Choose ${title}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <Poster uri={posterUri} title={title} size="xl" />
      <Text variant="headline" numberOfLines={2} style={styles.centre}>
        {title}
      </Text>
    </Pressable>
  );
}

/**
 * The reveal (design-system.md §9): an Amber panel, the ordinal in Ink at display size,
 * category and title below.
 *
 * Share is absent because share cards are not built. An action that does nothing would be
 * worse than one that is not offered yet.
 */
function Reveal({
  position,
  category,
  adjustable,
  title,
  onDone,
  onRankAnother,
}: {
  position: number;
  category: string;
  adjustable: boolean;
  title: string;
  onDone: () => void;
  onRankAnother: () => void;
}) {
  const readableCategory = category === 'tv_seasons' ? 'TV seasons' : 'Movies';

  return (
    <View style={styles.reveal}>
      <View
        style={styles.panel}
        accessibilityRole="summary"
        accessibilityLabel={`${title} is number ${position} in ${readableCategory}`}
      >
        <Text variant="reveal" tone="onFill" accessibilityElementsHidden>
          #{position}
        </Text>
        <Text variant="caption" tone="onFill">
          IN {readableCategory.toUpperCase()}
        </Text>
      </View>

      <Text variant="title2" style={styles.centre}>
        {title}
      </Text>

      {adjustable ? (
        // Only when the server says so. It means the title landed at the midpoint after
        // too many skips rather than by comparison, and saying it otherwise would invite
        // people to distrust positions that were earned.
        <Text variant="footnote" tone="secondary" style={styles.centre}>
          You skipped a few, so this is an estimate. You can move it from Rankings.
        </Text>
      ) : null}

      <View style={styles.controls}>
        <Button label="Rank another" onPress={onRankAnother} />
        <Button label="Done" kind="secondary" onPress={onDone} />
      </View>
    </View>
  );
}

function Centred({ children }: { children: React.ReactNode }) {
  return <View style={styles.centredBox}>{children}</View>;
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: theme.surface.base },
  comparison: {
    flex: 1,
    padding: theme.layout.gutter,
    gap: theme.layout.sectionGap,
  },
  topBar: { alignItems: 'flex-end' },
  cards: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.space[4],
  },
  card: { flex: 1, alignItems: 'center', gap: theme.space[3] },
  pressed: { opacity: 0.85 },
  controls: { gap: theme.space[3] },
  centre: { textAlign: 'center' },
  centredBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[4],
    padding: theme.space[8],
  },
  reveal: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.space[6],
    padding: theme.layout.gutter,
  },
  panel: {
    backgroundColor: theme.semantic.emphasis,
    borderRadius: theme.radius.card,
    paddingVertical: theme.space[8],
    paddingHorizontal: theme.space[12],
    alignItems: 'center',
    gap: theme.space[2],
  },
});
