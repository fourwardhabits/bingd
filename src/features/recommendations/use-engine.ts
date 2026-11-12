import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

import { engineFrom, type EngineId } from './rank';

/**
 * Which For You engine this reader gets, as the server decides it.
 *
 * Never fails: any error — including a server that predates `recommendation_engine` — is
 * V1, which is what every reader had before the switch existed. That is what lets V2 ship
 * in a binary while it is off, and lets an operator turn it off without a release.
 */
export function useRecommendationEngine(userId: string) {
  return useQuery({
    queryKey: ['recommendation-engine', userId],
    enabled: Boolean(userId),
    // The same clock as the slate it chooses for, so a rollback reaches a reader within one
    // For You staleness window.
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<EngineId> => {
      const { data, error } = await supabase.rpc('recommendation_engine');
      if (error) return 'v1';
      return engineFrom(data);
    },
  });
}
