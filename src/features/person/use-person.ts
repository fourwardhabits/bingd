import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { cachePerson } from '@/lib/tmdb-adapter';
import { supabase } from '@/lib/supabase';

export type PersonCredit = {
  mediaItemId: string;
  title: string;
  /** Movie or series. Never a season — TMDB credits people on shows, not seasons. */
  kind: 'movie' | 'series';
  year: number | null;
  posterPath: string | null;
  /** What they did in it — a character, or a crew job. */
  role: string | null;
  /** Which list TMDB had them in, which is the difference between acting and crew. */
  as: 'cast' | 'crew';
};

export type PersonDetail = {
  /** TMDB's person id, as a string, because that is what the route carries. */
  id: string;
  name: string;
  profilePath: string | null;
  /** TMDB's `known_for_department` — "Acting", "Directing", "Writing". */
  knownFor: string | null;
  biography: string | null;
  biographyTruncated: boolean;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  credits: PersonCredit[];
  /** How many credits TMDB had, which is usually more than were kept. */
  creditTotal: number;
};

/** A TMDB person id is a positive integer, and nothing else is worth a request. */
function personIdOf(value: string | null): number | null {
  const numeric = Number(value);
  // `Number.isSafeInteger` rather than `isFinite`, which waves through decimals,
  // negatives and exponent forms. Carried over from the previous implementation,
  // where independent review asked for the tighter form.
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

type CachedPayload = {
  person?: {
    name?: string;
    profile_path?: string | null;
    known_for?: string | null;
    biography?: string | null;
    biography_truncated?: boolean;
    birthday?: string | null;
    deathday?: string | null;
    place_of_birth?: string | null;
  };
  credits?: { id: string; kind: 'movie' | 'series'; role: string | null; as: 'cast' | 'crew' }[];
  credit_total?: number;
};

/**
 * A person, and everything TMDB credits them on.
 *
 * **This is no longer a view of the reader's own catalogue, and that is the change.**
 * The previous implementation answered "which titles already in this database mention
 * this person" by scanning `media_cache.credits` payloads for their id. The query was
 * sound and the index served it, but the question was wrong: somebody who has just
 * tapped a face wants to know what else that person has worked on, and answering with
 * a filter over the local catalogue meant a fresh install showed an actor with no
 * credits and an enriched one showed them with two.
 *
 * So the filmography comes from TMDB, cached in `person_cache` (20260817000500), and
 * every credited title is written into `media_items` by the adapter before the cache
 * row is written. That second half is what makes the page a discovery surface rather
 * than a list of names: a film the reader has never heard of is a real catalogue row
 * by the time it appears here, so opening it, ranking it or saving it is the same
 * action it would be anywhere else in the app. There is no import step and no id that
 * means something only to TMDB.
 *
 * `person_cache` is world-readable, like `media_items` and `media_cache` — a public
 * filmography is catalogue metadata and says nothing about any account — so this is a
 * plain select. Nothing viewer-relative is stored in it; whether the reader has
 * ranked, watched or saved a credit is answered by the tables that already answer it.
 *
 * The credits are returned in the cache's own order, which is the provider's
 * popularity ranking. Re-sorting here would derive a worse copy of an ordering that
 * was already applied where the popularity numbers were.
 */
export function usePerson(personId: string | null) {
  const numeric = personIdOf(personId);

  return useQuery({
    queryKey: ['person', numeric],
    enabled: numeric !== null,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<PersonDetail | null> => {
      const { data, error } = await supabase
        .from('person_cache')
        .select('payload')
        .eq('tmdb_person_id', numeric!)
        .maybeSingle();
      if (error) throw error;

      const payload = data?.payload as CachedPayload | undefined;
      // A payload with no `credits` array is a claim placeholder, not a person with
      // no work — somebody else is fetching them right now. Treated as absent, which
      // is what makes the screen show its loading state rather than an empty
      // filmography under a real name.
      const person = payload?.person;
      const name = person?.name;
      if (!person || !name || !Array.isArray(payload?.credits)) return null;

      const entries = payload.credits;
      const ids = entries.map((credit) => credit.id);

      const rows = ids.length
        ? await supabase
            .from('media_items')
            .select('id, kind, title, release_date, poster_path')
            .in('id', ids)
        : { data: [], error: null };
      if (rows.error) throw rows.error;

      const byId = new Map(
        ((rows.data ?? []) as {
          id: string;
          kind: PersonCredit['kind'];
          title: string;
          release_date: string | null;
          poster_path: string | null;
        }[]).map((row) => [row.id, row]),
      );

      const credits: PersonCredit[] = entries
        .map((credit) => {
          const row = byId.get(credit.id);
          // A credit whose catalogue row has gone is dropped rather than rendered as
          // a title-less tile. It should not happen — the adapter writes the rows
          // before the payload — but a cached payload outlives one deletion.
          if (!row) return null;
          return {
            mediaItemId: row.id,
            title: row.title,
            kind: credit.kind,
            year: row.release_date ? Number(row.release_date.slice(0, 4)) : null,
            posterPath: row.poster_path,
            role: credit.role,
            as: credit.as,
          };
        })
        .filter((credit): credit is PersonCredit => credit !== null);

      return {
        id: String(numeric),
        name,
        profilePath: person.profile_path ?? null,
        knownFor: person.known_for ?? null,
        biography: person.biography ?? null,
        biographyTruncated: Boolean(person.biography_truncated),
        birthday: person.birthday ?? null,
        deathday: person.deathday ?? null,
        placeOfBirth: person.place_of_birth ?? null,
        credits,
        creditTotal: payload.credit_total ?? credits.length,
      };
    },
  });
}

/**
 * Fetches a person the first time somebody opens them, at most once per mount.
 *
 * The same shape as `useTitleEnrichment` and for the same reason: the fetch
 * invalidates the query that decides whether a fetch is needed, so without the
 * attempted-set guard a person TMDB has nothing useful for would be requested on
 * every render and spend the api.md §9 ceiling doing it.
 *
 * `needed` is "the cache had nothing" rather than "the cache is stale". A stale row
 * still renders a complete page, and a background refresh that replaces one
 * filmography with a nearly identical one while somebody is reading it is worse than
 * a week-old credit list — the adapter's seven-day TTL is what handles the staleness,
 * on whoever opens the page after it lapses.
 *
 * A failure is deliberately silent past the empty state the screen already shows. An
 * error banner would be a second thing on a page whose first thing is already "we do
 * not have this person".
 */
export function usePersonFetch(personId: string | null, needed: boolean) {
  const queryClient = useQueryClient();
  const numeric = personIdOf(personId);
  const [fetching, setFetching] = useState(false);
  const attempted = useRef(new Set<number>());

  useEffect(() => {
    if (numeric === null || !needed || attempted.current.has(numeric)) return;
    attempted.current.add(numeric);

    let cancelled = false;
    setFetching(true);

    cachePerson(numeric)
      .then(async () => {
        if (cancelled) return;
        await queryClient.invalidateQueries({ queryKey: ['person', numeric] });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setFetching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [numeric, needed, queryClient]);

  return { fetching };
}
