import { render } from '@testing-library/react-native';
import { StyleSheet, type TextStyle } from 'react-native';

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

describe('SectionHeader at large text', () => {
  it('lets a long title wrap beside its action, which keeps its whole width', async () => {
    // At 200% text on a 320pt phone, "bingd Awards" in title2 plus See all is wider than
    // the screen. The heading must be the thing that gives, never the control.
    const view = await render(
      <SectionHeader title="bingd Awards" level="title" actionLabel="See all" onPressAction={() => {}} />,
    );

    const heading = view.getByTestId('section-header-title');
    expect(StyleSheet.flatten(heading.props.style)).toMatchObject({ flexShrink: 1 });
    const action = view.getByRole('button');
    expect(StyleSheet.flatten(action.props.style)).toMatchObject({ flexShrink: 0 });
  });
});
