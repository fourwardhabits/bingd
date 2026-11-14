import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

import { engineFrom, type EngineId } from './rank';

/** The For You staleness window, which is also how often a mounted reader re-asks. */
export const ENGINE_REREAD_MS = 30 * 60_000;

/**
 * Which For You engine this reader gets, as the server decides it.
 *
 * Never fails: any error — including a server that predates `recommendation_engine`, and
 * a request that throws rather than returning an error — is V1, which is what every reader
 * had before the switch existed. That is what lets V2 ship in a binary while it is off, and
 * lets an operator turn it off without a release.
 *
 * **A rollback has to reach a reader who never leaves the tab** (Codex P2 on #301). A
 * `staleTime` alone does not: stale data is only re-read on a mount, a focus or a
 * reconnect, and a For You tab left open keeps the engine it launched with for as long as
 * it stays open. So the engine is also re-read on an interval of the same window, and
 * `useForYou().refetch()` (Try again, and the retry on a failed wall) re-asks it too.
 */
export function useRecommendationEngine(userId: string) {
  return useQuery({
    queryKey: ['recommendation-engine', userId],
    enabled: Boolean(userId),
    // The same clock as the slate it chooses for, so a rollback reaches a reader within one
    // For You staleness window — mounted or not.
    staleTime: ENGINE_REREAD_MS,
    refetchInterval: ENGINE_REREAD_MS,
    queryFn: async (): Promise<EngineId> => {
      try {
        const { data, error } = await supabase.rpc('recommendation_engine');
        if (error) return 'v1';
        return engineFrom(data);
      } catch {
        return 'v1';
      }
    },
  });
}
