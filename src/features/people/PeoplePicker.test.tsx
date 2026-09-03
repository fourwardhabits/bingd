import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { PeoplePicker, filterPeople, type PickerPerson } from './PeoplePicker';

const person = (id: string, username: string, name: string): PickerPerson => ({
  id,
  username,
  name,
  avatarUri: null,
});

const abby = person('u-abby', 'abby', 'Abby');
const john = person('u-john', 'john', 'John');
const maria = person('u-maria', 'maria', 'Maria');
const noor = person('u-noor', 'noor', 'Noor');
const pete = person('u-pete', 'pete', 'Pete');
const quinn = person('u-quinn', 'quinn', 'Quinn');

const people = [abby, john, maria, noor, pete, quinn];

describe('the shared people picker', () => {
  it('renders a checkbox row per person, and the whole row toggles', async () => {
    const onToggle = jest.fn();
    await renderWithProviders(
      <PeoplePicker
        people={people}
        selected={new Set()}
        onToggle={onToggle}
        searchPlaceholder="Search your friends"
      />,
    );

    const row = screen.getByLabelText('Abby, @abby');
    expect(row.props.accessibilityRole).toBe('checkbox');
    expect(row.props.accessibilityState.checked).toBe(false);

    await fireEvent.press(row);
    expect(onToggle).toHaveBeenCalledWith('u-abby');
  });

  it('marks a selected person checked', async () => {
    await renderWithProviders(
      <PeoplePicker
        people={people}
        selected={new Set(['u-john'])}
        onToggle={jest.fn()}
        searchPlaceholder="Search your friends"
      />,
    );

    expect(screen.getByLabelText('John, @john').props.accessibilityState.checked).toBe(true);
    expect(screen.getByLabelText('Abby, @abby').props.accessibilityState.checked).toBe(false);
  });

  it('narrows by name or handle, with the sigil stripped', async () => {
    await renderWithProviders(
      <PeoplePicker
        people={people}
        selected={new Set()}
        onToggle={jest.fn()}
        searchPlaceholder="Search your friends"
      />,
    );

    await fireEvent.changeText(screen.getByPlaceholderText('Search your friends'), '@mar');
    expect(screen.getByLabelText('Maria, @maria')).toBeTruthy();
    expect(screen.queryByLabelText('Abby, @abby')).toBeNull();
  });

  it('says so when the search matches nobody', async () => {
    await renderWithProviders(
      <PeoplePicker
        people={people}
        selected={new Set()}
        onToggle={jest.fn()}
        searchPlaceholder="Search your friends"
      />,
    );

    await fireEvent.changeText(screen.getByPlaceholderText('Search your friends'), 'zz');
    expect(screen.getByText('Nobody by that name.')).toBeTruthy();
  });

  it('freezes every row while disabled', async () => {
    const onToggle = jest.fn();
    await renderWithProviders(
      <PeoplePicker
        people={people}
        selected={new Set()}
        onToggle={onToggle}
        disabled
        searchPlaceholder="Search your friends"
      />,
    );

    await fireEvent.press(screen.getByLabelText('Abby, @abby'));
    expect(onToggle).not.toHaveBeenCalled();
  });

  describe('the pinned self row', () => {
    it('is checked, disabled, and not a way out of the group', async () => {
      await renderWithProviders(
        <PeoplePicker
          people={people}
          selected={new Set()}
          onToggle={jest.fn()}
          pinned={{ name: 'You' }}
          searchPlaceholder="Search your friends"
        />,
      );

      const row = screen.getByLabelText('You');
      expect(row.props.accessibilityRole).toBe('checkbox');
      expect(row.props.accessibilityState.checked).toBe(true);
      expect(row.props.accessibilityState.disabled).toBe(true);
    });

    it('survives a search that matches nobody else', async () => {
      await renderWithProviders(
        <PeoplePicker
          people={people}
          selected={new Set()}
          onToggle={jest.fn()}
          pinned={{ name: 'You' }}
          searchPlaceholder="Search your friends"
        />,
      );

      await fireEvent.changeText(screen.getByPlaceholderText('Search your friends'), 'zz');
      expect(screen.getByLabelText('You')).toBeTruthy();
    });
  });

  describe('the cap', () => {
    it('disables the unselected rows at the cap, counting the pinned seat', async () => {
      const onToggle = jest.fn();
      await renderWithProviders(
        <PeoplePicker
          people={people}
          // Five chosen plus the pinned reader is six: the cap.
          selected={new Set(['u-abby', 'u-john', 'u-maria', 'u-noor', 'u-pete'])}
          onToggle={onToggle}
          pinned={{ name: 'You' }}
          max={6}
          searchPlaceholder="Search your friends"
        />,
      );

      const unchosen = screen.getByLabelText('Quinn, @quinn');
      expect(unchosen.props.accessibilityState.disabled).toBe(true);
      await fireEvent.press(unchosen);
      expect(onToggle).not.toHaveBeenCalled();
    });

    it('keeps the chosen rows tappable at the cap, so somebody can be swapped out', async () => {
      const onToggle = jest.fn();
      await renderWithProviders(
        <PeoplePicker
          people={people}
          selected={new Set(['u-abby', 'u-john', 'u-maria', 'u-noor', 'u-pete'])}
          onToggle={onToggle}
          pinned={{ name: 'You' }}
          max={6}
          searchPlaceholder="Search your friends"
        />,
      );

      await fireEvent.press(screen.getByLabelText('Pete, @pete'));
      expect(onToggle).toHaveBeenCalledWith('u-pete');
    });

    it('leaves every row live below the cap', async () => {
      const onToggle = jest.fn();
      await renderWithProviders(
        <PeoplePicker
          people={people}
          selected={new Set(['u-abby'])}
          onToggle={onToggle}
          pinned={{ name: 'You' }}
          max={6}
          searchPlaceholder="Search your friends"
        />,
      );

      await fireEvent.press(screen.getByLabelText('Quinn, @quinn'));
      expect(onToggle).toHaveBeenCalledWith('u-quinn');
    });
  });
});

describe('filterPeople', () => {
  it('returns everybody for a blank query', () => {
    expect(filterPeople(people, '  ')).toEqual(people);
  });

  it('matches name and handle case-insensitively', () => {
    expect(filterPeople(people, 'ABB')).toEqual([abby]);
    expect(filterPeople(people, 'quin')).toEqual([quinn]);
  });

  it('strips a leading @', () => {
    expect(filterPeople(people, '@noor')).toEqual([noor]);
  });
});
