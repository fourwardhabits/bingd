import { Ionicons } from '@expo/vector-icons';
import { fireEvent } from '@testing-library/react-native';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StyleSheet } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { EDIT_ICON_NAME, EditAction, EditIcon } from './EditIcon';

describe('EditIcon and EditAction (B9)', () => {
  it('is the create-outline glyph, never a verb that is not Edit', () => {
    expect(EDIT_ICON_NAME).toBe('create-outline');
    for (const other of ['swap-horizontal-outline', 'add', 'add-circle', 'bookmark-outline', 'share-outline', 'trash-outline']) {
      expect(EDIT_ICON_NAME).not.toBe(other);
    }
  });

  it('draws at the icon scale, Maroon by default', async () => {
    const view = await render(
      <>
        <EditIcon testID="sm" />
        <EditIcon size="md" color={theme.text.primary} testID="md" />
      </>,
    );
    // The jest renderer prints the glyph's code point, in a Text carrying its size and ink.
    const sm = view.getByTestId('sm', { includeHiddenElements: true });
    const md = view.getByTestId('md', { includeHiddenElements: true });
    expect(sm.children).toContain(String.fromCodePoint(Ionicons.glyphMap[EDIT_ICON_NAME] as number));
    expect(StyleSheet.flatten(sm.props.style)).toMatchObject({
      fontSize: theme.layout.icon.sm,
      color: theme.semantic.action,
    });
    expect(StyleSheet.flatten(md.props.style)).toMatchObject({ fontSize: theme.layout.icon.md, color: theme.text.primary });
  });

  it('EditAction is a 44pt labelled button, with an optional word', async () => {
    const onPress = jest.fn();
    const view = await render(
      <EditAction onPress={onPress} accessibilityLabel="Edit your note" label="Edit" testID="edit" />,
    );
    const button = view.getByRole('button', { name: 'Edit your note' });
    const style = StyleSheet.flatten(
      typeof button.props.style === 'function' ? button.props.style({ pressed: false }) : button.props.style,
    );
    expect(style.minWidth).toBe(theme.layout.minTapTarget);
    expect(style.minHeight).toBe(theme.layout.minTapTarget);
    expect(view.getByText('Edit')).toBeTruthy();
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  /**
   * Where the glyph is used, read from the source: the genuine edits use the shared name,
   * and no Rerank / Rank / Add control borrows it.
   */
  it('is used by the genuine Edit entry points and by nothing that ranks', () => {
    const root = join(__dirname, '../../..');
    const read = (path: string) => readFileSync(join(root, path), 'utf8');
    expect(read('src/features/collection/LogSheet.tsx')).toMatch(/icon=\{EDIT_ICON_NAME\}\s+label="Note"/);
    expect(read('app/settings/index.tsx')).toMatch(/icon=\{EDIT_ICON_NAME\}\s+label="Edit Profile"/);
    for (const path of ['src/features/collection/TitleRowActions.tsx', 'src/features/title/TitleActions.tsx']) {
      expect(read(path)).not.toMatch(/EDIT_ICON_NAME|EditIcon|EditAction/);
    }
  });
});
