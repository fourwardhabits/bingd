/**
 * `invite_link_created` follows the row, not the tap.
 *
 * This is the analytics half of independent review 21h. `create_invite_link` writes one
 * `invite_link_creations` row per accepted call, and answers `already_applied` — with
 * the caller's existing token, so the share still works — when `_claim_operation`
 * recognises a replayed operation id.
 *
 * The replay is not hypothetical. It is the designed path: a creation commits, the reply
 * is lost, `createInviteLink` returns null, the sheet degrades to sharing the title
 * without the link, and the person presses Share again *because the first attempt did
 * not do what they wanted*. The held id is what makes the second call a replay rather
 * than a second creation — and an event emitted on the tap would undo that, reporting
 * two links created out of one decision, in the one funnel the founder is watching for
 * growth.
 */

import { createInviteLink } from './use-recommend';

const mockTrack = jest.fn();
const mockRpc = jest.fn();

// The factory is evaluated when `use-recommend` is first required, which the hoisting
// puts *before* the const above is initialised — so it closes over the call rather than
// over the function, the same way the supabase mock below does.
jest.mock('@/lib/analytics', () => ({
  __esModule: true,
  track: (...args: unknown[]) => mockTrack(...args),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args) } }));

beforeEach(() => {
  jest.clearAllMocks();
});

const answers = (body: unknown, error: unknown = null) =>
  mockRpc.mockResolvedValue({ data: body, error });

describe('createInviteLink', () => {
  it('records a creation when the server wrote one', async () => {
    answers({ status: 'ok', token: 'abc', short_code: 'ABCD1234' });

    const url = await createInviteLink('film-1', 'op-1', 'title');

    expect(url).toBe('https://bingd.app/i/abc');
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'invite_link_created',
      props: { surface: 'title', has_title: true },
    });
  });

  it('records nothing on a replay, which writes no row', async () => {
    // The same token comes back, so the share is unaffected — and that is exactly why
    // the event cannot follow the return value.
    answers({ status: 'already_applied', token: 'abc', short_code: 'ABCD1234' });

    const url = await createInviteLink('film-1', 'op-1', 'title');

    expect(url).toBe('https://bingd.app/i/abc');
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('records nothing when the call failed', async () => {
    // Including the case where it may have committed and lost its reply. The retry that
    // follows carries the same id, is answered `already_applied`, and also records
    // nothing — so one decision that hit a dropped connection is counted zero times
    // rather than twice. The undercount is the deliberate direction.
    answers(null, { code: '', message: 'Network request failed' });

    expect(await createInviteLink('film-1', 'op-1', 'title')).toBeNull();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('says whether the share was about a title', async () => {
    // `create_invite_link` accepts a null media item — the share started from somewhere
    // with no title on screen — and records the creation either way.
    answers({ status: 'ok', token: 'abc' });

    await createInviteLink(null, 'op-2', 'profile');

    expect(mockTrack).toHaveBeenCalledWith({
      name: 'invite_link_created',
      props: { surface: 'profile', has_title: false },
    });
  });
});
