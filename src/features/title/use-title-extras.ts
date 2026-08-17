import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export type TitleVideo = {
  id: string;
  key: string;
  name: string;
  /** `Trailer` or `Teaser`. The adapter keeps no other kind. */
  type: string;
  /** Where it plays. `YouTube` for everything the adapter stores today. */
  site: string;
  official: boolean;
};

/**
 * Trailers for a title.
 *
 * The tab is rendered only when this has something in it, so a film TMDB publishes no
 * trailer for gets no Videos tab rather than an empty one — the same rule the TMDB
 * Reviews section follows. `20260816000500` records why the schema learned about
 * videos before anything fetched them; the adapter has written the facet since the
 * Phase E deployment on 2026-08-17, so the list is empty now only when TMDB's is.
 *
 * A title is filled in on first open (`useTitleEnrichment`), which is also when the
 * facet is written — so the very first viewer of a never-enriched row sees no Videos
 * tab, and it appears when the enrichment lands and this query is invalidated.
 */
export function useTitleVideos(mediaItemId: string | null) {
  return useQuery({
    queryKey: ['videos', mediaItemId],
    enabled: Boolean(mediaItemId),
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<TitleVideo[] | null> => {
      const { data, error } = await supabase
        .from('media_cache')
        .select('payload')
        .eq('media_item_id', mediaItemId!)
        .eq('facet', 'videos')
        .maybeSingle();
      if (error) throw error;

      // **Null and empty are different answers**, and the difference is what makes the
      // Phase E deployment reach titles that were enriched before it.
      //
      // Null means no facet row: nobody has asked TMDB about this title's videos since
      // the adapter learned to store them. Empty means TMDB was asked and had none —
      // the adapter writes the facet either way, which is what stops the check below
      // from asking forever about a film with no trailer.
      //
      // Without this the deployment would have been almost inert. `isThin` decides
      // whether to enrich, and it asks about artwork, overview and runtime — all of
      // which the five hundred already-enriched rows have. They would have been
      // complete by that measure and permanently without trailers or reviews, and the
      // only titles ever to get either would have been ones discovered afterwards.
      if (!data) return null;

      const payload = data.payload as { results?: TitleVideo[] } | undefined;
      return payload?.results ?? [];
    },
  });
}

/**
 * `useTitleNotes` lived here until 2026-08-17 and is gone.
 *
 * It backed a "Notes" section on the title page, which the founder's correction
 * replaced with a Reviews tab — and a review **is** a public Note, so keeping both
 * would have been the same content under two headings. `title_reviews` supersedes it
 * and does in one definer query what this did in two round trips, because it also
 * needs the author's live score and their reaction count.
 *
 * `public_notes` itself is untouched and still backs the profile surfaces.
 */
