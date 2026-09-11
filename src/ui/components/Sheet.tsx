import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { inkAlpha, theme } from '../tokens';
import { Text } from './Text';
import { useKeyboardHeight } from './use-keyboard-height';

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Announced when the sheet opens. */
  label: string;
  children: React.ReactNode;
  /**
   * Called when iOS has **finished** dismissing the presented view controller.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS EXISTS, AND WHY IT IS OPTIONAL
   *
   * Almost every caller in this app renders `<Sheet visible ...>` — the literal `true` —
   * and dismisses by unmounting the component. That is fine when nothing else wants the
   * screen next: UIKit is asked to dismiss, and the frame it takes to animate is nobody's
   * business.
   *
   * It is **not** fine when a second sheet is mounted in the same commit, because UIKit
   * cannot present a view controller while it is still dismissing another from the same
   * presenter. The presentation is refused, React believes it succeeded, and the window
   * that is left behind is transparent and swallows every touch — the screen underneath
   * draws correctly and is dead. Force-quitting clears it because the window is
   * process-local. That is the 2026-09-10 onboarding freeze, reproduced twice.
   *
   * So a caller that hands straight over to another sheet keeps this one mounted, sets
   * `visible` false, waits for this callback, and only then mounts the next.
   *
   * **`app/onboarding/taste.tsx` is the only caller doing that today**, and deliberately
   * so: it is the one place the failure was reproduced on a device.
   *
   * ---------------------------------------------------------------------------
   * THE REST OF THE CLASS IS KNOWN, AND IS NOT FIXED HERE
   *
   * The audit of 2026-09-10 found the same unserialised swap — one `<Modal>` unmounted
   * and another presented in the same commit — in six more places, none of them ever
   * reported:
   *
   *   - `app/(tabs)/log.tsx` and `app/title/[id].tsx`, log sheet <-> comparison, both ways
   *   - `app/(tabs)/log.tsx`, `SeasonPicker` -> log sheet
   *   - `app/title/[id].tsx`, the Ranked options sheet -> log, comparison, or an `Alert`
   *   - `src/features/profile/ProfileMenu.tsx`, Report -> `ReportSheet`, Block -> `Alert`
   *
   * They are held for a separate change on the founder's decision, so that the release
   * carrying the reproduced fix stays small enough to trust. The work exists on
   * `defer/modal-handoff-audit` with a `useSheetHandoff` hook that generalises what
   * `taste.tsx` does by hand.
   *
   * **Two warnings for whoever picks that up.** The audit's own list was wrong twice
   * before it was right — its first pass enumerated named sheet *components* and so
   * missed a bare `<Modal>` and an inline one; a later pass missed the profile menu — so
   * treat any list of these as the state of a search rather than a proof. And an `Alert`
   * counts: it is a `UIAlertController` presented from the same view controller.
   *
   * **Do not "simplify" a serialised handover back into a pair of `setState` calls.**
   * That is precisely the shape of the bug, and it does not look like one: the screen
   * renders perfectly and stops accepting touches.
   *
   * A caller that opens *one* sheet and closes it back to the screen underneath needs
   * none of this and passes the literal `true`, as most of them do.
   *
   * **iOS only.** React Native fires `onDismiss` on iOS and not on Android, which is
   * correct rather than a gap: an Android modal is a view in the same window and has no
   * presentation to serialise against. Callers branch on the platform rather than waiting
   * for a callback that will not arrive.
   */
  onDismissed?: () => void;
  /**
   * Called when iOS has **finished presenting** this sheet.
   *
   * The mirror of `onDismissed`, and it closes the same hazard from the other side.
   * **UIKit will not run a dismissal issued while the presentation is still animating** —
   * it refuses it and never calls the completion — so a caller that can ask for a
   * dismissal within the first third of a second of opening must wait for this first, or
   * its `onDismissed` never arrives and the sheet sits over a dead screen. That is the
   * freeze again, on the exit leg.
   *
   * It is reachable in onboarding and only there: the first title on a new account has an
   * empty band, so `rank_start` "places it outright" and the comparison sheet is finished
   * with a round trip after it opened — before it has finished appearing.
   */
  onShown?: () => void;
};

/**
 * The modal pattern for the whole app (design-system.md §8).
 *
 * It was specified there from the start and never built: `LogSheet`, `RankingSheet`
 * and `SeasonPicker` each reached for `<Modal presentationStyle="pageSheet">`, which
 * is a *full-height* native sheet. That is the reason the log flow reads as a
 * sequence of screens rather than as one small act — a page-sheet has to be filled,
 * so the content inside it spreads out to justify the height it was given.
 *
 * This anchors to the bottom and takes only the height its content needs, up to 90%.
 * The context the user was looking at stays visible above it, which is what makes
 * logging feel incidental (Beli 224, reference-notes.md §2).
 *
 * The backdrop is capped at 40% per §8: a warm light ground under a heavy scrim turns
 * muddy rather than dark.
 *
 * **It rises with the keyboard, which is the founder's device finding answered at the
 * one place that fixes every sheet at once.** A bottom-anchored sheet with a composer
 * at its foot — comments, the note in the log sheet, a goal's target — is covered by
 * the keyboard *by construction* on Android, where edge-to-edge means the window never
 * resizes and `adjustResize` has nothing to adjust. The measured height goes on the
 * root's padding rather than the sheet's margin, which does two things with one value:
 * it lifts the sheet clear, and it re-resolves `maxHeight: '90%'` against the space
 * that is actually left, so a tall sheet shrinks instead of running off the top.
 */
export function Sheet({ visible, onClose, label, children, onDismissed, onShown }: SheetProps) {
  const keyboard = useKeyboardHeight();
  const insets = useSafeAreaInsets();

  /**
   * The foot of every sheet in the app, decided in one place.
   *
   * A bottom-edge safe area is right about the device and wrong about the design: it
   * pads by the inset and by *nothing else*, so on a display that reports no bottom
   * inset — an Android device with three-button navigation, a simulator, every test —
   * a sticky footer’s buttons finish flush against the edge of the sheet. The founder
   * found that twice on one device, on Collection Filters and on Bingd Awards, which
   * are simply the two sheets whose last element is a button rather than a list.
   *
   * `Math.max` rather than a sum: the home indicator’s inset is already breathing
   * room, and adding a gutter on top of it would lift the buttons off a modern iPhone
   * for no reason. Whichever is larger, never less than a gutter — the same rule
   * `Screen` applies to the bottom of a page.
   */
  const bottomPadding = Math.max(insets.bottom, theme.space[4]);

  /**
   * **A dismissal is never asked for before the presentation has finished.**
   *
   * UIKit refuses a dismissal issued while the presentation is still animating, and it
   * never runs the completion — so `onDismiss` never arrives, a caller waiting on it waits
   * for ever, and the sheet sits over a screen that takes no touches. It is the freeze
   * again, from the other side, and it is reachable wherever a sheet can be closed within
   * about a third of a second of opening: a backdrop tap as it slides up, or a placement
   * that lands that fast because the first title on a new account has an empty band.
   *
   * Enforcing it **here** rather than in each caller's state machine is the whole point.
   * Three separate paths reached it in onboarding alone — the placement, the comparison
   * sheet's own dismissal, and the bucket sheet's — and each would have needed its own
   * `shown` flag and its own guard. One rule in the primitive covers every path, every
   * caller, and every path added later.
   *
   * `held` is only ever true between being asked to close and iOS confirming the sheet
   * arrived, so a caller that passes the literal `true` never reaches it.
   *
   * **What this does not cover**, stated so nobody reads more into it: the mirror case, a
   * presentation asked for while a dismissal is still animating. `shown` is cleared in
   * `onDismiss`, so it is still true for the whole slide-out and `held` is false there.
   * Reaching it needs `visible` driven false then true again inside about 300ms, which no
   * caller in the app does: onboarding’s step machine refuses the re-entry
   * itself, and the two other dynamic callers would need a double tap inside the animation.
   * The handoffs that could reach it belong to the deferred audit, not to this fix.
   */
  const [shown, setShown] = useState(false);
  const [asked, setAsked] = useState(visible);
  // Adjusted during render rather than in an effect or a ref: React's own answer for state
  // that has to follow a prop. It is conditional and idempotent, so it settles in the same
  // pass and never loops.
  if (visible && !asked) setAsked(true);
  const held = !visible && asked && !shown;

  return (
    <Modal
      visible={visible || held}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={() => {
        // Ready for the next presentation of this same sheet.
        setShown(false);
        setAsked(false);
        onDismissed?.();
      }}
      onShow={() => {
        setShown(true);
        onShown?.();
      }}
      accessibilityViewIsModal
      statusBarTranslucent
    >
      {/**
       * **Nothing in a dismissing sheet answers, and this is where that is decided once.**
       *
       * iOS keeps a modal's children mounted for the whole slide-out, so every control on
       * a sheet that is closing is still live: its Close button, its Done, its chips, and
       * the backdrop behind them. Any of them taken during that window unmounts this
       * `<Modal>` **mid-dismissal**, which is the operation the whole serialisation exists
       * to avoid, and it lands the screen in exactly the state it was fixed out of.
       *
       * Guarding the handlers one at a time was the first attempt and an independent
       * review found the ones that had been missed — a sheet has more ways out than
       * anybody enumerates correctly. `pointerEvents` is the same rule stated once, for
       * every sheet in the app and every control on it, including ones added later.
       *
       * Only reachable for a caller that drives `visible`; the twenty-odd callers that
       * pass the literal `true` are unaffected, because it is never false for them.
       */}
      <View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[styles.root, keyboard > 0 && { paddingBottom: keyboard }]}
      >
        {/* Tapping away closes.

            Hidden from the accessibility tree on purpose. Every sheet in the app
            carries its own labelled Close control, and an accessible scrim would put
            a *second* element called "Close" in front of a screen reader before it
            reached any of the content — two identical announcements for the same
            action. Dismissal stays available to those users through that control and
            through the hardware back button, which `onRequestClose` handles. */}
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <View style={[styles.sheet, { paddingBottom: bottomPadding }]} accessibilityLabel={label}>
          <View
            style={styles.handle}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          {children}
        </View>
      </View>
    </Modal>
  );
}

export type SheetRowProps = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  /** The current value, shown on the right. Absent reads as "nothing set yet". */
  value?: string | null;
  onPress?: () => void;
  /** Renders the row present but inert, and says why to a screen reader. */
  disabledReason?: string;
  /** Marks the row as open, so the chevron points down and state is announced. */
  expanded?: boolean;
};

/**
 * One compact row inside a sheet: icon, label, current value, chevron.
 *
 * A row rather than a form field, which is the density decision borrowed from Beli's
 * "Add to my list of ▾". A multiline `Field` is 48pt of input plus a label plus a
 * hint before the user has typed anything, and three of those cannot coexist with a
 * bucket prompt in a sheet anyone would call small. A row states its value in one
 * line and spends space only when opened.
 *
 * `disabledReason` exists because a row for something not built yet is worth keeping
 * — it shows where the feature will live — but only if it says so out loud rather
 * than looking broken (design-system.md §8, on disabled buttons).
 */
export function SheetRow({
  icon,
  label,
  value,
  onPress,
  disabledReason,
  expanded,
}: SheetRowProps) {
  const disabled = Boolean(disabledReason) || !onPress;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, expanded }}
      accessibilityLabel={label}
      accessibilityHint={disabledReason ?? value ?? undefined}
      accessibilityValue={value ? { text: value } : undefined}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={disabled ? theme.text.tertiary : theme.text.secondary}
      />
      <Text variant="callout" tone={disabled ? 'tertiary' : 'primary'} style={styles.rowLabel}>
        {label}
      </Text>
      <Text variant="footnote" tone="tertiary" numberOfLines={1} style={styles.rowValue}>
        {disabledReason ?? value ?? ''}
      </Text>
      {disabled ? null : (
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={theme.layout.icon.sm}
          color={theme.text.tertiary}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: inkAlpha(0.4),
  },
  sheet: {
    backgroundColor: theme.surface.raised,
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    maxHeight: '90%',
    ...theme.elevation.e2,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.border.strong,
    marginTop: theme.space[2],
    marginBottom: theme.space[1],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
  },
  rowLabel: { flexShrink: 0 },
  rowValue: { flex: 1, textAlign: 'right' },
  pressed: { opacity: 0.6 },
});
