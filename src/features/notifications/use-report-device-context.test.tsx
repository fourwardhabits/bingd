/**
 * `useReportDeviceContext`: once per signed-in account per app run, silently, and never
 * with nothing to say. The server half is `report_device_context` (20260930000100).
 */

import { renderHookWithProviders } from '@/test-utils/render';

import { reportDeviceContext, useReportDeviceContext } from './use-report-device-context';

let mockAuth: { status: string; userId?: string } = { status: 'signed-out' };
const mockRpc = jest.fn();
const mockContext = jest.fn();

jest.mock('@/features/auth', () => ({
  useAuth: () => mockAuth,
}));

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

jest.mock('@/lib/device-context', () => ({
  deviceContext: () => mockContext(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { status: 'signed-out' };
  mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
  mockContext.mockReturnValue({ timezone: 'Europe/Warsaw', region: 'PL' });
});

it('does nothing while signed out', async () => {
  await renderHookWithProviders(() => useReportDeviceContext());
  expect(mockRpc).not.toHaveBeenCalled();
});

it('reports once for a signed-in account, however often the auth object re-renders', async () => {
  mockAuth = { status: 'ready', userId: 'user-1' };
  const { rerender } = await renderHookWithProviders(() => useReportDeviceContext());
  mockAuth = { status: 'ready', userId: 'user-1' };
  await rerender({});
  await rerender({});
  expect(mockRpc).toHaveBeenCalledTimes(1);
  expect(mockRpc).toHaveBeenCalledWith('report_device_context', {
    p_timezone: 'Europe/Warsaw',
    p_region: 'PL',
  });
});

it('reports again for a different account on the same device', async () => {
  mockAuth = { status: 'ready', userId: 'user-1' };
  const { rerender } = await renderHookWithProviders(() => useReportDeviceContext());
  mockAuth = { status: 'signed-out' };
  await rerender({});
  mockAuth = { status: 'ready', userId: 'user-2' };
  await rerender({});
  expect(mockRpc).toHaveBeenCalledTimes(2);
});

it('sends nothing when the device reports neither value', async () => {
  mockContext.mockReturnValue({ timezone: null, region: null });
  await reportDeviceContext();
  expect(mockRpc).not.toHaveBeenCalled();
});

it('swallows a server error and a thrown transport alike', async () => {
  mockRpc.mockResolvedValueOnce({
    data: null,
    error: { code: 'PGRST202', message: 'not found' },
  });
  await expect(reportDeviceContext()).resolves.toBeUndefined();
  mockRpc.mockRejectedValueOnce(new Error('network'));
  await expect(reportDeviceContext()).resolves.toBeUndefined();
});
