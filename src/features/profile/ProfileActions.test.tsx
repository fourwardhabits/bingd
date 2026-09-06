import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { Button } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { ProfileActions } from './ProfileActions';

/**
 * The profile's header row: `[ Share Profile ] [ Invite friends ]`.
 *
 * **Two defects paid for this file, and they still apply to the row's new contents.**
 *
 * The first was a label on two lines, photographed on a physical iPhone. The row is two
 * equal halves inside the page gutter; at 375pt each half is 167pt, and a label at `md`
 * — 17pt semibold plus `space[5]` of padding either side — needs about 162. It fitted by
 * five points on the founder's device and did not fit at all on the narrower widths this
 * app supports, or at any Dynamic Type size above default, so the button wrapped and
 * grew to 68pt beside a 48pt neighbour. `Button`'s `fit` caps the line, shrinks rather
 * than clips, and trims the side padding so the shrink almost never engages.
 *
 * The second was drift. Each profile screen drew this pair itself, so the same object
 * was filled Maroon on the owner's profile and outlined grey on everybody else's — one
 * tap apart. The row is a component now and neither screen has an opinion about it.
 *
 * **What changed on 2026-09-06.** The trailing half was `bingd. Awards`, which now has a
 * section of its own on the profile with its own See all into the same sheet — so the
 * button was a duplicate affordance holding the more valuable of the two slots. Invite
 * friends came up out of the full-width row beneath it and took the place.
 *
 * The trailing half is a slot rather than a fixed button, because it is the one thing in
 * this row that depends on who is looking: Invite friends on your own profile, nothing
 * at all on somebody else's. A stub stands in for it here — `InviteFriendsButton` mints
 * a real invite link when pressed and has tests of its own — so that these assertions
 * are about the row.
 */

const invite = <Button label="Invite friends" fit onPress={() => {}} />;

const open = () => render(<ProfileActions onShare={() => {}} trailing={invite} />);
const openAlone = () => render(<ProfileActions onShare={() => {}} />);

type View = Awaited<ReturnType<typeof open>>;

const trailing = (view: View) => view.getByRole('button', { name: 'Invite friends' });
const share = (view: View) => view.getByRole('button', { name: 'Share Profile' });

/** The label node inside a button, which is where the line rules live. */
const labelOf = (view: View, label: string) => view.getByText(label);

describe('the row survives a narrow phone', () => {
  it('will not wrap either label to a second line', async () => {
    const view = await open();

    // The founder's screenshot, as a rule. One line, always.
    expect(labelOf(view, 'Share Profile').props.numberOfLines).toBe(1);
    expect(labelOf(view, 'Invite friends').props.numberOfLines).toBe(1);
  });

  it('shrinks rather than clipping when the column is too narrow', async () => {
    const view = await open();
    const label = labelOf(view, 'Share Profile');

    // `numberOfLines` alone truncates, which trades a two-line button for "Share Prof…".
    // Neither is acceptable, so the type scales instead.
    expect(label.props.adjustsFontSizeToFit).toBe(true);
    expect(label.props.minimumFontScale).toBe(0.85);
  });

  it('keeps the shrink from engaging at ordinary widths, by giving the label room', async () => {
    const view = await open();
    const style = StyleSheet.flatten(share(view).props.style);

    // 24pt of side padding rather than 40 is what makes the label fit at its natural
    // size down to about 330pt. A floor of 0.85 that had to work at every width would
    // be a visibly smaller button.
    expect(style.paddingHorizontal).toBe(theme.space[3]);
    expect(style.paddingHorizontal).toBeLessThan(theme.space[5]);
  });

  it('does not scale so far that the pair stops matching', async () => {
    const view = await open();

    // Below 85% one label reads visibly smaller than the other beside it, which is the
    // defect this is fixing rather than a smaller version of it. A label that cannot fit
    // at 85% is too long for this slot, and that is a copy decision.
    expect(labelOf(view, 'Share Profile').props.minimumFontScale).toBeGreaterThanOrEqual(0.85);
  });
});

describe('one treatment for one object', () => {
  it('outlines Share and lets the trailing act take the fill', async () => {
    const view = await open();

    // One filled control per row. The fill is the only thing on a profile competing with
    // the poster wall below it, so it is spent on the growth act — Share Profile is what
    // you do with people who are already here, Invite friends is how anybody new
    // arrives.
    expect(StyleSheet.flatten(share(view).props.style).backgroundColor).toBe(
      theme.surface.raised,
    );
    expect(StyleSheet.flatten(trailing(view).props.style).backgroundColor).toBe(
      theme.semantic.action,
    );
  });

  it('keeps the two the same height', async () => {
    const view = await open();

    // A wrapped label is what made them different heights. This is the assertion that
    // would have caught the founder's screenshot.
    const a = StyleSheet.flatten(share(view).props.style);
    const b = StyleSheet.flatten(trailing(view).props.style);
    expect(a.minHeight).toBe(b.minHeight);
    expect(a.minHeight).toBe(theme.layout.buttonMinHeight);
  });

  it('orders Share first and the trailing act second', async () => {
    const view = await open();

    // Share Profile is what a profile is *for* — the thing you hand somebody so they can
    // follow you. Both screens read the same way because both render this component.
    // `Button` takes its accessible name from the label it renders, so the order is
    // read off the rendered text rather than off a prop nothing sets.
    const labels = view
      .getAllByText(/^(Share Profile|Invite friends)$/)
      .map((node) => node.props.children);
    expect(labels).toEqual(['Share Profile', 'Invite friends']);
  });

  it('gives the two equal halves of the row', async () => {
    const view = await open();

    for (const button of [share(view), trailing(view)]) {
      expect(StyleSheet.flatten(button.parent?.props?.style).flex).toBe(1);
    }
  });
});

describe('somebody else’s profile, where there is nothing to invite them to', () => {
  it('draws Share alone rather than half a row and a gap', async () => {
    const view = await openAlone();

    expect(view.queryByRole('button', { name: 'Invite friends' })).toBeNull();
    expect(view.getByRole('button', { name: 'Share Profile' })).toBeTruthy();
  });

  it('still gives Share its own flexed half, so the row is one full-width control', async () => {
    const view = await openAlone();

    // `flex: 1` with one child is the whole row. The half is not conditional — a
    // slot that changed its own layout when its sibling vanished is a second layout
    // to keep correct.
    expect(StyleSheet.flatten(share(view).parent?.props?.style).flex).toBe(1);
  });
});
