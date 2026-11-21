import { Ionicons } from '@expo/vector-icons';
import { render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { Button } from './Button';

/**
 * **A caller's accessibility props never drop the button's own** (design-system v3 A.2 #10).
 *
 * `{...rest}` used to be spread after `accessibilityState`/`accessibilityHint`, so a caller
 * that passed either (the ranking reveal's exits, Keep Show) silently replaced the disabled
 * state and its reason.
 */
describe('Button accessibility', () => {
  it('keeps the caller’s hint while enabled', async () => {
    await render(
      <Button
        label="Keep"
        accessibilityHint="Keeps your show's ranking as it is"
        onPress={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Keep' });

    expect(button.props.accessibilityHint).toBe("Keeps your show's ranking as it is");
    expect(button.props.accessibilityState).toEqual({ disabled: false });
  });

  it('announces the disabled reason over the caller’s hint when disabled', async () => {
    await render(
      <Button
        label="Keep"
        disabled
        disabledReason="Keeping your show score"
        accessibilityHint="Keeps your show's ranking as it is"
        onPress={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Keep' });

    expect(button.props.accessibilityHint).toBe('Keeping your show score');
    expect(button.props.accessibilityState).toEqual({ disabled: true });
  });

  it('falls back to the caller’s hint when disabled without a reason', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await render(
      <Button label="Keep" disabled accessibilityHint="Caller hint" onPress={() => {}} />,
    );

    expect(screen.getByRole('button', { name: 'Keep' }).props.accessibilityHint).toBe(
      'Caller hint',
    );
    warn.mockRestore();
  });

  it('merges the caller’s state with its own disabled flag', async () => {
    await render(
      <Button
        label="Save"
        disabled
        disabledReason="Saving your changes"
        accessibilityState={{ busy: true, selected: false }}
        onPress={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState).toEqual({
      busy: true,
      selected: false,
      disabled: true,
    });
  });

  it('does not let a caller’s state re-enable a disabled button', async () => {
    await render(
      <Button
        label="Save"
        disabled
        disabledReason="Saving your changes"
        accessibilityState={{ disabled: false }}
        onPress={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState).toEqual({
      disabled: true,
    });
  });
});

/**
 * **`sm` reaches the 44pt target by default** (design-system v3 A.2 #7). It draws 36pt and
 * gives 4pt of vertical slop above and below unless the caller passes its own.
 */
describe('Button size="sm" slop', () => {
  const TARGET = theme.layout.minTapTarget;

  it('draws 36pt and answers 44 with no slop from the caller', async () => {
    await render(<Button label="Try again" kind="tertiary" size="sm" onPress={() => {}} />);
    const button = screen.getByRole('button', { name: 'Try again' });
    const drawn = StyleSheet.flatten(button.props.style);

    expect(drawn.minHeight).toBe(36);
    expect(button.props.hitSlop).toEqual({ top: 4, bottom: 4 });
    expect(drawn.minHeight + button.props.hitSlop.top + button.props.hitSlop.bottom).toBe(
      TARGET,
    );
    // Vertical only: horizontal slop would cross into a neighbour in a row of two.
    expect(button.props.hitSlop.left).toBeUndefined();
    expect(button.props.hitSlop.right).toBeUndefined();
  });

  it('adds none to md, which is already 48pt', async () => {
    await render(<Button label="Save" onPress={() => {}} />);
    const button = screen.getByRole('button', { name: 'Save' });

    expect(StyleSheet.flatten(button.props.style).minHeight).toBe(48);
    expect(button.props.hitSlop).toBeUndefined();
  });

  it('lets a caller’s slop win', async () => {
    await render(<Button label="Undo" size="sm" hitSlop={8} onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Undo' }).props.hitSlop).toBe(8);

    await render(
      <Button label="Keep" size="sm" hitSlop={{ top: 6, bottom: 2 }} onPress={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Keep' }).props.hitSlop).toEqual({
      top: 6,
      bottom: 2,
    });
  });
});

/**
 * **A glyph before the label** (title actions polish, 2026-11-21): the small icon,
 * `space[2]` before the word, in the label's own ink. Absent, nothing changes.
 */
describe('Button icon', () => {
  const glyph = (name: keyof typeof Ionicons.glyphMap) =>
    String.fromCodePoint(Ionicons.glyphMap[name] as number);

  it('draws the icon before the word, at the small size, in the fill’s ink', async () => {
    await render(<Button label="Recommend" icon="paper-plane-outline" onPress={() => {}} />);
    const icon = screen.getByText(glyph('paper-plane-outline'), { includeHiddenElements: true });
    expect(StyleSheet.flatten(icon.props.style)).toMatchObject({
      fontSize: theme.layout.icon.sm,
      color: theme.text.inverse,
    });
    // The nearest row above the glyph is the icon-and-word line.
    let node = icon.parent;
    while (node && StyleSheet.flatten(node.props.style)?.flexDirection !== 'row') node = node.parent;
    expect(StyleSheet.flatten(node?.props.style)).toMatchObject({
      flexDirection: 'row',
      gap: theme.space[2],
    });
    expect(node && within(node).getByText('Recommend')).toBeTruthy();
    // The word alone is the spoken name; the glyph is hidden from assistive technology.
    expect(screen.getByRole('button', { name: 'Recommend' }).props.accessibilityLabel).toBe(
      'Recommend',
    );
    expect(icon.props.accessibilityElementsHidden).toBe(true);
  });

  it('inks the icon as the label for a secondary button', async () => {
    await render(
      <Button label="Share off bingd" kind="secondary" icon="share-outline" onPress={() => {}} />,
    );
    expect(StyleSheet.flatten(screen.getByText(glyph('share-outline'), { includeHiddenElements: true }).props.style)).toMatchObject({
      color: theme.text.primary,
    });
  });

  it('keeps the label’s fit rules with an icon beside it', async () => {
    await render(<Button label="Share off bingd" icon="share-outline" fit onPress={() => {}} />);
    const word = screen.getByText('Share off bingd');
    expect(word.props.numberOfLines).toBe(1);
    expect(word.props.adjustsFontSizeToFit).toBe(true);
    expect(word.props.minimumFontScale).toBe(0.85);
    expect(StyleSheet.flatten(word.props.style)).toMatchObject({ flexShrink: 1 });
  });

  it('draws no icon when none is asked for', async () => {
    await render(<Button label="Done" onPress={() => {}} />);
    expect(screen.queryByText(glyph('paper-plane-outline'), { includeHiddenElements: true })).toBeNull();
  });
});
