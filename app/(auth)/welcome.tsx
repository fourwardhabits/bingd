import { Stack, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { markWelcomeSeen } from '@/features/onboarding/welcome';
import { theme } from '@/ui/tokens';
import { BrandLockup, Button, Screen, Text } from '@/ui/components';

/**
 * The opening: the only screen in the product that runs with no session.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A SCREEN IN FRONT OF THE FORM AT ALL
 *
 * Auth used to be the first thing a stranger met. The founder's flow puts one value
 * screen ahead of it and nothing else, and the reasoning is about what the reader is
 * being asked to spend (`01-screen-map.md` §2): **this screen costs nothing and has to
 * earn the tap**, while everything from step 3 on costs real effort and has nowhere to be
 * stored without an account. So exactly one screen sits before the account, and the rest
 * of onboarding sits after it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE VISUAL IS THE COMPARISON AND NOT A LIST
 *
 * The headline says the app puts your favorites in order. A picture of an ordered list
 * would say the same thing twice; the argument the headline *cannot* make on its own is
 * that getting there is two taps and a decision. So the visual is the app's own
 * comparison at about half size, with the real question above it.
 *
 * **It carries no score, and that is deliberate rather than an omission.** A number here
 * would start an explanation this screen has no room to finish, and the claim being made
 * is about the order rather than about the arithmetic underneath it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PAIR IS DRAWN RATHER THAN PHOTOGRAPHED
 *
 * There is no artwork to show. The catalogue is a cache of what somebody has already
 * searched for, reaching it needs a session, and this screen has neither — so a version
 * of this that rendered two real posters would be a screen that is empty on the one
 * launch it exists for, or one that ships bundled artwork the product has no licence to.
 *
 * What is drawn instead is the comparison's *shape*, in the app's own materials: two
 * poster frames at the real aspect ratio, the same 32pt OR disc `RankingSheet` uses, and
 * the real question above them. It reads as the app because it is made of the app.
 */
export default function WelcomeScreen() {
  const router = useRouter();

  /**
   * Both buttons go to the same place, and both close the opening for good.
   *
   * There is no separate "sign in" destination to send the returning reader to: the sign
   * in screen already offers every method to both, and a second route would be two ways
   * into one form. The secondary exists because a returning user needs to be told this
   * screen is not asking them to start again, which is a copy problem rather than a
   * routing one.
   *
   * `markWelcomeSeen` is dispatched and not awaited, on the ordering rule the rest of the
   * flow follows: the memory half is synchronous and is what the router reads, the disk
   * half is how it survives a relaunch, and awaiting the Keychain here would only make
   * somebody watch a button they have already pressed.
   */
  const begin = () => {
    void markWelcomeSeen();
    router.replace('/(auth)/sign-in');
  };

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.body}>
        {/* Steps 1 and 2 carry the lockup in the content rather than in chrome, because
            both are brand moments and neither has a header. From step 3 the mark moves
            into the header and stays there. */}
        <BrandLockup />

        <View style={styles.pitch}>
          <Text variant="title1">Your favorites, in order.</Text>
          <Text variant="body" tone="secondary">
            Rank what you watch, one quick comparison at a time. Your favorites get clearer
            as you go, without trying to squeeze everything into stars.
          </Text>
        </View>

        <Pair />
      </View>

      <View style={styles.footer}>
        {/* Low on the screen and above the buttons rather than in the body, so it lands in
            the same place whatever height the visual takes. The social half of the product
            is named here and nowhere else before sign in. */}
        <Text variant="footnote" tone="secondary" style={styles.centre}>
          See what friends are loving, compare taste, and find your next watch.
        </Text>
        <Button label="Get started" onPress={begin} />
        <Button label="I already have an account" kind="tertiary" onPress={begin} />
      </View>
    </Screen>
  );
}

/**
 * The comparison, at about half size and with nothing in it to read.
 *
 * Hidden from assistive technology below the question: two empty frames and the word OR
 * describe nothing to somebody who cannot see them, and the sentence above already says
 * what the picture is for. The question itself stays readable, which is the part that
 * carries the meaning.
 */
function Pair() {
  return (
    <View style={styles.pair}>
      <Text variant="body" tone="secondary" style={styles.centre}>
        Which did you like more?
      </Text>
      <View
        style={styles.cards}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={styles.card} />
        {/* The same disc, at the same 32pt, as the real comparison. */}
        <View style={styles.or}>
          <Text variant="caption" tone="secondary">
            OR
          </Text>
        </View>
        <View style={styles.card} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    justifyContent: 'center',
    gap: theme.space[6],
    paddingHorizontal: theme.layout.gutter,
  },
  pitch: { gap: theme.space[3] },
  pair: { gap: theme.space[3] },
  cards: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  card: {
    flex: 1,
    aspectRatio: theme.layout.aspect.poster,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.sunken,
  },
  or: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.sunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[4],
    gap: theme.space[3],
  },
  centre: { textAlign: 'center' },
});
