import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { segmentMentions } from '@/features/feed/mentions';

import { theme } from '../tokens';
import { Text } from './Text';

export type SpoilerNoteProps = {
  text: string;
  /** The author's own claim. Shown as a quiet marker even when nothing is masked. */
  hasSpoilers?: boolean;
  /** Decided by `shouldMask` in `use-watched.ts`, never inferred here. */
  masked: boolean;
  /** Lines shown when open. Omit for the whole note. */
  numberOfLines?: number;
  /** Names the title in the reveal control, so the button is not a bare "Show". */
  titleForLabel?: string | null;
  /**
   * What this piece of writing is called, for the spoken labels.
   *
   * A review by default, because every social surface this renders on — the feed, a
   * profile, the Reviews tab — is showing writing its author published. The comment
   * sheet passes `'comment'`. It used to say "note" everywhere, which meant a reader
   * inside a tab called Reviews tapped a control announced as "Show the note."
   */
  noun?: string;
  /**
   * Who this piece of writing names, from `activity_comments.mentions` — ids and both
   * spellings, already filtered for this reader by the server.
   *
   * Omit it (every surface but the comment sheet) and the text renders exactly as it did
   * before mentions were visible. Pass it and each confirmed `@handle` becomes a profile
   * link. A handle the server did not confirm stays ordinary text either way.
   */
  mentions?: readonly { id: string; username: string; handle?: string | null }[];
  /** Where a tapped name goes. Without it nothing is a link, however many mentions. */
  onPressMention?: (username: string) => void;
};

/**
 * The only component that renders someone's note text.
 *
 * Every social surface goes through it — the feed, a profile, a title page, any
 * preview — because a spoiler rule applied in four places is a spoiler rule with
 * three chances to be forgotten, and the one that gets forgotten is always a preview.
 *
 * **The masked branch does not render the text at all.** Not clipped to one line, not
 * blurred, not behind an overlay, not with `numberOfLines`. All of those keep the
 * string in the tree, where a screen reader reads it out, a text selection copies it,
 * and a font metric or an accessibility setting can expose a line of it. There is no
 * amount of visual covering that makes leaked text safe, so the text is simply not
 * there until the viewer asks for it.
 *
 * Revealing is local and per-mount. Nothing is written, so it changes what this
 * person sees on this screen and touches neither the author's note nor any record of
 * who has read it.
 */
export function SpoilerNote({
  text,
  hasSpoilers = false,
  masked,
  numberOfLines,
  titleForLabel,
  noun = 'review',
  mentions,
  onPressMention,
}: SpoilerNoteProps) {
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (masked && !revealed) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          titleForLabel
            ? `Contains spoilers for ${titleForLabel}. Show the ${noun}.`
            : `Contains spoilers. Show the ${noun}.`
        }
        onPress={() => setRevealed(true)}
        style={({ pressed }) => [styles.mask, pressed && styles.pressed]}
      >
        <Ionicons
          name="eye-off-outline"
          size={theme.layout.icon.sm}
          color={theme.text.secondary}
        />
        <Text variant="footnote" tone="secondary">
          Contains spoilers
        </Text>
        <Text variant="footnote" tone="action" style={styles.reveal}>
          Show
        </Text>
      </Pressable>
    );
  }

  const clamp = expanded ? undefined : numberOfLines;

  /**
   * Nested `Text`, not `Pressable`, and the choice is load-bearing.
   *
   * A mention sits inside a paragraph, so it has to wrap with the sentence around it —
   * onto the next line where the line ends — and a `Pressable` is a view: it becomes an
   * unbreakable box that pushes itself down and takes the layout with it. A nested
   * `Text` is a run of glyphs that happens to answer a tap, which is what an inline link
   * is.
   *
   * It also keeps the gestures right. The sheet scrolls, and the paragraph below can
   * itself be a "show the whole comment" target; a nested `Text` claims only the glyphs
   * it covers, so a drag that starts on a name still scrolls the thread and a tap
   * anywhere else still expands. Wrapping each name in its own touchable view is how
   * both of those break.
   */
  const body =
    mentions?.length && onPressMention
      ? segmentMentions(text, mentions).map((span, index) =>
          span.kind === 'text' ? (
            span.text
          ) : (
            <Text
              // Position is the only stable key here: the same person can be named twice
              // in one body, and the spans are rebuilt whole whenever the text changes.
              key={`${index}-${span.id}`}
              variant="body"
              tone="action"
              style={styles.mention}
              accessibilityRole="link"
              // The `@` is punctuation to a screen reader, and "at ravi" is not what the
              // control does. The name and the destination, in that order.
              accessibilityLabel={`${span.username}, open profile`}
              onPress={() => onPressMention(span.username)}
              suppressHighlighting
            >
              {span.text}
            </Text>
          ),
        )
      : text;

  return (
    <View style={styles.note}>
      {/* Kept after revealing, and shown to the author too. The claim is part of
          what the note says about itself, not merely the lock on the door.

          The same three words the mask above uses, and the same three the ranking
          sheet, the note control and the comment composer use. One word was a
          category; three are the claim the author actually made, and the founder's
          correction is that all four places should say it identically. */}
      {hasSpoilers ? (
        <View style={styles.marker}>
          <Ionicons name="eye-off" size={theme.layout.icon.sm} color={theme.text.tertiary} />
          <Text variant="caption" tone="tertiary">
            Contains spoilers
          </Text>
        </View>
      ) : null}
      <Pressable
        accessibilityRole={clamp ? 'button' : undefined}
        accessibilityLabel={clamp ? `Show the whole ${noun}` : undefined}
        onPress={() => setExpanded(true)}
        disabled={!clamp}
      >
        <Text variant="body" numberOfLines={clamp}>
          {body}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  note: { gap: theme.space[1] },
  marker: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  mask: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.sunken,
  },
  /**
   * Weight only. The colour is `tone="action"` — the maroon every other inline action in
   * the app uses — and there is no underline, because this design language does not
   * underline anything. The accent is the affordance, as it is on "Show" above.
   */
  mention: { fontWeight: '600' },
  reveal: { marginLeft: 'auto' },
  pressed: { opacity: 0.7 },
});
