import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

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
}: SpoilerNoteProps) {
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (masked && !revealed) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          titleForLabel
            ? `Contains spoilers for ${titleForLabel}. Show the note.`
            : 'Contains spoilers. Show the note.'
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
        accessibilityLabel={clamp ? 'Show the whole note' : undefined}
        onPress={() => setExpanded(true)}
        disabled={!clamp}
      >
        <Text variant="body" numberOfLines={clamp}>
          {text}
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
  reveal: { marginLeft: 'auto' },
  pressed: { opacity: 0.7 },
});
