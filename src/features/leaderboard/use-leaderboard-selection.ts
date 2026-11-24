import { useCallback, useEffect, useRef, useState } from 'react';

import { readPref, writePref } from '@/lib/prefs';

import {
  DEFAULT_METRIC,
  DEFAULT_TIMEFRAME,
  isLeaderboardMetric,
  isLeaderboardTimeframe,
  type LeaderboardMetric,
  type LeaderboardTimeframe,
} from './use-leaderboard';

/**
 * Where each choice is kept, per account: `${profileId}.${key}`, through `readPref` /
 * `writePref` (the local store Collection's preferences use). No server table, no sync — a
 * device habit about how to draw a surface.
 *
 * `leaderboard.timeframe` is the key the timeframe has always been stored under, so a
 * reader who chose This month (or All time) before this change keeps it.
 */
export const METRIC_PREF_KEY = 'leaderboard.metric';
export const TIMEFRAME_PREF_KEY = 'leaderboard.timeframe';

type Selection = { metric: LeaderboardMetric; timeframe: LeaderboardTimeframe };

const DEFAULTS: Selection = { metric: DEFAULT_METRIC, timeframe: DEFAULT_TIMEFRAME };

/**
 * **The board's category and timeframe, remembered per signed-in account** (founder brief
 * 2026-11-23 §2).
 *
 * Restored when the reader leaves the board and comes back (this state lives in the Feed
 * tab, which stays mounted) and after a relaunch (the store). Defaults are All Titles and
 * All time; a stored value the controls have no option for is ignored.
 *
 * **Not the Feed / Leaderboard / People mode**, which is deliberately not persisted: Feed
 * stays the tab's first screen on every launch.
 *
 * ---------------------------------------------------------------------------
 * THE TWO ASYNC HAZARDS, AND WHAT CLOSES EACH
 *
 * **Another account's choice.** The state is tagged with the account it belongs to, and a
 * tag that does not name the current reader is simply not theirs: the render that switches
 * accounts draws the defaults, before any effect has run, so the previous account's board
 * is never requested for the next one. That is `CollectionScreen`'s `mediumPref` shape.
 *
 * **An older read over a newer choice.** The read for an account can resolve after the
 * reader has already chosen on it — a slow store, or a tap in the first frames. Every
 * choice is also kept in memory, per account and per field, for as long as the tab is
 * mounted, and a read only fills the fields this account has not chosen since mounting. So a
 * read can never undo a choice, whichever order they land in, and a choice made on one
 * account can never answer a read for another. Writes go through the store's per-key queue
 * (`session-storage.ts`), so the stored value is the last one chosen.
 */
export function useLeaderboardSelection(profileId: string) {
  const [state, setState] = useState<Selection & { profileId: string }>(() => ({
    profileId,
    ...DEFAULTS,
  }));
  /** What each account has chosen while this tab has been mounted, field by field. */
  const chosen = useRef(new Map<string, Partial<Selection>>());

  useEffect(() => {
    let cancelled = false;
    const read = <T>(key: string, valid: (v: unknown) => v is T) =>
      readPref<unknown>(`${profileId}.${key}`)
        .then((stored) => (valid(stored) ? stored : null))
        .catch(() => null);

    void Promise.all([
      read(METRIC_PREF_KEY, isLeaderboardMetric),
      read(TIMEFRAME_PREF_KEY, isLeaderboardTimeframe),
    ]).then(([metric, timeframe]) => {
      if (cancelled) return;
      const mine = chosen.current.get(profileId) ?? {};
      setState({
        profileId,
        metric: mine.metric ?? metric ?? DEFAULTS.metric,
        timeframe: mine.timeframe ?? timeframe ?? DEFAULTS.timeframe,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const current: Selection = state.profileId === profileId ? state : DEFAULTS;

  const choose = useCallback(
    <K extends keyof Selection>(field: K, value: Selection[K], key: string) => {
      chosen.current.set(profileId, { ...chosen.current.get(profileId), [field]: value });
      setState((prev) => ({
        ...(prev.profileId === profileId
          ? prev
          : { profileId, ...DEFAULTS, ...chosen.current.get(profileId) }),
        [field]: value,
      }));
      // Not awaited, and a refusal costs the reader nothing more than the default next
      // launch — Collection's rule.
      void writePref(`${profileId}.${key}`, value).catch(() => {});
    },
    [profileId],
  );

  const changeMetric = useCallback(
    (next: LeaderboardMetric) => choose('metric', next, METRIC_PREF_KEY),
    [choose],
  );
  const changeTimeframe = useCallback(
    (next: LeaderboardTimeframe) => choose('timeframe', next, TIMEFRAME_PREF_KEY),
    [choose],
  );

  return {
    metric: current.metric,
    timeframe: current.timeframe,
    changeMetric,
    changeTimeframe,
  };
}
