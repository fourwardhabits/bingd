import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { track } from '@/lib/analytics';
import { newOperationId } from '@/features/collection/writes';
import { Button, Field, Poster, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { VisibilityPicker } from './VisibilityPicker';
import { deleteList, moveListItem, removeListItem, updateList } from './writes';
import type { ListItem, ListOrderStyle, ListView, ListVisibility } from './types';

export type EditListSheetProps = {
  list: ListView;
  items: ListItem[];
  profilePrivate: boolean;
  onClose: () => void;
  /** Called after any write the server accepted, so the screen behind can refetch. */
  onChanged: () => void;
  /** Called after the list is gone. The screen behind has to leave, not refetch. */
  onDeleted: () => void;
};

/**
 * Edit mode: the fields, the order, and the way out.
 *
 * ---------------------------------------------------------------------------
 * MOVE CONTROLS, NOT DRAG
 *
 * Up and down arrows, plus a ⋯ with *Move to top* and *Move to bottom*. Drag is v1.1,
 * and it is deferred for a reason worth stating: the gesture libraries are already
 * installed, so this is not a dependency question — it is that drag inside a scroller
 * inside a sheet is a three-way gesture conflict that has to be got right on a device,
 * and the arrows are correct, testable and accessible on the first day.
 *
 * The same moves are exposed as `accessibilityActions`, so the order is reachable
 * without seeing the arrows at all. That is not a consolation prize for the arrows
 * being unfashionable: a drag-only reorder is unreachable by assistive technology
 * unless somebody builds exactly this underneath it anyway.
 *
 * ---------------------------------------------------------------------------
 * EVERY MOVE IS ONE RPC NAMING ONE ITEM
 *
 * Not an array of ids. Two devices each sending an order would overwrite each other
 * silently; two devices each naming an item resolve to last-move-wins (§E).
 */
export function EditListSheet({
  list,
  items,
  profilePrivate,
  onClose,
  onChanged,
  onDeleted,
}: EditListSheetProps) {
  const [title, setTitle] = useState(list.title);
  const [description, setDescription] = useState(list.description ?? '');
  const [orderStyle, setOrderStyle] = useState<ListOrderStyle>(list.orderStyle);
  const [visibility, setVisibility] = useState<ListVisibility>(list.visibility ?? 'private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('A list needs a title.');
      return;
    }

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

  const move = async (item: ListItem, toIndex: number) => {
    if (busy) return;
    setBusy(true);
    const result = await moveListItem({
      operationId: newOperationId(),
      listId: list.id,
      mediaItemId: item.mediaItemId,
      // Zero-based, which is what the server clamps against. The ordinal on screen is
      // one-based, and converting here rather than there keeps one convention per side.
      toIndex,
    });
    setBusy(false);
    if (result.outcome !== 'failed' || result.changed) onChanged();
    if (result.outcome === 'failed') setError(result.message);
  };

  const remove = async (item: ListItem) => {
    if (busy) return;
    setBusy(true);
    const result = await removeListItem({
      operationId: newOperationId(),
      listId: list.id,
      mediaItemId: item.mediaItemId,
    });
    setBusy(false);
    if (result.outcome !== 'failed' || result.changed) onChanged();
    if (result.outcome === 'failed') setError(result.message);
  };

  const confirmDelete = () => {
    Alert.alert(
      `Delete "${list.title}"?`,
      'This cannot be undone, and the link stops working for everybody who has it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const result = await deleteList({
                operationId: newOperationId(),
                listId: list.id,
              });
              if (result.outcome === 'failed') {
                setError(result.message);
                if (result.changed) onChanged();
                return;
              }
              onDeleted();
            })();
          },
        },
      ],
    );
  };

  return (
    <Sheet visible onClose={onClose} label={`Edit ${list.title}`}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text variant="title2">Edit list</Text>
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

        {items.length > 0 ? (
          <View style={styles.order}>
            <Text variant="subhead" tone="secondary">
              Order
            </Text>
            {items.map((item, index) => (
              <OrderRow
                key={item.mediaItemId}
                item={item}
                index={index}
                total={items.length}
                numbered={orderStyle === 'ranked'}
                busy={busy}
                onMove={(toIndex) => void move(item, toIndex)}
                onRemove={() => void remove(item)}
              />
            ))}
          </View>
        ) : null}

        {error ? (
          <Text variant="footnote" tone="secondary" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Button label={busy ? 'Saving…' : 'Save'} onPress={() => void save()} disabled={busy} />

        {/* Last, and on its own. The only ordering that never puts Delete under a thumb
            reaching for something else — the title menu's own rule. */}
        <Button label="Delete list" kind="tertiary" onPress={confirmDelete} />
      </ScrollView>
    </Sheet>
  );
}

function OrderRow({
  item,
  index,
  total,
  numbered,
  busy,
  onMove,
  onRemove,
}: {
  item: ListItem;
  index: number;
  total: number;
  numbered: boolean;
  busy: boolean;
  onMove: (toIndex: number) => void;
  onRemove: () => void;
}) {
  const first = index === 0;
  const last = index === total - 1;

  return (
    <View
      style={styles.orderRow}
      // The same four moves the arrows and the ⋯ offer, reachable without them. A
      // drag-only reorder would need exactly this underneath it anyway.
      accessibilityActions={[
        ...(first ? [] : [{ name: 'moveUp', label: 'Move up' }]),
        ...(last ? [] : [{ name: 'moveDown', label: 'Move down' }]),
        ...(first ? [] : [{ name: 'moveToTop', label: 'Move to top' }]),
        ...(last ? [] : [{ name: 'moveToBottom', label: 'Move to bottom' }]),
        { name: 'remove', label: 'Remove from list' },
      ]}
      onAccessibilityAction={(event) => {
        switch (event.nativeEvent.actionName) {
          case 'moveUp':
            return onMove(index - 1);
          case 'moveDown':
            return onMove(index + 1);
          case 'moveToTop':
            return onMove(0);
          case 'moveToBottom':
            return onMove(total - 1);
          case 'remove':
            return onRemove();
          default:
            return undefined;
        }
      }}
      accessibilityLabel={`${numbered ? `${index + 1}. ` : ''}${item.name}`}
    >
      {numbered ? (
        <Text variant="footnote" tone="tertiary" style={styles.orderNumber}>
          {index + 1}
        </Text>
      ) : null}

      <Poster uri={item.posterUri} title={item.name} size="row" />

      <Text variant="footnote" numberOfLines={2} style={styles.orderTitle}>
        {item.name}
      </Text>

      <ArrowButton
        icon="arrow-up"
        label={`Move ${item.name} up`}
        disabled={first || busy}
        onPress={() => onMove(index - 1)}
      />
      <ArrowButton
        icon="arrow-down"
        label={`Move ${item.name} down`}
        disabled={last || busy}
        onPress={() => onMove(index + 1)}
      />
      <ArrowButton
        icon="close"
        label={`Remove ${item.name}`}
        disabled={busy}
        onPress={onRemove}
      />
    </View>
  );
}

function ArrowButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={theme.space[1]}
      onPress={onPress}
      style={({ pressed }) => [styles.arrow, pressed && styles.pressed]}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={disabled ? theme.text.tertiary : theme.text.secondary}
      />
    </Pressable>
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
  order: { gap: theme.space[2] },
  orderRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  orderNumber: { minWidth: 20, textAlign: 'right' },
  orderTitle: { flex: 1 },
  arrow: {
    width: theme.layout.minTapTarget - 8,
    height: theme.layout.minTapTarget - 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
});
