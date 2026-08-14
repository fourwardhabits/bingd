import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export type CreditPerson = {
  id: string;
  name: string;
  character?: string;
  profilePath?: string | null;
  department?: string;
};

export type CreditsResult = {
  cast: CreditPerson[];
  director: string | null;
};

export function useCredits(mediaItemId: string | null) {
  return useQuery({
    queryKey: ['credits', mediaItemId],
    enabled: Boolean(mediaItemId),
    queryFn: async (): Promise<CreditsResult | null> => {
      const { count, error: countError } = await supabase
        .from('media_cache')
        .select('*', { count: 'exact', head: true });
      if (countError) throw countError;
      if (!count) return null;

      const { data, error } = await supabase
        .from('media_cache')
        .select('payload')
        .eq('media_item_id', mediaItemId!)
        .eq('facet', 'credits')
        .maybeSingle();
      if (error) throw error;
      if (!data?.payload) return null;

      const payload = data.payload as {
        cast?: {
          id: string | number;
          name: string;
          character?: string;
          profile_path?: string | null;
        }[];
        crew?: { id: string | number; name: string; job?: string; department?: string }[];
      };
      const cast = (payload.cast ?? []).slice(0, 12).map((person) => ({
        id: String(person.id),
        name: person.name,
        character: person.character,
        profilePath: person.profile_path ?? null,
      }));
      const director =
        payload.crew?.find((person) => person.job === 'Director')?.name ??
        payload.crew?.find((person) => person.department === 'Directing')?.name ??
        null;

      return { cast, director };
    },
  });
}
