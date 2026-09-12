import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Share, type ShareAction } from 'react-native';

import { InviteFriendsButton } from './InviteFriendsButton';

/**
 * The button reuses the reviewed invite path and adds nothing of its own: these tests
 * are about the seams — the canonical URL goes out unaltered, a failure keeps its
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

/** A promise the test settles by hand, so a pending mint or an open sheet can be held. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const INVITE_URL = 'https://bingd.app/i/tok123';

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
      message: 'Join me on bingd. https://bingd.app/i/tok123',
      url: 'https://bingd.app/i/tok123',
    });
    share.mockRestore();
  });

  it('treats a cancelled share sheet as nobody’s error', async () => {
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

describe('the label while the share is under way', () => {
  it('reads Opening… only while the link is minted, and Invite friends while the sheet is up', async () => {
    /**
     * `Share.share` settles when the sheet closes, so a label bound to the whole attempt
     * sat behind the open sheet saying "Inviting…" — an invitation nobody had sent.
     * The only wait the button names is the mint, before there is a sheet to show.
     */
    const mint = deferred<string | null>();
    const sheet = deferred<ShareAction>();
    mockCreateInviteLink.mockReturnValue(mint.promise);
    const share = jest.spyOn(Share, 'share').mockReturnValue(sheet.promise);
    const view = await render(<InviteFriendsButton />);
    const neverInviting = () => expect(view.queryByText(/Inviting/)).toBeNull();

    neverInviting();
    await fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));

    // The mint is pending: the one interval with a transient label.
    expect(view.getByRole('button', { name: 'Opening…' })).toBeTruthy();
    expect(share).not.toHaveBeenCalled();
    neverInviting();

    await act(async () => mint.resolve(INVITE_URL));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));

    // The sheet is open and its promise is pending: the button reads as itself.
    expect(view.getByRole('button', { name: 'Invite friends' })).toBeTruthy();
    expect(view.queryByText('Opening…')).toBeNull();
    neverInviting();

    await act(async () => sheet.resolve({ action: 'dismissedAction' }));

    expect(view.getByRole('button', { name: 'Invite friends' })).toBeTruthy();
    neverInviting();
    share.mockRestore();
  });

  it('ignores a tap behind the open sheet, and shares again once it is dismissed', async () => {
    const sheet = deferred<ShareAction>();
    mockCreateInviteLink.mockResolvedValue(INVITE_URL);
    const share = jest
      .spyOn(Share, 'share')
      .mockReturnValueOnce(sheet.promise)
      .mockResolvedValue({ action: 'dismissedAction' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await render(<InviteFriendsButton />);

    await fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));

    // The sheet is still up. A second tap reaches the button and must do nothing.
    await fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));
    expect(mockCreateInviteLink).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);

    await act(async () => sheet.resolve({ action: 'dismissedAction' }));
    expect(view.getByRole('button', { name: 'Invite friends' })).toBeTruthy();

    // Dismissed is not an error, and the control is live again.
    await fireEvent.press(view.getByRole('button', { name: 'Invite friends' }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    expect(mockCreateInviteLink).toHaveBeenCalledTimes(2);
    expect(alert).not.toHaveBeenCalled();
    expect(view.queryByText(/Inviting/)).toBeNull();
    share.mockRestore();
    alert.mockRestore();
  });

  // Last in the file on purpose: two presses fired together are the case most likely to
  // leave the renderer in a state later tests in the same file would inherit.
  it('turns two taps inside one render into one mint and one sheet', async () => {
    /**
     * The old guard read state, and both taps of a fast double tap ran against the same
     * render — two `create_invite_link` calls and two sheets. Firing both presses before
     * either is awaited hands the handler the same props twice, which is that race.
     */
    mockCreateInviteLink.mockResolvedValue(INVITE_URL);
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'dismissedAction' });
    const view = await render(<InviteFriendsButton />);
    const button = view.getByRole('button', { name: 'Invite friends' });

    // React reports the two presses' act scopes as overlapping; that is the point here,
    // and the reverted guard fails this test with two calls of each.
    await Promise.all([fireEvent.press(button), fireEvent.press(button)]);

    await waitFor(() => expect(share).toHaveBeenCalled());
    await waitFor(() => expect(view.getByRole('button', { name: 'Invite friends' })).toBeTruthy());
    expect(mockCreateInviteLink).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);
    share.mockRestore();
  });
});
