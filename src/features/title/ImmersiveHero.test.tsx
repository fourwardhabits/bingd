import { fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { paperAlpha, theme } from '@/ui/tokens';

import { ImmersiveHero, bandHeight } from './ImmersiveHero';

/**
 * **The opening screen** (founder, UI cohesion pass, 2026-11-06): one viewport holding the
 * artwork, the floating module and a quiet chevron, with the picture continuing behind
 * the module to the foot of the screen and About below the fold.
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

describe('the opening screen', () => {
  it('is at least as tall as the visible area it is given', async () => {
    const view = await draw({ viewportHeight: 812 });
    expect(style(view.getByTestId('immersive-hero')).minHeight).toBe(812);
  });

  it('holds the module, then spare space, then the chevron, in that order', async () => {
    const view = await draw({ onPressMore: () => {} });
    const tree = JSON.stringify(view.toJSON());
    const at = (id: string) => tree.indexOf(`"testID":"${id}"`);
    expect(at('immersive-space-above')).toBeLessThan(at('immersive-module'));
    expect(at('immersive-module')).toBeLessThan(at('immersive-space-below'));
    expect(at('immersive-space-below')).toBeLessThan(at('immersive-more'));
    // More of the spare height above the module than below it.
    expect(style(view.getByTestId('immersive-space-above')).flexGrow).toBeGreaterThan(
      style(view.getByTestId('immersive-space-below')).flexGrow as number,
    );
    expect(within(view.getByTestId('immersive-module')).getByText('Module contents')).toBeTruthy();
  });

  it('keeps the module 12pt in from each edge', async () => {
    const view = await draw();
    expect(style(view.getByTestId('immersive-module-row')).paddingHorizontal).toBe(theme.space[3]);
  });

  it('scrolls on from the chevron, which is a labelled 44pt control', async () => {
    const onPressMore = jest.fn();
    const view = await draw({ onPressMore });
    const more = view.getByRole('button', { name: 'More about this title' });
    const box = style(more);
    expect(box.width).toBe(44);
    expect(box.height).toBe(44);
    await fireEvent.press(more);
    expect(onPressMore).toHaveBeenCalledTimes(1);
  });

  it('draws the chevron as a hint only when there is nowhere to scroll it to', async () => {
    const view = await draw();
    expect(view.queryByRole('button', { name: 'More about this title' })).toBeNull();
    expect(view.getByTestId('immersive-more', { includeHiddenElements: true })).toBeTruthy();
  });

  it('reports where the module starts, for the top bar', async () => {
    const onModuleTop = jest.fn();
    const view = await draw({ onModuleTop });
    fireEvent(view.getByTestId('immersive-module-row'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 301.4, width: 360, height: 340 } },
    });
    expect(onModuleTop).toHaveBeenCalledWith(301);
  });
});

describe('the picture behind it', () => {
  it('continues the artwork from the band to the foot of the screen, mirrored and softened', async () => {
    const view = await draw();
    const band = style(view.getByTestId('immersive-art')).height as number;
    const field = style(view.getByTestId('immersive-extension'));
    expect(field.top).toBe(band);
    expect(field.bottom).toBe(0);

    const image = view.getByTestId('immersive-extension-image');
    expect(image.props.blurRadius).toBeGreaterThan(0);
    expect(style(image).transform).toEqual([{ scaleY: -1 }]);
    expect(view.getByTestId('immersive-band-fade')).toBeTruthy();
    expect(view.getByTestId('immersive-field-seam')).toBeTruthy();
  });

  it('uses the poster the same way for a poster-only title', async () => {
    const view = await draw({ artwork: POSTER as never, posterUri: POSTER.uri });
    expect(view.getByTestId('immersive-poster')).toBeTruthy();
    expect(JSON.stringify(view.getByTestId('immersive-extension-image').props.source)).toContain(
      POSTER.uri,
    );
  });

  it('falls back to Parchment with no artwork, and a chevron that reads on it', async () => {
    const view = await draw({ artwork: NONE as never, onPressMore: () => {} });
    expect(view.queryByTestId('immersive-extension-image')).toBeNull();
    expect(view.queryByTestId('immersive-band-fade')).toBeNull();
    const glyph = view.getByTestId('immersive-more-glyph');
    expect(style(glyph).color ?? glyph.props.color).toBe(theme.text.secondary);
  });

  it('draws the chevron in Paper over artwork', async () => {
    const view = await draw({ onPressMore: () => {} });
    const glyph = view.getByTestId('immersive-more-glyph');
    expect(style(glyph).color ?? glyph.props.color).toBe(paperAlpha(0.88));
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
