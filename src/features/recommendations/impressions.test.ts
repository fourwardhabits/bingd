import { noteImpressions, resetImpressions } from './impressions';

/**
 * The impression writer's guard — founder §15, "do not record a server write for every
 * render/re-render accidentally".
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE HALF THAT CAN BE WRONG
 *
 * There are two defences and only one of them is a guarantee. The server truncates
 * `shown_at` to the hour, so its primary key collapses everything inside one hour into
 * one row per title however badly a client behaves — that is the contract, and
 * `supabase/tests/recommendation-rotation.test.mjs` holds it.
 *
 * What is tested here is the *optimisation*: the guard that stops the round trip being
 * made at all. It is the piece a re-render can defeat, so it is the piece worth pinning,
 * and the file is deliberately clear about which is which — a reader who mistook this
 * for the guarantee would be one refactor away from removing the real one.
 */

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (name: string, args: unknown) => mockRpc(name, args) },
}));

beforeEach(() => {
  resetImpressions();
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: { status: 'ok', recorded: 2 }, error: null });
});

describe('what gets sent', () => {
  it('records a wall once', async () => {
    await noteImpressions('movies|{}', ['a', 'b']);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('note_recommendations_shown', {
      p_media_item_ids: ['a', 'b'],
    });
  });

  it('sends nothing at all for an empty wall', async () => {
    await noteImpressions('movies|{}', []);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('deduplicates within one wall', async () => {
    // A slate should never contain a title twice, and this must not be the place that
    // discovers otherwise — but it must not pass the duplicate on either.
    await noteImpressions('movies|{}', ['a', 'a', 'b']);
    expect(mockRpc).toHaveBeenCalledWith('note_recommendations_shown', {
      p_media_item_ids: ['a', 'b'],
    });
  });

  it('chunks a long wall rather than truncating it', async () => {
    // The server raises 22023 above `foryou.impression_batch_max`, so a wall longer than
    // sixty has to be split. **Split, not sliced** — see the growth test below for the
    // defect slicing caused.
    const many = Array.from({ length: 140 }, (_, index) => `film-${index}`);
    await noteImpressions('movies|{}', many);

    expect(mockRpc).toHaveBeenCalledTimes(3);
    const batches = mockRpc.mock.calls.map(
      ([, args]) => (args as { p_media_item_ids: string[] }).p_media_item_ids,
    );
    expect(batches.map((batch) => batch.length)).toEqual([60, 60, 20]);
    // Every title, exactly once, across the batches.
    expect(new Set(batches.flat()).size).toBe(140);
  });
});

describe('the guard against a render loop', () => {
  it('does not re-send an unchanged wall', async () => {
    await noteImpressions('movies|{}', ['a', 'b']);
    await noteImpressions('movies|{}', ['a', 'b']);
    await noteImpressions('movies|{}', ['a', 'b']);

    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('ignores the order the same wall arrives in', async () => {
    // The fingerprint is order-independent because a re-render can legitimately produce
    // the same set in a different order, and a write per reorder is a write per render
    // with extra steps.
    await noteImpressions('movies|{}', ['a', 'b']);
    await noteImpressions('movies|{}', ['b', 'a']);

    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('sends only what is new when the wall grows by a page', async () => {
    await noteImpressions('movies|{}', ['a', 'b']);
    await noteImpressions('movies|{}', ['a', 'b', 'c']);

    expect(mockRpc).toHaveBeenCalledTimes(2);
    // Just the new one: re-sending `a` and `b` would be a round trip to be told what the
    // primary key already knows.
    expect(mockRpc.mock.calls[1]?.[1]).toEqual({ p_media_item_ids: ['c'] });
  });

  /**
   * **The defect a fingerprint over a truncated list caused**, found by independent
   * review and worth its own test because nothing else would have shown it.
   *
   * `diversifyPaged` preserves its prefix, so a wall growing from sixty items to a
   * hundred leaves the first sixty — and therefore any hash of the *truncated* list —
   * unchanged. The guard matched, the call returned early, and titles 61–100 were never
   * recorded at all: the pages a reader had to work hardest to reach were the only ones
   * with no durable cooldown next launch.
   */
  it('records the pages past sixty, which a truncating guard silently dropped', async () => {
    const firstThree = Array.from({ length: 60 }, (_, index) => `film-${index}`);
    await noteImpressions('movies|{}', firstThree);
    mockRpc.mockClear();

    const fivePages = Array.from({ length: 100 }, (_, index) => `film-${index}`);
    await noteImpressions('movies|{}', fivePages);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const sent = (mockRpc.mock.calls[0]?.[1] as { p_media_item_ids: string[] })
      .p_media_item_ids;
    expect(sent).toHaveLength(40);
    expect(sent).toContain('film-99');
    expect(sent).not.toContain('film-0');
  });

  it('keeps one wall’s guard from silencing another', async () => {
    // Movies and TV are separate slates sharing one session. Keyed on the wall, so a
    // reader who has only ever opened Movies never records TV impressions — and opening
    // TV is not suppressed by Movies having been seen.
    await noteImpressions('movies|{}', ['a', 'b']);
    await noteImpressions('tv|{}', ['a', 'b']);

    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  /**
   * **The cross-account hole**, found by independent review of the first fix.
   *
   * This map lives for the life of the process, so on a shared device where one account
   * signs out and another signs in without a relaunch, the second reader's wall overlaps
   * the first's — and under a key that did not name the viewer, every overlapping title
   * was treated as already recorded. Those titles would then have **no durable cooldown
   * at all** for the new account, which is the one thing the ledger exists to give them.
   *
   * The same viewer-relative-key defect reviews 6 and 10 each found elsewhere in this
   * app. Fixed in the key (`use-for-you.ts` builds it from `userId` first) rather than by
   * a reset somebody has to remember to call, which is what this asserts: two keys that
   * differ only by viewer do not share a guard.
   */
  it('does not let one account’s wall silence another’s on the same device', async () => {
    await noteImpressions('user-1|movies|{}', ['a', 'b']);
    mockRpc.mockClear();

    await noteImpressions('user-2|movies|{}', ['a', 'b']);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0]?.[1]).toEqual({ p_media_item_ids: ['a', 'b'] });
  });
});

describe('when the write fails', () => {
  it('lets the next render try again after a refusal', async () => {
    // A refusal proves nothing was stored. Leaving the guard marked would suppress this
    // wall's impressions for the life of the process over one transient failure.
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });

    await noteImpressions('movies|{}', ['a', 'b']);
    await noteImpressions('movies|{}', ['a', 'b']);

    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('forgets only the chunk that failed', async () => {
    // A long wall is several calls. One failing must not un-record the ones that landed,
    // or a wall that half-succeeded would re-send its successful half on every render.
    const many = Array.from({ length: 120 }, (_, index) => `film-${index}`);
    mockRpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'nope' } });

    await noteImpressions('movies|{}', many);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    mockRpc.mockClear();
    mockRpc.mockResolvedValue({ data: null, error: null });

    await noteImpressions('movies|{}', many);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const retried = (mockRpc.mock.calls[0]?.[1] as { p_media_item_ids: string[] })
      .p_media_item_ids;
    expect(retried).toHaveLength(60);
    expect(retried).toContain('film-119');
    expect(retried).not.toContain('film-0');
  });

  it('survives a thrown error rather than propagating it', async () => {
    // Nothing on screen waits for this. A rejected promise reaching the effect that calls
    // it would be an unhandled rejection over a background fact about ordering.
    mockRpc.mockRejectedValueOnce(new Error('offline'));

    await expect(noteImpressions('movies|{}', ['a', 'b'])).resolves.toBeUndefined();
    await noteImpressions('movies|{}', ['a', 'b']);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('does not retry a wall that was recorded successfully', async () => {
    await noteImpressions('movies|{}', ['a', 'b']);
    mockRpc.mockClear();
    await noteImpressions('movies|{}', ['a', 'b']);

    expect(mockRpc).not.toHaveBeenCalled();
  });
});
