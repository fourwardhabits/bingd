import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export type PersonCredit = {
  mediaItemId: string;
  title: string;
  kind: 'movie' | 'series' | 'season';
  year: number | null;
  posterPath: string | null;
  seriesTitle: string | null;
  /** What they did in it — a character, or a crew job. */
  role: string | null;
};

export type PersonDetail = {
  id: string;
  name: string;
  profilePath: string | null;
  credits: PersonCredit[];
};

type CastEntry = { id: number | string; name: string; character?: string | null; profile_path?: string | null };
type CrewEntry = { id: number | string; name: string; job?: string | null; department?: string | null };

/**
 * A person, assembled from the credits the app already holds.
 *
 * There is no `people` table, and this deliberately does not add one. The only person
 * data in the database lives inside `media_cache.credits`, which the provider owns
 * and refreshes; a table would be a second copy of it to keep in step, and the page
 * has exactly one useful question to answer — what else of theirs is here.
 *
 * So the question is asked of the credits payloads directly, as a jsonb containment
 * match served by the partial GIN index in `20260816000500`. `media_cache` is
 * world-readable (`media_cache_read` is `using (true)`), which is right: a cast list
 * is catalogue metadata, not anybody's private data.
 *
 * The name and photograph come from whichever credit mentions them, because that is
 * where TMDB puts them and there is nowhere else to look. If the catalogue has never
 * been enriched, this returns null and the screen says so rather than inventing a
 * person out of an id in a URL.
 */
export function usePerson(personId: string | null) {
  return useQuery({
    queryKey: ['person', personId],
    enabled: Boolean(personId),
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<PersonDetail | null> => {
      const numeric = Number(personId);
      // TMDB person ids are integers. A non-numeric id cannot match anything, and
      // building a containment filter out of it would be putting unvalidated input
      // into a query shape for no possible gain.
      if (!Number.isFinite(numeric)) return null;

      const [cast, crew] = await Promise.all([
        supabase
          .from('media_cache')
          .select('media_item_id, payload')
          .eq('facet', 'credits')
          .filter('payload', 'cs', JSON.stringify({ cast: [{ id: numeric }] }))
          .limit(50),
        supabase
          .from('media_cache')
          .select('media_item_id, payload')
          .eq('facet', 'credits')
          .filter('payload', 'cs', JSON.stringify({ crew: [{ id: numeric }] }))
          .limit(50),
      ]);

      if (cast.error) throw cast.error;
      if (crew.error) throw crew.error;

      const rows = [...(cast.data ?? []), ...(crew.data ?? [])] as {
        media_item_id: string;
        payload: { cast?: CastEntry[]; crew?: CrewEntry[] };
      }[];
      if (!rows.length) return null;

      // One entry per title, and the acting credit wins where somebody both wrote
      // and appeared in something — it is the one a viewer recognises them for.
      const roleByMedia = new Map<string, string | null>();
      let name: string | null = null;
      let profilePath: string | null = null;

      for (const row of rows) {
        const castEntry = (row.payload.cast ?? []).find((p) => String(p.id) === String(numeric));
        const crewEntry = (row.payload.crew ?? []).find((p) => String(p.id) === String(numeric));
        const entry = castEntry ?? crewEntry;
        if (!entry) continue;

        name ??= entry.name;
        profilePath ??= castEntry?.profile_path ?? null;

        const role = castEntry?.character ?? crewEntry?.job ?? crewEntry?.department ?? null;
        if (!roleByMedia.has(row.media_item_id) || castEntry) {
          roleByMedia.set(row.media_item_id, role);
        }
      }

      if (!name) return null;

      const ids = [...roleByMedia.keys()];
      const { data: media, error: mediaError } = await supabase
        .from('media_items')
        .select('id, kind, title, release_date, poster_path, parent:parent_id(title)')
        .in('id', ids);
      if (mediaError) throw mediaError;

      const credits: PersonCredit[] = ((media ?? []) as unknown as {
        id: string;
        kind: PersonCredit['kind'];
        title: string;
        release_date: string | null;
        poster_path: string | null;
        parent: { title: string } | { title: string }[] | null;
      }[])
        .map((item) => {
          const parent = Array.isArray(item.parent) ? item.parent[0] : item.parent;
          return {
            mediaItemId: item.id,
            title: item.title,
            kind: item.kind,
            year: item.release_date ? Number(item.release_date.slice(0, 4)) : null,
            posterPath: item.poster_path,
            seriesTitle: parent?.title ?? null,
            role: roleByMedia.get(item.id) ?? null,
          };
        })
        // Newest first, and undated last rather than first — an unenriched row
        // sorting above someone's best-known film reads as a bug.
        .sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity));

      return { id: String(personId), name, profilePath, credits };
    },
  });
}
