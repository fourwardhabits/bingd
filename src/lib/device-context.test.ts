/**
 * The device timezone and region release awareness reports (founder decision 5: a
 * timezone is never guessed). Unlike `watchRegion`, nothing here falls back to a default:
 * unknown must reach the server as unknown.
 */

import { deviceContext } from './device-context';

const mockGetCalendars = jest.fn();
const mockGetLocales = jest.fn();
jest.mock('expo-localization', () => ({
  getCalendars: () => mockGetCalendars(),
  getLocales: () => mockGetLocales(),
}));

beforeEach(() => {
  mockGetCalendars.mockReset();
  mockGetLocales.mockReset();
});

it('reports the device zone and region as the device states them', () => {
  mockGetCalendars.mockReturnValue([{ timeZone: 'Europe/Warsaw' }]);
  mockGetLocales.mockReturnValue([{ regionCode: 'pl' }]);
  expect(deviceContext()).toEqual({ timezone: 'Europe/Warsaw', region: 'PL' });
});

it('never falls back: a device that says nothing reports nothing', () => {
  mockGetCalendars.mockReturnValue([{ timeZone: null }]);
  mockGetLocales.mockReturnValue([{ regionCode: null }]);
  expect(deviceContext()).toEqual({ timezone: null, region: null });

  mockGetCalendars.mockReturnValue([]);
  mockGetLocales.mockReturnValue([]);
  expect(deviceContext()).toEqual({ timezone: null, region: null });
});

it('refuses shapes that cannot be an IANA zone or a country code', () => {
  mockGetCalendars.mockReturnValue([{ timeZone: 'GMT+05:30 India Standard Time' }]);
  mockGetLocales.mockReturnValue([{ regionCode: '419' }]);
  expect(deviceContext()).toEqual({ timezone: null, region: null });
});

it('reads each field on its own, so one native failure does not lose the other', () => {
  mockGetCalendars.mockImplementation(() => {
    throw new Error('native module unavailable');
  });
  mockGetLocales.mockReturnValue([{ regionCode: 'US' }]);
  expect(deviceContext()).toEqual({ timezone: null, region: 'US' });

  mockGetCalendars.mockReturnValue([{ timeZone: 'America/Los_Angeles' }]);
  mockGetLocales.mockImplementation(() => {
    throw new Error('native module unavailable');
  });
  expect(deviceContext()).toEqual({ timezone: 'America/Los_Angeles', region: null });
});
