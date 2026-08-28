import { Ionicons } from '@expo/vector-icons';
import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { shouldMask } from '@/features/collection/use-watched';
import { newOperationId } from '@/features/collection/writes';
import { ReportSheet } from '@/features/moderation/ReportSheet';
import { Avatar, Button, EmptyState, ReactionControl, SpoilerNote, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import { relativeTime } from './activity';
import { ReactionDetail } from './ReactionDetail';
import { ReactionPill } from './ReactionPill';
import { useCommentReactors } from './use-comment-reactors';
import {
  COMMENT_MAX_LENGTH,
  threadsOf,
  useCommentWrites,
  useComments,
  type Comment,
} from './use-comments';
import {
  DEFAULT_REACTION,
  REACTION_GLYPH,
  type ReactionKind,
} from './use-reactions';

export type CommentThreadProps = {
  /** The event whose comments these are. Null renders nothing. */
  eventId: string | null;
  /** What the event is about, for spoiler masking. Never the parent series. */
  mediaItemId: string | null;
  /** The full display title, for the reveal control's label. */
  title: string | null;
  viewerId: string;
  /** Which exact media items the viewer has watched — `useWatched`'s answer. */
  watched: Set<string> | undefined;
  onPressPerson: (username: string) => void;
  /**
   * Where the list is drawn. The sheet caps its height and scrolls internally; the
   * dedicated page is already inside a scroll view and must not nest a second one.
   */
  scroll: 'own' | 'inherited';
};

/**
 * The conversation on one activity: the comments, their replies, and the box to add one.
 *
 * ---------------------------------------------------------------------------
 * ONE IMPLEMENTATION, TWO SURFACES
 *
 * `CommentSheet` (the Feed's comments icon) and `app/activity/[id].tsx` (where a comment
 * notification lands) both render this. That is the founder's rule for this pass stated
 * as a file: *"Both should consume the SAME canonical comments query/model. Do not build
 * two separate comment data implementations."*
 *
 * It would have been easy not to. The two surfaces genuinely differ — one is a bottom
 * sheet over a feed, the other is a pushed screen with a header and the activity card
 * above it — and the shortest path to the second was a copy of the first with the
 * chrome changed. What that copy would have drifted on is not layout: it is the reply
 * target, the tombstone branch, the masking rule and the optimism policy, four things
 * that have to be identical or two readers looking at one conversation see two different
 * conversations. So the difference between the surfaces is `scroll` and their wrappers,
 * and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BODIES ARE ONLY EVER HERE
 *
 * The feed row shows a *count* and never a preview. That is not a layout decision. The
 * founder's rule is that no text preview may leak masked spoiler content, and the only
 * version of that rule which cannot be got wrong is one where the text has nowhere to
 * leak from: the list query does not run until this component mounts, so a feed of
 * thirty rows has never held a single comment body in memory.
 *
 * ---------------------------------------------------------------------------
 * SPOILERS
 *
 * `shouldMask` decides, and nothing here does. It is the same function the feed's notes
 * use, with the same three inputs — the author's claim, the exact media item, and
 * whether *this* viewer has watched that exact item. Exact means exact: the id passed in
 * is `feed_events.media_item_id`, so a comment on Season 2 stays masked for someone who
 * has watched Season 1 or "watched" the parent series.
 */
export function CommentThread({
  eventId,
  mediaItemId,
  title,
  viewerId,
  watched,
  onPressPerson,
  scroll,
}: CommentThreadProps) {
  const comments = useComments(eventId, viewerId);
  const { add, edit, remove, react, busy, reacting } = useCommentWrites(viewerId);

  const [draft, setDraft] = useState('');
  const [spoilers, setSpoilers] = useState(false);
  // Which comment is being rewritten, if any. Editing reuses the one composer rather
  // than growing a second one inside the row: two text inputs that can both be focused
  // is how a draft ends up submitted against the wrong comment.
  const [editing, setEditing] = useState<Comment | null>(null);
  /**
   * Which comment Reply was tapped on, if any.
   *
   * The whole comment rather than an id, because the composer names the person — and a
   * refetch replaces the objects, so holding the row would leave the banner reading the
   * name from a version of the list that no longer exists. Holding an id and looking it
   * up each render has the opposite problem: a comment deleted underneath an open
   * composer would make the banner vanish while the draft stayed. The copy is the state
   * the reader started from, which is the thing the banner is describing.
   */
  const [replyingTo, setReplyingTo] = useState<Comment | null>(null);
  // Which comment's reason sheet is open, by id. An id rather than the row, because a
  // refetch replaces the objects and the sheet should stay open across one.
  const [reporting, setReporting] = useState<string | null>(null);
  // And which comment's reaction picker is open, by id for the same reason. A separate
  // idea from `reporting`: a row can be in either, both or neither, which is exactly how
  // `feed.tsx` keeps its picker and its detail sheet apart.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  /**
   * And which comment's reactor list is open — the third independent per-row surface,
   * kept apart from the picker exactly as `feed.tsx` keeps its pair apart. The
   * identities are fetched on open (`use-comment-reactors`): the thread query
   * deliberately carries only aggregates.
   */
  const [reactorsFor, setReactorsFor] = useState<string | null>(null);
  const reactors = useCommentReactors(reactorsFor, viewerId);

  /**
   * The composer belongs to one event, and this is what makes that true.
   *
   * Found by independent review 11, as a Major. This component is rendered by the screen
   * and stays *mounted* on the sheet — closing it sets `eventId` to null and the early
   * return below draws nothing, but the state survives. So a draft written against one
   * activity reappeared on the next one, and an edit left open did something worse:
   * `editing` still held a comment from the first event, so pressing Save while looking
   * at the second rewrote a comment that was not on screen.
   *
   * Reset during render rather than in an effect, because an effect runs *after* the
   * first paint — which would show the stale draft, and would leave a window in which
   * Save was still wired to the old comment.
   */
  const [composer, setComposer] = useState({ eventId, opening: 0 });

  /**
   * **One id per intent, held across retries.**
   *
   * `add_comment` inserts, and `_claim_operation` can only refuse a replay that carries
   * the id it already saw. A submit whose reply is lost is reported as a failure with
   * the draft still in the box — so the obvious next thing a person does is press Post
   * again, and a fresh id on that attempt is two identical comments with no error to
   * show for it.
   *
   * Cleared on success, and on any edit to what is being said: a different body, a
   * flipped spoiler claim, a different comment under edit **or a different reply target**
   * is a different intent, and replaying it under the old id would have the server answer
   * `already_applied` to something nobody has stored.
   */
  const attempt = useRef<string | null>(null);
  const newIntent = () => {
    attempt.current = null;
  };

  /**
   * The composer's identity, readable from a closure that outlives its render.
   *
   * Review 11b found that resetting the *state* on a change of event does nothing for
   * work already in flight: a submit awaiting a round trip, and a delete confirmation
   * waiting on a native alert, both hold callbacks made when the surface belonged to
   * another activity.
   *
   * Review 11c then found two things wrong with the first fix, and both are in here:
   * **it is an opening, not an event id** (open A, close, reopen A: two different
   * composers with the same event id), and **`useLayoutEffect`, not `useEffect`** —
   * a passive effect is not guaranteed to flush before React yields, and the native
   * alert exists independently of this component.
   */
  const openingRef = useRef(composer.opening);
  useLayoutEffect(() => {
    openingRef.current = composer.opening;
  }, [composer.opening]);

  if (composer.eventId !== eventId) {
    setComposer({ eventId, opening: composer.opening + 1 });
    setDraft('');
    setSpoilers(false);
    setEditing(null);
    setReplyingTo(null);
  }

  if (!eventId) return null;

  const reset = () => {
    newIntent();
    setDraft('');
    setSpoilers(false);
    setEditing(null);
    setReplyingTo(null);
  };

  /** Whether this is still the composer the closure was made in. */
  const stillHere = (opening: number) => openingRef.current === opening;

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;

    const opening = composer.opening;
    const wasEditing = editing;
    const wasReplyingTo = replyingTo;
    // Held rather than minted per attempt — see `attempt` above. `??=` is what makes a
    // retry of the same words carry the id the first try used.
    const operationId = (attempt.current ??= newOperationId());

    const result = wasEditing
      ? await edit({ operationId, commentId: wasEditing.id, body, hasSpoilers: spoilers })
      : await add({
          operationId,
          eventId,
          body,
          hasSpoilers: spoilers,
          // Whichever comment Reply was tapped on, including a reply. The server
          // re-points it at that thread's root, so this file never decides what a thread
          // is — see `add_comment`.
          parentId: wasReplyingTo?.id ?? null,
        });

    if (!result.ok) {
      // Reported even if the surface has moved on. The write may not have happened and
      // the author believes it did; that is worth interrupting for wherever they are.
      Alert.alert(
        wasEditing ? 'Could not save your edit' : 'Could not post your comment',
        result.message,
      );
      return;
    }

    newIntent();
    if (stillHere(opening)) reset();
  };

  const beginEdit = (comment: Comment) => {
    newIntent();
    setReplyingTo(null);
    setEditing(comment);
    setDraft(comment.body ?? '');
    setSpoilers(comment.hasSpoilers);
  };

  const beginReply = (comment: Comment) => {
    // A different target is a different intent, so the held id goes with it.
    newIntent();
    setEditing(null);
    setReplyingTo(comment);
    setDraft('');
    setSpoilers(false);
  };

  const confirmDelete = (comment: Comment) => {
    const opening = composer.opening;

    Alert.alert('Delete this comment?', 'It will be removed for everyone.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            // The confirmation belonged to a screen that may no longer be there. A
            // native alert sits above the sheet, so the sheet can close or move to
            // another activity underneath it — and a destructive write confirmed
            // against a context the user can no longer see is not a confirmed write.
            if (!stillHere(opening)) return;
            // If the comment being deleted is the one open in the composer — as the
            // thing being edited or the thing being replied to — the composer has to
            // let go of it, or the next save edits a row that is gone and the next
            // reply names a parent the server will refuse.
            if (editing?.id === comment.id || replyingTo?.id === comment.id) reset();
            const result = await remove({ commentId: comment.id });
            if (!result.ok) Alert.alert('Could not delete', result.message);
          })();
        },
      },
    ]);
  };

  /**
   * Choosing a meaning, which is the whole of what the picker does.
   *
   * The picker closes first, exactly as the feed's does: the sheet underneath is
   * refetched by the write, and a pill left open over a row that is about to re-render
   * is a control pointing at a state nobody chose.
   */
  const choose = (comment: Comment, kind: ReactionKind | null) => {
    setPickerFor(null);
    if (reacting) return;
    void (async () => {
      // The state wanted, not "the opposite of what I am showing" — see `react` in
      // `use-comments.ts`. A retry after a lost reply converges instead of undoing.
      const result = await react({ commentId: comment.id, kind });
      if (!result.ok) Alert.alert('Could not do that', result.message);
    })();
  };

  /**
   * A plain tap, and it is `feed.tsx`’s rule verbatim.
   *
   * Nothing becomes a heart, and a heart becomes nothing. If some *other* reaction is
   * already set a tap replaces it with the heart rather than clearing it — the gesture
   * means "react", and the way to remove a reaction you can see is to tap the one you
   * chose. Stated here rather than shared because it is four lines and a comment; what
   * must not drift is the *rule*, and the rule is written the same way in both places.
   */
  const toggleDefault = (comment: Comment) =>
    choose(comment, comment.myReaction === DEFAULT_REACTION ? null : DEFAULT_REACTION);

  const threads = threadsOf(comments.data);
  const over = draft.length > COMMENT_MAX_LENGTH;

  const rowProps = (comment: Comment) => ({
    comment,
    masked: shouldMask({
      hasSpoilers: comment.hasSpoilers,
      mediaItemId,
      viewerId,
      authorId: comment.authorId,
      watched,
    }),
    title,
    mine: comment.authorId === viewerId,
    onPressAuthor: () => onPressPerson(comment.authorUsername),
    onReply: () => beginReply(comment),
    onReact: () => toggleDefault(comment),
    onOpenPicker: () => setPickerFor(comment.id),
    onOpenReactors: () => setReactorsFor(comment.id),
    picker:
      pickerFor === comment.id ? (
        <ReactionPill
          current={comment.myReaction}
          onChoose={(kind) => choose(comment, kind)}
          onDismiss={() => setPickerFor(null)}
        />
      ) : null,
    onEdit: () => beginEdit(comment),
    onDelete: () => confirmDelete(comment),
    onReport: () => setReporting(comment.id),
  });

  const list = comments.isError ? (
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
  ) : threads.length === 0 ? (
    <View style={styles.pad}>
      <EmptyState kind="nothingYet" compact title="No comments yet" body="Say something about this." />
    </View>
  ) : (
    threads.map((thread) => (
      <View key={thread.root.id}>
        <CommentRow {...rowProps(thread.root)} />
        {thread.replies.map((reply) => (
          // One indent, and the same row. A reply is not a different kind of thing, and
          // a second component for it is a second place to get masking wrong.
          <View key={reply.id} style={styles.indent}>
            <CommentRow {...rowProps(reply)} isReply />
          </View>
        ))}
      </View>
    ))
  );

  return (
    <>
      {/* The sheet caps its height and scrolls the conversation inside itself; the
          dedicated page is already inside a scroll view, and nesting a second one there
          would give the thread its own scrollbar inside the page's — two gestures for
          one list, and the inner one swallowing the outer one's. */}
      {scroll === 'own' ? (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {list}
        </ScrollView>
      ) : (
        <View style={styles.flow}>{list}</View>
      )}

      <View style={styles.composer}>
        {editing ? (
          <View style={styles.banner}>
            <Text variant="caption" tone="secondary">
              Editing your comment
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Stop editing" onPress={reset}>
              <Text variant="caption" tone="action">
                Cancel
              </Text>
            </Pressable>
          </View>
        ) : replyingTo ? (
          /* The founder's "Replying to Sarah", in the compact grammar the editing banner
             already established. It names a person rather than a comment because that is
             what the reader is answering — and because a comment has no name to use. */
          <View style={styles.banner}>
            <Text variant="caption" tone="secondary" numberOfLines={1} style={styles.bannerCopy}>
              Replying to {replyingTo.authorName}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop replying"
              onPress={reset}
            >
              <Text variant="caption" tone="action">
                Cancel
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* "Your comment" while editing rather than "Edit your comment", which is the
            row button's label — two controls answering to one label is ambiguous to a
            screen reader, and it is the row's button that performs the *action*. */}
        <TextInput
          accessibilityLabel={
            editing ? 'Your comment' : replyingTo ? `Reply to ${replyingTo.authorName}` : 'Add a comment'
          }
          placeholder={replyingTo ? `Reply to ${replyingTo.authorName}` : 'Add a comment'}
          placeholderTextColor={theme.text.tertiary}
          value={draft}
          onChangeText={(next) => {
            // Different words are a different intent, so the held id goes with them.
            newIntent();
            setDraft(next);
          }}
          multiline
          maxLength={COMMENT_MAX_LENGTH}
          style={styles.input}
        />

        <View style={styles.composerActions}>
          {/* The author's claim about their own writing, set before it is posted. */}
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: spoilers }}
            accessibilityLabel="Mark this comment as containing spoilers"
            onPress={() => {
              newIntent();
              setSpoilers((value) => !value);
            }}
            hitSlop={theme.space[2]}
            style={({ pressed }) => [styles.spoilerToggle, pressed && styles.pressed]}
          >
            <Ionicons
              name={spoilers ? 'eye-off' : 'eye-off-outline'}
              size={theme.layout.icon.sm}
              color={spoilers ? theme.semantic.action : theme.text.secondary}
            />
            <Text variant="caption" tone={spoilers ? 'action' : 'secondary'}>
              Contains spoilers
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
            label={editing ? 'Save' : replyingTo ? 'Reply' : 'Post'}
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

      {/* Stacked over whatever is showing rather than replacing it, so closing the
          reason list returns to the conversation the reader was in. */}
      <ReportSheet
        visible={reporting !== null}
        onClose={() => setReporting(null)}
        subject="comment"
        subjectId={reporting ?? ''}
        noun="comment"
      />

      {/* The feed's own list component over a comment's reactors (§18) — nested the
          way AwardsSheet nests its drill-down, so a sheet surface and the pushed
          page both get it. An error resolves to null and the sheet simply closes on
          the next render; a reactor list is not worth an error state of its own. */}
      {reactorsFor ? (
        <ReactionDetail
          summary={reactors.data ?? null}
          loading={reactors.isPending}
          onClose={() => setReactorsFor(null)}
          onPressPerson={(username) => {
            setReactorsFor(null);
            onPressPerson(username);
          }}
        />
      ) : null}
    </>
  );
}

function CommentRow({
  comment,
  masked,
  title,
  mine,
  isReply = false,
  onPressAuthor,
  onReply,
  onReact,
  onOpenPicker,
  onOpenReactors,
  picker,
  onEdit,
  onDelete,
  onReport,
}: {
  comment: Comment;
  masked: boolean;
  title: string | null;
  mine: boolean;
  isReply?: boolean;
  onPressAuthor: () => void;
  onReply: () => void;
  /** A plain tap: toggles the default reaction on or off. */
  onReact: () => void;
  /** A long press: opens the six. */
  onOpenPicker: () => void;
  /** Tap or long press on the glyph cluster: who reacted, with what (§18). */
  onOpenReactors: () => void;
  /** Rendered above the actions, inside the row - see ReactionPill. */
  picker: React.ReactNode;
  onEdit: () => void;
  onDelete: () => void;
  onReport: () => void;
}) {
  /**
   * A retracted comment, which is a place in the conversation and not a comment.
   *
   * It is drawn at all only because replies hang off it — `delete_comment` tombstones a
   * root with replies precisely so other people's writing survives, and removes anything
   * else outright, so this branch is never a comment nobody answered. No avatar, no name,
   * no actions: attributing a retraction to somebody is the opposite of retracting it,
   * and there is nothing here to like, report, edit or reply to.
   */
  if (comment.deleted) {
    return (
      <View style={[styles.row, styles.tombstone]}>
        <Text variant="caption" tone="tertiary">
          Comment deleted
        </Text>
      </View>
    );
  }

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
          text={comment.body ?? ''}
          hasSpoilers={comment.hasSpoilers}
          masked={masked}
          titleForLabel={title}
          // The one surface where this text is not a review.
          noun="comment"
        />

        {/* Above the actions and inside the row, which is where `ActivityRow` puts it:
            positioned against its own parent, so it travels with the row when the thread
            scrolls and cannot be clipped on Android by being drawn outside it. */}
        {picker ? <View style={styles.picker}>{picker}</View> : null}

        <View style={styles.actions}>
          {/* The reaction — the one control both surfaces render now (§17). This
              grammar started here and the founder promoted it: heart first, cluster
              and count inline. What this row adds since PR #64 is the cluster as a
              way *in*: tap or hold it and the people behind the number are named
              (§18), which is `feed.tsx`'s detail sheet fed by `comment_reactors`. */}
          <ReactionControl
            label={
              comment.reactedByMe
                ? `You reacted to ${comment.authorName}'s comment. Tap to remove, long press to change.`
                : `React to ${comment.authorName}'s comment. Long press for more reactions.`
            }
            active={comment.reactedByMe}
            glyphs={comment.reactionKinds.map((kind) => REACTION_GLYPH[kind])}
            count={comment.reactionCount}
            onToggle={onReact}
            onOpenPicker={onOpenPicker}
            onOpenDetail={onOpenReactors}
          />

          {/* Offered on a reply as well as on a root. Tapping it there is an ordinary
              thing to do and the server puts the result in the same thread — see
              `add_comment`. Refusing it on replies would have been the visible half of
              a rule the reader has no way to know about. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reply to ${comment.authorName}`}
            accessibilityHint={
              isReply ? 'Adds to this conversation' : 'Adds a reply under this comment'
            }
            onPress={onReply}
            hitSlop={slop}
          >
            <Text variant="caption" tone="secondary">
              Reply
            </Text>
          </Pressable>

          {/* Which of the rest depends on whose comment it is.

              Report sits in the branch Edit and Delete do not, which is how it stays
              honest rather than merely tidy: `report()` refuses your own content with a
              22023, so offering the control on your own comment would be a button whose
              only outcome is an error message. */}
          {mine ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit your comment"
                onPress={onEdit}
                hitSlop={slop}
              >
                <Text variant="caption" tone="secondary">
                  Edit
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete your comment"
                onPress={onDelete}
                hitSlop={slop}
              >
                <Text variant="caption" tone="secondary">
                  Delete
                </Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Report ${comment.authorName}'s comment`}
              accessibilityHint="Tells whoever runs bingd. about this comment"
              onPress={onReport}
              hitSlop={slop}
            >
              <Text variant="caption" tone="tertiary">
                Report
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * The slop that carries the 44pt floor for a one-line caption control.
 *
 * Slop rather than height, which is the `Button` `sm` reasoning applied to something
 * smaller still: a row of four 44pt boxes under every comment would change what the
 * surface reads as, and the tap target is what has to be 44pt, not the ink.
 */
const slop = (theme.layout.minTapTarget - theme.typography.caption.lineHeight) / 2;

const styles = StyleSheet.create({
  list: { maxHeight: 360 },
  listContent: { paddingBottom: theme.space[3] },
  flow: { paddingBottom: theme.space[2] },
  pad: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[3] },
  row: {
    flexDirection: 'row',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
  },
  // One level, and one level only. The avatar is `sm` plus the row gap, so a reply lines
  // up under the name of the comment it answers rather than at an arbitrary inset.
  indent: { paddingLeft: theme.space[6] },
  tombstone: { paddingVertical: theme.space[2] },
  rowCopy: { flex: 1, gap: theme.space[1] },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  author: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    paddingTop: theme.space[1],
  },
  // The pill sits above the actions and hugs the left edge of the copy column, which
  // is where the control it belongs to is.
  picker: { alignSelf: 'flex-start', paddingTop: theme.space[1] },
  composer: {
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
  },
  banner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bannerCopy: { flex: 1 },
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
