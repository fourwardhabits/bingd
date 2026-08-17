import { meaningfulMatch, type UserResult } from './use-user-search';

/**
 * `meaningfulMatch` — which people earn a place under **All**.
 *
 * The founder's rule for the combined tab is "a compact Users section only for
 * meaningful name/handle matches", with titles staying dominant. `search_users`
 * matches substrings, so without a definition of *meaningful* the rule decays into
 * "always" and typing "the" puts strangers above a page of films.
 *
 * The one thing to hold onto: this is a **display** rule and never an authorisation
 * one. Every person it excludes is a person the viewer is entitled to see, and the
 * Users tab shows all of them.
 */

const user = (username: string, name?: string): UserResult => ({
  id: username,
  username,
  name: name ?? username,
  avatarUri: null,
  visibility: 'public',
});

describe('who leads with All', () => {
  it('takes an exact handle', () => {
    expect(meaningfulMatch(user('anna'), 'anna')).toBe(true);
  });

  it('takes a handle prefix', () => {
    expect(meaningfulMatch(user('anna'), 'ann')).toBe(true);
  });

  it('takes a display-name prefix', () => {
    expect(meaningfulMatch(user('xq_handle', 'Greta Gerwig'), 'greta')).toBe(true);
  });

  it('refuses a match only in the middle', () => {
    // `deanna` really does match "ann" and really is returned by the server. It is
    // one tap away under Users; it is not what somebody typing "ann" meant.
    expect(meaningfulMatch(user('deanna'), 'ann')).toBe(false);
    expect(meaningfulMatch(user('tim_burton'), 'burton')).toBe(false);
  });

  it('ignores case and surrounding space, as the server does', () => {
    expect(meaningfulMatch(user('anna'), '  ANNA ')).toBe(true);
  });

  it('folds accents the same way the database does', () => {
    // A second implementation of `media_fold` is normally wrong. It is safe here only
    // because a disagreement costs a person appearing under Users instead of All —
    // never a person appearing who should not.
    expect(meaningfulMatch(user('amelie_p', 'Amélie Poulain'), 'amelie')).toBe(true);
    expect(meaningfulMatch(user('amelie_p', 'Amélie Poulain'), 'amélie')).toBe(true);
  });

  it('refuses an empty query, so All does not fill with people on a cleared field', () => {
    expect(meaningfulMatch(user('anna'), '')).toBe(false);
    expect(meaningfulMatch(user('anna'), '   ')).toBe(false);
  });
});
