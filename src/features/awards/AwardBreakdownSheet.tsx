import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { avatarUri, posterUri } from '@/lib/images';
import { Button, EmptyState, Sheet, Text, TitleRow, UserRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { AwardProgress } from './progress';
import type { Breakdown, BreakdownRow } from './tracks';

/**
 * How many rows are mounted before the reader asks for more.
 *
 * **The cap is on what is *mounted*, not on what is scrollable.** `maxHeight: 380` below
 * bounds the viewport and nothing else: a `ScrollView` mounts every child it is given, so
 * before this cap existed, opening Movie Muncher on a collection at its gold tier mounted
 * **a thousand `TitleRow`s and started a thousand poster requests** in one frame. That is
 * the founder's stated worst case (1,000 movies, 500 ranked titles) and it is a
 * multi-second freeze on a mid-range Android for a sheet nobody scrolls to the bottom of.
 *
 * Fifty is about seven viewports of scrolling — far enough that reaching the button is a
 * deliberate act, small enough that the mount is cheap.
 *
 * **Not virtualisation, deliberately.** `FlashList` is already a dependency and would be
 * the right answer for a screen; inside a `Modal`, in a container whose height is a
 * `maxHeight` rather than a fixed one, it needs a definite height to measure against, and
 * getting that wrong is a blank sheet. This is a release-hardening pass with no physical
 * iOS validation behind it, so the fix that cannot regress the layout wins over the one
 * that is theoretically neater.
 *
 * **The award's number is untouched by any of this.** `breakdownTotal` is computed from
 * `contributions` in `tracks.ts`, not from what this component draws, so revealing rows
 * in pages cannot put the sheet out of step with the badge above it — the invariant test
 * in `awards.test.ts` measures the data, not the render.
 */
const PAGE = 50;

export type AwardBreakdownSheetProps = {
  award: AwardProgress;
  /** The rows behind the number, from the same call that produced it. */
  breakdown: Breakdown;
  onPressTitle?: (mediaItemId: string) => void;
  onPressProfile?: (username: string) => void;
  onClose: () => void;
};

/**
 * What an award's number is made of.
 *
 * **The founder's principle, and it is about trust rather than navigation.** If Bingd
 * shows somebody `10 / 14`, they are entitled to see what the ten are. A count of your
 * own life that you cannot enumerate is a claim you have to take on faith, and the first
 * thing anybody does with a number they doubt is try to check it.
 *
 * So all twenty rows open one of these — not twelve, as in the first pass. The seven
 * that count people, writing and reactions get the same sheet with different rows,
 * rather than a bespoke screen each.
 *
 * **One shape for every award.** Titles, people and genres are all `BreakdownRow`, and
 * this decides how to draw one from which fields it carries: a poster makes it a title,
 * an avatar makes it a person, neither makes it a plain line. Three row components would
 * be three ways for a breakdown to stop matching its number.
 *
 * **The numbers here are the award's own.** `breakdown` comes from
 * `progress.breakdownFor`, which calls the same `contributions` the metric is measured
 * from — there is no second query and therefore nothing to drift.
 *
 * **Read-only, always.** Nothing here edits, removes or excludes: a "don't count this
 * one" control would be a rule living in a sheet, invisible to every other surface that
 * counts the same things. The way to change what is in the list is to change the thing
 * it came from, and every row that can leads there.
 *
 * **Privacy is the reads', not this component's.** A person who is hidden, suspended or
 * gone arrives as a row with no handle and no link (`use-awards.ts`, `personFrom`), so
 * the count stays honest without disclosing anything about them.
 */
export function AwardBreakdownSheet({
  award,
  breakdown,
  onPressTitle,
  onPressProfile,
  onClose,
}: AwardBreakdownSheetProps) {
  const total = breakdown.sections.reduce((sum, section) => sum + section.rows.length, 0);
  const [shown, setShown] = useState(PAGE);

  /**
   * The revealed prefix, spent across the sections in order.
   *
   * Sections are kept rather than flattened because Two-Screen Life's two halves are the
   * explanation of its arithmetic — losing the headings would cost the one thing that
   * sheet exists to show. A section past the budget draws nothing at all, including its
   * heading: a bare "TV" label with no rows under it reads as "you have none",
   * which is a different and false claim.
   */
  const visible = useMemo(
    () =>
      breakdown.sections.map((section, index) => {
        // Each section's own share of the budget, from how many rows precede it. A
        // running counter reassigned inside the map would be the shorter spelling and
        // the React Compiler rejects it — correctly, since a memo body that mutates a
        // closure variable is not safe to re-run. Quadratic in the number of *sections*,
        // of which no award has more than two.
        const before = breakdown.sections
          .slice(0, index)
          .reduce((sum, earlier) => sum + earlier.rows.length, 0);
        return { section, rows: section.rows.slice(0, Math.max(0, shown - before)) };
      }),
    [breakdown.sections, shown],
  );

  const remaining = total - Math.min(shown, total);

  return (
    <Sheet visible onClose={onClose} label={`What counts toward ${award.title}`}>
      <View style={styles.head}>
        <Text variant="title2">{award.title}</Text>
        {/* The award's own progress line and nothing else. Repeating the description
            would be the sheet explaining what the row above it already said. */}
        <Text variant="footnote" tone="secondary">
          {award.unavailable ? award.detailLine : `${award.countLabel} · ${award.detailLine}`}
        </Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {total === 0 ? (
          <View style={styles.empty}>
            <EmptyState
              kind="nothingYet"
              compact
              title={breakdown.emptyLabel}
              body="Nothing is counting toward this one yet."
            />
          </View>
        ) : (
          <>
            {visible.map(({ section, rows }, index) =>
              // A section wholly past the budget is omitted rather than drawn empty.
              rows.length === 0 && section.rows.length > 0 ? null : (
                <View key={section.label ?? `section-${index}`}>
                  {/* Only where an award genuinely has two halves — Two-Screen Life. The
                      value beside the label is that side's own cap, which is what makes
                      the capped arithmetic self-evident without a paragraph about it. */}
                  {section.label ? (
                    <View style={styles.sectionHead}>
                      <Text variant="footnote" tone="secondary" style={styles.sectionLabel}>
                        {section.label}
                      </Text>
                      {section.value ? (
                        <Text variant="footnote" tone="secondary">
                          {section.value}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}

                  {section.rows.length === 0 && section.label ? (
                    <Text variant="footnote" tone="tertiary" style={styles.sectionEmpty}>
                      Nothing on this side yet.
                    </Text>
                  ) : null}

                  {rows.map((row) => (
                    <Row
                      key={row.key}
                      row={row}
                      onPressTitle={onPressTitle}
                      onPressProfile={onPressProfile}
                    />
                  ))}
                </View>
              ),
            )}

            {/* Says the total rather than hiding behind "more", because the number above
                is the whole point of the sheet and a reader who counts the rows to check
                it deserves to be told why they do not add up yet. */}
            {remaining > 0 ? (
              <View style={styles.more}>
                <Text variant="footnote" tone="secondary">
                  {`Showing ${Math.min(shown, total).toLocaleString('en')} of ${total.toLocaleString('en')}`}
                </Text>
                <Button
                  label={`Show ${Math.min(PAGE, remaining).toLocaleString('en')} more`}
                  kind="secondary"
                  onPress={() => setShown((count) => count + PAGE)}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      <View style={styles.actions}>
        <Button label="Close" kind="secondary" onPress={onClose} />
      </View>
    </Sheet>
  );
}

/**
 * One line, drawn as whatever it is.
 *
 * The existing primitives rather than new ones: `TitleRow` leads with a poster and
 * `UserRow` with a round avatar, and the founder's standing rule is that the two must
 * stay distinguishable from their silhouette alone. A row with neither — a genre — is a
 * label and a value, which needs no primitive at all.
 */
function Row({
  row,
  onPressTitle,
  onPressProfile,
}: {
  row: BreakdownRow;
  onPressTitle?: (mediaItemId: string) => void;
  onPressProfile?: (username: string) => void;
}) {
  if (row.link?.kind === 'profile' || row.avatarPath !== undefined) {
    const username = row.link?.kind === 'profile' ? row.link.username : null;
    return (
      <UserRow
        name={row.label}
        // The handle where there is one; `UserRow` prints it with the @ itself, so the
        // detail line's own prefix is stripped rather than doubled.
        username={username ?? (row.detail?.replace(/^@/, '') ?? '')}
        avatarUri={avatarUri(row.avatarPath)}
        relationship={username && row.detail?.startsWith('@') ? null : row.detail}
        // A profile that is not visible has no route to open. Pressing does nothing
        // rather than pushing a screen that would say "this profile is not available".
        onPress={() => {
          if (username && onPressProfile) onPressProfile(username);
        }}
      />
    );
  }

  if (row.posterPath !== undefined) {
    return (
      <TitleRow
        title={row.label}
        year={row.year}
        posterUri={posterUri(row.posterPath)}
        secondary={row.detail ?? null}
        trailing={
          row.value ? (
            <Text variant="footnote" tone="secondary">
              {row.value}
            </Text>
          ) : undefined
        }
        divided
        onPress={() => {
          if (row.link?.kind === 'title' && onPressTitle) onPressTitle(row.link.mediaItemId);
        }}
      />
    );
  }

  // A genre, or anything else that is a name and a number.
  return (
    <View style={styles.plain} accessible accessibilityRole="text"
      accessibilityLabel={[row.label, row.value].filter(Boolean).join(', ')}>
      <Text variant="callout" style={styles.plainLabel}>
        {row.label}
      </Text>
      {row.value ? (
        <Text variant="footnote" tone="secondary">
          {row.value}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[3],
    gap: theme.space[1],
  },
  // Bounded, so a thousand films does not push the Close control off a sheet that is
  // already capped at 90% of the screen. The same figure the goals drill-down uses.
  list: { maxHeight: 380 },
  listContent: { paddingBottom: theme.space[2] },
  empty: { paddingHorizontal: theme.layout.gutter },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[1],
  },
  sectionLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  sectionEmpty: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  more: {
    alignItems: 'center',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[1],
  },
  plain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    minHeight: theme.layout.rowMinHeight,
  },
  plainLabel: { flex: 1 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
});
