import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { ArchivePreview } from './read-archive';
import type { ImdbPreview } from './read-imdb';
import { isImdbPreview, type ImportPreview } from './use-import';

/** "1 movie", "2 movies". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * **The approved preflight fallback (J5).** Before an import there is no truthful source for
 * how many titles will go unmatched without rewriting the trusted matcher, so the preview
 * names no number and says where the answer will be. Never approximated.
 */
export const FALLBACK_LINE = 'Anything we can’t match will be listed after the import.';

/** The IMDb preview's notes, each only when it has something to say. Exported for tests. */
export const tvNote = (shows: number) =>
  `We’ll look for your ${plural(shows, 'rated TV show', 'rated TV shows')}, but TV shows from IMDb aren’t added yet.`;
export const episodeNote = (episodes: number) =>
  `${plural(episodes, 'TV episode', 'TV episodes')} won’t come in because bingd doesn’t track single episodes.`;
export const otherNote = (other: number) =>
  other === 1
    ? '1 title won’t come in because bingd doesn’t track that kind of title.'
    : `${other} titles won’t come in because bingd doesn’t track those kinds of titles.`;

/**
 * *Ready to import*: what the chosen file holds, from the parse on this phone, before
 * anything is sent (IMP1113-UI §B).
 *
 * **Parse counts only.** Every number here is the reader's (`normaliseImdb`,
 * `normaliseArchive`); none is a guess at what the server will do with it. That is why
 * there is no *Unmatched* row (J5, above), no *Ratings* row (a rating is provenance and
 * never a score, so counting them invited the reading that they would become one), and no
 * *Not supported* row (an episode and a game are not supported for different reasons, and
 * each gets its own sentence instead).
 *
 * IMDb's card is one row, *Movies*: the distinct movie-kind titles (films, TV movies,
 * videos, shorts, specials). TV shows are not a row because none is added this release;
 * when the file has some, one sentence says they will be looked for and not added.
 */
export function PreviewSummary({
  preview,
  onStart,
  onReset,
  exit,
}: {
  preview: ImportPreview;
  onStart: () => void;
  onReset: () => void;
  /** The onboarding step's *Not now*. */
  exit?: ReactNode;
}) {
  return (
    <View style={styles.block} testID="import-preview">
      <View style={styles.words}>
        <Text variant="display" accessibilityRole="header">
          Ready to import
        </Text>
        <Text variant="body" tone="secondary">
          Here’s what we found.
        </Text>
      </View>

      {isImdbPreview(preview) ? (
        <ImdbFound preview={preview} />
      ) : (
        <ArchiveFound preview={preview} />
      )}

      <Note>{FALLBACK_LINE}</Note>

      <View style={styles.actions}>
        <Button label="Import" onPress={onStart} testID="import-start" />
        {exit}
        {/* Quiet and centred, as *Keep Show* under *Update Show* (LogSheet): the filled
            act is the point of the page, this is the way back to the picker. `sm` is drawn
            at the compact height and the slop returns it to the 44pt target. */}
        <View style={styles.quiet}>
          <Button
            label="Choose a different file"
            kind="tertiary"
            tone="secondary"
            size="sm"
            hitSlop={QUIET_SLOP}
            onPress={onReset}
            testID="import-choose-again"
          />
        </View>
      </View>
    </View>
  );
}

/** `sm`'s visible height back up to the 44pt target, top and bottom (LogSheet's `KEEP_SLOP`). */
export const QUIET_SLOP = {
  top: (theme.layout.minTapTarget - theme.layout.control.compactAction.visibleHeight) / 2,
  bottom: (theme.layout.minTapTarget - theme.layout.control.compactAction.visibleHeight) / 2,
} as const;

function ImdbFound({ preview }: { preview: ImdbPreview }) {
  const { counts } = preview.normalised;
  const unread = counts.malformed + counts.invalidIds;
  return (
    <>
      <View style={styles.card}>
        <Stat label="Movies" value={counts.movies} />
      </View>
      {counts.tvShows > 0 ? <Note>{tvNote(counts.tvShows)}</Note> : null}
      {counts.episodes > 0 ? <Note>{episodeNote(counts.episodes)}</Note> : null}
      {counts.otherUnsupported > 0 ? <Note>{otherNote(counts.otherUnsupported)}</Note> : null}
      {counts.damaged || unread > 0 ? (
        <Note warning>
          {counts.damaged
            ? 'Part of your file couldn’t be read, so some titles may be missing. Everything we could read is here.'
            : `${plural(unread, 'row', 'rows')} couldn’t be read, so we skipped ${unread === 1 ? 'it' : 'them'}.`}
        </Note>
      ) : null}
    </>
  );
}

function ArchiveFound({ preview }: { preview: ArchivePreview }) {
  const { counts } = preview.normalised;
  return (
    <>
      <View style={styles.card}>
        <Stat label="Movies" value={counts.watched} />
        {counts.watchlist > 0 ? <Stat label="Watchlist" value={counts.watchlist} /> : null}
        {counts.watches > 0 ? <Stat label="Diary entries" value={counts.watches} /> : null}
      </View>
      {/* Only shown when there is something to say. A permanent "0 couldn't be read" line
          teaches people to ignore the place a real warning would appear. */}
      {counts.malformed > 0 || counts.damagedFiles > 0 ? (
        <Note warning>
          {counts.damagedFiles > 0
            ? `${counts.damagedFiles === 1 ? 'One file' : `${counts.damagedFiles} files`} in your ZIP couldn’t be read, so we skipped ${counts.damagedFiles === 1 ? 'it' : 'them'}. Everything else is here.`
            : `${counts.malformed} ${counts.malformed === 1 ? 'entry' : 'entries'} couldn’t be read, so we skipped ${counts.malformed === 1 ? 'it' : 'them'}.`}
        </Note>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text variant="body" style={styles.statLabel}>
        {label}
      </Text>
      <Text variant="headline">{value}</Text>
    </View>
  );
}

/**
 * One footnote with its glyph: information, or (`warning`) something was skipped.
 *
 * A warning reads one step louder (`secondary` ink and glyph) and is announced as one
 * (*Warning, …*), because the glyph is the only other thing that says so and a screen
 * reader does not read glyphs.
 */
export function Note({ children, warning = false }: { children: string; warning?: boolean }) {
  return (
    <View
      style={styles.note}
      accessible={warning || undefined}
      accessibilityLabel={warning ? `Warning, ${children}` : undefined}
    >
      <Ionicons
        name={warning ? 'alert-circle-outline' : 'information-circle-outline'}
        size={theme.layout.icon.sm}
        color={warning ? theme.text.secondary : theme.text.tertiary}
      />
      <Text
        variant="footnote"
        tone={warning ? 'secondary' : 'tertiary'}
        style={styles.noteText}
      >
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[4] },
  words: { gap: theme.layout.section.headingToControls },
  card: {
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    padding: theme.layout.cardPadding,
    gap: theme.space[3],
  },
  stat: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  statLabel: { flex: 1 },
  note: { flexDirection: 'row', gap: theme.space[2], alignItems: 'flex-start' },
  noteText: { flex: 1 },
  actions: { gap: theme.space[2], marginTop: theme.space[2] },
  quiet: { alignItems: 'center' },
});
