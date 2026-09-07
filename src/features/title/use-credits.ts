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
  /**
   * The television equivalent of a director, from the crew already fetched.
   *
   * A season's identity line wants the person a reader would name if you asked them
   * whose show it is, and TMDB does not publish a "showrunner" role — so this is the
   * best available answer from the same payload, in the order the credit is usually
   * meant: an explicit Creator, then an Executive Producer.
   *
   * **No second request.** It reads the `credits` facet this hook was already reading;
   * the identity line falls back to it only when there is no director, and prints
   * nothing when there is neither. A guess would be worse than a missing segment.
   */
  showrunner: string | null;
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
      const showrunner =
        payload.crew?.find((person) => person.job === 'Creator')?.name ??
        payload.crew?.find((person) => person.job === 'Executive Producer')?.name ??
        null;

      return { cast, director, showrunner };
    },
  });
}
