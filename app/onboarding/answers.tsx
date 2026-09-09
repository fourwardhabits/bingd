import { Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { OnboardingHeader } from '@/features/onboarding/OnboardingHeader';
import {
  hydrateMotivations,
  useMotivations,
} from '@/features/onboarding/motivation-selection';
import { chosenMotivations } from '@/features/onboarding/motivations';
import { useAdvanceStage } from '@/features/onboarding/use-onboarding-stage';
import { track } from '@/lib/analytics';
import { fontFamily, theme } from '@/ui/tokens';
import { Button, Screen, SectionHeader, Text } from '@/ui/components';

/**
 * Step 4: here is how that works.
 *
 * ---------------------------------------------------------------------------
 * ONE CARD PER PICK, AND THE SAME SIZE EACH
 *
 * The card answering "pick something with friends" is exactly as large as the one
 * answering "know my favorites", **because the person picked both**. Every alternative
 * considered — a grid at four, two columns at six, smaller type as the list grows — makes
 * the app's answer to somebody's stated reason shrink in proportion to how many reasons
 * they gave. At six the screen scrolls, which is what scrolling is for.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FEATURE NAME IS THE ONLY BOLD THING ON THE CARD
 *
 * This screen is where the reader is handed the app's vocabulary. `Ranking`, `Feed`, `For
 * You`, `Group Picks`, `Taste Match`, `Collection` are the words on the tabs and in the
 * menus they are about to meet, and emphasising them here is what makes the meeting a
 * recognition rather than an introduction.
 *
 * Nothing else carries emphasis. A card with two bold phrases has none.
 *
 * ---------------------------------------------------------------------------
 * WHY A RESUME LANDS BACK ON THE QUESTION
 *
 * This screen is a function of the previous one's answer, so an empty selection is not an
 * empty state — it is a screen with nothing to be about. Rather than draw a heading over
 * nothing, it returns to step 3. That happens only when the stored selection cannot be
 * read at all, which is the same class of failure `motivation-selection.ts` accepts in
 * exchange for not putting a column on the account table.
 */
export default function AnswersScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const advance = useAdvanceStage(profile.id);
  const picked = useMotivations(profile.id);
  const cards = chosenMotivations(picked);

  /**
   * Hydrate once, and go back to the question when there is nothing to answer.
   *
   * Guarded on the hydration having happened rather than on the set being empty: the
   * store answers `EMPTY` before the preference has been read, and redirecting on that
   * would send every reader back to step 3 for one frame on the way in.
   */
  useEffect(() => {
    let active = true;
    void hydrateMotivations(profile.id).then((stored) => {
      if (active && stored.size === 0) router.replace('/onboarding/motivations');
    });
    return () => {
      active = false;
    };
  }, [profile.id, router]);

  const onContinue = () => {
    track({
      name: 'onboarding_step_completed',
      props: { step: 'answers', outcome: 'continued' },
    });
    advance('taste');
    router.replace('/onboarding/taste');
  };

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <OnboardingHeader step="answers" />

      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.intro}>
          <Text variant="title1">Here is how that works</Text>
          <Text variant="body" tone="secondary">
            One answer for each thing you picked.
          </Text>
        </View>

        {cards.map((motivation) => (
          <View key={motivation.id} style={styles.card}>
            {/* Maroon and upper-cased by `SectionHeader`, which is the app's own section
                treatment. The words are the reader's own row from step 3, not a second
                copy that an edit could leave disagreeing with what they tapped. */}
            <SectionHeader title={motivation.label} />
            <View style={styles.answer}>
              {/* Inline emphasis the way the rest of the app does it: a nested `Text`
                  carrying `sansSemibold`, as `FollowStoryRow` and `PeopleView` do for a
                  name inside a sentence. The feature name is the only bold thing on the
                  card. */}
              <Text variant="body">
                <Text variant="body" style={styles.feature}>
                  {motivation.feature}
                </Text>{' '}
                {motivation.answer}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* On a hairline, so a scrolled screen still shows where the action is. */}
      <View style={styles.footer}>
        <Button label="Continue" onPress={onContinue} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: theme.space[6] },
  intro: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[4],
    gap: theme.space[2],
  },
  card: { paddingBottom: theme.space[4] },
  answer: { paddingHorizontal: theme.layout.gutter },
  feature: { fontFamily: fontFamily.sansSemibold },
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border.hairline,
  },
});
