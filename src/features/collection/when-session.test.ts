import {
  WHEN_SESSION_IDLE_MS,
  carriedWhen,
  keepWhenAlive,
  rememberWhen,
  resetWhenSession,
} from './when-session';

const T0 = 1_750_000_000_000;
const minutes = (n: number) => n * 60 * 1000;

beforeEach(() => resetWhenSession());

describe('the When session', () => {
  it('carries nothing until the reader has chosen', () => {
    expect(carriedWhen('user-1', T0)).toBeNull();
  });

  it('carries an explicit Earlier to the next title', () => {
    rememberWhen('user-1', 'earlier', T0);

    expect(carriedWhen('user-1', T0 + minutes(2))).toBe('earlier');
  });

  it('switches back when the reader explicitly chooses Today', () => {
    rememberWhen('user-1', 'earlier', T0);
    rememberWhen('user-1', 'today', T0 + minutes(1));

    expect(carriedWhen('user-1', T0 + minutes(2))).toBe('today');
  });

  it('belongs to one account, so another account on the device never inherits it', () => {
    rememberWhen('user-1', 'earlier', T0);

    expect(carriedWhen('user-2', T0 + minutes(1))).toBeNull();
  });

  it('ends after about thirty minutes without logging, background time included', () => {
    rememberWhen('user-1', 'earlier', T0);

    expect(carriedWhen('user-1', T0 + WHEN_SESSION_IDLE_MS)).toBe('earlier');
    expect(carriedWhen('user-1', T0 + WHEN_SESSION_IDLE_MS + 1)).toBeNull();
    // And once ended it stays ended: a later read inside what would have been the
    // window does not bring it back.
    expect(carriedWhen('user-1', T0 + minutes(1))).toBeNull();
  });

  it('stays alive while titles keep being logged under it', () => {
    rememberWhen('user-1', 'earlier', T0);
    keepWhenAlive('user-1', T0 + minutes(25));

    expect(carriedWhen('user-1', T0 + minutes(50))).toBe('earlier');
  });

  it('is not revived by logging after it has expired', () => {
    rememberWhen('user-1', 'earlier', T0);
    keepWhenAlive('user-1', T0 + minutes(31));

    expect(carriedWhen('user-1', T0 + minutes(32))).toBeNull();
  });

  it('is forgotten on reset, which is what an app restart amounts to', () => {
    rememberWhen('user-1', 'earlier', T0);
    resetWhenSession();

    expect(carriedWhen('user-1', T0 + minutes(1))).toBeNull();
  });
});
