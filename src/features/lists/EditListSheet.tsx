import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { track } from '@/lib/analytics';
import { newOperationId } from '@/features/collection/writes';
import { Button, Field, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { VisibilityPicker, visibilityChangeDialog } from './VisibilityPicker';
import { updateList } from './writes';
import type { ListOrderStyle, ListView, ListVisibility } from './types';

export type EditListSheetProps = {
  list: ListView;
  profilePrivate: boolean;
  onClose: () => void;
  /** Called after any write the server accepted, so the screen behind can refetch. */
  onChanged: () => void;
};

/**
 * *Edit list settings* — title, description, Numbered, and who can see it (founder QA,
 * 2026-09-21).
 *
 * **No ordering and no delete here any more.** The order is changed where the list is
 * read — long-press and drag on the list's own page — and a title comes off from its
 * row's ⋯. Delete is its own row in the list's ⋯, with its own confirmation. A settings
 * sheet that also reordered and deleted was three tools in one scroller.
 *
 * A change of visibility is confirmed before it is saved, with a question that names the
 * change (`visibilityChangeDialog`): the picker's inline copy describes the options, and
 * the dialog is the moment the reader agrees to the consequence.
 */
export function EditListSheet({ list, profilePrivate, onClose, onChanged }: EditListSheetProps) {
  const [title, setTitle] = useState(list.title);
  const [description, setDescription] = useState(list.description ?? '');
  const [orderStyle, setOrderStyle] = useState<ListOrderStyle>(list.orderStyle);
  const [visibility, setVisibility] = useState<ListVisibility>(list.visibility ?? 'private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const write = async (trimmed: string) => {
    setBusy(true);
    setError(null);

    const result = await updateList({
      operationId: newOperationId(),
      listId: list.id,
      title: trimmed,
      // Always sent, so clearing the description is expressible. The server treats an
      // empty string as "clear" and a null as "leave alone"; this screen always knows
      // what it wants, so it never sends null.
      description,
      visibility,
      orderStyle,
    });

    setBusy(false);

    if (result.outcome === 'failed') {
      setError(result.message);
      if (result.changed) onChanged();
      return;
    }
    if (result.outcome === 'profile_private') {
      setVisibility(list.visibility ?? 'private');
      setError('Make your profile public to publish lists on it.');
      return;
    }
    if (result.outcome === 'hidden') {
      setError('This list is hidden while it is reviewed, so its visibility cannot change.');
      return;
    }

    // Emitted only when it actually moved. The same save with an unchanged mode is not
    // a visibility change and must not read as one.
    if (list.visibility && visibility !== list.visibility) {
      track({
        name: 'list_visibility_changed',
        props: {
          from: list.visibility,
          to: visibility,
          surface: 'edit',
          profile_private: profilePrivate,
        },
      });
    }

    onChanged();
    onClose();
  };

  const save = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('A list needs a title.');
      return;
    }
    if (list.visibility && visibility !== list.visibility) {
      const dialog = visibilityChangeDialog(visibility, profilePrivate);
      Alert.alert(dialog.title, dialog.body, [
        { text: 'Cancel', style: 'cancel' },
        { text: dialog.confirm, onPress: () => void write(trimmed) },
      ]);
      return;
    }
    void write(trimmed);
  };

  return (
    <Sheet visible onClose={onClose} label={`Settings for ${list.title}`}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text variant="title2">Edit list settings</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            hitSlop={theme.space[2]}
            onPress={onClose}
          >
            <Text variant="callout" tone="action">
              Done
            </Text>
          </Pressable>
        </View>

        {list.hidden ? (
          <View style={styles.banner} accessibilityRole="alert">
            <Text variant="footnote" tone="secondary">
              This list is hidden while it is reviewed. You can still edit it; its
              visibility cannot change until the review is finished.
            </Text>
          </View>
        ) : null}

        <Field label="Title" value={title} onChangeText={setTitle} maxLength={100} />

        <Field
          label="Description (optional)"
          value={description}
          onChangeText={setDescription}
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
          hidden={list.hidden}
        />

        {error ? (
          <Text variant="footnote" tone="secondary" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Button label={busy ? 'Saving…' : 'Save'} onPress={save} disabled={busy} />
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  banner: {
    padding: theme.space[3],
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.sunken,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  toggleLines: { flex: 1, gap: theme.space[1] },
});
