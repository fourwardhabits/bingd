import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { fontFamily, theme } from '../tokens';

import { CompanionNames, companionNames, othersLabel, SentenceLink } from './SentenceLink';
import { Text } from './Text';

/**
 * **The pressable phrase in a post's sentence** (founder, 2026-11-19): "and 3 others",
 * "and 1 other", "6 titles" read as links, in the entity treatment, and open the list.
 */

const entity = { fontFamily: fontFamily.sansSemibold, color: theme.text.primary };

describe('the grammar', () => {
  it('is singular at one and plural above it', () => {
    expect(othersLabel(1)).toBe('1 other');
    expect(othersLabel(2)).toBe('2 others');
    expect(othersLabel(12)).toBe('12 others');
  });

  it('names one or two companions and counts the rest', () => {
    expect(companionNames(['Anna'])).toBe('Anna');
    expect(companionNames(['Anna', 'Raj'])).toBe('Anna and Raj');
    expect(companionNames(['Anna', 'Raj', 'Beth'])).toBe('Anna and 2 others');
  });
});

describe('SentenceLink', () => {
  it('is set as an entity — semibold, primary ink — and is a button', async () => {
    const view = await render(
      <Text>
        {'and '}
        <SentenceLink label="3 others" onPress={() => {}} testID="link" />
      </Text>,
    );
    const link = view.getByTestId('link');
    expect(StyleSheet.flatten(link.props.style)).toMatchObject(entity);
    expect(link.props.accessibilityRole).toBe('button');
  });

  it('consumes its own press and nothing around it', async () => {
    const open = jest.fn();
    const around = jest.fn();
    const view = await render(
      <Text onPress={around}>
        {'Ada ranked '}
        <Text onPress={around}>Sheroes</Text>
        {' and '}
        <SentenceLink label="2 more" onPress={open} testID="link" />
      </Text>,
    );
    await fireEvent.press(view.getByTestId('link'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(around).not.toHaveBeenCalled();
  });
});

describe('CompanionNames', () => {
  it('makes the count a link to everyone past two names', async () => {
    const open = jest.fn();
    const view = await render(
      <Text>
        <CompanionNames
          names={['Anna', 'Raj', 'Beth']}
          onPressAll={open}
          entityStyle={entity}
          testID="companions"
        />
      </Text>,
    );
    const link = view.getByTestId('companions');
    expect(link.props.children).toBe('2 others');
    expect(StyleSheet.flatten(link.props.style)).toMatchObject(entity);
    await fireEvent.press(link);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('draws two names, or a surface with no list, as plain entity ink', async () => {
    const two = await render(
      <Text>
        <CompanionNames
          names={['Anna', 'Raj']}
          onPressAll={() => {}}
          entityStyle={entity}
          testID="c"
        />
      </Text>,
    );
    expect(two.queryByTestId('c')).toBeNull();
    expect(two.getByText('Anna and Raj')).toBeTruthy();

    const unwired = await render(
      <Text>
        <CompanionNames names={['Anna', 'Raj', 'Beth']} entityStyle={entity} testID="c" />
      </Text>,
    );
    expect(unwired.queryByTestId('c')).toBeNull();
    expect(unwired.getByText('Anna and 2 others')).toBeTruthy();
  });
});
