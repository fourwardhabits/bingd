import { render } from '@testing-library/react-native';
import { Animated } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { theme } from '@/ui/tokens';

import { TitleTopBar } from './TitleTopBar';

/**
 * The transparent navigation over the title page's hero.
 *
 * What is asserted here is the property the boolean it replaced could not have: that the
 * ground, the compact title and the two icon treatments are **one interpolation**, so
 * they cannot be at different points in the transition. A screenshot cannot say that and
 * a threshold could not deliver it.
 *
 * The screen owns the value; this component owns what it drives. `TitleScreenResilience`
 * covers the other half — that Back is `router.back()` and that the route draws no
 * navigator header at all.
 */

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** The bar at a given point in the fade, as the screen would drive it. */
const at = async (progress: number, props: Partial<Parameters<typeof TitleTopBar>[0]> = {}) => {
  const value = new Animated.Value(progress);
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <TitleTopBar
        progress={value.interpolate({ inputRange: [0, 1], outputRange: [0, 1] })}
        revealed={progress >= 1}
        onBack={props.onBack ?? jest.fn()}
        onMore={props.onMore}
        title={props.title ?? 'Inception'}
        subtitle={props.subtitle ?? null}
      />
    </SafeAreaProvider>,
  );
};

/** A style prop, flattened, whichever form it was passed in. */
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten))
    : ((style ?? {}) as Record<string, unknown>);

/**
 * What an `Animated.Value`-backed opacity currently resolves to.
 *
 * `includeHiddenElements`, because the compact title is deliberately out of the
 * accessibility tree while it is invisible — which is exactly what this library excludes
 * from a query by default, and is itself one of the things asserted below.
 */
type View = Awaited<ReturnType<typeof at>>;
const opacityOf = (view: View, testID: string) => {
  const node = view.getByTestId(testID, { includeHiddenElements: true });
  const value = flatten(node.props.style).opacity as { __getValue?: () => number } | number;
  return typeof value === 'number' ? value : (value?.__getValue?.() ?? NaN);
};

describe('the ground under the chrome', () => {
  it('is fully transparent while the hero is whole', async () => {
    const view = await at(0);

    // The founder's rule: no permanently opaque rectangle over the app's one full-bleed
    // surface. At the top of the page there is nothing behind the controls but artwork
    // and `TitleHero`'s own scrim.
    expect(opacityOf(view, 'title-top-bar-ground')).toBe(0);
  });

  it('is halfway there halfway through, rather than switching', async () => {
    const view = await at(0.5);

    // The property the boolean could not have. A threshold has no middle; this is the
    // middle, and it is what makes the transition read as a response to the scroll.
    expect(opacityOf(view, 'title-top-bar-ground')).toBeCloseTo(0.5);
  });

  it('is an opaque Paper header with its hairline by the time the hero has gone', async () => {
    const view = await at(1);

    const ground = flatten(view.getByTestId('title-top-bar-ground').props.style);
    expect(opacityOf(view, 'title-top-bar-ground')).toBe(1);
    expect(ground.backgroundColor).toBe(theme.surface.base);
    // The rule arrives with the ground rather than being drawn across the artwork on the
    // way, which is why it is on this view and not on the bar.
    expect(ground.borderBottomColor).toBe(theme.border.hairline);
  });
});

describe('the compact title', () => {
  it('is invisible and unannounced while the page is still naming itself', async () => {
    const view = await at(0);

    expect(opacityOf(view, 'title-top-bar-title')).toBe(0);
    // Out of the accessibility tree, not merely transparent: the fade is continuous and
    // the tree is not, so without this a screen reader would meet the title twice on
    // every title page — which is the duplication the detail-header rule exists to stop.
    expect(
      view.getByTestId('title-top-bar-title', { includeHiddenElements: true }).props
        .accessibilityElementsHidden,
    ).toBe(true);
    expect(view.queryByText('Inception')).toBeNull();
  });

  it('is readable, and readable to a screen reader, once the hero has left', async () => {
    const view = await at(1);

    expect(opacityOf(view, 'title-top-bar-title')).toBe(1);
    expect(view.getByText('Inception')).toBeTruthy();
  });

  it('carries a season’s series above its own name', async () => {
    // "Season 2" alone in a bar is not an answer to "where am I", which is why this is
    // the one place in the app where the header is two lines.
    const view = await at(1, { title: 'Season 2', subtitle: 'Parks and Recreation' });

    expect(view.getByText('Parks and Recreation')).toBeTruthy();
    expect(view.getByText('Season 2')).toBeTruthy();
  });
});

/**
 * One render per test, and no `unmount` in the middle of one.
 *
 * This library's `render` returns queries bound to a single shared root, so a second
 * render inside one test is a second copy of the component in one tree — and unmounting
 * the first leaves every query after it looking at something that is no longer there.
 * Two states means two tests.
 */
describe('the controls', () => {
  it('carries Back while the hero is whole', async () => {
    const view = await at(0);

    expect(view.getByTestId('title-back')).toBeTruthy();
  });

  it('still carries Back once the bar has become a header', async () => {
    // "Back remains present and functional throughout" — there is no point in the
    // transition where the way out of the page is missing.
    const view = await at(1);

    expect(view.getByTestId('title-back')).toBeTruthy();
    expect(view.getByLabelText('Back')).toBeTruthy();
  });

  it('crossfades each glyph between the two treatments rather than recolouring it', async () => {
    /**
     * Two copies, stacked, opposite opacities. A colour interpolation would work and
     * would have to run on the JavaScript thread; opacity does not, so the transition
     * keeps up with a page that is also laying out a season's worth of episode stills.
     *
     * The test reads the pair off the control's own children: at either end exactly one
     * of them is drawn, which is what "the icon treatment transitions for contrast"
     * means when the ground behind it has changed colour.
     */
    const view = await at(0);
    const light = view
      .getByTestId('title-back')
      .children.map((child) => flatten((child as never as { props: { style: unknown } }).props.style))
      .map((style) => style.opacity)
      .map((value) =>
        typeof value === 'number'
          ? value
          : ((value as { __getValue?: () => number })?.__getValue?.() ?? NaN),
      );

    expect(light).toHaveLength(2);
    // Over artwork: the light copy is drawn and the Ink one is not.
    expect(light[0]).toBe(1);
    expect(light[1]).toBe(0);
  });

  it('draws no menu control when the screen gives it none', async () => {
    // A series has no menu, and neither does a title nobody has ranked.
    const view = await at(0);

    expect(view.queryByTestId('title-more')).toBeNull();
  });

  it('draws the menu control when the screen gives it one', async () => {
    const view = await at(0, { onMore: jest.fn() });

    expect(view.getByTestId('title-more')).toBeTruthy();
    expect(view.getByLabelText('More options for Inception')).toBeTruthy();
  });
});
