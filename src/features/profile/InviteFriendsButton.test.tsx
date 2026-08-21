import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';

import { InviteFriendsButton } from './InviteFriendsButton';

/**
 * The button reuses the reviewed invite path and adds nothing of its own: these tests
 * are about the seams â€” the canonical URL goes out unaltered, a failure keeps its
 * operation id for the retry, and a success releases it so the next tap is a new
 * decision in the creation log.
 */
const mockCreateInviteLink = jest.fn();
jest.mock('@/features/recommendations/use-recommend', () => ({
  createInviteLink: (...args: unknown[]) => mockCreateInviteLink(...args),
}));

let mockMinted = 0;
jest.mock('@/features/collection/writes', () => ({
  newOperationId: () => `op-${++mockMinted}`,
}));

beforeEach(() => {
  mockCreateInviteLink.mockReset();
  mockMinted = 0;
});

describe('Invite friends', () => {
  it('shares the canonical invite URL from the existing creation path', async () => {
    mockCreateInviteLink.mockResolvedValue('https://bingd.app/i/tok123');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const view = await render(<InviteFriendsButton />);

    fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));

    // No title attached, and the surface names where the share began.
    await waitFor(() => expect(mockCreateInviteLink).toHaveBeenCalledWith(null, 'op-1', 'profile'));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(share).toHaveBeenCalledWith({
      message: 'Join me on Bingd: https://bingd.app/i/tok123',
      url: 'https://bingd.app/i/tok123',
    });
    share.mockRestore();
  });

  it('treats a cancelled share sheet as nobodyâ€™s error', async () => {
    mockCreateInviteLink.mockResolvedValue('https://bingd.app/i/tok123');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'dismissedAction' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await render(<InviteFriendsButton />);

    fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));

    await waitFor(() => expect(share).toHaveBeenCalled());
    // No alert, no success message: opening a sheet is not an invitation sent, and
    // closing one is not a failure.
    expect(alert).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByRole('button', { name: 'Invite friends' })).toBeTruthy());
    share.mockRestore();
    alert.mockRestore();
  });

  it('says so when the link cannot be minted, and never opens the sheet without one', async () => {
    mockCreateInviteLink.mockResolvedValue(null);
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await render(<InviteFriendsButton />);

    fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));

    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith('Could not get your invite link', expect.any(String)),
    );
    // The link is the point of the control; there is nothing to degrade to.
    expect(share).not.toHaveBeenCalled();
    share.mockRestore();
    alert.mockRestore();
  });

  it('holds one operation id across a failed attempt and its retry', async () => {
    // The creation may have committed while its reply was lost. A retry carrying a
    // fresh id would record a second creation for one intent (`createInviteLink`'s
    // own contract); carrying the same id lets `_claim_operation` answer it.
    mockCreateInviteLink.mockResolvedValueOnce(null);
    mockCreateInviteLink.mockResolvedValueOnce('https://bingd.app/i/tok123');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await render(<InviteFriendsButton />);

    fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));
    await waitFor(() => expect(alert).toHaveBeenCalled());

    fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));
    await waitFor(() => expect(share).toHaveBeenCalled());

    expect(mockCreateInviteLink).toHaveBeenNthCalledWith(1, null, 'op-1', 'profile');
    expect(mockCreateInviteLink).toHaveBeenNthCalledWith(2, null, 'op-1', 'profile');
    share.mockRestore();
    alert.mockRestore();
  });

  it('mints a fresh id once a link came back, so a later tap is a new decision', async () => {
    mockCreateInviteLink.mockResolvedValue('https://bingd.app/i/tok123');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const view = await render(<InviteFriendsButton />);

    fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));

    expect(mockCreateInviteLink).toHaveBeenNthCalledWith(1, null, 'op-1', 'profile');
    expect(mockCreateInviteLink).toHaveBeenNthCalledWith(2, null, 'op-2', 'profile');
    share.mockRestore();
  });
});
