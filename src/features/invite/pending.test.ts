/**
 * Holding an invitation across signup.
 *
 * This is a small module and it is the single point of failure for the case the whole
 * resolver exists to serve: somebody who does **not** have Bingd, taps a link, and has
 * to get through sign-in and a profile form before there is an account to attribute.
 * Everything else in the invite flow degrades; this either works or the invitation is
 * silently lost with nothing on any screen to say so.
 */

import {
  claimForRedemption,
  clearPendingInvite,
  holdInvite,
  isInviteToken,
  MAX_RECOVERABLE_ATTEMPTS,
  pendingInvite,
  recordRecoverableRefusal,
  redemptionOperationId,
  replacePendingInvite,
} from './pending';

let mockStored: Record<string, string> = {};
// The key is the un-prefixed name, because this stands in for `readPref`/`writePref`
// themselves rather than for the storage under them — the real `pref.` prefix is
// applied inside the module being replaced.
jest.mock('@/lib/prefs', () => ({
  __esModule: true,
  readPref: (name: string) => Promise.resolve(mockStored[name] ? JSON.parse(mockStored[name]) : null),
  writePref: (name: string, value: unknown) => {
    mockStored[name] = JSON.stringify(value);
    return Promise.resolve();
  },
}));

const TOKEN = 'a3f19c2b4d5e6f708192a3b4c5d6e7f8';
const OTHER = 'ffffffffffffffffffffffffffffffff';

beforeEach(() => {
  mockStored = {};
});

describe('isInviteToken', () => {
  it('accepts exactly the shape create_invite_link mints', () => {
    // 32 lowercase hex characters: `gen_random_uuid()` with the dashes removed.
    expect(isInviteToken(TOKEN)).toBe(true);
  });

  it('refuses everything else, including things that would mean something downstream', () => {
    for (const value of [
      '',
      'short',
      TOKEN.toUpperCase(),
      `${TOKEN}x`,
      TOKEN.slice(0, 31),
      '../../etc/passwd',
      "' or 1=1--",
      '<script>',
      null,
      undefined,
      42,
      { token: TOKEN },
    ]) {
      expect(isInviteToken(value)).toBe(false);
    }
  });
});

describe('holdInvite', () => {
  it('holds a token so it survives the routing that is about to happen', async () => {
    await holdInvite(TOKEN);
    expect(await pendingInvite()).toBe(TOKEN);
  });

  it('does not hold something that is not a token', async () => {
    await holdInvite('../../etc/passwd');
    expect(await pendingInvite()).toBeNull();
  });

  it('keeps the first invitation when a second arrives before signup', async () => {
    /**
     * A real sequence: a link in a group chat, then a second from somebody else, both
     * opened before signing in. The person made a decision when they tapped the first
     * one, and overwriting silently would hand the attribution to whichever link they
     * happened to tap last — which is not a choice anybody made.
     *
     * `redeem_invite`'s primary key on `invitee_id` enforces the same rule on the
     * server. This makes the client agree with it rather than race it.
     */
    await holdInvite(TOKEN);
    await holdInvite(OTHER);

    expect(await pendingInvite()).toBe(TOKEN);
  });

  it('reads through a stored value that is not a token as nothing held', async () => {
    // Corrupted storage, or a value from an older build. It must not be handed to an
    // RPC and must not block a genuine invitation from being held afterwards.
    mockStored['invite.pendingToken'] = JSON.stringify('nonsense');

    expect(await pendingInvite()).toBeNull();
    await holdInvite(TOKEN);
    expect(await pendingInvite()).toBe(TOKEN);
  });
});

describe('redemptionOperationId', () => {
  it('mints once and reuses it, because the intent outlives the process', async () => {
    // The app can be killed between a redemption that committed and the reply that never
    // arrived. Only the same id lets `_claim_operation` recognise the retry as a replay.
    let issued = 0;
    const mint = () => `op-${(issued += 1)}`;

    expect(await redemptionOperationId(mint)).toBe('op-1');
    expect(await redemptionOperationId(mint)).toBe('op-1');
    expect(issued).toBe(1);
  });

  it('mints a fresh one for the next invitation', async () => {
    // Cleared with the token, so a second invitation on the same device is a second
    // genuine call rather than a replay of the first one's id.
    let issued = 0;
    const mint = () => `op-${(issued += 1)}`;

    await holdInvite(TOKEN);
    await redemptionOperationId(mint);
    await clearPendingInvite();

    await holdInvite(OTHER);
    expect(await redemptionOperationId(mint)).toBe('op-2');
  });
});

describe('replacePendingInvite', () => {
  /**
   * The deliberate counterpart to `holdInvite`'s first-one-wins rule, added after
   * independent review 26b found what its absence cost: token A held, the person opens
   * token B, taps *Use a different account*, signs in as somebody else — and the
   * background hook credits A's owner for an invitation they never acted on.
   *
   * Opening a link is not a decision. Acting on the screen showing it is.
   */
  it('overwrites the held token, which holdInvite deliberately will not', async () => {
    await holdInvite(TOKEN);
    await holdInvite(OTHER);
    expect(await pendingInvite()).toBe(TOKEN);

    await replacePendingInvite(OTHER);
    expect(await pendingInvite()).toBe(OTHER);
  });

  it('resets the operation id, because a different invitation is a different decision', async () => {
    // Reusing the previous one's id would have the new token answered already_applied
    // for a call it was never part of — and the attribution would never be written.
    let issued = 0;
    const mint = () => `op-${(issued += 1)}`;

    await holdInvite(TOKEN);
    expect(await redemptionOperationId(mint)).toBe('op-1');

    await replacePendingInvite(OTHER);
    expect(await redemptionOperationId(mint)).toBe('op-2');
  });

  it('refuses anything that is not a token, leaving what was held', async () => {
    await holdInvite(TOKEN);
    await replacePendingInvite('../../etc/passwd');
    expect(await pendingInvite()).toBe(TOKEN);
  });
});

describe('claimForRedemption', () => {
  /**
   * Independent review 26c's Major. Fixing the account switch alone was not enough:
   * *every* explicit action on a screen showing token B has to reconcile the stored
   * token before it takes an operation id.
   *
   * With A held and B accepted, the naive version submitted B carrying A's id — and if
   * A's earlier uncertain call had committed, the server answers already_applied while
   * the screen reports B as accepted and A's owner holds the credit. Attribution is
   * immutable, so B can then never be credited.
   */
  it('makes the acted-on token pending, replacing a different one that was held', async () => {
    await holdInvite(TOKEN);

    await claimForRedemption(OTHER, () => 'op-1');

    expect(await pendingInvite()).toBe(OTHER);
  });

  it('keeps the held id when the acted-on token is the one already pending', async () => {
    // The ordinary case, and every retry. Dropping the id here would make a lost reply
    // a second call rather than a replay, which is the whole point of holding it.
    await holdInvite(TOKEN);
    expect(await claimForRedemption(TOKEN, () => 'op-1')).toBe('op-1');
    expect(await claimForRedemption(TOKEN, () => 'op-2')).toBe('op-1');
  });

  it('mints a fresh id when the token changed, because it is a different decision', async () => {
    await holdInvite(TOKEN);
    expect(await claimForRedemption(TOKEN, () => 'op-1')).toBe('op-1');
    expect(await claimForRedemption(OTHER, () => 'op-2')).toBe('op-2');
  });

  it('resets the recoverable-refusal count with the token', async () => {
    await holdInvite(TOKEN);
    for (let i = 1; i < MAX_RECOVERABLE_ATTEMPTS; i += 1) await recordRecoverableRefusal();
    expect(await recordRecoverableRefusal()).toBe(false);

    await claimForRedemption(OTHER, () => 'op-1');

    // A different invitation starts with its own budget: the previous token's refusals
    // said nothing about this inviter.
    expect(await recordRecoverableRefusal()).toBe(true);
  });

  it('claims nothing for a value that is not a token', async () => {
    await holdInvite(TOKEN);
    expect(await claimForRedemption('../../etc/passwd', () => 'op-1')).toBeNull();
    expect(await pendingInvite()).toBe(TOKEN);
  });

  it('claims an invitation on a device that held none', async () => {
    // The signed-in case: the link opened the app directly and nothing was ever stashed.
    expect(await claimForRedemption(TOKEN, () => 'op-1')).toBe('op-1');
    expect(await pendingInvite()).toBe(TOKEN);
  });
});

describe('recordRecoverableRefusal', () => {
  it('drops the spent operation id so the next launch is a real attempt', async () => {
    // Independent review 26b. Without this the retry carries an id the ledger has
    // already seen, is answered already_applied, and nothing is reconsidered.
    await holdInvite(TOKEN);
    expect(await redemptionOperationId(() => 'op-1')).toBe('op-1');

    expect(await recordRecoverableRefusal()).toBe(true);

    expect(await redemptionOperationId(() => 'op-2')).toBe('op-2');
    expect(await pendingInvite()).toBe(TOKEN);
  });

  it('counts refusals across launches and gives up at the bound', async () => {
    await holdInvite(TOKEN);
    for (let i = 1; i < MAX_RECOVERABLE_ATTEMPTS; i += 1) {
      expect(await recordRecoverableRefusal()).toBe(true);
    }
    expect(await recordRecoverableRefusal()).toBe(false);
  });
});

describe('clearPendingInvite', () => {
  it('clears the token and its operation id together', async () => {
    await holdInvite(TOKEN);
    await redemptionOperationId(() => 'op-1');

    await clearPendingInvite();

    expect(await pendingInvite()).toBeNull();
    // Asserted through the public path: a fresh mint is offered rather than the old id.
    expect(await redemptionOperationId(() => 'op-2')).toBe('op-2');
  });
});
