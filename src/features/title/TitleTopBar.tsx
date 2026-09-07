import { Ionicons } from '@expo/vector-icons';
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/ui/components';
import { inkAlpha, theme } from '@/ui/tokens';

/**
 * The bar height above the status bar, per platform.
 *
 * **The same pair the navigator's own header used**, and the same pair `TitleHero` and
 * `DetailHeader` state — 44 on iOS, 56 on Android's toolbar convention. Drawing this bar
 * ourselves changed how it behaves and deliberately not how tall it is: the founder's
 * direction is that title detail keeps the compact height it had before the redesign, and
 * this is that height, to the point.
 *
 * It also reserves nothing. The bar is absolutely positioned over the artwork, so the
 * hero still begins at the top of the display and no content moved down to make room for
 * the transparency.
 */
export const NAV_BAR_HEIGHT = Platform.select({ android: 56, default: 44 }) as number;

/**
 * A disc of Ink under each glyph while it is over artwork.
 *
 * `TitleHero`'s top scrim is the app's existing contrast language and it is a *gradient
 * across the whole width* — which is the right treatment for a bar and not quite enough
 * for a single glyph on a bright backdrop, where the scrim is at its weakest exactly
 * where the icon is smallest. A local disc is the standard answer and the founder's
 * direction names it. It fades out with the same value the ground fades in on, so it
 * exists only while there is artwork behind the glyph and never over Paper.
 *
 * Deliberately low: enough to separate a Parchment glyph from a pale sky, not enough to
 * read as a button. Two overlapping circles would be chrome; two barely-there ones are a
 * shadow the eye does not name.
 */
const DISC = inkAlpha(0.28);

export type TitleTopBarProps = {
  /**
   * 0 while the hero is fully in view, 1 once it has left. Drives the ground, the
   * compact title and the crossfade between the two icon treatments in one value, so
   * they cannot disagree about how far through the transition the page is.
   */
  progress: Animated.AnimatedInterpolation<number>;
  /**
   * Whether the compact title is *readable* — for assistive technology, not for the eye.
   *
   * The fade is continuous and the accessibility tree is not: a title block held at
   * `opacity: 0` is still in the tree, so a screen reader on any title page would meet the
   * name twice, once in the bar and once in the identity block six points below it. That
   * is the duplication `DetailHeader`'s whole rule exists to prevent, reintroduced by the
   * animation.
   *
   * So the visual state is the interpolation and the announced state is this boolean,
   * crossed with hysteresis by the screen. They can disagree for a few points of scroll,
   * which nobody can perceive in either channel.
   */
  revealed: boolean;
  /** Returns to whatever pushed this route. Never a route of its own. */
  onBack: () => void;
  /** Opens the title's menu. Absent for a title with no menu — a series. */
  onMore?: () => void;
  /** What the bar says once the page has stopped naming itself. */
  title: string;
  /** The series above a season's own name, on the bar's second line. */
  subtitle?: string | null;
};

/**
 * The title page's own navigation, drawn **on** the artwork rather than above it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN STOPPED USING THE NAVIGATOR'S HEADER
 *
 * The page had `headerTransparent: true` with a `headerBackground` that was mounted or
 * not mounted according to a boolean (`useDetailHeader`). That gives two states and no
 * way between them: the ground and the title appeared at a threshold, in one frame, and
 * the founder's brief asks for the opposite — a surface that gains opacity as the hero
 * leaves, reading as an ordinary Paper header by the time it has gone.
 *
 * The other half is contrast. A back control on unpredictable artwork has to change
 * colour as the ground arrives under it, and `headerTintColor` is a navigation option
 * rather than a value that can be animated. So the controls are drawn here, where an
 * `Animated.Value` can carry the ground, the title and the icon treatment together.
 *
 * **Navigation semantics are unchanged.** `onBack` is `router.back()`: it returns to
 * whatever pushed this route, exactly as the native control did, and Android's hardware
 * back and the iOS edge swipe are the navigator's and are untouched.
 *
 * ---------------------------------------------------------------------------
 * HOW THE ICONS STAY LEGIBLE
 *
 * Two copies of each glyph, stacked, cross-faded on the same `progress` — light on the
 * artwork, Ink on Paper. A colour interpolation would work too and would have to run on
 * the JavaScript thread; opacity does not, so the transition survives a page that is
 * also laying out a season's worth of episode stills.
 *
 * Over the artwork they sit on `TitleHero`'s own `TopScrim`, which is the app's existing
 * contrast language for exactly this and is why there is no disc, no blur and no bar
 * behind them. The scrim is strongest where the glyphs are and gone before the subject.
 */
export function TitleTopBar({
  progress,
  revealed,
  onBack,
  onMore,
  title,
  subtitle,
}: TitleTopBarProps) {
  const insets = useSafeAreaInsets();
  // The light treatment is the inverse of the dark one, so one value drives both and
  // there is no moment where neither is drawn.
  const onArtwork = Animated.subtract(1, progress);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.bar, { paddingTop: insets.top, height: insets.top + NAV_BAR_HEIGHT }]}
    >
      {/* The Paper ground, arriving. Its hairline arrives with it, so the bar does not
          draw a rule across the artwork on the way. */}
      <Animated.View
        testID="title-top-bar-ground"
        pointerEvents="none"
        style={[styles.ground, { opacity: progress }]}
      />

      <View style={styles.row}>
        <BarButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={onBack}
          progress={progress}
          onArtwork={onArtwork}
          testID="title-back"
        />

        {/* The compact title, which appears only once the page has stopped naming
            itself — the rule `DetailHeader` established and this keeps. A season carries
            its series above it, because "Season 2" alone in a bar answers nothing. */}
        <Animated.View
          pointerEvents="none"
          style={[styles.titleBlock, { opacity: progress }]}
          testID="title-top-bar-title"
          // Out of the tree entirely until it is readable. See `revealed`.
          accessibilityElementsHidden={!revealed}
          importantForAccessibility={revealed ? 'auto' : 'no-hide-descendants'}
        >
          {subtitle ? (
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          <Text variant="callout" numberOfLines={1}>
            {title}
          </Text>
        </Animated.View>

        {onMore ? (
          <BarButton
            icon="ellipsis-horizontal"
            accessibilityLabel={`More options for ${title}`}
            onPress={onMore}
            progress={progress}
            onArtwork={onArtwork}
            testID="title-more"
          />
        ) : (
          // The back control's own width, so the title stays centred on a page with no
          // menu rather than sliding across when one appears.
          <View style={styles.control} />
        )}
      </View>
    </View>
  );
}

/**
 * One overlay control: the glyph twice, cross-faded.
 *
 * The target is the full bar height rather than the glyph's own, which clears 44pt at
 * every text size without the bar growing — the same arrangement every other overlay
 * control in the app uses.
 */
function BarButton({
  icon,
  accessibilityLabel,
  onPress,
  progress,
  onArtwork,
  testID,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  accessibilityLabel: string;
  onPress: () => void;
  progress: Animated.AnimatedInterpolation<number>;
  onArtwork: Animated.AnimatedInterpolation<number> | Animated.AnimatedSubtraction<number>;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={theme.space[2]}
      style={({ pressed }) => [styles.control, pressed && styles.pressed]}
    >
      <Animated.View style={[styles.glyph, { opacity: onArtwork }]}>
        {/* The disc and the light glyph fade together, because they are one treatment:
            a Parchment icon needs the disc and an Ink one on Paper must not have it. */}
        <View style={styles.disc}>
          <Ionicons name={icon} size={theme.layout.icon.md} color={theme.text.inverse} />
        </View>
      </Animated.View>
      <Animated.View style={[styles.glyph, { opacity: progress }]}>
        <Ionicons name={icon} size={theme.layout.icon.lg} color={theme.text.primary} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 },
  ground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.surface.base,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.space[2],
  },
  control: {
    width: theme.layout.minTapTarget,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /**
   * The disc, sized to the glyph rather than to the target.
   *
   * 32pt around a 24pt icon: the touch target is the control's own 44pt box, and a disc
   * that filled it would be a button. The icon steps down to `md` inside the disc and
   * back up to `lg` without one, so the two treatments read at the same visual size.
   */
  disc: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: DISC,
  },
  // Both copies occupy the same box, so the crossfade does not move the glyph by a pixel.
  glyph: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBlock: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
});
