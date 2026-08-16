import { useCallback, useEffect, useRef, useState } from 'react';

import { readPref, writePref } from '@/lib/prefs';

/**
 * The last few things this person searched for.
 *
 * Kept because an empty search screen is the most common state of a search
 * screen, and "nothing typed yet" is a worse thing to show someone than the
 * title they were looking at yesterday. `screens.md` §11.
 *
 * Queries, not results. A recent search re-runs rather than restoring a cached
 * row, so a title the catalogue has since fetched from TMDB comes back with its
 * artwork, and a title the user has since logged comes back with its state.
 */
const PREF_KEY = 'search.recent';

/** Enough to recognise, few enough to scan. Beyond about five, a list of past
 *  searches stops being a shortcut and becomes something to read. */
const LIMIT = 5;

/** Below this the query was not a search, it was a keystroke on the way to one. */
const MIN_LENGTH = 2;

export function useRecentSearches(userId: string) {
  const [recent, setRecent] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const key = `${userId}.${PREF_KEY}`;

  // Held in a ref as well as in state so `remember` can compute the next list
  // without depending on the current one. Without it the callback changes on
  // every recorded search, and the effect that calls it runs again.
  const current = useRef<string[]>([]);

  useEffect(() => {
    let live = true;
    readPref<string[]>(key)
      .then((stored) => {
        if (!live) return;
        const clean = Array.isArray(stored) ? stored.filter((q) => typeof q === 'string') : [];
        current.current = clean;
        setRecent(clean);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [key]);

  const remember = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length < MIN_LENGTH) return;

      // Case-insensitive dedupe keeping the newest spelling, so searching
      // "inception" after "Inception" moves the entry rather than adding a
      // second one that differs only in shift key.
      const fold = trimmed.toLowerCase();
      const next = [trimmed, ...current.current.filter((q) => q.toLowerCase() !== fold)].slice(
        0,
        LIMIT,
      );

      if (next.length === current.current.length && next[0] === current.current[0]) return;

      current.current = next;
      setRecent(next);
      void writePref(key, next).catch(() => {});
    },
    [key],
  );

  const clear = useCallback(() => {
    current.current = [];
    setRecent([]);
    void writePref(key, []).catch(() => {});
  }, [key]);

  return { recent, remember, clear, loaded };
}
