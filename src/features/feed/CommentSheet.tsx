import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet } from 'react-native';

import { Sheet, SheetHeader } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { CommentThread } from './CommentThread';

export type CommentSheetProps = {
  /** The event whose comments these are. Null closes the sheet. */
  eventId: string | null;
  /** What the event is about, for spoiler masking. Never the parent series. */
  mediaItemId: string | null;
  /** The full display title, for the reveal control's label. */
  title: string | null;
  /** See `CommentThreadProps.allowSpoilers`. */
  allowSpoilers?: boolean;
  viewerId: string;
  /** Which exact media items the viewer has watched — `useWatched`'s answer. */
  watched: Set<string> | undefined;
  onClose: () => void;
  onPressPerson: (username: string) => void;
};

/**
 * The Feed's comments icon, unchanged as an interaction and now a wrapper.
 *
 * **The sheet stays a sheet**, which is the founder's explicit instruction for this pass:
 * a comment *notification* opens the dedicated thread page, and the comments *button* on
 * a feed card goes on opening this. They are different acts. Tapping the icon is "let me
 * see what people said about this without losing my place in the feed"; tapping a
 * notification is "somebody said something to me", and that deserves a screen with the
 * activity above it and a back gesture.
 *
 * Everything that was in this file is now in `CommentThread`, which the page renders too.
 * What is left here is the presentation: a `Sheet`, and the height cap that makes the
 * conversation scroll inside it. That split is the whole point — see that file's header
 * on what a second copy would have drifted on.
 */
export function CommentSheet({
  eventId,
  mediaItemId,
  title,
  allowSpoilers,
  viewerId,
  watched,
  onClose,
  onPressPerson,
}: CommentSheetProps) {
  // Before the `Sheet`, because `visible` is unconditional below: the sheet's own
  // presence is what `eventId` controls, and rendering a visible sheet with nothing in it
  // would animate an empty panel up whenever the feed closed one.
  if (!eventId) return null;

  return (
    /**
     * **Swipe and an obvious way out** (founder iPhone QA, 2026-11-24). The sheet opens at
     * its content's height; dragging the top edge up grows it to the standard 85% for a long
     * conversation, and dragging down — or the ✕ beside the title, or Android Back, or the
     * backdrop — closes it. iOS has no Back, so the ✕ is always there. Closing never posts
     * and never loses words: an unsent draft is kept for this activity (`keepDraft`).
     */
    <Sheet
      visible
      onClose={onClose}
      label="Comments"
      draggable
      header={
        <SheetHeader
          title="Comments"
          accessory={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close comments"
              onPress={onClose}
              hitSlop={(theme.layout.minTapTarget - theme.layout.icon.md) / 2}
              style={({ pressed }) => pressed && styles.pressed}
              testID="comment-sheet-close"
            >
              <Ionicons name="close" size={theme.layout.icon.md} color={theme.text.secondary} />
            </Pressable>
          }
        />
      }
    >
      <CommentThread
        keepDraft
        eventId={eventId}
        mediaItemId={mediaItemId}
        title={title}
        allowSpoilers={allowSpoilers}
        viewerId={viewerId}
        watched={watched}
        onPressPerson={onPressPerson}
        scroll="own"
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
});
