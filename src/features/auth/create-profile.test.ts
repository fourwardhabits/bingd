import { createProfile, usernameAvailability } from './create-profile';

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => mockRpc.mockReset());

/**
 * The mapping from what the database says to what the form does. It is tested
 * because two of these are indistinguishable from "something went wrong" if the
 * mapping is missing, and both have consequences: a retried request would strand
 * the user on the signup screen, and an under-13 refusal would leave the app
 * holding a session for an account the server has already deleted.
 */
describe('createProfile', () => {
  const input = { username: 'rosalind', displayName: 'Rosalind', dateOfBirth: '1990-04-02' };

  it('passes the arguments the function expects', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
    await createProfile(input);

    expect(mockRpc).toHaveBeenCalledWith('create_profile', {
      p_username: 'rosalind',
      p_display_name: 'Rosalind',
      p_date_of_birth: '1990-04-02',
    });
  });

  it('reports success', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
    expect(await createProfile(input)).toEqual({ outcome: 'created' });
  });

  /**
   * Returned rather than raised, because the migration deletes the auth.users row
   * and an exception would roll that deletion back. If this mapping were missing the
   * caller would fall through to `created` and route a deleted account into the app.
   */
  it('recognises the under-13 refusal, which arrives as a value not an error', async () => {
    mockRpc.mockResolvedValue({
      data: { ok: false, reason: 'under_13', account_deleted: true },
      error: null,
    });
    expect(await createProfile(input)).toEqual({ outcome: 'under_13' });
  });

  it('does not treat an unknown refusal as success', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, reason: 'something_new' }, error: null });
    expect(await createProfile(input)).toMatchObject({ outcome: 'failed' });
  });

  it.each([
    ['42710', 'already_exists'],
    ['23505', 'username_taken'],
    ['22023', 'invalid'],
    ['28000', 'failed'],
  ])('maps SQLSTATE %s to %s', async (code, outcome) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'from postgres' } });
    expect((await createProfile(input)).outcome).toBe(outcome);
  });

  it('maps an unrecognised error to a failure that carries its message', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection lost' } });
    expect(await createProfile(input)).toEqual({
      outcome: 'failed',
      message: 'connection lost',
    });
  });

  it('sends null rather than an empty display name', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
    await createProfile({ ...input, displayName: null });
    expect(mockRpc).toHaveBeenCalledWith(
      'create_profile',
      expect.objectContaining({ p_display_name: null }),
    );
  });
});

describe('usernameAvailability', () => {
  it('normalises before asking, so the answer matches what will be inserted', async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await usernameAvailability('  Rosalind  ');
    expect(mockRpc).toHaveBeenCalledWith('username_available', { p_username: 'rosalind' });
  });

  it('answers true and false', async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    expect(await usernameAvailability('free_name')).toBe(true);
    mockRpc.mockResolvedValue({ data: false, error: null });
    expect(await usernameAvailability('taken')).toBe(false);
  });

  /**
   * Distinct from false on purpose. Rendering an unanswered check as "taken" would
   * tell a user offline that every name they try is unavailable.
   */
  it('returns null when it cannot get an answer', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'offline' } });
    expect(await usernameAvailability('anything')).toBeNull();
  });

  it('does not ask about an empty string', async () => {
    expect(await usernameAvailability('   ')).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
