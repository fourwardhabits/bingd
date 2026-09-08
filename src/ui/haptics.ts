import * as Haptics from 'expo-haptics';

/**
 * The app's whole haptic vocabulary. Three words, and there is not a fourth.
 *
 * ---------------------------------------------------------------------------
 * WHY A VOCABULARY RATHER THAN A CALL
 *
 * `expo-haptics` has been a dependency since the first build and nothing in `src/` had
 * ever imported it. That is the good starting position for this, because the failure
 * mode of haptics is not absence — it is a codebase where forty call sites each chose an
 * intensity, and the phone buzzes at the same strength for saving a film and for
 * finishing a ranking. Feedback that does not vary stops being feedback and becomes a
 * tic.
 *
 * So the intensity is chosen **here**, once, by what the act *means*, and a call site
 * chooses a meaning rather than a waveform:
 *
 *   `selection`  a lightweight, reversible state change the reader made — a bookmark, a
 *                filter chip, a person added to a group. The lightest thing the platform
 *                offers, and the only one used more than a few times a session.
 *   `decision`   a judgement that goes to the server and moves something. In practice:
 *                answering a ranking comparison. A medium impact, so it lands as an
 *                acknowledgement rather than as a nudge.
 *   `success`    an act completing. Exactly one thing in this app is one: a ranking
 *                arriving at a score. It is a notification pattern rather than an
 *                impact, which is what makes it read as *finished* rather than as
 *                *pressed*.
 *
 * ---------------------------------------------------------------------------
 * WHAT MUST NEVER BE HAPTIC
 *
 * Scrolling. Navigation, forward or back. An ordinary button. Anything the app does on
 * its own — a query resolving, a cache filling, a screen appearing. The rule is that a
 * haptic answers something the reader *did*, and the reader did not do those.
 *
 * ---------------------------------------------------------------------------
 * FAILING GRACEFULLY IS THE WHOLE ERROR CONTRACT
 *
 * Every one of these is fire-and-forget and swallows its rejection. Haptics are absent on
 * web, absent on a good many Android devices, and refused outright when the system has
 * them switched off — none of which is an error, and none of which may interrupt the act
 * the haptic was decorating. A `void` return with a `.catch` is deliberate: an `await`
 * here would put the platform's haptic engine on the critical path of a bookmark.
 *
 * Reduce Motion is not consulted, and that is correct. It is a motion setting; the system
 * haptic switch is the one that governs this, and the platform already honours it below
 * us.
 */

/** Fire and forget. A device with no haptics, or haptics switched off, is not an error. */
const fire = (run: () => Promise<void>) => {
  try {
    void run().catch(() => {});
  } catch {
    // Synchronous throw from a platform with no module at all. Same answer: nothing.
  }
};

/**
 * A lightweight state change the reader made.
 *
 * Bookmark on or off, a filter chip, a person joining a group pick. Deliberately the
 * lightest style the platform has: this is the one that fires often enough that a heavier
 * pattern would become the thing the app is remembered for.
 */
export const hapticSelection = () => fire(Haptics.selectionAsync);

/**
 * A judgement the reader made that the server will hear about.
 *
 * Answering a comparison, which is the one place in the app where a tap *is* an opinion.
 * Medium rather than light, because the weight is the point: the comparison is the unit
 * of work in the ranking ritual, and it should feel like something was recorded.
 */
export const hapticDecision = () =>
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));

/**
 * An act finishing.
 *
 * A ranking arriving at a score, and nothing else. The success *notification* pattern
 * rather than a heavy impact: an impact says "you pressed something" and this has to say
 * "that is done", which is a different sentence. It fires once per completed placement,
 * from the reveal's own mount, so a re-render cannot repeat it.
 */
export const hapticSuccess = () =>
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
