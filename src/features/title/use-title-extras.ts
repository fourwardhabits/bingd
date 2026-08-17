import { useQuery } from '@tanstack/react-query';

import { avatarUri, profileUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

export type TitleVideo = {
  id: string;
  key: string;
  name: string;
  type: string;
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
    queryFn: async (): Promise<TitleVideo[]> => {
      const { data, error } = await supabase
        .from('media_cache')
        .select('payload')
        .eq('media_item_id', mediaItemId!)
        .eq('facet', 'videos')
        .maybeSingle();
      if (error) throw error;

      const payload = data?.payload as { results?: TitleVideo[] } | undefined;
      return payload?.results ?? [];
    },
  });
}

export type TmdbReview = {
  id: string;
  author: string;
  avatarUri: string | null;
  /** The 0–10 value the author attached on TMDB's site, or null — most attach none. */
  rating: number | null;
  body: string;
  /** True when the stored body is an excerpt and the rest is on TMDB. */
  truncated: boolean;
  createdAt: string | null;
  url: string | null;
};

/**
 * Reviews written by **TMDB's own site users**, for one title.
 *
 * The name matters and is fixed in three places — this type, the section heading, and
 * the facet in the database. These are not critic reviews and not professional ones;
 * TMDB publishes neither. Nor are they anything of Bingd's: the Community score is an
 * aggregate over `rankings`, a Note is `user_media.note`, and a comment is a `comments`
 * row against a feed event. None of those three is in this payload and none of them
 * should ever be merged into it.
 *
 * `media_cache` is world-readable, which is right — a published review on a public
 * catalogue page is not anybody's private data — so this is a plain select rather than
 * a definer function. Seasons have no reviews at all and never will: TMDB's
 * /tv/{id}/reviews is about the series, and attributing it to a season would put
 * somebody's words under a heading they did not write them for.
 */
export function useTitleReviews(mediaItemId: string | null) {
  return useQuery({
    queryKey: ['tmdb-reviews', mediaItemId],
    enabled: Boolean(mediaItemId),
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<TmdbReview[]> => {
      const { data, error } = await supabase
        .from('media_cache')
        .select('payload')
        .eq('media_item_id', mediaItemId!)
        .eq('facet', 'reviews')
        .maybeSingle();
      if (error) throw error;

      const payload = data?.payload as
        | {
            results?: {
              id: string;
              author: string;
              avatar_path: string | null;
              rating: number | null;
              content: string;
              truncated?: boolean;
              created_at: string | null;
              url: string | null;
            }[];
          }
        | undefined;

      return (payload?.results ?? []).map((review) => ({
        id: review.id,
        author: review.author,
        avatarUri: reviewAvatarUri(review.avatar_path),
        rating: review.rating,
        body: review.content,
        truncated: Boolean(review.truncated),
        createdAt: review.created_at,
        url: review.url,
      }));
    },
  });
}

/**
 * A review author's photograph, which comes in two shapes and only two.
 *
 * The adapter has already unwrapped TMDB's leading-slash-before-an-absolute-URL form,
 * so what arrives here is either an absolute URL (a Gravatar, for the majority of
 * accounts that have one) or a TMDB image path. Anything else falls back to initials,
 * which is what `Avatar` does for a Bingd user without a photograph.
 */
function reviewAvatarUri(path: string | null): string | null {
  if (!path) return null;
  if (/^https:\/\//i.test(path)) return path;
  // Deliberately not http:. An avatar is the one thing on this screen loaded from a
  // host neither Bingd nor TMDB controls, and a cleartext image request from a
  // release build is a lint failure waiting to happen on both platforms.
  if (/^http:\/\//i.test(path)) return null;
  return profileUri(path);
}

export type TitleNote = {
  userId: string;
  username: string;
  name: string;
  avatarUri: string | null;
  note: string;
  hasSpoilers: boolean;
  updatedAt: string | null;
};

/**
 * What people have written about this exact title.
 *
 * Two queries, because `public_notes` is a definer function that projects only the
 * note columns — it cannot embed a profile, and it should not: widening it to join
 * `profiles` would put a second table's exposure decisions inside a function whose
 * whole justification is that it exposes exactly five columns of one table.
 *
 * So the notes come back first, and the names are resolved from `public_profiles`,
 * which is the view that already exists for exactly this. Both reads are already
 * authorised — a note only arrives if `can_view_profile` said so — and a profile that
 * fails to resolve drops its note rather than rendering an anonymous one.
 */
export function useTitleNotes(mediaItemId: string | null) {
  return useQuery({
    queryKey: ['title-notes', mediaItemId],
    enabled: Boolean(mediaItemId),
    queryFn: async (): Promise<TitleNote[]> => {
      const { data, error } = await supabase.rpc('public_notes', {
        p_user_ids: null,
        p_media_item_ids: [mediaItemId],
        p_limit: 25,
      });
      if (error) throw error;

      const notes = (data ?? []) as {
        user_id: string;
        note: string;
        has_spoilers: boolean;
        updated_at: string | null;
      }[];
      if (!notes.length) return [];

      const { data: people, error: peopleError } = await supabase
        .from('public_profiles')
        .select('id, username, display_name, avatar_path')
        .in('id', [...new Set(notes.map((note) => note.user_id))]);
      if (peopleError) throw peopleError;

      const byId = new Map(
        (people ?? []).map((person) => [
          person.id as string,
          person as { id: string; username: string; display_name: string | null; avatar_path: string | null },
        ]),
      );

      return notes
        .map((note) => {
          const person = byId.get(note.user_id);
          if (!person) return null;
          return {
            userId: note.user_id,
            username: person.username,
            name: person.display_name || person.username,
            avatarUri: avatarUri(person.avatar_path),
            note: note.note,
            hasSpoilers: note.has_spoilers,
            updatedAt: note.updated_at,
          };
        })
        .filter(Boolean) as TitleNote[];
    },
  });
}
