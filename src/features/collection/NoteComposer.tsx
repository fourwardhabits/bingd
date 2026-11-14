import { StyleSheet, TextInput, View } from 'react-native';

import { Text, ToggleChip } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { NoteVisibility } from './writes';

/**
 * The one note composer, and the reason it is a file rather than a block inside `LogSheet`.
 *
 * Founder decision, 2026-09-25: *"The Note experience should be consistent anywhere the user
 * creates/edits the note associated with a watch — initial log/rank, Another watch, Watch
 * History → edit watch."* The two rewatch surfaces had been built against a different object
 * (`watch_events.note`, owner-only by schema), so they drew the field without the claims that
 * make writing publishable. Extracting the composer is what stops that happening a third
 * time: there is now exactly one place the field and its two chips are written down.
 *
 * What it edits is always `user_media.note` — the title's one note, private by default,
 * published only by the explicit chip. `watch_events.note` is untouched and stays owner-only.
 */

/** The field itself. One name, whether or not it is shared — the chip says that. */
export function NoteInput({
  value,
  label,
  onChangeText,
  onBlur,
  editable = true,
}: {
  value: string;
  /** "Note". One field, one name; whether it is shared is the chip's job to say. */
  label: string;
  onChangeText: (next: string) => void;
  onBlur: () => void;
  /** False while the caller's save is in flight, so nothing typed then is dropped. */
  editable?: boolean;
}) {
  return (
    <TextInput
      accessibilityLabel={label}
      editable={editable}
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      multiline
      maxLength={2000}
      placeholder="What did you think?"
      placeholderTextColor={theme.text.tertiary}
      style={styles.noteInput}
    />
  );
}

/**
 * The two claims about a piece of writing, and the line that says what they mean.
 *
 * Both sit with the field they describe rather than in a settings screen, because both are
 * decisions about this piece of writing and are only ever made while writing it.
 *
 * **Publishing is the positive state of "Share as a review", never the absence of a
 * negative.** The control once read "Only me" and was off by default, so the way to keep a
 * note to yourself was to notice a chip and tick it — and the way to publish was to do
 * nothing at all. Naming the act that has consequences is what makes the default safe to
 * leave alone, and it is why no caller may pre-set this to `public` for writing that
 * already exists.
 */
export function NoteClaims({
  visibility,
  spoilers,
  onVisibility,
  onSpoilers,
}: {
  visibility: NoteVisibility;
  spoilers: boolean;
  onVisibility: (next: NoteVisibility) => void;
  onSpoilers: (next: boolean) => void;
}) {
  return (
    <>
      <View style={styles.noteClaims}>
        <ToggleChip
          verticalSlop={FIRST_CHIP_SLOP}
          icon={spoilers ? 'eye-off' : 'eye-off-outline'}
          label="Contains spoilers"
          on={spoilers}
          accessibilityLabel="This note contains spoilers"
          onToggle={() => onSpoilers(!spoilers)}
        />
        <ToggleChip
          verticalSlop={SECOND_CHIP_SLOP}
          icon={visibility === 'public' ? 'people' : 'people-outline'}
          label="Share as a review"
          on={visibility === 'public'}
          accessibilityLabel="Share this note as a public review"
          onToggle={() => onVisibility(visibility === 'public' ? 'private' : 'public')}
        />
      </View>
      <Text variant="caption" tone="tertiary">
        {visibility === 'private'
          ? 'Only you can read this.'
          : spoilers
            ? 'Shown with your rating, hidden until people who have not seen it tap to reveal.'
            : 'Shown with your rating on your profile and in your friends’ feeds.'}
      </Text>
    </>
  );
}

/**
 * **Each claim answers 44pt, on one line or two, and nothing on screen moves** (A11Y-44,
 * design-system v3 A.2 #12).
 *
 * The chips are 32pt and sat in a row with no vertical padding, so RN clipped their slop
 * to the row and they answered 32. Both callers (LogSheet's note and Watch details) put
 * this row in a column with `space[2]` between the field, the row and the caption, and
 * that space was empty. The row now takes it as its own box: `space[2]` of padding above
 * and below, handed back by the same negative margin, so the chips are drawn exactly where
 * they were and the row's box reaches the field above and the caption below without
 * covering either. Requires a parent `gap` of at least `space[2]`, which both have.
 *
 * At 320 and 360pt the two chips do not fit on one line (about 334pt for 328) and wrap,
 * `space[2]` apart. Symmetric slop would cross in that gap, so it is split by place: the
 * first chip takes the row's top padding and half the gap below it, the second half the
 * gap above it and the row's bottom padding. That is 8 + 32 + 4 and 4 + 32 + 8, 44pt each,
 * on one line or two; wrapped, the two meet in the middle of the gap and never cross.
 */
const FIRST_CHIP_SLOP = { top: theme.space[2], bottom: theme.space[1] };
const SECOND_CHIP_SLOP = { top: theme.space[1], bottom: theme.space[2] };

const styles = StyleSheet.create({
  noteClaims: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space[2],
    paddingVertical: theme.space[2],
    marginVertical: -theme.space[2],
  },
  noteInput: {
    minHeight: 88,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.strong,
    backgroundColor: theme.surface.raised,
    padding: theme.space[3],
    textAlignVertical: 'top',
    color: theme.text.primary,
    ...theme.typography.body,
  },
});
