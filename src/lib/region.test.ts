/**
 * Which market the availability block asks about.
 *
 * Small, and worth pinning for two reasons. It is read from a **native module** —
 * `expo-localization`, which has been a dependency since 2026-08-13 and is therefore in
 * every binary in the field, which is the whole reason this is the region signal rather
 * than a new package — and a throw here would be a throw on a title page.
 *
 * And the fallback is a stated product limitation rather than an implementation detail:
 * a device that cannot say where it is gets the US list. Region *selection* is deferred,
 * not forgotten; see the module header.
 */

const mockGetLocales = jest.fn();
jest.mock('expo-localization', () => ({
  getLocales: () => mockGetLocales(),
}));

/**
 * A fresh module per case, because the answer is cached for the life of the process.
 *
 * That cache is deliberate — `getLocales` reads a native module and `watchRegion` is
 * called from a component that renders on every title page — so exercising the branches
 * means re-importing rather than calling twice.
 */
const regionWith = (locales: unknown) => {
  mockGetLocales.mockReturnValue(locales);
  let region = '';
  jest.isolateModules(() => {
    region = (require('./region') as typeof import('./region')).watchRegion();
  });
  return region;
};

beforeEach(() => mockGetLocales.mockReset());

it('asks about the country the device says it is in', () => {
  expect(regionWith([{ regionCode: 'GB' }])).toBe('GB');
});

it('upper-cases, because the response is an object key on the other side', () => {
  expect(regionWith([{ regionCode: 'de' }])).toBe('DE');
});

it('falls back to the US when the locale carries no region at all', () => {
  // Uncommon and real: a device set to a language rather than to a place.
  expect(regionWith([{ regionCode: null }])).toBe('US');
  expect(regionWith([])).toBe('US');
  expect(regionWith(undefined)).toBe('US');
});

it('falls back rather than passing on something that is not a country', () => {
  expect(regionWith([{ regionCode: 'en-US' }])).toBe('US');
  expect(regionWith([{ regionCode: 419 }])).toBe('US');
});

it('falls back rather than throwing when the native module refuses', () => {
  // The block this feeds is the one thing on a title page allowed to be absent. It
  // must never be the thing that takes the page down with it.
  mockGetLocales.mockImplementation(() => {
    throw new Error('no native module');
  });
  let region = '';
  jest.isolateModules(() => {
    region = (require('./region') as typeof import('./region')).watchRegion();
  });
  expect(region).toBe('US');
});

it('reads the device once and remembers the answer', () => {
  mockGetLocales.mockReturnValue([{ regionCode: 'FR' }]);
  jest.isolateModules(() => {
    const { watchRegion } = require('./region') as typeof import('./region');
    expect(watchRegion()).toBe('FR');
    expect(watchRegion()).toBe('FR');
    expect(watchRegion()).toBe('FR');
  });
  expect(mockGetLocales).toHaveBeenCalledTimes(1);
});
