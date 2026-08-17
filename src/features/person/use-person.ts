import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

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

/**
 * What the cache holds for one person, which is three states rather than two.
 *
 * The third is the one a nullable `PersonDetail` could not express and independent
 * review 13 found the consequences of: a row that exists, is fresh, and carries a
 * *claim placeholder* rather than a filmography, because somebody else's request is
 * in flight right now. Reported as "nothing cached", it made a losing caller show the
 * empty state and stop — no retry, no poll, and no invalidation when the winner's
 * write landed a second later. Two people opening the same actor at the same moment
 * meant one of them saw an empty page indefinitely.
 */
export type PersonState = {
  /** Null while nothing usable is cached. */
  detail: PersonDetail | null;
  /** Somebody else holds the claim. Poll; do not spend a second request. */
  claimed: boolean;
  /** Past its TTL. Render it, and refresh behind the reader. */
  stale: boolean;
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

const NOTHING: PersonState = { detail: null, claimed: false, stale: false };

/** How often to look again while somebody else is fetching this person. */
const CLAIM_POLL_MS = 1_500;

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
 * **`expires_at` is selected, not just the payload.** Without it there is no way to
 * know a cached filmography has lapsed, and nothing would ever ask for a fresh one —
 * the seven-day TTL would be a number in a migration that no code path could act on.
 * Independent review 13 found exactly that. A stale row is still returned and still
 * rendered; the refresh happens behind the reader rather than instead of them.
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
    // While somebody else's request is in flight, look again shortly. The claim is a
    // two-minute placeholder, so this polls a handful of times at most and stops the
    // moment the winner's payload lands — which is the only way a losing caller ever
    // sees the answer, since nothing invalidates this query on their behalf.
    refetchInterval: (query) => (query.state.data?.claimed ? CLAIM_POLL_MS : false),
    queryFn: async (): Promise<PersonState> => {
      const { data, error } = await supabase
        .from('person_cache')
        .select('payload, expires_at')
        .eq('tmdb_person_id', numeric!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return NOTHING;

      const row = data as { payload: CachedPayload | null; expires_at: string | null };
      const expired = row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : true;

      const payload = row.payload ?? undefined;
      const person = payload?.person;
      const name = person?.name;

      // A payload with no `credits` array is a claim placeholder, not a person with no
      // work. An *unexpired* one means somebody is fetching them right now; an expired
      // one means that somebody never came back, and the right answer is to ask again.
      if (!person || !name || !Array.isArray(payload?.credits)) {
        return expired ? NOTHING : { detail: null, claimed: true, stale: false };
      }

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
        }[]).map((item) => [item.id, item]),
      );

      const credits: PersonCredit[] = entries
        .map((credit) => {
          const item = byId.get(credit.id);
          // A credit whose catalogue row has gone is dropped rather than rendered as
          // a title-less tile. It should not happen — the adapter writes the rows
          // before the payload — but a cached payload outlives one deletion.
          if (!item) return null;
          return {
            mediaItemId: item.id,
            title: item.title,
            kind: credit.kind,
            year: item.release_date ? Number(item.release_date.slice(0, 4)) : null,
            posterPath: item.poster_path,
            role: credit.role,
            as: credit.as,
          };
        })
        .filter((credit): credit is PersonCredit => credit !== null);

      return {
        detail: {
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
        },
        claimed: false,
        stale: expired,
      };
    },
  });
}

/**
 * Fetches a person the first time somebody opens them, at most once per mount.
 *
 * The attempted-set guard is not optional. The fetch invalidates the query that
 * decides whether a fetch is needed, so without it a person TMDB has nothing useful
 * for would be requested on every render and spend the api.md §9 ceiling doing it.
 *
 * `needed` is decided by the caller and is two cases, not one: nothing cached, or
 * something cached that has expired. The second is what makes the seven-day TTL real
 * — a stale row still renders a complete page, and the refresh happens behind the
 * reader. It is deliberately **not** "somebody else holds the claim": that case wants
 * a poll, which `usePerson` does, and a second provider request there is precisely
 * what the claim exists to prevent.
 *
 * `retry` is the escape hatch the guard would otherwise close. If the winner of a
 * claim dies, its placeholder expires after two minutes and the row reads as absent
 * again — but this hook has already spent its one attempt for this mount. Clearing
 * the attempt on an explicit tap is the right gate: user-initiated, so it cannot loop.
 *
 * A failure is deliberately silent past the empty state the screen already shows. An
 * error banner would be a second thing on a page whose first thing is already "we do
 * not have this person".
 */
export function usePersonFetch(personId: string | null, needed: boolean) {
  const queryClient = useQueryClient();
  const numeric = personIdOf(personId);
  const [fetching, setFetching] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const attempted = useRef(new Set<number>());

  useEffect(() => {
    if (numeric === null || !needed || attempted.current.has(numeric)) return;
    attempted.current.add(numeric);

    let cancelled = false;
    setFetching(true);

    cachePerson(numeric)
      .then(async () => {
        if (cancelled) return;
        // Invalidated whatever the adapter said, including `cached` — losing the
        // claim is exactly when the poll needs to start, and the poll is driven by
        // this query seeing the placeholder.
        await queryClient.invalidateQueries({ queryKey: ['person', numeric] });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setFetching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [numeric, needed, queryClient, attempt]);

  const retry = useCallback(() => {
    if (numeric !== null) attempted.current.delete(numeric);
    setAttempt((count) => count + 1);
  }, [numeric]);

  return { fetching, retry };
}
