import { Ionicons } from '@expo/vector-icons';
import { within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { paperAlpha, theme } from '@/ui/tokens';

import {
  RANK_LABEL,
  RANK_LABEL_MAX_SCALE,
  RANK_SLOP,
  RANK_VISIBLE_HEIGHT,
  TitleActions,
  titleActionsFit,
} from './TitleActions';

/**
 * **One row: Rank / Log rewatch · Watchlist · Add to List · Recommend** (TV show & season
 * ranking, founder brief §3, 2026-11-14).
 *
 * A layout cannot be measured here, so what is pinned is the contract that makes one row
 * hold at the narrowest phone and the largest text: the cluster never wraps; the labelled
 * control is the only thing that gives width back, and its word stays on one line, grows
 * no further than 1.5x, and past that fits itself to the row rather than being cut; and the
 * icon controls keep fixed boxes whose slop clears the 44pt target.
 */
const action = (label: string, ranked = false) => (
  <TitleActions
    tone="artwork"
    rank={{
      ranked,
      label,
      compact: ranked,
      unclamped: true,
      accessibilityLabel: label,
      onPress: jest.fn(),
    }}
    save={{ accessibilityLabel: 'Save', onPress: jest.fn() }}
    list={{ accessibilityLabel: 'List', onPress: jest.fn() }}
    recommend={{ accessibilityLabel: 'Recommend', onPress: jest.fn() }}
  />
);

describe('the title action cluster', () => {
  it.each([RANK_LABEL.movie, RANK_LABEL.series, RANK_LABEL.season])(
    'keeps "%s" and all three icons on one row',
    async (label) => {
      const view = await renderWithProviders(action(label));
      const cluster = view.getByTestId('title-actions');
      expect(StyleSheet.flatten(cluster.props.style).flexWrap).toBe('nowrap');
      expect(StyleSheet.flatten(cluster.props.style).flexDirection).toBe('row');
      for (const id of ['title-action-save', 'title-action-list', 'title-action-recommend']) {
        expect(within(cluster).getByTestId(id)).toBeTruthy();
      }
    },
  );

  it('fits the word to the row at large text instead of cutting it or wrapping', async () => {
    const view = await renderWithProviders(action('Log rewatch', true));
    const label = view.getByTestId('title-action-rank-label');
    expect(label.props.children).toBe('Log rewatch');
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.adjustsFontSizeToFit).toBe(true);
    expect(label.props.maxFontSizeMultiplier).toBe(RANK_LABEL_MAX_SCALE);
    expect(label.props.minimumFontScale).toBeGreaterThanOrEqual(0.7);
  });

  it('lets only the labelled control give width back', async () => {
    const view = await renderWithProviders(action(RANK_LABEL.season));
    const control = view.getByTestId('title-action-rank');
    const style = StyleSheet.flatten(
      typeof control.props.style === 'function'
        ? control.props.style({ pressed: false })
        : control.props.style,
    );
    expect(style.flexShrink).toBe(1);
    // Its own target never drops below the minimum.
    expect(style.minHeight).toBeGreaterThanOrEqual(theme.layout.minTapTarget - 8);
  });

  it('keeps each icon a fixed box whose slop clears 44pt', async () => {
    const view = await renderWithProviders(action(RANK_LABEL.season));
    for (const id of ['title-action-save', 'title-action-list', 'title-action-recommend']) {
      const icon = view.getByTestId(id);
      const style = StyleSheet.flatten(
        typeof icon.props.style === 'function'
          ? icon.props.style({ pressed: false })
          : icon.props.style,
      );
      expect(
        style.width + icon.props.hitSlop.left + icon.props.hitSlop.right,
      ).toBeGreaterThanOrEqual(44);
      expect(style.height).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    }
  });
});

/**
 * **A lighter filled Rank, the same target** (visual refine, 2026-11-12).
 *
 * The filled Maroon Rank Movie / Rank Show / Rank Season is drawn 8pt shorter than the
 * 44pt target, as the compact Log rewatch already was, and vertical slop gives the 8
 * back. Its word, icon, gap and colour are unchanged, the outlined Ranked and the Log
 * rewatch forms are untouched, and the row still never wraps.
 */
describe('the filled Rank control', () => {
  const unranked = (label: string, tone: 'paper' | 'artwork' = 'paper') => (
    <TitleActions
      tone={tone}
      rank={{
        ranked: false,
        label,
        unclamped: tone === 'artwork',
        accessibilityLabel: label,
        onPress: jest.fn(),
      }}
      save={{ accessibilityLabel: 'Save', onPress: jest.fn() }}
      list={{ accessibilityLabel: 'List', onPress: jest.fn() }}
      recommend={{ accessibilityLabel: 'Recommend', onPress: jest.fn() }}
    />
  );
  const flat = (node: { props: Record<string, unknown> }) =>
    StyleSheet.flatten(
      typeof node.props.style === 'function'
        ? (node.props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : node.props.style,
    ) as Record<string, unknown>;

  it.each([
    ['paper', RANK_LABEL.movie],
    ['paper', RANK_LABEL.series],
    ['paper', RANK_LABEL.season],
    ['artwork', RANK_LABEL.movie],
    ['artwork', RANK_LABEL.series],
    ['artwork', RANK_LABEL.season],
  ] as const)('on %s says "%s" in the same type, icon first', async (tone, label) => {
    const view = await renderWithProviders(unranked(label, tone));
    const control = view.getByTestId('title-action-rank');
    const word = view.getByTestId('title-action-rank-label');
    expect(word.props.children).toBe(label);
    expect(StyleSheet.flatten(word.props.style)).toMatchObject(theme.typography.headline);
    // The icon leads the word, at the small icon size, inside the control. Ionicons draws
    // as a glyph in its icon font, so the first host child is that glyph.
    const [icon, second] = control.children;
    if (!icon || typeof icon === 'string') throw new Error('the control has no icon');
    expect([icon.props.children].flat()[0]).toBe(
      String.fromCodePoint(Ionicons.glyphMap['star-outline'] as number),
    );
    expect(StyleSheet.flatten(icon.props.style)).toMatchObject({
      fontSize: theme.layout.icon.sm,
      color: theme.semantic.actionText,
    });
    expect(second).toBe(word);
    // Filled Maroon, as before.
    const style = flat(control);
    expect(style.backgroundColor).toBe(theme.semantic.action);
    expect(style.gap).toBe(theme.space[2]);
    expect(style.paddingHorizontal).toBe(theme.space[3]);
    expect(style.maxWidth).toBe(
      tone === 'artwork' ? '100%' : theme.layout.control.inlineButtonMaxWidth,
    );
    expect(style.flexShrink).toBe(1);
    expect(style.minWidth).toBeUndefined();
  });

  it('is drawn shorter than 44pt, and its slop makes the target 44pt again', async () => {
    const view = await renderWithProviders(unranked(RANK_LABEL.season));
    const control = view.getByTestId('title-action-rank');
    const style = flat(control);
    expect(style.minHeight).toBe(RANK_VISIBLE_HEIGHT);
    expect(RANK_VISIBLE_HEIGHT).toBe(36);
    expect(control.props.hitSlop).toEqual(RANK_SLOP);
    expect(
      (style.minHeight as number) + control.props.hitSlop.top + control.props.hitSlop.bottom,
    ).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    // No fixed height: a label at the 1.5x cap (a 33pt line) grows the box rather than clip.
    expect(style.height).toBeUndefined();
    expect(theme.typography.headline.lineHeight! * RANK_LABEL_MAX_SCALE).toBeLessThanOrEqual(
      RANK_VISIBLE_HEIGHT,
    );
  });

  it('keeps the icon controls beside it at a 44pt target', async () => {
    const view = await renderWithProviders(unranked(RANK_LABEL.movie));
    for (const id of ['title-action-save', 'title-action-list', 'title-action-recommend']) {
      const icon = view.getByTestId(id);
      const style = flat(icon);
      expect(
        (style.width as number) + icon.props.hitSlop.left + icon.props.hitSlop.right,
      ).toBeGreaterThanOrEqual(44);
      expect(style.height).toBe(theme.layout.minTapTarget);
    }
  });

  it('leaves the outlined Ranked at 44pt with no slop', async () => {
    const view = await renderWithProviders(
      <TitleActions
        rank={{ ranked: true, accessibilityLabel: 'Ranked', onPress: jest.fn() }}
        save={{ accessibilityLabel: 'Save', onPress: jest.fn() }}
        recommend={{ accessibilityLabel: 'Recommend', onPress: jest.fn() }}
      />,
    );
    const control = view.getByTestId('title-action-ranked');
    const style = flat(control);
    expect(style.minHeight).toBe(theme.layout.minTapTarget);
    expect(control.props.hitSlop).toBeUndefined();
    expect(style.backgroundColor).toBe(theme.surface.raised);
    expect(style.borderColor).toBe(theme.semantic.action);
  });

  it('leaves the compact Log rewatch exactly as it was', async () => {
    const view = await renderWithProviders(action('Log rewatch', true));
    const control = view.getByTestId('title-action-ranked');
    const style = flat(control);
    expect(style.minHeight).toBe(theme.layout.minTapTarget - 8);
    expect(style.paddingHorizontal).toBe(theme.space[2] + 2);
    expect(style.gap).toBe(theme.space[1] + 2);
    expect(style.backgroundColor).toBe(paperAlpha(0.08));
    expect(style.borderColor).toBe(paperAlpha(0.5));
    expect(control.props.hitSlop).toEqual({ top: 4, bottom: 4 });
    expect(
      StyleSheet.flatten(view.getByTestId('title-action-rank-label').props.style),
    ).toMatchObject(theme.typography.subhead);
  });

  /**
   * 320pt (SE-class): the classic page moves the row under the poster there, where it has
   * the screen less two gutters, and the Cinematic card is wider still. Every Rank word
   * holds the row at the default size; past that the word fits itself (above), so the
   * cluster never wraps.
   */
  it.each(Object.values(RANK_LABEL))(
    'holds "%s" and three icons on one row at 320pt',
    async (label) => {
      const narrow = 320 - theme.layout.gutter * 2;
      expect(titleActionsFit(narrow, 1, { rank: true, icons: 3, label })).toBe(true);
      const view = await renderWithProviders(unranked(label));
      const cluster = StyleSheet.flatten(view.getByTestId('title-actions').props.style);
      expect(cluster.flexWrap).toBe('nowrap');
    },
  );
});
