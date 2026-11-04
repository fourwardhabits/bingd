import { render } from '@testing-library/react-native';
import { StyleSheet, type TextStyle } from 'react-native';

import { theme } from '../tokens';
import { SectionHeader } from './SectionHeader';

const printed = (text: ReturnType<typeof render> extends Promise<infer V> ? V : never, label: string) =>
  StyleSheet.flatten(text.getByText(label).props.style) as TextStyle;

/**
 * **Reading the string is not enough here, which is how this shipped wrong.**
 *
 * `bingd AWARDS` is the founder's deliberate spelling, and a test reading the text node
 * finds exactly that. The `sectionHeader` token uppercases as a style, so what a reader saw
 * was `BINGD AWARDS`, on every platform, with every test passing. These read the style.
 */
describe('SectionHeader casing', () => {
  it('prints an exact-case title as given, with the token’s uppercasing undone', async () => {
    const view = await render(<SectionHeader title="bingd AWARDS" exactCase />);

    expect(printed(view, 'bingd AWARDS').textTransform).toBe('none');
  });

  it('leaves every other heading uppercase', async () => {
    const view = await render(<SectionHeader title="Top ranked" />);

    expect(printed(view, 'TOP RANKED').textTransform).toBe('uppercase');
  });

  it('gives a screen reader the readable spelling either way', async () => {
    const view = await render(<SectionHeader title="Top ranked" />);

    expect(view.getByLabelText('Top ranked')).toBeTruthy();
  });
});

/**
 * **Two sizes, and the large one is opt-in** (founder final polish, 2026-11-04). The Feed
 * and Profile tabs ask for 15pt by name; every other heading in the app keeps 12pt, so the
 * default is the one that must not move.
 */
describe('SectionHeader sizes', () => {
  it('keeps the standard heading at 12pt', async () => {
    const view = await render(<SectionHeader title="Account" />);
    const style = printed(view, 'ACCOUNT');

    expect(style.fontSize).toBe(12);
    expect(style.lineHeight).toBe(16);
    expect(style.letterSpacing).toBe(0.6);
  });

  it('draws the large heading in Inter Semibold 15, Maroon, uppercase, 0.7 tracking', async () => {
    const view = await render(<SectionHeader title="Trending now" size="large" />);
    const style = printed(view, 'TRENDING NOW');

    expect(style.fontFamily).toBe(theme.typography.sectionHeader.fontFamily);
    expect(style.fontSize).toBe(15);
    expect(style.lineHeight).toBe(20);
    expect(style.letterSpacing).toBe(0.7);
    expect(style.textTransform).toBe('uppercase');
    expect(style.color).toBe(theme.semantic.action);
  });

  it('keeps bingd lower-case at the large size', async () => {
    const view = await render(<SectionHeader title="bingd AWARDS" exactCase size="large" />);
    const style = printed(view, 'bingd AWARDS');

    expect(style.fontSize).toBe(15);
    expect(style.textTransform).toBe('none');
  });
});
