import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';

import { track, type ListCreateSurface } from '@/lib/analytics';
import { newOperationId } from '@/features/collection/writes';
import { Button, Field, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { VisibilityPicker } from './VisibilityPicker';
import { createList } from './writes';
import type { ListOrderStyle, ListVisibility } from './types';

export type NewListSheetProps = {
  onClose: () => void;
  /** Where this sheet was opened from. The §M `list_created.surface` property. */
  surface: ListCreateSurface;
  /** True when the caller's own profile is private, which disables **On your profile**. */
  profilePrivate: boolean;
  /**
   * A title chosen before the list existed — the ⋯ → Add to list… path on an account
   * with no lists yet. Sent as `p_first_media_item_id`, so creating the list and putting
   * the title on it is **one** round trip and one operation id.
   */
  firstTitle?: { mediaItemId: string; name: string } | null;
  /** Handed the new list's id, and the name it was given, once the server has answered. */
  onCreated: (list: { id: string; title: string }) => void;
};

/**
 * New list — title, an optional description, Numbered, and who can see it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OPERATION ID IS HELD ACROSS RETRIES
 *
 * `operationId` is state rather than a value computed at press time, which is
 * `lib/operation-intent.ts`'s rule expressed locally: a create whose reply is lost is
 * reported as a failure, the person presses Create again, and a **fresh** id on the
 * second attempt would make two lists out of one intention. Holding it means the
 * server's ledger answers the retry with the first list.
 *
 * It is reset only on a successful create, which is the asymmetry that matters: holding
 * a spent id is the dangerous direction everywhere else, and here it cannot arise,
 * because success closes the sheet.
 */
export function NewListSheet({
  onClose,
  surface,
  profilePrivate,
  firstTitle = null,
  onCreated,
}: NewListSheetProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [orderStyle, setOrderStyle] = useState<ListOrderStyle>('unranked');
  const [visibility, setVisibility] = useState<ListVisibility>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationId, setOperationId] = useState(newOperationId);

  const trimmed = title.trim();
  const canCreate = trimmed.length > 0 && !busy;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);

    const result = await createList({
      operationId,
      title: trimmed,
      description: description.trim() || null,
      visibility,
      orderStyle,
      firstMediaItemId: firstTitle?.mediaItemId ?? null,
    });

    setBusy(false);

    if (result.outcome === 'ok') {
      track({
        name: 'list_created',
        props: {
          surface,
          visibility,
          order_style: orderStyle,
          has_first_item: Boolean(firstTitle),
          owned_count_after: result.inAppCountBefore + 1,
          // §M: this creation would have been refused under a three-list cap. Measured
          // from the count the server returned, never shown, and nothing branches on it.
          would_have_exceeded_3_lists: result.inAppCountBefore >= 3,
        },
      });
      setOperationId(newOperationId());
      onCreated({ id: result.id, title: trimmed });
      return;
    }

    if (result.outcome === 'list_limit') {
      track({ name: 'list_limit_reached' });
      setError("You've reached the maximum number of lists.");
      return;
    }

    if (result.outcome === 'profile_private') {
      // Reachable only if the profile went private in another tab between the picker
      // being drawn and Create being pressed. The option is disabled otherwise.
      setVisibility('link');
      setError('Make your profile public to publish lists on it.');
      return;
    }

    setError(result.outcome === 'failed' ? result.message : 'That could not be saved.');
  };

  return (
    <Sheet visible onClose={onClose} label="New list">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text variant="title2">New list</Text>
          {firstTitle ? (
            // The zero-lists path from a title's ⋯. Saying which title is about to be
            // added is what makes creating-a-list-to-put-this-in one act rather than two.
            <Text variant="footnote" tone="secondary">
              Will add: {firstTitle.name}
            </Text>
          ) : null}
        </View>

        <Field
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="e.g. Movies for Dad"
          maxLength={100}
          autoFocus
          returnKeyType="next"
        />

        <Field
          label="Description (optional)"
          value={description}
          onChangeText={setDescription}
          placeholder="What is this list for?"
          maxLength={1000}
          multiline
        />

        <View style={styles.toggleRow}>
          <View style={styles.toggleLines}>
            <Text variant="callout">Numbered list</Text>
            <Text variant="footnote" tone="secondary">
              Show 1, 2, 3 next to each title
            </Text>
          </View>
          <Switch
            value={orderStyle === 'ranked'}
            onValueChange={(next) => setOrderStyle(next ? 'ranked' : 'unranked')}
            accessibilityLabel="Numbered list"
          />
        </View>

        <VisibilityPicker
          value={visibility}
          onChange={setVisibility}
          profilePrivate={profilePrivate}
        />

        {error ? (
          <Text variant="footnote" tone="secondary" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Button
          label={busy ? 'Creating…' : 'Create list'}
          onPress={() => void submit()}
          disabled={!canCreate}
        />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[6],
    gap: theme.space[4],
  },
  header: { gap: theme.space[1] },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  toggleLines: { flex: 1, gap: theme.space[1] },
});
