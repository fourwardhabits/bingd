import { Sheet } from '@/ui/components';

import { CommentThread } from './CommentThread';

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
    <Sheet visible onClose={onClose} label="Comments">
      <CommentThread
        eventId={eventId}
        mediaItemId={mediaItemId}
        title={title}
        viewerId={viewerId}
        watched={watched}
        onPressPerson={onPressPerson}
        scroll="own"
      />
    </Sheet>
  );
}
