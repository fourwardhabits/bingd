import { Ionicons } from '@expo/vector-icons';
import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { shouldMask } from '@/features/collection/use-watched';
import { newOperationId } from '@/features/collection/writes';
import { ReportSheet } from '@/features/moderation/ReportSheet';
import { Avatar, Button, EmptyState, ReactionControl, SpoilerNote, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import { relativeTime } from './activity';
import { applyMention, mentionFragment, resolveMentions } from './mentions';
import { MentionSuggestions } from './MentionSuggestions';
import { ReactionDetail } from './ReactionDetail';
import { ReactionPill } from './ReactionPill';
import { useCommentReactors } from './use-comment-reactors';
import { useMentionCandidates } from './use-mentions';
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
   * ---------------------------------------------------------------------------
   * @MENTIONS — THE THREE PIECES OF STATE, AND WHY EACH IS SEPARATE
   *
   * **`caret`** is where the cursor is. React Native does not tell you on
   * `onChangeText`, so it is tracked from `onSelectionChange` *and* set optimistically
   * on every edit — the two events do not arrive in a guaranteed order, and a fragment
   * computed against a stale caret opens the list on the wrong word.
   *
   * **`known`** is handle → id, for everybody the author has ever picked in this
   * composer plus everybody the comment being edited already names. It is what turns
   * text back into ids at submit time, and it is a ref rather than state because
   * nothing renders from it and a set on every keystroke would be a render for nothing.
   *
   * **`fragment`** is derived, not stored: it is a pure function of the draft and the
   * caret, so there is no way for the list to be open while the text says it should not
   * be. That is the failure this shape rules out rather than tests for.
   *
   * The founder's constraint was "keep this visually restrained and do not build a
   * People picker", so there is no mode, no separate field, and nothing to dismiss: the
   * list is present exactly while a fragment is.
   */
  const [caret, setCaret] = useState(0);
  const known = useRef(new Map<string, string>());
  const remember = (handle: string, id: string) => {
    known.current.set(handle.toLowerCase(), id);
  };

  const fragment = mentionFragment(draft, caret);
  /**
   * Not a user search — see `use-mentions.ts`. The population is the people this reader
   * follows plus the conversation's own participants, built server-side, so a stranger
   * is never a row this component has to filter out.
   *
   * Called unconditionally and before the early returns below, because hooks cannot be
   * conditional; `enabled` is what stops it asking anything while nobody is typing an @.
   */
  const suggestions = useMentionCandidates(eventId, fragment?.query ?? null, viewerId);

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
    /**
     * **And the mentions the author picked go with the composer they were picked in.**
     *
     * Carried across, a handle typed against one activity could resolve to an id the
     * reader chose on another — the same class of bug review 11 found in the draft
     * itself, one layer down.
     *
     * Cleared *here* rather than beside the state resets below, because a ref written
     * during render is torn between two passes under concurrent rendering. Nothing is at
     * risk in the gap: the draft is emptied in the same commit, and a mention can only
     * be resolved out of text that is no longer there.
     */
    known.current = new Map();
  }, [composer.opening]);

  if (composer.eventId !== eventId) {
    setComposer({ eventId, opening: composer.opening + 1 });
    setDraft('');
    setSpoilers(false);
    setEditing(null);
    setReplyingTo(null);
    setCaret(0);
  }

  if (!eventId) return null;

  const reset = () => {
    newIntent();
    setDraft('');
    setSpoilers(false);
    setEditing(null);
    setReplyingTo(null);
    // An empty draft has no fragment, so the suggestion list closes with it rather than
    // hanging over a box the reader has just been given back.
    setCaret(0);
    forgetMentions();
  };

  /**
   * **The picked handles belong to one comment, not to the thread.**
   *
   * Independent review 68: clearing this only when the *activity* changes meant one
   * selection authorised every later comment in the same conversation. Choose Ravi from
   * the list, post; then hand-type `@ravi` in the next comment and it resolved to his id
   * — which is precisely the "a handle nobody chose is not a mention" rule failing, and
   * it turns one deliberate choice into a way to keep naming somebody by typing.
   *
   * So it is emptied wherever the composer changes what it is composing: after a
   * successful post, on Cancel, when a reply target is chosen, and at the start of an
   * edit (which then re-seeds from the comment's own record). The unmount path in
   * `useLayoutEffect` above still covers a change of activity.
   */
  const forgetMentions = () => {
    known.current = new Map();
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

    /**
     * Text back into people, at the last moment.
     *
     * The intersection of "handles still in what is being posted" and "people this
     * author actually picked" — `resolveMentions` states both halves and why. Deleting a
     * name from the draft is therefore how a mention is removed; there is no second
     * control, and nothing to remember to press.
     */
    const mentionIds = resolveMentions(body, known.current);

    const result = wasEditing
      ? await edit({
          operationId,
          commentId: wasEditing.id,
          body,
          hasSpoilers: spoilers,
          mentionIds,
        })
      : await add({
          operationId,
          eventId,
          body,
          hasSpoilers: spoilers,
          mentionIds,
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
    setCaret(comment.body?.length ?? 0);
    /**
     * **The ids the comment already carries, seeded before a single key is pressed.**
     *
     * Without this, reopening a comment to fix a typo would post it back with an empty
     * mention list: the handles are in the text but the author never picked them *in
     * this composer*, so `resolveMentions` would resolve none of them and the server
     * would deactivate every one. Nobody would be notified twice — the ledger sees to
     * that — but the relation would quietly rot, and it is the relation that survives a
     * rename.
     *
     * **Both spellings**, and the second is the rename case. The body says whatever it
     * said when it was written; the person may be called something else now. Seeding only
     * the current handle leaves `@ravi` in the text resolving to nobody the moment Ravi
     * becomes `ravinder` — so an ordinary typo fix would drop him, which is the "a handle
     * change must not break the stored association" rule failing at the one point it
     * actually gets exercised. Independent review 68.
     *
     * `activity_comments.mentions` is where both come from, which is the whole reason
     * that column crosses the wire.
     */
    forgetMentions();
    for (const mention of comment.mentions) {
      remember(mention.username, mention.id);
      if (mention.handle) remember(mention.handle, mention.id);
    }
  };

  const beginReply = (comment: Comment) => {
    // A different target is a different intent, so the held id goes with it.
    newIntent();
    setEditing(null);
    setReplyingTo(comment);
    setDraft('');
    setSpoilers(false);
    setCaret(0);
    // A different target is a different comment, and the handles picked for the last one
    // do not carry into it. See `forgetMentions`.
    forgetMentions();
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
        /**
         * `keyboardShouldPersistTaps` so a tap on Reply, a reaction or Cancel lands
         * while the composer has focus, instead of being spent dismissing the keyboard
         * — the page below already does this and the sheet did not.
         */
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
        >
          {list}
        </ScrollView>
      ) : (
        <View style={styles.flow}>{list}</View>
      )}

      <View style={styles.composer}>
        {/**
          * The suggestions, above the field and above the banner both.
          *
          * Above the *field* because the keyboard is below it, and a list drawn under
          * the composer would be off-screen exactly when it is needed. Above the
          * *banner* because "Replying to Sarah" is context for the box, and putting a
          * transient strip between the two would separate a label from the thing it
          * labels every time somebody typed an @.
          *
          * Present exactly while a fragment is: there is no open/closed state to get
          * out of step, because `fragment` is derived from the draft and the caret.
          */}
        {fragment ? (
          <MentionSuggestions
            candidates={suggestions.data ?? []}
            loading={suggestions.isPending}
            onChoose={(candidate) => {
              // Remembered before the text changes, so the id is already known by the
              // time `resolveMentions` reads the handle back out of it.
              remember(candidate.username, candidate.id);
              const next = applyMention(draft, fragment, candidate.username);
              // A different comment is a different intent — the same rule typing obeys.
              newIntent();
              setDraft(next.text);
              setCaret(next.cursor);
            }}
          />
        ) : null}

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
            /**
             * The caret, for the one case where waiting for the truth is too slow.
             *
             * `onSelectionChange` is the authority, and it fires — but the order of the
             * two events is not guaranteed on either platform, and a fragment computed
             * against the previous keystroke's caret opens the list one character behind
             * what is on screen.
             *
             * So this guesses **only for a pure append**, which is what typing a name
             * is: `next` extends the draft, so the caret is at its end, and that is true
             * whichever order the events arrive in. Editing in the middle of finished
             * text takes neither branch and is left entirely to the selection handler,
             * because a guess there would be wrong and would fight the correction.
             */
            if (next.startsWith(draft)) setCaret(next.length);
          }}
          onSelectionChange={(event) => setCaret(event.nativeEvent.selection.start)}
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
            // `myReaction` says *which*, which is what the action slot draws (§6).
            // `reactedByMe` still says *whether*. The pair was already fetched for the
            // picker's `current`; nothing new is read.
            mineGlyph={comment.myReaction ? REACTION_GLYPH[comment.myReaction] : null}
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
  /**
   * **`flexShrink`, and it is the whole of the sheet's keyboard bug** (founder, Android).
   *
   * `Sheet` already lifts clear of the keyboard — it measures the height and pads its
   * root, which re-resolves the sheet's `maxHeight: '90%'` against what is left. What it
   * could not do is decide which of its children gives up the space. This list asked for
   * a flat 360 and, being the first child, took it; the composer is the last child, so
   * the part clipped off the bottom of a capped sheet was always the box being typed in.
   *
   * The cap stays — a conversation must not push the composer off a *tall* screen either
   * — but it is now a maximum rather than a claim. The list shrinks, the composer keeps
   * its intrinsic height, and nothing here has to know the keyboard exists.
   */
  list: { flexShrink: 1, maxHeight: 360 },
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
