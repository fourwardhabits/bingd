import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '@/ui/tokens';

import { ProfileActions } from './ProfileActions';

/**
 * **`bingd. Awards` on two lines, photographed on a physical iPhone.**
 *
 * The row is two equal halves inside the page gutter. At 375pt each half is 167pt, and
 * the label at `md` — 17pt semibold plus `space[5]` of padding either side — needs about
 * 162. It fitted by five points on the founder's device and did not fit at all on the
 * narrower widths this app supports, or at any Dynamic Type size above default. So the
 * button wrapped to two lines and grew to 68pt beside a 48pt Share Profile.
 *
 * The label is not the thing to change: it is the product's name and it is on the sheet
 * the button opens. What changed is `Button`'s `fit`, which caps the line, shrinks
 * rather than clips, and trims the side padding so the shrink almost never engages.
 *
 * The second defect in the same row was drift. Each profile screen drew this pair
 * itself, so Awards was filled Maroon on the owner's and outlined grey on everybody
 * else's — the same object in two treatments, one tap apart. The row is a component now,
 * and neither screen has an opinion about it.
 */

// Every query in this library is async as of v14, so the render has to be awaited or
// assertions run against a tree that was never given the chance to update.
const open = () => render(<ProfileActions onShare={() => {}} onOpenAwards={() => {}} />);

type View = Awaited<ReturnType<typeof open>>;

const awards = (view: View) => view.getByRole('button', { name: 'bingd. Awards' });
const share = (view: View) => view.getByRole('button', { name: 'Share Profile' });

/** The label node inside a button, which is where the line rules live. */
const labelOf = (view: View, label: string) => view.getByText(label);

describe('the awards button survives a narrow phone', () => {
  it('will not wrap to a second line', async () => {
    const view = await open();

    // The founder's screenshot, as a rule. One line, always.
    expect(labelOf(view, 'bingd. Awards').props.numberOfLines).toBe(1);
  });

  it('shrinks rather than clipping when the column is too narrow', async () => {
    const view = await open();
    const label = labelOf(view, 'bingd. Awards');

    // `numberOfLines` alone truncates, which trades a two-line button for "bingd. Awa…".
    // Neither is acceptable, so the type scales instead.
    expect(label.props.adjustsFontSizeToFit).toBe(true);
    expect(label.props.minimumFontScale).toBe(0.85);
  });

  it('keeps the shrink from engaging at ordinary widths, by giving the label room', async () => {
    const view = await open();
    const style = StyleSheet.flatten(awards(view).props.style);

    // 24pt of side padding rather than 40 is what makes the label fit at its natural
    // size down to about 330pt. A floor of 0.85 that had to work at every width would
    // be a visibly smaller button.
    expect(style.paddingHorizontal).toBe(theme.space[3]);
    expect(style.paddingHorizontal).toBeLessThan(theme.space[5]);
  });

  it('does not scale so far that the pair stops matching', async () => {
    const view = await open();

    // Below 85% the label reads visibly smaller than Share Profile beside it, which is
    // the defect this is fixing rather than a smaller version of it. A label that cannot
    // fit at 85% is too long for this slot, and that is a copy decision.
    expect(labelOf(view, 'bingd. Awards').props.minimumFontScale).toBeGreaterThanOrEqual(0.85);
  });

  it('applies the same treatment to Share Profile, so the two stay a pair', async () => {
    const view = await open();

    expect(labelOf(view, 'Share Profile').props.numberOfLines).toBe(1);
    expect(StyleSheet.flatten(share(view).props.style).paddingHorizontal).toBe(theme.space[3]);
  });
});

describe('one treatment for one object', () => {
  it('fills Awards in maroon and outlines Share', async () => {
    const view = await open();

    // Awards is the fun one and Share is the useful one; a row of two identical outlined
    // buttons says neither. The fill is the only thing on a profile competing with the
    // poster wall below it, so it is spent on the control meant to be tempting.
    expect(StyleSheet.flatten(awards(view).props.style).backgroundColor).toBe(
      theme.semantic.action,
    );
    expect(StyleSheet.flatten(share(view).props.style).backgroundColor).toBe(
      theme.surface.raised,
    );
  });

  it('keeps Awards the same height as Share', async () => {
    const view = await open();

    // The wrap is what made them different heights. This is the assertion that would
    // have caught the founder's screenshot.
    const a = StyleSheet.flatten(awards(view).props.style);
    const b = StyleSheet.flatten(share(view).props.style);
    expect(a.minHeight).toBe(b.minHeight);
    expect(a.minHeight).toBe(theme.layout.buttonMinHeight);
  });

  it('orders Share first and Awards second', async () => {
    const view = await open();

    // Share Profile is what a profile is *for* — the thing you hand somebody so they can
    // follow you. Both screens read the same way because both render this component.
    // `Button` takes its accessible name from the label it renders, so the order is
    // read off the rendered text rather than off a prop nothing sets.
    const labels = view
      .getAllByText(/^(Share Profile|bingd. Awards)$/)
      .map((node) => node.props.children);
    expect(labels).toEqual(['Share Profile', 'bingd. Awards']);
  });

  it('gives the two equal halves of the row', async () => {
    const view = await open();

    for (const button of [share(view), awards(view)]) {
      expect(StyleSheet.flatten(button.parent?.props?.style).flex).toBe(1);
    }
  });
});
