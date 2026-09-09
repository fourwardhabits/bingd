/**
 * **What reaches the disk, and in what order.**
 *
 * Both of the stores this flow keeps on the device — the stage pointer and the five-film
 * selection — publish to memory synchronously and hand their write to the platform
 * without waiting for it. That is deliberate and it is why the flow feels immediate: no
 * button press watches the Keychain happen.
 *
 * It also meant, until independent review said so, that **two writes to one key could be
 * in flight at once and nothing decided which of them landed last.** SecureStore makes no
 * ordering promise across two calls, so the older value could arrive second and win.
 *
 * The defect is invisible for the whole of the session that causes it, because memory is
 * the authority while the process lives. It is paid on the next launch, by a reader who
 * resumes at a step they already finished or comes back to a partial grid — which is the
 * one loss the selection store exists to prevent.
 *
 * These tests are therefore about the **witness**, not the value: `writePref` here does
 * not resolve on its own. The test holds each call open and releases them in whatever
 * order it likes, so "the newest value wins" is asserted against a platform that is
 * actively trying to reorder them, rather than against one that happens to be fast.
 */
import { advanceStage, resetOnboardingStages, stageInMemory } from './use-onboarding-stage';
import {
  PICK_TARGET,
  rankingOutcome,
  resetPickFive,
  resetRankingOutcome,
  setPicks,
  setRankingOutcome,
  type PickedTitle,
  type RankingOutcomeRead,
} from './pick-five';

/** Every `writePref` that was actually issued, in the order the platform received it. */
const mockIssued: { name: string; value: unknown }[] = [];
/** Every one that was allowed to complete, in the order it landed. */
const mockLanded: { name: string; value: unknown }[] = [];
/** The releases for the calls still open, so a test can complete them out of order. */
const mockGates: (() => void)[] = [];

/** A read that never settles, which is the failure the graces exist for. */
let mockReadHangs = false;

jest.mock('@/lib/prefs', () => ({
  readPref: () => (mockReadHangs ? new Promise(() => {}) : Promise.resolve(null)),
  writePref: (name: string, value: unknown) => {
    mockIssued.push({ name, value });
    return new Promise<void>((resolve) => {
      mockGates.push(() => {
        mockLanded.push({ name, value });
        resolve();
      });
    });
  },
}));

jest.mock('@/lib/flight-recorder', () => ({
  note: () => {},
  tally: () => {},
}));

/**
 * Drains the microtask queue.
 *
 * A macrotask turn rather than a counted number of `Promise.resolve()`s, because the queue
 * these tests are about is a chain whose length is the point: counting turns would make
 * the test agree with today's number of `.then` hops rather than with the behaviour.
 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Releases the oldest open write, then lets whatever was queued behind it run. */
const release = async () => {
  const gate = mockGates.shift();
  if (!gate) throw new Error('no write was open to release');
  gate();
  await settle();
};

beforeEach(() => {
  mockIssued.length = 0;
  mockLanded.length = 0;
  mockGates.length = 0;
  mockReadHangs = true;
  resetOnboardingStages();
  resetPickFive();
  resetRankingOutcome();
});

// ---------------------------------------------------------------------------

describe('the stage pointer', () => {
  /**
   * The failure, stated as the thing that can no longer happen: two writes open at the
   * same time. One key, one call in flight, so the platform is never given the chance to
   * choose an order.
   */
  it('never has two writes to the same key open at once', async () => {
    void advanceStage('user-1', 'motivations');
    void advanceStage('user-1', 'answers');
    void advanceStage('user-1', 'taste');
    await settle();

    expect(mockGates).toHaveLength(1);
  });

  /**
   * **The adversarial ordering, run.**
   *
   * `answers` is dispatched and held open. `taste` is dispatched while it is still in
   * flight and is released first — which is precisely the completion order that used to
   * leave `answers` on the disk of somebody who had reached the picker.
   */
  it('lands the newest stage last, even when an older write is released first', async () => {
    void advanceStage('user-1', 'answers');
    await settle();
    void advanceStage('user-1', 'taste');
    await settle();

    // Only `answers` was ever handed to the platform; `taste` is queued behind it.
    expect(mockIssued.map((write) => write.value)).toEqual(['answers']);

    await release();
    await release();

    expect(mockLanded.map((write) => write.value)).toEqual(['answers', 'taste']);
    // The last thing written is the stage the reader actually reached, which is the whole
    // claim: a relaunch resumes at `taste`, never at `answers`.
    expect(mockLanded[mockLanded.length - 1]?.value).toBe('taste');
  });

  /**
   * Two advances in one turn never produce two writes at all. The first is superseded
   * before the platform is asked, so the intermediate value is skipped rather than
   * written and immediately overwritten.
   */
  it('skips a stage that was superseded before its write began', async () => {
    void advanceStage('user-1', 'answers');
    void advanceStage('user-1', 'people');
    await settle();

    expect(mockIssued.map((write) => write.value)).toEqual(['people']);
  });

  /** The memory guard is untouched: it still refuses to move backwards. */
  it('still refuses to go backwards, and writes nothing when it refuses', async () => {
    void advanceStage('user-1', 'people');
    await settle();
    await release();

    void advanceStage('user-1', 'answers');
    await settle();

    expect(stageInMemory('user-1')).toBe('people');
    expect(mockIssued.map((write) => write.value)).toEqual(['people']);
  });

  /**
   * Per account, not one queue for the device. Two accounts write different keys, and
   * making one wait on the other's stalled Keychain would be a new way to lose the thing
   * this is protecting.
   */
  it('does not make one account wait on another account’s stalled write', async () => {
    void advanceStage('user-1', 'answers');
    await settle();
    void advanceStage('user-2', 'answers');
    await settle();

    expect(mockGates).toHaveLength(2);
  });

  /**
   * **A queue is a barrier, and this is the way out of it.**
   *
   * The first version of this serialisation had no deadline, which review caught: a write
   * the platform never calls back holds every later stage behind it for the life of the
   * process, so the device ends up with an *older* stage than the reader reached — a worse
   * version of the race the queue was added to remove. The wait is bounded on the same
   * terms as every other bounded wait in this codebase; the stalled write is not
   * cancelled, and the queue moves on without it.
   */
  it('does not let one stalled write hold every later stage for ever', async () => {
    jest.useFakeTimers();
    try {
      void advanceStage('user-1', 'answers');
      await jest.advanceTimersByTimeAsync(0);
      // Handed to the platform, and deliberately never released.
      expect(mockIssued.map((write) => write.value)).toEqual(['answers']);

      void advanceStage('user-1', 'people');
      await jest.advanceTimersByTimeAsync(0);
      // Still barred, which is correct: the grace has not expired yet.
      expect(mockIssued.map((write) => write.value)).toEqual(['answers']);

      await jest.advanceTimersByTimeAsync(5000);

      expect(mockIssued.map((write) => write.value)).toEqual(['answers', 'people']);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------

const film = (id: string): PickedTitle => ({ id, title: `Film ${id}`, year: 2020, posterUri: null });

describe('the five-film selection', () => {
  it('never has two writes to the same key open at once', async () => {
    void setPicks('user-1', [film('a')]);
    void setPicks('user-1', [film('a'), film('b')]);
    void setPicks('user-1', [film('a'), film('b'), film('c')]);
    await settle();

    expect(mockGates).toHaveLength(1);
  });

  /**
   * **The tap pair that actually loses data**, and the one this is really about: a
   * deselect and its replacement, a few hundred milliseconds apart. Each used to dispatch
   * a full-array write of its own, and the four-title array landing after the five-title
   * one left a subset of the reader's choice on the device.
   */
  it('lands the final selection last, even when an earlier write is released first', async () => {
    const four = [film('a'), film('b'), film('c'), film('d')];
    const five = [...four, film('e')];

    void setPicks('user-1', four);
    await settle();
    void setPicks('user-1', five);
    await settle();

    expect(mockIssued).toHaveLength(1);

    await release();
    await release();

    const last = mockLanded[mockLanded.length - 1]?.value as PickedTitle[];
    expect(last.map((picked) => picked.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  /**
   * Select, select, deselect, replace — the whole interaction, with every write held open
   * and released in the worst order available. What survives is what the grid shows.
   */
  it('survives a select / select / deselect / replace run in the wrong order', async () => {
    void setPicks('user-1', [film('a')]);
    await settle();
    void setPicks('user-1', [film('a'), film('b')]);
    void setPicks('user-1', [film('a')]);
    void setPicks('user-1', [film('a'), film('c')]);
    await settle();

    while (mockGates.length > 0) await release();

    const last = mockLanded[mockLanded.length - 1]?.value as PickedTitle[];
    expect(last.map((picked) => picked.id)).toEqual(['a', 'c']);
  });

  /** The cap is still applied, and it is applied to what gets written as well. */
  it('still writes at most the five the run can take', async () => {
    void setPicks('user-1', ['a', 'b', 'c', 'd', 'e', 'f'].map(film));
    await settle();
    await release();

    const written = mockLanded[0]?.value as PickedTitle[];
    expect(written).toHaveLength(PICK_TARGET);
  });

  it('does not make one account wait on another account’s stalled write', async () => {
    void setPicks('user-1', [film('a')]);
    await settle();
    void setPicks('user-2', [film('b')]);
    await settle();

    expect(mockGates).toHaveLength(2);
  });

  /** The same way out of the same barrier. See the stage store's version above. */
  it('does not let one stalled write hold every later selection for ever', async () => {
    jest.useFakeTimers();
    try {
      void setPicks('user-1', [film('a')]);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockIssued).toHaveLength(1);

      void setPicks('user-1', [film('a'), film('b')]);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockIssued).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(5000);

      expect(mockIssued).toHaveLength(2);
      const latest = mockIssued[1]?.value as PickedTitle[];
      expect(latest.map((picked) => picked.id)).toEqual(['a', 'b']);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the ranking outcome, read at the last button of the flow', () => {
  /**
   * **The stranding this codebase already shipped once, in a new place.**
   *
   * `rankingOutcome` sits between the notification step's button and the navigation it
   * promised. Its `.catch` covers a read that fails and says nothing about one that never
   * settles — which is exactly the build-4 shape: a Keychain call the platform does not
   * call back, holding a screen shut at the end of a ten-step flow.
   *
   * The fallback is the honest word rather than a convenient one. A read that will not
   * settle *is* an unknown outcome, and the event says so rather than guessing.
   */
  it('answers unknown rather than waiting for ever on a Keychain that never replies', async () => {
    jest.useFakeTimers();
    try {
      let settled: RankingOutcomeRead | null = null;
      void rankingOutcome('user-1').then((answer) => {
        settled = answer;
      });

      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBeNull();

      await jest.advanceTimersByTimeAsync(3000);
      expect(settled).toBe('unknown');
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The ordinary case never reaches the disk at all, so the grace costs nothing.
   *
   * `setRankingOutcome` is dispatched rather than awaited here for the same reason
   * `taste.tsx` dispatches it: it writes memory synchronously and hands the disk half to
   * the platform, and this mock's platform never answers. The point of the test is that
   * the read below does not need it to.
   */
  it('answers from memory without a read when the same process recorded it', async () => {
    void setRankingOutcome('user-1', 'completed');

    await expect(rankingOutcome('user-1')).resolves.toBe('completed');
  });
});
