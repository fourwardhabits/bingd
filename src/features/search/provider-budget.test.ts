import {
  clearProviderCooldown,
  noteProviderRateLimited,
  providerCooldownUntil,
  providerQueryOf,
} from './provider-budget';

const HOUR = 60 * 60_000;
const at = (iso: string) => new Date(iso).getTime();

beforeEach(() => clearProviderCooldown());

describe('providerQueryOf', () => {
  it('makes one question of every spelling TMDB answers identically', () => {
    // Each of these was its own cache entry, and so its own charged request.
    for (const typed of ['Network', 'network', ' network ', 'NETWORK']) {
      expect(providerQueryOf(typed)).toBe('network');
    }
    expect(providerQueryOf('the   dark\tknight')).toBe('the dark knight');
  });
});

describe('the hourly cooldown', () => {
  it('holds until the top of the next UTC hour, which is when the server window resets', () => {
    noteProviderRateLimited(at('2026-09-13T17:22:13.582Z'));

    expect(providerCooldownUntil(at('2026-09-13T17:59:59.999Z'))).toBe(at('2026-09-13T18:00:00.000Z'));
    // The first instant of the new window is available again.
    expect(providerCooldownUntil(at('2026-09-13T18:00:00.000Z'))).toBeNull();
  });

  it('never ends immediately, even when refused on the stroke of the hour', () => {
    // A refusal at exactly 17:00:00.000 belongs to the 17:00 window, which has an hour left.
    noteProviderRateLimited(at('2026-09-13T17:00:00.000Z'));

    expect(providerCooldownUntil(at('2026-09-13T17:00:00.000Z'))).toBe(
      at('2026-09-13T17:00:00.000Z') + HOUR,
    );
  });

  it('is available when nothing has been refused', () => {
    expect(providerCooldownUntil()).toBeNull();
  });

  it('lifts for a deliberate retry', () => {
    noteProviderRateLimited();
    expect(providerCooldownUntil()).not.toBeNull();

    clearProviderCooldown();

    expect(providerCooldownUntil()).toBeNull();
  });
});
