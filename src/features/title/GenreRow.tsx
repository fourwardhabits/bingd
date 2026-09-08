import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';
import { Chip, Sheet, Text } from '@/ui/components';

export type GenreRowProps = {
  /** In the catalogue's own order, which is TMDB's primary-first ordering. */
  genres: string[];
};

/**
 * How many chips are ever drawn, before measurement narrows it further.
 *
 * A ceiling rather than the answer: measurement decides how many actually fit, and this
 * only stops a title with eleven genres from mounting eleven chips to hide nine of them.
 * Four is one more than has ever fitted on a 360pt screen, so it can never be the
 * binding constraint on a real device.
 */
const MAX_CANDIDATES = 4;

/**
 * One row of genres, with `+N` on the same line — always (founder, physical Android,
 * 2026-09-07).
 *
 * **The bug this replaces.** The page drew a fixed three chips and then `+N`, inside a
 * wrapping container. Three chips fit at some widths and not others, so on Dan Da Dan —
 * `Anime`, `Action & Adventure`, `Comedy` — the third chip fitted and `+1` did not, and
 * the overflow marker wrapped onto a line of its own. A count that says "there is more"
 * is worth nothing if stating it costs the row it was invented to save.
 *
 * **So the count is measured rather than assumed.** The chips lay out on one unwrapped
 * line, each reports its width, and the row keeps as many as fit in the space left after
 * reserving room for the marker. Dan Da Dan comes out `[Anime] [Action & Adventure]
 * [+2]` — two genres and an honest count — instead of three genres and a wrapped `+1`.
 *
 * Measuring rather than estimating from character counts, because the font is not
 * monospaced and the user's text size is theirs to set: an estimate that is right at the
 * default size is a wrapped row at 130%.
 *
 * **Every visible chip opens the full list, and so does `+N`.** The founder's rule: the
 * row is a summary of one fact, so every part of it leads to the whole of that fact.
 * Tapping a genre has never filtered anything from this page and does not start now —
 * there is no filtered view of a single title to go to.
 */
export function GenreRow({ genres }: GenreRowProps) {
  const [open, setOpen] = useState(false);
  /** The row's inner width, once laid out. Null on the first pass. */
  const [available, setAvailable] = useState<number | null>(null);
  /** Each candidate chip's measured width, by index. */
  const [widths, setWidths] = useState<Record<number, number>>({});

  if (!genres.length) return null;

  const candidates = genres.slice(0, MAX_CANDIDATES);
  const measured = candidates.every((_, index) => widths[index] != null);

  /**
   * How many chips fit.
   *
   * Before measurement, one — the narrowest honest guess, and the only count that cannot
   * overflow any width this app supports. It is visible for a single frame, and showing
   * one chip that then becomes three is a smaller lie than showing three that wrap.
   *
   * Room for the marker is reserved whenever there is anything left over, because that
   * is exactly when it will be drawn. `MARKER_WIDTH` is deliberately generous: reserving
   * a little too much costs at most one chip, and reserving too little costs the wrap
   * this component exists to prevent.
   */
  const shownCount = (() => {
    if (!measured || available == null) return 1;
    let used = 0;
    let count = 0;
    for (const [index] of candidates.entries()) {
      const next = used + (widths[index] ?? 0) + (count > 0 ? theme.space[2] : 0);
      // Everything after this one, plus the genres this component never mounted.
      const remaining = genres.length - (count + 1);
      const reserve = remaining > 0 ? MARKER_WIDTH + theme.space[2] : 0;
      if (next + reserve > available) break;
      used = next;
      count += 1;
    }
    // At least one, even where a single genre is wider than the row: a chip that
    // truncates says more than an empty line does.
    return Math.max(1, count);
  })();

  const shown = candidates.slice(0, shownCount);
  const hidden = genres.length - shown.length;

  return (
    <>
      {/**
       * The measuring pass, and the reason it has to exist.
       *
       * A row can only measure what it renders, so a row that renders what it has
       * measured can never grow past its first guess — it would sit at one chip for ever,
       * because chips two and three were never mounted to be measured. This layer mounts
       * every candidate at its natural width, off the layout flow and invisible, purely
       * to answer "how wide is this chip".
       *
       * Absolutely positioned so it takes no height, transparent so it is never seen, and
       * hidden from assistive technology so the same four genres are not announced twice.
       * It unmounts the moment the answers are in.
       */}
      {!measured ? (
        <View
          style={styles.measure}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {candidates.map((genre, index) => (
            <View
              key={genre}
              testID={`genre-measure-${index}`}
              onLayout={(event) => {
                /**
                 * **Read the event now. Never inside the updater.**
                 *
                 * This is the title-page crash — `TypeError: Cannot read property 'layout'
                 * of null`, named off the founder's device on 2026-09-07 after weeks as an
                 * unnamed boundary. React Native pools synthetic events: once the handlers
                 * for an event have run it is released, and `SyntheticEvent.destructor()`
                 * sets `nativeEvent` to null. A functional `setState` updater does not run
                 * in the handler — React runs it later, during render, whenever it cannot
                 * compute it eagerly, which is exactly when another update is already
                 * queued on this component. So the first chip's width was read while the
                 * event was alive and every later chip's was read off a destroyed one: one
                 * genre never crashed, two or more crashed whenever their layouts landed
                 * in a batch. Thrown during render, it reached the error boundary and not
                 * the red box, which is the "loads for a moment, then the apology" the
                 * founder saw.
                 *
                 * The updater closes over a number now. `GenreRow.test.tsx` reproduces the
                 * failure's own shape and keeps it from coming back.
                 */
                const { width } = event.nativeEvent.layout;
                setWidths((current) =>
                  current[index] != null ? current : { ...current, [index]: width },
                );
              }}
            >
              <Chip label={genre} />
            </View>
          ))}
        </View>
      ) : null}

      <View
        testID="genre-row"
        style={styles.row}
        onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}
      >
        {shown.map((genre) => (
          <Pressable
            key={genre}
            accessibilityRole="button"
            accessibilityLabel={`${genre}. See all genres`}
            onPress={() => setOpen(true)}
            // A 32pt chip answering a 44pt thumb, the same way every chip row does.
            hitSlop={theme.layout.chipHitSlop}
          >
            <Chip label={genre} />
          </Pressable>
        ))}

        {/**
         * The overflow, on the same line by construction.
         *
         * Not a chip: it is a count rather than a genre, and a reader must not be able to
         * mistake `+2` for something a title is. It is a control, though — the founder's
         * rule is that every part of the row opens the same list.
         */}
        {hidden > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`And ${hidden} more ${hidden === 1 ? 'genre' : 'genres'}. See all genres`}
            onPress={() => setOpen(true)}
            // As tall as the chips beside it, then the chips' own slop — so the marker
            // meets the 44pt target the same way they do, and its slop no longer
            // crosses into the last chip's.
            hitSlop={theme.layout.chipHitSlop}
            style={styles.markerControl}
          >
            <Text variant="footnote" tone="tertiary" style={styles.marker}>
              {`+${hidden}`}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* The whole list, in the app's one sheet. Read-only: this is the rest of a fact
          the row summarised, not a set of controls — nothing here filters a page that is
          already about one title.

          **Mounted only while open**, which is what every other sheet on the title page
          already does and this one did not. `Sheet` is a React Native `<Modal>`, and a
          `<Modal>` that is merely `visible={false}` is still a mounted native dialog host
          — here, one sitting inside the page's `ScrollView`, on every title page in the
          app, permanently, for a list nobody had asked to see. It also kept a pair of
          `Keyboard` listeners alive through `useKeyboardHeight` for a sheet with no text
          field in it. Nothing is lost by mounting on demand: the sheet holds no state
          worth preserving between openings. */}
      {open ? (
        <Sheet visible onClose={() => setOpen(false)} label="All genres">
          <View style={styles.sheet}>
            <Text variant="title2">Genres</Text>
            <View style={styles.sheetChips}>
              {genres.map((genre) => (
                <Chip key={genre} label={genre} />
              ))}
            </View>
          </View>
        </Sheet>
      ) : null}
    </>
  );
}

/**
 * The space `+N` is allowed to need, reserved before the chips are counted.
 *
 * A fixed number rather than a measurement, because the marker's width can only be known
 * after deciding whether to draw it, and that is the decision it would be feeding. It is
 * sized for `+99` at 130% text — far past any real genre list — so the reservation is
 * always sufficient and at worst costs one chip on a title with a very long third genre.
 */
const MARKER_WIDTH = 34;

const styles = StyleSheet.create({
  /**
   * `nowrap` is the whole mechanism: it is what makes the chips lay out on one line so
   * their widths can be read, and it is what guarantees the marker can never be pushed
   * onto a second one. `hidden` catches the single frame before measurement lands.
   */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    overflow: 'hidden',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    // Breathing room under the synopsis, which this row follows directly (founder,
    // physical Android, 2026-09-07). The chips sat on the paragraph's last line. Twelve
    // points keeps them associated with it — the genres are the paragraph's footnote —
    // without becoming a section break.
    paddingTop: theme.space[3],
  },
  /** Off the flow and invisible: it exists to be measured, never to be seen. */
  measure: {
    position: 'absolute',
    opacity: 0,
    top: 0,
    left: 0,
    flexDirection: 'row',
    gap: theme.space[2],
  },
  marker: { minWidth: theme.space[4] },
  markerControl: { minHeight: theme.layout.control.chipHeight, justifyContent: 'center' },
  sheet: { gap: theme.space[4], paddingBottom: theme.space[4] },
  sheetChips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
});
