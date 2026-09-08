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
   * The television equivalent of a director: an explicit **Creator**, and nothing else.
   *
   * ---------------------------------------------------------------------------
   * WHY THE EXECUTIVE-PRODUCER FALLBACK IS GONE (founder, 2026-09-07)
   *
   * It read `Creator`, then `Executive Producer`, on the reasoning that TMDB publishes no
   * "showrunner" role so the next-best credit should stand in. The founder's rule for
   * this line is the opposite one, and it is right: **`TV-MA · 24 episodes` is better
   * than a misleading person.** An executive producer on a television payload is
   * routinely a financier, a star with a production deal, or a studio executive — naming
   * one of them as the person whose show it is puts a confident falsehood in the one
   * place on the page a reader has no way to check.
   *
   * A `Creator` credit is the claim the line is actually making, so it is the only credit
   * that fills it. Where there is none, the segment is simply absent and the line reads
   * with two parts instead of three.
   *
   * **`director` is never a fallback for this**, and that is the other half of the same
   * correction. On a season payload the `Director` credit is an *episode* director — the
   * person who directed one of nine — and the identity line spent a release printing them
   * as though they were the showrunner.
   *
   * **No second request.** It reads the `credits` facet this hook was already reading.
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
      // Creator or nothing. See the type above for why an Executive Producer is not an
      // acceptable stand-in for the person whose show it is.
      const showrunner = payload.crew?.find((person) => person.job === 'Creator')?.name ?? null;

      return { cast, director, showrunner };
    },
  });
}
