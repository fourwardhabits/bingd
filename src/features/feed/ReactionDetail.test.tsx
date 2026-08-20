import { fireEvent } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { ReactionDetail } from './ReactionDetail';
import type { ReactionSummary } from './use-reactions';

const person = (name: string, kind: ReactionSummary['people'][number]['kind']) => ({
  userId: `${name}-id`,
  username: name.toLowerCase(),
  name,
  avatarUri: null,
  kind,
});

const summary: ReactionSummary = {
  total: 4,
  mine: 'love',
  kinds: ['love', 'funny'],
  byKind: { love: 3, funny: 1 },
  people: [
    person('Zoe', 'love'),
    person('Anna', 'love'),
    person('Beth', 'love'),
    person('Raj', 'funny'),
  ],
};

const open = (over: Partial<ReactionSummary> = {}, onPressPerson = jest.fn()) =>
  renderWithProviders(
    <ReactionDetail
      summary={{ ...summary, ...over }}
      onClose={() => {}}
      onPressPerson={onPressPerson}
    />,
  );

/**
 * Who reacted, and with what.
 *
 * Founder decision, 2026-08-16: everyone the viewer is authorised to see is named —
 * no friend-only masking. That rests on the read having been authorised already, so
 * the property this suite holds is that the surface *shows what it was given* and
 * invents nothing: no filtering of its own, no anonymous placeholder, and no total
 * that disagrees with the list under it.
 */
describe('the filters', () => {
  it('offers All with the total, and each reaction with its own count', async () => {
    const view = await open();

    expect(view.getByLabelText('All, 4')).toBeTruthy();
    expect(view.getByLabelText('Love, 3')).toBeTruthy();
    expect(view.getByLabelText('Funny, 1')).toBeTruthy();
  });

  it('does not offer a reaction nobody used', async () => {
    const view = await open();
    expect(view.queryByLabelText(/^Disagree/)).toBeNull();
  });

  it('narrows the list to the reaction chosen', async () => {
    const view = await open();
    expect(view.getByText('Raj')).toBeTruthy();

    await fireEvent.press(view.getByLabelText('Love, 3'));

    expect(view.queryByText('Raj')).toBeNull();
    expect(view.getByText('Zoe')).toBeTruthy();
  });

  it('goes back to everyone on All', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText('Love, 3'));
    await fireEvent.press(view.getByLabelText('All, 4'));

    expect(view.getByText('Raj')).toBeTruthy();
  });
});

describe('the people', () => {
  it('names each one and says which reaction they used', async () => {
    const view = await open();
    expect(view.getByLabelText('Raj, reacted Funny. Open their profile.')).toBeTruthy();
  });

  it('opens a profile when tapped', async () => {
    const onPressPerson = jest.fn();
    const view = await open({}, onPressPerson);

    await fireEvent.press(view.getByLabelText('Anna, reacted Love. Open their profile.'));

    // The username, because that is what the route takes — and the profile it
    // opens applies its own access rules. Appearing here is not a key to anything.
    expect(onPressPerson).toHaveBeenCalledWith('anna');
  });

  it('says how many were counted but could not be named', async () => {
    // The count comes from the reaction row and the name from a profile embed, and
    // the second can be withheld when the first was not. A list quietly shorter
    // than the total above it is worse than saying so.
    const view = await open({ total: 6 });
    expect(view.getByText('2 more not shown')).toBeTruthy();
  });

  it('does not claim a residual when everyone is named', async () => {
    const view = await open();
    expect(view.queryByText(/more not shown/)).toBeNull();
  });
});
