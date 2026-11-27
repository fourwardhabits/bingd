import { Ionicons } from '@expo/vector-icons';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { shouldMask } from '@/features/collection/use-watched';
import { newOperationId } from '@/features/collection/writes';
import { ReportSheet } from '@/features/moderation/ReportSheet';
import {
  Avatar,
  Button,
  EmptyState,
  ReactionControl,
  SpoilerNote,
  Text,
  useSheetExpanded,
} from '@/ui/components';
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
  readableCount,
  threadOf,
  threadsOf,
  useCommentWrites,
  useComments,
  type Comment,
} from './use-comments';
import {
  DEFAULT_REACTION,
  REACTION_GLYPH,
  reactionFailureAlert,
  type ReactionKind,
} from './use-reactions';

export type CommentThreadProps = {
  /** The event whose comments these are. Null renders nothing. */
  eventId: string | null;
  /** What the event is about, for spoiler masking. Never the parent series. */
  mediaItemId: string | null;
  /** The full display title, for the reveal control's label. */
  title: string | null;
  /**
   * Whether the composer offers "Contains spoilers". False on a follow story (Workstream C,
   * 2026-11-19): a post about who somebody followed has no title to spoil. Defaults to true,
   * so every other thread is unchanged.
   */
  allowSpoilers?: boolean;
  viewerId: string;
  /** Which exact media items the viewer has watched — `useWatched`'s answer. */
  watched: Set<string> | undefined;
  onPressPerson: (username: string) => void;
  /**
   * Where the list is drawn. The sheet caps its height and scrolls internally; the
   * dedicated page is already inside a scroll view and must not nest a second one.
   */
  scroll: 'own' | 'inherited';
  /**
   * The comment a notification was about, when this conversation was opened from one
   * (`/activity/[id]?comment=` or `?notification=`). Only notification entry sets it.
   *
   * Since 2026-11-23 (founder: "Comments UX & Notification Reply Refinement") it does three
   * things, where #365 did one:
   *
   *   1. **Focused view.** Only that comment's thread is drawn at first — the root and its
   *      replies — with "See all N comments" to expand in place. Scrolled into view once
   *      and the comment briefly marked, as before.
   *   2. **Reply mode.** The composer starts as a reply to that comment's author, because
   *      somebody who was told "Ada replied to your comment" and types into the box means
   *      to answer Ada — #365 left it on "Add a comment", and the answer became a new
   *      top-level comment. **The keyboard is not opened**: arriving is not the same as
   *      deciding to type, and a keyboard over the thread on arrival hides what they came
   *      to read. An explicit Reply tap still focuses, as before.
   *   3. Nothing else: a draft, an edit or a reply the reader has already started is never
   *      overwritten, and a target that is gone, retracted or the reader's own leaves the
   *      composer on "Add a comment".
   */
  focusCommentId?: string | null;
  /**
   * Where the focused thread starts, in the coordinates of whatever scrolls this
   * component, for `scroll: 'inherited'` — the page owns that scroll view. With `own`
   * the list scrolls itself and this is not called.
   */
  onFocusOffset?: (y: number) => void;
  /**
   * Keep an unsent draft when this conversation closes, and bring it back when the same
   * activity is opened again (the Feed's sheet, founder iPhone QA 2026-11-24): a swipe down
   * must never post what was typed, and must never silently lose it either.
   */
  keepDraft?: boolean;
};

/**
 * **Unsent drafts, per account and activity.** Memory only, for this run of the app: a
 * draft is a moment's work, not something to write to disk. It keeps everything the
 * composer needs to carry on exactly where it stopped — the words, the spoiler claim, the
 * reply or edit target, the mentions the author picked, and the operation id, so a retry
 * after an ambiguous failure still cannot post twice.
 */
type HeldDraft = {
  draft: string;
  spoilers: boolean;
  replyingTo: Comment | null;
  editing: Comment | null;
  known: [string, string][];
  attempt: string | null;
};
const heldDrafts = new Map<string, HeldDraft>();
/**
 * Operation ids whose comment has been posted. A composer reopened while its post was still
 * in flight holds that post's words and id; once the post lands, closing it must not save
 * them again as unsent (Codex review, PR #374). Text changed since carries a new id.
 */
const postedOperations = new Set<string>();
const heldKey = (viewerId: string, eventId: string | null) => `${viewerId}:${eventId ?? ''}`;
/** For tests: start every case from no held drafts. */
export const forgetHeldDrafts = () => {
  heldDrafts.clear();
  postedOperations.clear();
};

/** How long a notification's comment stays marked after the conversation opens. */
export const FOCUS_HIGHLIGHT_MS = 2500;

/**
 * How much of what comes before a focused *reply* stays on screen above it: about one
 * comment, so the reader sees what it answers. Never above the thread's own root.
 */
const REPLY_CONTEXT = 160;

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
  allowSpoilers = true,
  viewerId,
  watched,
  onPressPerson,
  scroll,
  focusCommentId = null,
  onFocusOffset,
  keepDraft = false,
}: CommentThreadProps) {
  const comments = useComments(eventId, viewerId);
  const sheetExpanded = useSheetExpanded();
  const { add, edit, remove, react, busy, reacting } = useCommentWrites(viewerId);

  const heldFor = (id: string | null) =>
    keepDraft ? heldDrafts.get(heldKey(viewerId, id)) : undefined;
  const [draft, setDraft] = useState(() => heldFor(eventId)?.draft ?? '');
  const [spoilers, setSpoilers] = useState(() => heldFor(eventId)?.spoilers ?? false);
  // Which comment is being rewritten, if any. Editing reuses the one composer rather
  // than growing a second one inside the row: two text inputs that can both be focused
  // is how a draft ends up submitted against the wrong comment.
  const [editing, setEditing] = useState<Comment | null>(
    () => heldFor(eventId)?.editing ?? null,
  );
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
  const [replyingTo, setReplyingTo] = useState<Comment | null>(
    () => heldFor(eventId)?.replyingTo ?? null,
  );
  /**
   * The server said the comment being replied to is gone (`add_comment`'s `P0002 no such
   * comment`) before this reader's list had caught up. The list is the other way to know —
   * see `targetUnavailable` below — and either one stops the composer posting.
   */
  /**
   * Keyed by the comment it is about, not a flag: a refusal that arrives after the reader
   * has moved Reply to another comment is about the old target, and must not mark the new
   * one unavailable (Codex review, PR #365).
   */
  const [replyGone, setReplyGone] = useState<string | null>(null);
  const input = useRef<TextInput>(null);
  const list = useRef<ScrollView>(null);
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
    const held = heldFor(composer.eventId);
    known.current = new Map(held?.known ?? []);
    // A held draft carries the id its last attempt used; anything else starts afresh.
    attempt.current = held?.attempt ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening, by design
  }, [composer.opening]);

  /**
   * **What a closing conversation keeps** (`keepDraft`). Mirrored after every commit, and
   * saved under the activity it belongs to when this composer stops being that activity's —
   * on close (unmount) or when the surface moves to another activity. An empty composer
   * leaves nothing behind.
   */
  const latest = useRef<HeldDraft | null>(null);
  useLayoutEffect(() => {
    latest.current = {
      draft,
      spoilers,
      replyingTo,
      editing,
      known: [...known.current.entries()],
      attempt: attempt.current,
    };
  });
  useLayoutEffect(() => {
    if (!keepDraft || !eventId) return;
    const key = heldKey(viewerId, eventId);
    return () => {
      // The operation id read live, not from the last commit: a Post pressed just before
      // the close has set it without a render in between.
      const last = latest.current && { ...latest.current, attempt: attempt.current };
      const posted = last?.attempt != null && postedOperations.has(last.attempt);
      if (last && !posted && (last.draft.trim() || last.replyingTo || last.editing)) {
        heldDrafts.set(key, last);
      } else heldDrafts.delete(key);
    };
  }, [keepDraft, viewerId, eventId]);

  if (composer.eventId !== eventId) {
    const held = heldFor(eventId);
    setComposer({ eventId, opening: composer.opening + 1 });
    setDraft(held?.draft ?? '');
    setSpoilers(held?.spoilers ?? false);
    setEditing(held?.editing ?? null);
    setReplyingTo(held?.replyingTo ?? null);
    setReplyGone(null);
    setCaret(0);
  }

  /**
   * ---------------------------------------------------------------------------
   * ARRIVING AT ONE COMMENT (a notification tap)
   *
   * Laid out before it can be scrolled to, so every thread, reply block and reply reports
   * its offset as it lays out — the thread inside the list, the replies inside the thread,
   * the reply inside those — and the scroll happens once, when the target's are known.
   * Every row reports, not only the target's: a push resolves its comment *after* the
   * list may have laid out, and a layout that has already happened is never reported
   * again. Refs rather than state: nothing renders from them.
   */
  const layout = useRef({
    container: undefined as number | undefined,
    threads: new Map<string, number>(),
    replies: new Map<string, number>(),
    rows: new Map<string, number>(),
  });
  const scrolledTo = useRef<string | null>(null);

  const allThreads = threadsOf(comments.data);
  const focusThread = focusCommentId ? threadOf(allThreads, focusCommentId) : null;
  const focusIsReply = Boolean(focusThread && focusThread.root.id !== focusCommentId);
  const focusMissing = Boolean(focusCommentId && comments.data && !focusThread);

  /**
   * **The focused view, and its way out.** Only while the target's thread exists; a
   * notification about a comment that has gone opens the whole conversation with a note,
   * as before. "See all" expands in place — same component, same state — so the reply
   * target and the draft are simply still there, and the composer's mode is untouched.
   */
  const [expanded, setExpanded] = useState(false);
  const focusedView = Boolean(focusThread) && !expanded;
  /**
   * **Measurements belong to one shape of the list** (Codex review, PR #374). A push's
   * comment can resolve after the whole conversation has laid out; the list then becomes
   * the focused thread alone, and the offset recorded for that thread in the full list
   * would land the scroll below it. So when the shape changes, the threads' offsets are
   * forgotten and the scroll waits for where the thread is *now* (the offsets inside a
   * thread — its replies, a reply — do not move with it and are kept). A layout effect,
   * so it runs before both the arrival effect below and the native layout events.
   */
  // The shape is what is actually drawn — which threads, and whether "See all" sits
  // above them — so a change of mode that draws the same thing (a post with one thread)
  // keeps its measurements, since no new layout would come to replace them (Codex
  // review, PR #374).
  const listShape = [
    focusThread && allThreads.length > 1 ? 'see-all' : '',
    ...(focusedView && focusThread ? [focusThread] : allThreads).map(
      (thread) => thread.root.id,
    ),
  ].join('|');
  useLayoutEffect(() => {
    layout.current.threads.clear();
  }, [listShape]);
  /**
   * **Reply mode on arrival**, set during render rather than in an effect so the first
   * frame that shows the comment already shows "Replying to …" — the same pattern the
   * per-activity reset above uses. Once per focused comment: Cancel returns to "Add a
   * comment" and stays there, and a refetch never re-applies it.
   */
  const [arrivedFor, setArrivedFor] = useState<string | null>(null);
  const arrival =
    focusCommentId && focusThread && arrivedFor !== focusCommentId
      ? (comments.data?.find((row) => row.id === focusCommentId) ?? null)
      : null;
  if (arrival) {
    setArrivedFor(focusCommentId);
    if (
      !arrival.deleted &&
      arrival.authorId !== viewerId &&
      !editing &&
      !replyingTo &&
      draft.length === 0
    ) {
      setReplyingTo(arrival);
      setReplyGone(null);
    }
  }

  const tryFocusScroll = () => {
    if (!focusCommentId || !focusThread || scrolledTo.current === focusCommentId) return;
    const at = layout.current;
    const thread = at.threads.get(focusThread.root.id);
    if (thread === undefined) return;
    // In the focused view the thread is the whole list, and "See all" sits above it: land
    // at the top of the list so both are in view. Otherwise, at the thread's own top.
    const floor = focusedView ? 0 : thread;
    let within = floor;
    if (focusIsReply) {
      const replies = at.replies.get(focusThread.root.id);
      const reply = at.rows.get(focusCommentId);
      if (replies === undefined || reply === undefined) return;
      within = Math.max(floor, thread + replies + reply - REPLY_CONTEXT);
    }
    if (scroll === 'own') {
      scrolledTo.current = focusCommentId;
      list.current?.scrollTo({ y: within, animated: true });
      return;
    }
    if (at.container === undefined) return;
    scrolledTo.current = focusCommentId;
    onFocusOffset?.(at.container + within);
  };

  /**
   * The mark, for a moment. Started when the comment is found rather than when the scroll
   * lands, so a thread already on screen (no scroll needed) is marked all the same. Derived
   * rather than set: the comment is marked until its timer has run out.
   */
  const focusFound = Boolean(focusThread);
  const [markExpired, setMarkExpired] = useState<string | null>(null);
  const highlighted =
    focusCommentId && focusFound && markExpired !== focusCommentId ? focusCommentId : null;
  useEffect(() => {
    if (!focusCommentId || !focusFound) return;
    const timer = setTimeout(() => setMarkExpired(focusCommentId), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focusCommentId, focusFound]);

  // The rows may have laid out before the target was known (a push's comment arrives with
  // the inbox read), and a layout already reported is never reported again — so once it is
  // known, try with what has already been measured. Through a ref, so the effect runs on
  // the target changing and not on every render's new closure.
  const focusScroll = useRef(tryFocusScroll);
  useLayoutEffect(() => {
    focusScroll.current = tryFocusScroll;
  });
  useEffect(() => {
    if (focusCommentId && focusFound) focusScroll.current();
  }, [focusCommentId, focusFound]);

  const measured =
    (key: 'threads' | 'replies' | 'rows', id: string) => (event: LayoutChangeEvent) => {
      layout.current[key].set(id, event.nativeEvent.layout.y);
      tryFocusScroll();
    };
  const measuredContainer = (event: LayoutChangeEvent) => {
    layout.current.container = event.nativeEvent.layout.y;
    tryFocusScroll();
  };

  if (!eventId) return null;

  const reset = () => {
    newIntent();
    setDraft('');
    setSpoilers(false);
    setEditing(null);
    setReplyingTo(null);
    setReplyGone(null);
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
    // A reply to a comment that no longer exists is refused here, and by the server,
    // rather than quietly re-aimed at the top level. See `keepAsNewComment`.
    if (wasReplyingTo && targetUnavailable) return;
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
      /**
       * **The comment being answered went away between Reply and the press.** Deleted,
       * or its author blocked or hidden since — `add_comment` says `no such comment` for
       * all three and wrote nothing. The draft stays, the composer says what happened in
       * place of "Replying to", and the reader chooses: post it as a new comment, or
       * cancel. Not an alert, because the banner *is* the explanation and the choices
       * live beside the text they are about.
       */
      if (wasReplyingTo && result.unavailable === 'comment') {
        if (stillHere(opening)) {
          setReplyGone(wasReplyingTo.id);
          AccessibilityInfo.announceForAccessibility?.(
            `${wasReplyingTo.authorName}'s comment is no longer available. Your text is still here.`,
          );
          void comments.refetch();
        }
        return;
      }
      // Reported even if the surface has moved on. The write may not have happened and
      // the author believes it did; that is worth interrupting for wherever they are.
      Alert.alert(
        wasEditing ? 'Could not save your edit' : 'Could not post your comment',
        result.message,
      );
      return;
    }

    newIntent();
    // Posted: whatever was held for this activity — including a copy saved because the
    // sheet closed while this was in flight — is spent, and must not come back.
    // Only that copy: a draft written since — reopened and changed, which mints a new
    // intent — carries another operation id and is the reader's newer work (Codex review,
    // PR #374).
    if (keepDraft) {
      postedOperations.add(operationId);
      const key = heldKey(viewerId, eventId);
      if (heldDrafts.get(key)?.attempt === operationId) heldDrafts.delete(key);
    }
    if (stillHere(opening)) {
      /**
       * A new top-level comment is a thread of its own, which the focused view would not
       * show — so it would seem to vanish the moment it was posted (Codex review, PR #374).
       * Posting one opens the whole conversation, where it now is.
       */
      if (!wasEditing && !wasReplyingTo) setExpanded(true);
      reset();
    }
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
    setReplyGone(null);
    setDraft('');
    setSpoilers(false);
    setCaret(0);
    // A different target is a different comment, and the handles picked for the last one
    // do not carry into it. See `forgetMentions`.
    forgetMentions();
    /**
     * **The box takes focus**, so tapping Reply visibly *does* something where the reader
     * is about to type: the keyboard rises, and on the page the composer is scrolled into
     * what is left of the screen. Before this the only change was a caption above a box
     * that might have been off-screen — the likeliest reason so many answers in production
     * were posted as new comments.
     */
    input.current?.focus();
  };

  /**
   * Back to a new comment, keeping the words: the recovery for a reply whose comment has
   * gone. The draft is now a different intent (no parent), so it gets an id of its own;
   * the reader then presses the ordinary Post.
   */
  const keepAsNewComment = () => {
    newIntent();
    setReplyingTo(null);
    setReplyGone(null);
    input.current?.focus();
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
            // If the comment being deleted is the one being edited, the composer has to
            // let go of it, or the next save edits a row that is gone. The one being
            // *replied to* is different: the reader may have written a reply already, and
            // emptying the box would lose it. The list refetches after the delete, the
            // target is then missing or a tombstone, and the composer says so and offers
            // a new comment or Cancel — see `targetUnavailable`.
            if (editing?.id === comment.id) reset();
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
      const alert = reactionFailureAlert(result, 'Could not do that');
      if (alert) Alert.alert(...alert);
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

  const threads = allThreads;
  const shownThreads = focusedView && focusThread ? [focusThread] : threads;
  const over = draft.length > COMMENT_MAX_LENGTH;

  /**
   * ---------------------------------------------------------------------------
   * WHAT THE COMPOSER IS DOING, STATED ONCE
   *
   * The comment being replied to, as the list has it now — a refetch may have renamed its
   * author, tombstoned it or dropped it. The snapshot in `replyingTo` is what the reader
   * chose; this is whether it still exists.
   */
  const liveTarget = replyingTo
    ? (comments.data?.find((row) => row.id === replyingTo.id) ?? null)
    : null;
  const target = liveTarget ?? replyingTo;
  /**
   * Gone from the list, a tombstone, or refused by the server. Judged against the last
   * list that loaded — a refetch that *failed* keeps that list, so a dropped connection is
   * not mistaken for a deletion.
   */
  const targetUnavailable = Boolean(
    replyingTo &&
    (replyGone === replyingTo.id ||
      (comments.data !== undefined && (!liveTarget || liveTarget.deleted))),
  );
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
    // The same route the author's own name uses, so a name in the body and a name in
    // the header of the row above it go to the same place.
    onPressMention: onPressPerson,
    onReply: () => beginReply(comment),
    // The comment the composer is answering, and the one a notification pointed at: the
    // same quiet well, so "where will this go" and "this is what you were told about"
    // are answered on the row itself as well as in words.
    marked: (replyingTo?.id === comment.id && !editing) || highlighted === comment.id,
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

  const conversation =
    comments.isError && !comments.data ? (
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
        <EmptyState
          kind="nothingYet"
          compact
          title="No comments yet"
          body="Be the first to comment."
        />
      </View>
    ) : (
      <>
        {/* A notification about a comment that has since gone: the conversation still
          opens, and says so rather than leaving the reader looking for it. */}
        {focusMissing ? (
          <Text variant="footnote" tone="tertiary" style={styles.pad}>
            That comment is no longer available.
          </Text>
        ) : null}
        {/**
         * "See all N comments": subdued maroon, at the top of the focused conversation so it
         * is on screen when the reader lands. N is every comment this reader can see — the
         * same readable count the Feed's comment button states — and the control exists only
         * when there is more than this thread to see.
         */}
        {focusThread && threads.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              expanded
                ? 'Show only this conversation'
                : `See all ${readableCount(comments.data)} comments`
            }
            accessibilityHint={
              expanded
                ? 'Hides the other conversations on this activity'
                : 'Shows every conversation on this activity. Your reply stays as it is'
            }
            // In place, and from where the control is: "See all" shows the conversation
            // from its first thread, directly under the control the reader just pressed.
            onPress={() => setExpanded((value) => !value)}
            hitSlop={slop}
            style={({ pressed }) => [styles.seeAll, pressed && styles.pressed]}
          >
            <Text variant="footnote" tone="action">
              {expanded
                ? 'Show only this conversation'
                : `See all ${readableCount(comments.data)} comments`}
            </Text>
          </Pressable>
        ) : null}
        {shownThreads.map((thread, index) => (
          /**
           * One thread: a root, then its replies under a connector.
           *
           * **A connector only between a root and its own replies** (founder, 2026-11-22,
           * the "Feed & Comments (Refined)" concept): a thin rule down from the root's
           * avatar that the replies hang from. Indentation alone did not carry it — an
           * answer posted as a new comment and a reply looked one step apart. Independent
           * top-level comments are *not* joined to each other: they are separated by space
           * alone. No card, no shadow, no rule between threads.
           */
          <View
            key={thread.root.id}
            testID={`comment-thread-${thread.root.id}`}
            style={index > 0 && styles.threadGap}
            onLayout={measured('threads', thread.root.id)}
          >
            <CommentRow {...rowProps(thread.root)} />
            {thread.replies.length > 0 ? (
              <View
                testID={`comment-replies-${thread.root.id}`}
                style={styles.replies}
                onLayout={measured('replies', thread.root.id)}
              >
                {thread.replies.map((reply) => (
                  // The same row. A reply is not a different kind of thing, and a second
                  // component for it is a second place to get masking wrong.
                  <View key={reply.id} onLayout={measured('rows', reply.id)}>
                    <CommentRow {...rowProps(reply)} isReply />
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </>
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
          ref={list}
          // Grown with the sheet when it is swiped up (`Sheet` `draggable`): the cap is
          // for the sheet's content height, not for a sheet the reader asked to be tall.
          style={[styles.list, sheetExpanded && styles.listExpanded]}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
        >
          {conversation}
        </ScrollView>
      ) : (
        <View style={styles.flow} onLayout={measuredContainer}>
          {conversation}
        </View>
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop editing"
              onPress={reset}
            >
              <Text variant="caption" tone="action">
                Cancel
              </Text>
            </Pressable>
          </View>
        ) : replyingTo && target ? (
          /**
           * **The reply indicator** (founder, 2026-11-22): one line above the SAME input —
           * there is one composer, and Reply only changes what it says. It tells the reader
           * what they are writing (a reply) and to whom (the person they tapped — on a
           * reply-to-a-reply that is the reply's author, never the thread's). Just "Replying
           * to {Name}" since 2026-11-24: the founder found "· under their comment" / "· in
           * X's thread" explained the threading instead of the reply; the row being answered
           * is marked in the list, which says where. Its ✕ is the Cancel: back to "Add a
           * comment" / Post.
           *
           * **When the comment being answered has gone** — deleted, or its author no longer
           * visible to this reader, deliberately one sentence for all of them — the same
           * indicator says so instead, Reply is disabled, and the words stay in the box.
           * Its ✕ then returns to Add a comment *keeping* the words, so posting them as a
           * new comment is the ordinary Post, pressed on purpose. Nothing is ever re-aimed
           * at the top level without the reader asking, and there is no second button.
           */
          <View
            style={styles.banner}
            accessibilityLiveRegion={targetUnavailable ? 'polite' : 'none'}
          >
            {targetUnavailable ? (
              <Text variant="caption" tone="secondary" style={styles.bannerCopy}>
                {target.authorName}’s comment is no longer available. Tap ✕ to post yours as a
                new comment.
              </Text>
            ) : (
              <Text
                variant="caption"
                tone="secondary"
                numberOfLines={2}
                style={styles.bannerCopy}
              >
                Replying to{' '}
                <Text variant="caption" style={styles.bannerName}>
                  {target.authorName}
                </Text>
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                targetUnavailable
                  ? 'Dismiss, keep your text'
                  : `Cancel reply to ${target.authorName}`
              }
              accessibilityHint={
                targetUnavailable
                  ? 'Returns to adding a new comment, with your text still in the box'
                  : 'Returns to adding a new comment'
              }
              onPress={targetUnavailable ? keepAsNewComment : reset}
              hitSlop={dismissSlop}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Ionicons name="close" size={theme.layout.icon.sm} color={theme.text.secondary} />
            </Pressable>
          </View>
        ) : null}

        {/* "Your comment" while editing rather than "Edit your comment", which is the
            row button's label — two controls answering to one label is ambiguous to a
            screen reader, and it is the row's button that performs the *action*. The
            same reasoning gives a reply "Your reply to Anna" rather than the row's
            "Reply to Anna". Every mode is in the label, so it is never only visual. */}
        <TextInput
          ref={input}
          accessibilityLabel={
            editing
              ? 'Your comment'
              : replyingTo && target
                ? `Your reply to ${target.authorName}`
                : 'Add a comment'
          }
          accessibilityHint={
            editing
              ? 'Editing your comment'
              : replyingTo && target
                ? `A reply to ${target.authorName}`
                : 'A new comment on this activity, not a reply'
          }
          placeholder={
            editing
              ? 'Edit your comment'
              : replyingTo && target
                ? `Reply to ${target.authorName}…`
                : 'Add a comment'
          }
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
          {allowSpoilers ? (
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
          ) : null}

          {/* Only once it is close enough to matter. A counter that is always there
              turns a remark into a form. */}
          {draft.length > COMMENT_MAX_LENGTH - 100 ? (
            <Text variant="caption" tone={over ? 'action' : 'tertiary'}>
              {COMMENT_MAX_LENGTH - draft.length}
            </Text>
          ) : null}

          <Button
            label={editing ? 'Save' : replyingTo ? 'Reply' : 'Post'}
            accessibilityHint={
              editing
                ? 'Saves your edit'
                : replyingTo && target
                  ? `Posts your reply to ${target.authorName}`
                  : 'Posts a new comment'
            }
            onPress={() => void submit()}
            disabled={!draft.trim() || over || busy || targetUnavailable}
            disabledReason={
              targetUnavailable
                ? 'The comment you were replying to is gone.'
                : over
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
  marked = false,
  onPressAuthor,
  onPressMention,
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
  /** The comment being replied to, or the one a notification opened at. */
  marked?: boolean;
  onPressAuthor: () => void;
  /** A name inside the body. Takes the handle, because that is what the text names. */
  onPressMention: (username: string) => void;
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
      <View
        style={[
          styles.row,
          isReply && styles.replyRow,
          styles.tombstone,
          marked && styles.marked,
        ]}
      >
        <Text variant="caption" tone="tertiary">
          Comment deleted
        </Text>
      </View>
    );
  }

  return (
    <View
      testID={`comment-row-${comment.id}`}
      style={[styles.row, isReply && styles.replyRow, marked && styles.marked]}
    >
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
          // The ledger, not a re-parse of the body: `activity_comments` has already
          // decided who this comment names and which of them this reader may be shown.
          // A handle that is not in here — a stranger, somebody blocked, anybody at all
          // on a tombstone — stays ordinary text, which is the safe direction.
          mentions={comment.mentions}
          onPressMention={onPressMention}
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
              accessibilityHint="Tells whoever runs bingd about this comment"
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

/** The same floor for the indicator's ✕, which is an icon rather than a line of text. */
const dismissSlop = (theme.layout.minTapTarget - theme.layout.icon.sm) / 2;

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
  listExpanded: { flexGrow: 1, maxHeight: '100%' },
  listContent: { paddingBottom: theme.space[3] },
  flow: { paddingBottom: theme.space[2] },
  pad: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[3] },
  row: {
    flexDirection: 'row',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
  },
  // Between two threads: space, and only space — a top-level comment is not connected to
  // the one before it.
  threadGap: { marginTop: theme.space[2] },
  seeAll: {
    alignSelf: 'flex-start',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  /**
   * The replies, hung from a thin rule that drops from the centre of the root's avatar —
   * one level, and one level only. `marginLeft` puts the 2pt rule's centre on the avatar's
   * centre (gutter + half of `sm`), so the connector visibly comes *from* the comment
   * answered. At 320pt the reply's text column is still ~215pt wide.
   */
  replies: {
    marginLeft: theme.layout.gutter + theme.layout.avatar.sm / 2 - 1,
    borderLeftWidth: 2,
    borderLeftColor: theme.border.hairline,
    marginBottom: theme.space[2],
  },
  // Inside the connector the row's own left gutter is the gap from the rule, and a reply
  // sits a little tighter vertically than a root so a thread reads as one block.
  replyRow: { paddingLeft: theme.space[3], paddingVertical: theme.space[2] },
  // The comment being replied to, or the one a notification opened at: a quiet well in
  // the existing sunken surface, no border and no shadow.
  marked: { backgroundColor: theme.surface.sunken },
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
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space[3],
  },
  bannerCopy: { flex: 1 },
  bannerName: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
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
