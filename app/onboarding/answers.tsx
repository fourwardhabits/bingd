import { Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useAuth, useCurrentUserId } from '@/features/auth';
import { OnboardingHeader } from '@/features/onboarding/OnboardingHeader';
import {
  hydrateMotivations,
  useMotivations,
} from '@/features/onboarding/motivation-selection';
import { chosenMotivations } from '@/features/onboarding/motivations';
import { rewindStage, useAdvanceStage } from '@/features/onboarding/use-onboarding-stage';
import { track } from '@/lib/analytics';
import { fontFamily, theme } from '@/ui/tokens';
import { Button, Screen, SectionHeader, Text } from '@/ui/components';

/**
 * Step 2 of the flow: here is how that works.
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
 * nothing, it returns to the question. That happens only when the stored selection cannot
 * be read at all, which is the same class of failure `motivation-selection.ts` accepts in
 * exchange for not putting a column on the account table.
 *
 * **And the stage is corrected before the navigation, which is what stops the recovery
 * being a loop** (independent review of the founder's reordering). The selection and the
 * stage are separate preference keys written by the same Continue, so one can persist
 * without the other; a screen that only navigated would be sent straight back by routing,
 * which still read `answers` as authoritative, and would hydrate the same empty selection
 * for ever. The flow really is at the question, so that is what the stage is made to say.
 */
export default function AnswersScreen() {
  const router = useRouter();
  /**
   * The account id, not the profile: this screen runs before the form. See the note on
   * the same line in `motivations.tsx` for why the move costs nothing.
   */
  const userId = useCurrentUserId();
  const auth = useAuth();
  const advance = useAdvanceStage(userId);
  const picked = useMotivations(userId);
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
    void hydrateMotivations(userId).then((stored) => {
      if (!active || stored.size > 0) return;
      // The stage first, so routing agrees with the navigation rather than undoing it.
      // Not awaited: the memory half of `rewindStage` is synchronous and is what the
      // router reads, and the disk half is how it survives a relaunch.
      void rewindStage(userId, 'motivations');
      router.replace('/onboarding/motivations');
    });
    return () => {
      active = false;
    };
  }, [userId, router]);

  /**
   * **Where Continue goes, and why it asks the auth state rather than assuming.**
   *
   * The stage advances to `taste` either way: that is where the flow is *up to*, and it
   * is the answer this device has to remember. What differs is the next screen, and the
   * profile is what decides it — a reader who came through sign in with no `profiles` row
   * has the form next (founder's order, 2026-09-09), and one who somehow arrives here with
   * an account already has the picker.
   *
   * Resolved here rather than left to `useAuthRouting`, which would also get it right, so
   * that the write and the navigation are adjacent and synchronous. The same reason
   * `finish` in `notifications.tsx` resolves its destination before writing `done`: no
   * commit in between for the router to answer in, and no frame of the wrong screen.
   */
  const onContinue = () => {
    track({
      name: 'onboarding_step_completed',
      props: { step: 'answers', outcome: 'continued' },
    });
    advance('taste');
    router.replace(auth.status === 'ready' ? '/onboarding/taste' : '/(auth)/create-profile');
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
