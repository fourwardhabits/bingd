import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { OnboardingHeader } from '@/features/onboarding/OnboardingHeader';
import {
  hydrateMotivations,
  setMotivations,
} from '@/features/onboarding/motivation-selection';
import {
  MOTIVATIONS,
  motivationsProperty,
  type MotivationId,
} from '@/features/onboarding/motivations';
import { useAdvanceStage } from '@/features/onboarding/use-onboarding-stage';
import { useBeginTasteOnboarding } from '@/features/onboarding/use-taste-onboarding';
import { track } from '@/lib/analytics';
import { theme } from '@/ui/tokens';
import { Button, Screen, Text } from '@/ui/components';

/**
 * Step 3: what do you want out of bingd.?
 *
 * ---------------------------------------------------------------------------
 * WHY THE PRODUCT ASKS AT ALL
 *
 * Not to configure anything. Nothing downstream reads the answer
 * (`motivation-selection.ts` records why), and the next screen is the whole of its
 * purpose: six outcomes go in, and the features that deliver them come back out with
 * their real names attached. The reader learns the app's vocabulary from their own words
 * rather than from a tour.
 *
 * It is also the only place the product ever asks somebody *why* they are here, which is
 * what makes `onboarding_motivations` worth more than the rest of the flow's telemetry
 * put together.
 *
 * ---------------------------------------------------------------------------
 * ANY NUMBER, INCLUDING ALL SIX
 *
 * There is no maximum and no recommended count. A cap would make the reader rank their
 * own reasons before the app has shown them anything, which is a worse version of the
 * task step 6 exists for.
 *
 * **Continue is disabled at zero, and that is the only gate in the entire flow.** It
 * exists because step 4 has literally nothing to draw otherwise, not because an answer is
 * owed. Every other step in onboarding can be left.
 */
export default function MotivationsScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const advance = useAdvanceStage(profile.id);
  const [picked, setPicked] = useState<ReadonlySet<MotivationId>>(new Set());

  /**
   * `onboarding_started` fires here, because this is where onboarding now starts.
   *
   * It used to fire on arrival at the picker, which was the first screen of the flow when
   * the flow was one screen. With auth at step 2 and two value screens after it, that
   * would put the denominator three screens in and silently exclude everybody who left
   * during the part of onboarding most likely to lose them.
   *
   * `begin` is the same idempotent enrolment the picker still calls: two guards that
   * refuse to write over a decision already taken, in memory or on disk. Calling it from
   * both places is intended, and is why it was built that way.
   */
  const begin = useBeginTasteOnboarding(profile.id);
  useEffect(() => {
    void begin();
  }, [begin]);

  /**
   * A resumed selection, restored once.
   *
   * Local state rather than the store's own subscription, because this screen *edits* the
   * set: a subscribed value would be overwritten on every tap by whatever the store last
   * published, and the store is only written on Continue. The store is the durable copy;
   * this is the working one.
   */
  useEffect(() => {
    let active = true;
    void hydrateMotivations(profile.id).then((stored) => {
      if (active && stored.size > 0) setPicked(stored);
    });
    return () => {
      active = false;
    };
  }, [profile.id]);

  const toggle = (id: MotivationId) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * The one event that says why somebody downloaded the app, fired here rather than on
   * the next screen.
   *
   * This is the moment the answer becomes final: step 4 cannot change it, and a person
   * who abandons the flow after this point still told the product something true. Firing
   * it on arrival at step 4 instead would lose exactly the readers whose motivation is
   * most worth knowing, which are the ones who left.
   */
  const onContinue = () => {
    if (picked.size === 0) return;

    void setMotivations(profile.id, picked);
    track({
      name: 'onboarding_motivations',
      props: { count: picked.size, picked: motivationsProperty(picked) },
    });
    track({
      name: 'onboarding_step_completed',
      props: { step: 'motivations', outcome: 'continued' },
    });

    advance('answers');
    router.replace('/onboarding/answers');
  };

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <OnboardingHeader step="motivations" />

      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.intro}>
          <Text variant="title1">What do you want out of bingd.?</Text>
          {/* The whole of the multi-select instruction, and it is doing real work:
              nothing else on the screen says the limit is not one. */}
          <Text variant="body" tone="secondary">
            Pick as many as you like.
          </Text>
        </View>

        <View style={styles.list}>
          {MOTIVATIONS.map((motivation) => (
            <MotivationRow
              key={motivation.id}
              label={motivation.label}
              selected={picked.has(motivation.id)}
              onPress={() => toggle(motivation.id)}
            />
          ))}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Button label="Continue" onPress={onContinue} disabled={picked.size === 0} />
      </View>
    </Screen>
  );
}

/**
 * One of the six, as a full row rather than a chip.
 *
 * Six options at body size need the width: "See what my friends are watching" does not
 * fit a chip at any accessible text size without wrapping into something that no longer
 * looks like a control. A tapped row also *reads* as pressed rather than merely marked,
 * which a chip does not.
 *
 * The state is spoken by `accessibilityState.selected` rather than by the tick, which is
 * decoration. A screen reader announces the label and whether it is selected; the fill and
 * the check are how the same fact is said to everybody else.
 */
function MotivationRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      style={[styles.row, selected && styles.rowSelected]}
    >
      <Text variant="body" style={styles.rowLabel}>
        {label}
      </Text>
      {selected ? (
        <Ionicons
          name="checkmark-circle"
          size={22}
          color={theme.semantic.score}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : (
        <View style={styles.tickPlaceholder} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: theme.space[6] },
  intro: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[5],
    gap: theme.space[2],
  },
  list: { paddingHorizontal: theme.layout.gutter, gap: theme.space[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space[3],
    paddingVertical: theme.space[3],
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  rowSelected: {
    backgroundColor: theme.surface.sunken,
    borderColor: theme.semantic.score,
  },
  // Takes the width so a long label wraps inside the row rather than pushing the tick
  // off the end of it.
  rowLabel: { flex: 1 },
  // Holds the tick's place, so selecting a row does not re-flow its label sideways.
  tickPlaceholder: { width: 22, height: 22 },
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border.hairline,
  },
});
