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
}: {
  value: string;
  /** "Note". One field, one name; whether it is shared is the chip's job to say. */
  label: string;
  onChangeText: (next: string) => void;
  onBlur: () => void;
}) {
  return (
    <TextInput
      accessibilityLabel={label}
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
          icon={spoilers ? 'eye-off' : 'eye-off-outline'}
          label="Contains spoilers"
          on={spoilers}
          accessibilityLabel="This note contains spoilers"
          onToggle={() => onSpoilers(!spoilers)}
        />
        <ToggleChip
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

const styles = StyleSheet.create({
  noteClaims: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
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
