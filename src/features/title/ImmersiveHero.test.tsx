import { render } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { theme } from '@/ui/tokens';

import {
  ImmersiveHero,
  SHEET_CONTENT_INSET,
  SHEET_INSET,
  bandHeight,
  moduleOverlap,
} from './ImmersiveHero';

/**
 * **The Cinematic title page's head** (founder direction, title-page sprint, 2026-11-06):
 * the large sharp artwork, the Paper module overlapping its lower part, and nothing else —
 * no blurred extension, no filler height, no chevron. The page goes on from the module on
 * the same Paper.
 */

const BACKDROP = { treatment: 'backdrop', uri: 'https://image.tmdb.org/t/p/w1280/b.jpg' } as const;
const POSTER = { treatment: 'poster', uri: 'https://image.tmdb.org/t/p/w500/p.jpg' } as const;
const NONE = { treatment: 'poster', uri: null } as const;

const draw = (props: Partial<React.ComponentProps<typeof ImmersiveHero>> = {}) =>
  render(
    <ImmersiveHero
      artwork={BACKDROP as never}
      posterUri={null}
      title="Dune: Part Two"
      topInset={24}
      viewportHeight={760}
      {...props}
    >
      <Text>Module contents</Text>
    </ImmersiveHero>,
  );

const style = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

describe('the head of the page', () => {
  it('is the sharp band and the module, and nothing to fill the rest of the screen', async () => {
    const view = await draw();

    expect(view.getByTestId('immersive-art')).toBeTruthy();
    expect(view.getByTestId('immersive-module')).toBeTruthy();
    // The blurred field, its cross-fade, the band's dark foot and the chevron are gone.
    for (const gone of [
      'immersive-extension',
      'immersive-extension-image',
      'immersive-crossfade-48',
      'immersive-band-fade',
      'immersive-field-seam',
      'immersive-more',
      'immersive-space-above',
      'immersive-space-below',
    ]) {
      expect(view.queryByTestId(gone)).toBeNull();
    }
    // As tall as its contents: no floor of a whole viewport.
    expect(style(view.getByTestId('immersive-hero')).minHeight).toBeUndefined();
  });

  it('draws the backdrop once, sharp', async () => {
    const view = await draw();
    type Node = { props?: Record<string, unknown>; children?: (Node | string)[] | null };
    const found: Record<string, unknown>[] = [];
    const walk = (node: Node | string | null) => {
      if (!node || typeof node === 'string') return;
      const source = node.props?.source as { uri?: string } | { uri?: string }[] | undefined;
      const uris = Array.isArray(source) ? source.map((s) => s.uri) : [source?.uri];
      if (uris.includes(BACKDROP.uri)) found.push(node.props!);
      for (const child of node.children ?? []) walk(child);
    };
    walk(view.toJSON() as Node);

    expect(found).toHaveLength(1);
    expect(found[0]!.blurRadius ?? 0).toBe(0);
  });

  it('rises the module over the band’s lower 22%, whatever the band’s height', async () => {
    const view = await draw();
    const band = style(view.getByTestId('immersive-art')).height as number;
    const row = style(view.getByTestId('immersive-module-row'));

    expect(row.marginTop).toBe(-moduleOverlap(band));
    for (const height of [250, 284, 324]) {
      const share = moduleOverlap(height) / height;
      expect(share).toBeGreaterThanOrEqual(0.2);
      expect(share).toBeLessThanOrEqual(0.25);
    }
  });

  it('keeps the module 12pt in from each edge, its content on the page’s one content line', async () => {
    const view = await draw();
    expect(style(view.getByTestId('immersive-module-row')).paddingHorizontal).toBe(SHEET_INSET);
    expect(SHEET_INSET).toBe(12);
    expect(SHEET_INSET + (style(view.getByTestId('immersive-module')).paddingHorizontal as number)).toBe(
      SHEET_CONTENT_INSET,
    );
  });

  /**
   * The title card (final title refinement, 2026-11-06): Paper, rounded all round and closed
   * by one hairline, with no shadow, so the full-width page under it reads as the page.
   */
  it('is a Paper card closed by one hairline, with no shadow', async () => {
    const module = style((await draw()).getByTestId('immersive-module'));

    expect(module.backgroundColor).toBe(theme.surface.base);
    expect(module.borderRadius).toBe(theme.radius.card);
    expect(module.borderColor).toBe(theme.border.hairline);
    expect(module.borderWidth).toBeGreaterThan(0);
    expect(module.borderWidth).toBeLessThanOrEqual(1);
    expect(module.elevation).toBeUndefined();
    expect(module.shadowOpacity).toBeUndefined();
  });

  it('reports where the module starts, for the top bar', async () => {
    const onModuleTop = jest.fn();
    const view = await draw({ onModuleTop });

    view.getByTestId('immersive-module-row').props.onLayout({
      nativeEvent: { layout: { y: 222.4, height: 300, x: 0, width: 360 } },
    });
    expect(onModuleTop).toHaveBeenCalledWith(222);
  });
});

describe('a title without a backdrop', () => {
  it('stands a sharp poster on its own soft ground, under the bar', async () => {
    const view = await draw({ artwork: POSTER as never, posterUri: POSTER.uri });
    expect(view.getByTestId('immersive-poster')).toBeTruthy();
    expect(view.queryByTestId('immersive-extension')).toBeNull();
  });

  it('falls back to Parchment and the initials frame with no artwork', async () => {
    const view = await draw({ artwork: NONE as never });
    expect(view.getByTestId('immersive-poster')).toBeTruthy();
    expect(style(view.getByTestId('immersive-art')).backgroundColor).toBe(theme.surface.sunken);
  });
});

describe('the sharp band', () => {
  const barBand = 24 + 56;

  it('is 16:9 made a quarter taller on a short screen', () => {
    expect(bandHeight({ treatment: 'backdrop', width: 360, viewport: 560, barBand })).toBe(253);
  });

  it('grows toward 40% of a tall screen, but never past 1.4x the 16:9 frame', () => {
    expect(bandHeight({ treatment: 'backdrop', width: 360, viewport: 690, barBand })).toBe(276);
    expect(bandHeight({ treatment: 'backdrop', width: 360, viewport: 900, barBand })).toBe(284);
    expect(bandHeight({ treatment: 'backdrop', width: 412, viewport: 915, barBand })).toBe(324);
  });

  it('keeps room for the bar and some picture on a very wide, short screen', () => {
    expect(bandHeight({ treatment: 'backdrop', width: 320, viewport: 480, barBand })).toBe(
      barBand + 145,
    );
  });

  it('stands a poster under the bar, whatever the screen', () => {
    const poster = bandHeight({ treatment: 'poster', width: 360, viewport: 900, barBand });
    expect(poster).toBe(barBand + theme.poster.detail.height + 56);
  });
});
