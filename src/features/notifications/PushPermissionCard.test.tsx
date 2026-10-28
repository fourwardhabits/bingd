import { fireEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { PushPermissionCard } from './PushPermissionCard';

const mockPermission = jest.fn();
const mockRequest = jest.fn();
const mockRegister = jest.fn((_id: string) => Promise.resolve('registered'));
const mockMarkOffered = jest.fn(() => Promise.resolve());

jest.mock('./push', () => ({
  pushPermission: () => mockPermission(),
  requestPushPermission: () => mockRequest(),
}));
jest.mock('./push-permission', () => ({
  registerThisDevice: (id: string) => mockRegister(id),
  markPushOffered: () => mockMarkOffered(),
}));

beforeEach(() => jest.clearAllMocks());

/**
 * The way back from "Not now" (2026-10-28). The card says what the operating system
 * says, offers the request only where the OS can still show one, and otherwise sends the
 * reader to Settings rather than drawing a button that would do nothing.
 */
describe('PushPermissionCard', () => {
  it('says push is on and offers nothing to press when it is granted', async () => {
    mockPermission.mockResolvedValue('granted');
    const view = await renderWithProviders(<PushPermissionCard userId="me" />);
    await waitFor(() => expect(view.getByText('Push notifications are on')).toBeTruthy());
    expect(view.queryByText('Turn on')).toBeNull();
    expect(view.queryByText('Open Settings')).toBeNull();
  });

  it('asks only when pressed, records the offer, and registers this device on a yes', async () => {
    mockPermission.mockResolvedValue('undetermined');
    mockRequest.mockResolvedValue('granted');
    const view = await renderWithProviders(<PushPermissionCard userId="me" />);
    await waitFor(() => expect(view.getByText('Turn on')).toBeTruthy());
    expect(mockRequest).not.toHaveBeenCalled();

    fireEvent.press(view.getByText('Turn on'));
    await waitFor(() => expect(view.getByText('Push notifications are on')).toBeTruthy());
    expect(mockMarkOffered).toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith('me');
  });

  it('sends a blocked reader to Settings instead of asking again', async () => {
    mockPermission.mockResolvedValue('blocked');
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const view = await renderWithProviders(<PushPermissionCard userId="me" />);
    await waitFor(() => expect(view.getByText('Open Settings')).toBeTruthy());
    expect(view.queryByText('Turn on')).toBeNull();
    fireEvent.press(view.getByText('Open Settings'));
    expect(openSettings).toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('draws nothing where push is not possible at all', async () => {
    mockPermission.mockResolvedValue('unavailable');
    const view = await renderWithProviders(<PushPermissionCard userId="me" />);
    await waitFor(() => expect(mockPermission).toHaveBeenCalled());
    expect(view.queryByTestId('push-permission-card')).toBeNull();
  });
});
