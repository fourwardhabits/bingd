import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Field, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { GOAL_LABEL, GOAL_CATEGORIES, type GoalCategory } from './goals';

export type GoalDraft = Partial<Record<GoalCategory, number>>;

export type GoalSheetProps = {
  year: number;
  /**
   * The stored targets, read once when the sheet opens. A missing key is a medium
   * with no goal.
   *
   * **This component must be mounted only while the sheet is open**, which is why
   * there is no `visible` prop to get that wrong with. The draft below is seeded from
   * `targets` by a `useState` initializer, and an initializer runs on mount and never
   * again: a sheet mounted alongside the section it belongs to would seed itself from
   * whatever the goals query held at *that* moment, which is `{}` while the query is
   * still in flight. Opening Edit would then show two empty fields, and saving them
   * would clear both goals — an empty field is how this sheet says "remove".
   * Independent review found exactly that. Mounting on open makes the initializer run
   * when the values are known, and makes Cancel discard the draft rather than keep it.
   */
  targets: GoalDraft;
  /** Called with only the media whose target actually changed. */
  onSave: (changes: { category: GoalCategory; target: number | null }[]) => void;
  onClose: () => void;
  /** Blocks a second submission while the writes are in flight. */
  saving?: boolean;
};

/** The bounds `set_watch_goal` and the check constraint both enforce. Repeated here
 *  so the user is told before a round trip, not by a 22023 afterwards. */
const MIN = 1;
const MAX = 10000;

/**
 * Setting, changing and removing both goals, in one sheet.
 *
 * One sheet rather than one per medium, because the decision a user is making is
 * "what does my year look like" and that is a single thought. Two sheets would also
 * make the common case — setting movies and leaving TV alone — feel like a choice
 * that had to be declined.
 *
 * **An empty field clears that goal.** That is the whole delete affordance, and it is
 * why there is no Remove button: absence is how the schema says "no goal"
 * (20260816000800), and a text field that has been emptied is the most direct way a
 * person can say the same thing. A destructive-looking button for "I no longer have a
 * target this year" would overstate it.
 *
 * Edits are local until Save, matching `CollectionFilterSheet`, and only the changed
 * media are written — so opening the sheet and closing it writes nothing at all.
 */
export function GoalSheet({ year, targets, onSave, onClose, saving }: GoalSheetProps) {
  const [draft, setDraft] = useState<Record<GoalCategory, string>>(() => ({
    movies: targets.movies != null ? String(targets.movies) : '',
    tv_seasons: targets.tv_seasons != null ? String(targets.tv_seasons) : '',
  }));

  const parsed = (raw: string): { target: number | null; error: string | null } => {
    const trimmed = raw.trim();
    if (!trimmed) return { target: null, error: null };
    // Digits only. `Number('12e3')` is 12000 and `Number(' 12 ')` is 12, and neither
    // is something the user typed on a numeric keypad meaning what it parses to.
    if (!/^\d+$/.test(trimmed)) return { target: null, error: 'Use a whole number.' };
    const value = Number(trimmed);
    if (value < MIN || value > MAX) {
      return { target: null, error: `Pick a number between ${MIN} and ${MAX}.` };
    }
    return { target: value, error: null };
  };

  const errors = GOAL_CATEGORIES.map((category) => parsed(draft[category]).error).filter(Boolean);

  const save = () => {
    const changes = GOAL_CATEGORIES.flatMap((category) => {
      const { target } = parsed(draft[category]);
      const stored = targets[category] ?? null;
      // Unchanged media are not written. A no-op `set_watch_goal` is harmless — it is
      // idempotent by construction — but sending it would mean every open-and-close
      // of this sheet touched `updated_at` on a row nobody edited.
      return target === stored ? [] : [{ category, target }];
    });
    onSave(changes);
  };

  return (
    <Sheet visible onClose={onClose} label={`Your ${year} goals`}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.intro}>
          <Text variant="title2">Your {year} goals</Text>
          <Text variant="footnote" tone="secondary">
            Set one, both, or neither. Only titles with a watch date in {year} count, and a
            rewatch counts once.
          </Text>
        </View>

        {GOAL_CATEGORIES.map((category) => {
          const { error } = parsed(draft[category]);
          return (
            <Field
              key={category}
              label={GOAL_LABEL[category]}
              value={draft[category]}
              onChangeText={(text) => setDraft({ ...draft, [category]: text })}
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={5}
              placeholder="No goal"
              error={error ?? undefined}
              hint={
                targets[category] != null ? 'Clear the field to remove this goal.' : undefined
              }
            />
          );
        })}
      </ScrollView>

      <View style={styles.actions}>
        <Button label="Cancel" kind="secondary" onPress={onClose} />
        <Button
          label={saving ? 'Saving…' : 'Save'}
          onPress={save}
          disabled={saving || errors.length > 0}
          disabledReason={
            errors.length > 0 ? 'Fix the goal numbers first.' : 'Saving your goals.'
          }
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[4],
    gap: theme.space[4],
  },
  intro: { gap: theme.space[1], paddingTop: theme.space[2] },
  actions: {
    flexDirection: 'row',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
});
