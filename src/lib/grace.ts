/**
 * A bounded wait on work that is not allowed to hold the user.
 *
 * **This exists because of TestFlight build 4, and it is the state model rather than a
 * timeout dressed up as one.** Three separate awaits sat between a button press and the
 * navigation it promised — push-token registration, a SecureStore read, the sign-out
 * teardown — and every one of them is a promise the platform is allowed to never settle:
 * `getExpoPushTokenAsync` with APNs simply not calling back, a Keychain operation that
 * blocks, a network call whose reply is lost. Each held a screen shut for good.
 *
 * The rule the callers now share: **the wait is for the answer, never for the entry.**
 * The work is not cancelled at the deadline — it finishes in the background and its side
 * effects stand — and the caller continues with `fallback`, which every call site chooses
 * to mean "proceed without knowing".
 *
 * Rejection also resolves to `fallback`, so no lane out of this helper can throw. Every
 * caller is a `void` press handler two frames from a person; a rejection there dies
 * silently, which is exactly the dead-button shape this replaces.
 */
export function withGrace<T, F>(work: Promise<T>, graceMs: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), graceMs);
    const settle = (value: T | F) => {
      clearTimeout(timer);
      resolve(value);
    };
    work.then(settle, () => settle(fallback));
  });
}
