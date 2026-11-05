import { useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { Sheet, SheetDone, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

const SEP = ' · ';

/**
 * How many whole genres fit on one line, leaving room for `+N` when some do not.
 *
 * Pure, so the arithmetic — the part worth being sure of — is tested without a layout
 * engine. `widths` are the genres' own rendered widths; `separator` is ` · `; `plus(n)` is
 * the width of the `+n` control, which grows with the digits it holds.
 *
 * Always at least one: a first genre too long for the line is shown, truncated by the
 * text engine, with `+N` beside it — so nothing is cut without the rest being one tap away.
 */
export function genresThatFit(
  widths: readonly number[],
  available: number,
  separator: number,
  plus: (hidden: number) => number,
): number {
  const total = widths.length;
  if (total <= 1) return total;
  const lineOf = (count: number) =>
    widths.slice(0, count).reduce((sum, width) => sum + width, 0) +
    separator * (count - 1) +
    (count < total ? separator + plus(total - count) : 0);
  for (let count = total; count >= 1; count -= 1) {
    if (lineOf(count) <= available) return count;
  }
  return 1;
}

/**
 * The genres, under the title, on exactly one line (Cinematic Editorial brief, §2).
 *
 *     Science Fiction · Action · +2
 *
 * The metadata row's typography and muted tone, middle dots, no chips. As many whole
 * genres as fit; the rest behind a `+N` that opens them all in a sheet. Measured rather
 * than estimated, so a long name, a narrow screen and a large text size all resolve the
 * same way: by what actually fits. Hidden entirely when the title has no genres.
 *
 * Before the first measurement it draws the whole list on one clamped line, which is the
 * right answer whenever everything fits and a harmless one for a frame when it does not.
 */
export function GenreLine({ genres, titleName }: { genres: readonly string[]; titleName: string }) {
  const [available, setAvailable] = useState(0);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [separator, setSeparator] = useState(0);
  const [digitWidth, setDigitWidth] = useState(0);
  const [open, setOpen] = useState(false);

  if (!genres.length) return null;

  const measured =
    available > 0 &&
    separator > 0 &&
    digitWidth > 0 &&
    genres.every((_, index) => widths[index] !== undefined);
  // `+N` is a `+` and its digits; measured as `+0`, widened per extra digit.
  const plus = (hidden: number) => digitWidth * (String(hidden).length + 1) + PLUS_PAD;
  const shown = measured
    ? genresThatFit(
        genres.map((_, index) => widths[index] as number),
        available,
        separator,
        plus,
      )
    : genres.length;
  const hidden = genres.length - shown;

  const measure = (key: number) => (event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setWidths((was) => (was[key] === width ? was : { ...was, [key]: width }));
  };

  return (
    <View
      testID="genre-line"
      style={styles.frame}
      onLayout={(event) => setAvailable(Math.floor(event.nativeEvent.layout.width))}
    >
      {/* The measuring copies: each genre, the separator and a digit, at the row's own
          type, invisible and out of the flow. */}
      <View style={styles.measure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {genres.map((genre, index) => (
          <Text key={`m-${genre}`} testID={`genre-line-measure-${index}`} variant="footnote" style={styles.nowrap} onLayout={measure(index)}>
            {genre}
          </Text>
        ))}
        <Text testID="genre-line-measure-sep" variant="footnote" style={styles.nowrap} onLayout={(e) => setSeparator(Math.ceil(e.nativeEvent.layout.width))}>
          {SEP}
        </Text>
        <Text testID="genre-line-measure-plus" variant="footnote" style={styles.nowrap} onLayout={(e) => setDigitWidth(Math.ceil(e.nativeEvent.layout.width / 2))}>
          +0
        </Text>
      </View>

      <View style={styles.row}>
        <Text
          testID="genre-line-text"
          variant="footnote"
          tone="secondary"
          numberOfLines={1}
          style={styles.genres}
          accessibilityLabel={
            hidden
              ? `Genres: ${genres.slice(0, shown).join(', ')}, and ${hidden} more`
              : `Genres: ${genres.join(', ')}`
          }
        >
          {genres.slice(0, shown).join(SEP)}
          {/* The dot only: a trailing space is dropped at a clamped line's end, so the
              gap before +N is the control's own margin. */}
          {hidden ? ' ·' : ''}
        </Text>
        {hidden ? (
          <Pressable
            testID="genre-line-more"
            accessibilityRole="button"
            accessibilityLabel={`Show all ${genres.length} genres`}
            onPress={() => setOpen(true)}
            // The row is a footnote tall; the slop takes the target to 44pt.
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={({ pressed }) => [styles.more, pressed && styles.pressed]}
          >
            <Text variant="footnote" tone="action" style={styles.nowrap}>
              {`+${hidden}`}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {open ? (
        <Sheet visible onClose={() => setOpen(false)} label={`Genres of ${titleName}`}>
          <View style={styles.sheet} testID="genre-sheet">
            <Text variant="title2">Genres</Text>
            <Text variant="body" tone="secondary">
              {genres.join(SEP)}
            </Text>
          </View>
          {/* The labelled way out every sheet carries: `Sheet` hides its scrim from
              assistive technology on the understanding that this exists. */}
          <SheetDone onPress={() => setOpen(false)} />
        </Sheet>
      ) : null}
    </View>
  );
}

/** A little space either side of `+N`, so it reads as its own control. */
const PLUS_PAD = 4;

const styles = StyleSheet.create({
  // Clips the measuring copies, which may be wider than the line they are measuring for.
  frame: { overflow: 'hidden' },
  measure: { position: 'absolute', opacity: 0, flexDirection: 'row', left: 0, top: 0 },
  nowrap: { flexShrink: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  genres: { flexShrink: 1 },
  more: { marginLeft: theme.space[1] },
  // `Sheet` does not pad its children; every sheet in the app brings its own gutter.
  sheet: { gap: theme.space[3], paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  pressed: { opacity: 0.7 },
});
