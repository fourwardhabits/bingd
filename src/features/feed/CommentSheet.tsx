import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { shouldMask } from '@/features/collection/use-watched';
import { Avatar, Button, EmptyState, Sheet, SpoilerNote, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import { COMMENT_MAX_LENGTH, useCommentWrites, useComments, type Comment } from './use-comments';

export type CommentSheetProps = {
  /** The event whose comments these are. Null closes the sheet. */
  eventId: string | null;
  /** What the event is about, for spoiler masking. Never the parent series. */
  mediaItemId: string | null;
  /** The full display title, for the reveal control's label. */
  title: string | null;
  viewerId: string;
  /** Which exact media items the viewer has watched — `useWatched`'s answer. */
  watched: Set<string> | undefined;
  onClose: () => void;
  onPressPerson: (username: string) => void;
};

/**
 * The comments on one activity, and the box to add one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BODIES ARE ONLY EVER HERE
 *
 * The feed row shows a *count* and never a preview. That is not a layout decision.
 * The founder's rule is that no text preview may leak masked spoiler content, and the
 * only version of that rule which cannot be got wrong is one where the text has
 * nowhere to leak from: the list query does not run until this sheet is open, so a
 * feed of thirty rows has never held a single comment body in memory. A one-line
 * preview would have needed its own mask, its own accessibility label, and its own
 * test, and would have been the thing somebody later "optimised" by clamping the
 * string instead.
 *
 * ---------------------------------------------------------------------------
 * SPOILERS
 *
 * `shouldMask` decides, and nothing here does. It is the same function the feed's
 * notes use, with the same three inputs — the author's claim, the exact media item,
 * and whether *this* viewer has watched that exact item. Exact means exact: the id
 * passed in is `feed_events.media_item_id`, so a comment on Season 2 stays masked for
 * someone who has watched Season 1 or "watched" the parent series, and those eleven
 * cases are already tested where the function lives.
 *
 * `SpoilerNote` then does the rendering, and its masked branch does not put the text
 * in the tree at all — not clipped, not blurred, not behind an overlay. Revealing is
 * local to this mount and writes nothing.
 *
 * A viewer who *has* watched sees the comment normally, with the quiet "Spoilers"
 * marker `SpoilerNote` keeps after revealing. That is the founder's "subtle spoiler
 * indication", and it costs the reader nothing.
 */
export function CommentSheet({
  eventId,
  mediaItemId,
  title,
  viewerId,
  watched,
  onClose,
  onPressPerson,
}: CommentSheetProps) {
  const comments = useComments(eventId, viewerId);
  const { add, edit, remove, busy } = useCommentWrites(viewerId);

  const [draft, setDraft] = useState('');
  const [spoilers, setSpoilers] = useState(false);
  // Which comment is being rewritten, if any. Editing reuses the one composer rather
  // than growing a second one inside the row: two text inputs that can both be
  // focused is how a draft ends up submitted against the wrong comment.
  const [editing, setEditing] = useState<Comment | null>(null);

  if (!eventId) return null;

  const reset = () => {
    setDraft('');
    setSpoilers(false);
    setEditing(null);
  };

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;

    const result = editing
      ? await edit({ commentId: editing.id, body, hasSpoilers: spoilers })
      : await add({ eventId, body, hasSpoilers: spoilers });

    if (!result.ok) {
      Alert.alert(editing ? 'Could not save your edit' : 'Could not post your comment', result.message);
      return;
    }
    reset();
  };

  const beginEdit = (comment: Comment) => {
    setEditing(comment);
    setDraft(comment.body);
    setSpoilers(comment.hasSpoilers);
  };

  const confirmDelete = (comment: Comment) => {
    Alert.alert('Delete this comment?', 'It will be removed for everyone.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            // If the comment being deleted is the one open in the composer, the
            // composer has to let go of it or the next save would edit a row that
            // is gone and report P0002 as "no such comment".
            if (editing?.id === comment.id) reset();
            const result = await remove({ commentId: comment.id });
            if (!result.ok) Alert.alert('Could not delete', result.message);
          })();
        },
      },
    ]);
  };

  const rows = comments.data ?? [];
  const over = draft.length > COMMENT_MAX_LENGTH;

  return (
    <Sheet visible onClose={onClose} label="Comments">
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {comments.isError ? (
          <View style={styles.pad}>
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not load comments"
              body="Check your connection and try again."
            />
          </View>
        ) : comments.isPending ? (
          <Text variant="footnote" tone="tertiary" style={styles.pad}>
            Loading comments…
          </Text>
        ) : rows.length === 0 ? (
          <View style={styles.pad}>
            <EmptyState
              kind="nothingYet"
              compact
              title="No comments yet"
              body="Say something about this."
            />
          </View>
        ) : (
          rows.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              masked={shouldMask({
                hasSpoilers: comment.hasSpoilers,
                mediaItemId,
                viewerId,
                authorId: comment.authorId,
                watched,
              })}
              title={title}
              mine={comment.authorId === viewerId}
              onPressAuthor={() => onPressPerson(comment.authorUsername)}
              onEdit={() => beginEdit(comment)}
              onDelete={() => confirmDelete(comment)}
            />
          ))
        )}
      </ScrollView>

      <View style={styles.composer}>
        {editing ? (
          <View style={styles.editingBanner}>
            <Text variant="caption" tone="secondary">
              Editing your comment
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Stop editing" onPress={reset}>
              <Text variant="caption" tone="action">
                Cancel
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* "Your comment" while editing rather than "Edit your comment", which is the
            row button's label — two controls answering to one label is ambiguous to a
            screen reader, and it is the row's button that performs the *action*. This
            one is the field holding the text. */}
        <TextInput
          accessibilityLabel={editing ? 'Your comment' : 'Add a comment'}
          placeholder="Add a comment"
          placeholderTextColor={theme.text.tertiary}
          value={draft}
          onChangeText={setDraft}
          multiline
          maxLength={COMMENT_MAX_LENGTH}
          style={styles.input}
        />

        <View style={styles.composerActions}>
          {/* The author's claim about their own writing, set before it is posted.
              The database stores it and never infers it, and the client masks on it
              — so this control is the whole of the spoiler feature's input. */}
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: spoilers }}
            accessibilityLabel="Mark this comment as containing spoilers"
            onPress={() => setSpoilers((value) => !value)}
            hitSlop={theme.space[2]}
            style={({ pressed }) => [styles.spoilerToggle, pressed && styles.pressed]}
          >
            <Ionicons
              name={spoilers ? 'eye-off' : 'eye-off-outline'}
              size={theme.layout.icon.sm}
              color={spoilers ? theme.semantic.action : theme.text.secondary}
            />
            <Text variant="caption" tone={spoilers ? 'action' : 'secondary'}>
              Spoilers
            </Text>
          </Pressable>

          {/* Only once it is close enough to matter. A counter that is always there
              turns a remark into a form. */}
          {draft.length > COMMENT_MAX_LENGTH - 100 ? (
            <Text variant="caption" tone={over ? 'action' : 'tertiary'}>
              {COMMENT_MAX_LENGTH - draft.length}
            </Text>
          ) : null}

          <Button
            label={editing ? 'Save' : 'Post'}
            onPress={() => void submit()}
            disabled={!draft.trim() || over || busy}
            disabledReason={
              over
                ? `A comment is limited to ${COMMENT_MAX_LENGTH} characters.`
                : busy
                  ? 'Saving your last change.'
                  : 'Write something first.'
            }
          />
        </View>
      </View>
    </Sheet>
  );
}

function CommentRow({
  comment,
  masked,
  title,
  mine,
  onPressAuthor,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  masked: boolean;
  title: string | null;
  mine: boolean;
  onPressAuthor: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${comment.authorName}'s profile`}
        onPress={onPressAuthor}
        hitSlop={theme.space[1]}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Avatar size="sm" uri={comment.authorAvatarUri} name={comment.authorName} />
      </Pressable>

      <View style={styles.rowCopy}>
        <View style={styles.rowHead}>
          {/* The name is the link, as it is in the activity sentence above. */}
          <Text variant="footnote" style={styles.author} onPress={onPressAuthor}>
            {comment.authorName}
          </Text>
          <Text variant="caption" tone="tertiary">
            {relativeTime(comment.createdAt)}
            {comment.editedAt ? ' · edited' : ''}
          </Text>
        </View>

        {/* The only place a comment body is rendered, and it goes through the same
            component every other piece of someone's writing does. */}
        <SpoilerNote
          text={comment.body}
          hasSpoilers={comment.hasSpoilers}
          masked={masked}
          titleForLabel={title}
        />

        {mine ? (
          <View style={styles.ownActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Edit your comment" onPress={onEdit}>
              <Text variant="caption" tone="secondary">
                Edit
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete your comment"
              onPress={onDelete}
            >
              <Text variant="caption" tone="secondary">
                Delete
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The feed's wording, so two surfaces do not describe the same instant differently. */
function relativeTime(value: string) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const styles = StyleSheet.create({
  list: { maxHeight: 360 },
  listContent: { paddingBottom: theme.space[3] },
  pad: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[3] },
  row: {
    flexDirection: 'row',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
  },
  rowCopy: { flex: 1, gap: theme.space[1] },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  author: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
  ownActions: { flexDirection: 'row', gap: theme.space[4], paddingTop: theme.space[1] },
  composer: {
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
  },
  editingBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: {
    minHeight: theme.layout.minTapTarget,
    maxHeight: 120,
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[2],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.sunken,
    color: theme.text.primary,
    fontFamily: fontFamily.sans,
    fontSize: 15,
  },
  composerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  spoilerToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    flex: 1,
    minHeight: theme.layout.minTapTarget,
  },
  pressed: { opacity: 0.7 },
});
