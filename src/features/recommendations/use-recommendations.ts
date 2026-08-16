import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

/**
 * The most recent slate, read rather than built.
 *
 * `recs-builder` writes generations on a schedule ([`recommendations.md`](../../../docs/architecture/recommendations.md) §1),
 * so opening this tab is a read of the newest one. Building on demand would put
 * candidate generation, scoring and diversity re-ranking in the path of a tab tap.
 *
 * The client never composes a reason. It receives the selected slate with its
 * stored `evidence` and renders a sentence from that structure — it is never
 * given the candidate pool, so there is nothing available to fabricate from
 * (AD-8, PRD §13).
 */

/** The evidence shapes the builder writes, and the only ones rendered. */
export type Evidence =
  | { kind: 'social'; endorser_count: number }
  | { kind: 'following'; actor_name?: string; their_position?: number }
  | { kind: 'content'; because_title?: string }
  | { kind: 'fresh' }
  | { kind: 'curated' };

export type Recommendation = {
  mediaItemId: string;
  rank: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  evidence: Evidence;
};

export type Slate = {
  generatedAt: string;
  items: Recommendation[];
};

type MediaShape = {
  title: string;
  release_date: string | null;
  poster_path: string | null;
};

/** PostgREST returns an embedded row as an object but types it as an array. */
const media = (value: MediaShape | MediaShape[] | null): MediaShape =>
  (Array.isArray(value) ? value[0] : value) ?? {
    title: '',
    release_date: null,
    poster_path: null,
  };

export function useRecommendations(userId: string) {
  return useQuery({
    queryKey: queryKeys.recommendations(userId),
    enabled: Boolean(userId),
    // A slate is built on a schedule, so refetching it minutes later returns the
    // same rows. Half an hour is well inside the build cadence.
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<Slate | null> => {
      const { data: generation, error: generationError } = await supabase
        .from('recommendation_generations')
        .select('id, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (generationError) throw generationError;
      // No generation is not an error. It is a user the builder has not reached
      // yet, which is every user before their first slate.
      if (!generation) return null;

      const { data, error } = await supabase
        .from('recommendations')
        .select('media_item_id, rank, evidence, media_items(title, release_date, poster_path)')
        .eq('generation_id', generation.id)
        .order('rank');

      if (error) throw error;

      const items = (data ?? []).map((row) => {
        const item = media(row.media_items as MediaShape | MediaShape[] | null);
        return {
          mediaItemId: row.media_item_id as string,
          rank: row.rank as number,
          title: item.title,
          year: item.release_date ? Number(item.release_date.slice(0, 4)) : null,
          posterPath: item.poster_path,
          evidence: row.evidence as Evidence,
        };
      });

      return { generatedAt: generation.created_at as string, items };
    },
  });
}

export type Shelf = {
  /** Stable across renders, so a shelf keeps its scroll position. */
  id: string;
  title: string;
  items: Recommendation[];
};

/**
 * Groups a slate into shelves, one per distinct reason.
 *
 * The shelf title *is* the explanation — that is the whole argument for shelves
 * over a vertical list. A reason that covers six titles costs one line instead
 * of six ([`screens.md`](../../../docs/design/screens.md) §8).
 *
 * A recommendation whose evidence this function cannot turn into a sentence is
 * dropped rather than shown under a generic heading. "Recommended for you" is
 * precisely the unfalsifiable label PRD §13 exists to forbid, and a slate is
 * worth less than the credibility of the ones that can explain themselves.
 */
export function shelvesFrom(slate: Slate | null | undefined): Shelf[] {
  if (!slate) return [];

  const byTitle = new Map<string, Shelf>();

  for (const item of slate.items) {
    const title = shelfTitleFor(item.evidence);
    if (!title) continue;

    const existing = byTitle.get(title);
    if (existing) existing.items.push(item);
    else byTitle.set(title, { id: title, title, items: [item] });
  }

  // Insertion order, which is slate rank order, so the strongest recommendation
  // determines which shelf comes first.
  return [...byTitle.values()];
}

function shelfTitleFor(evidence: Evidence | null | undefined): string | null {
  if (!evidence?.kind) return null;

  switch (evidence.kind) {
    case 'social': {
      const n = evidence.endorser_count;
      if (!n) return null;
      return n === 1
        ? 'Someone with similar taste loved this'
        : `${n} people with similar taste loved this`;
    }
    case 'following':
      return evidence.actor_name ? `${evidence.actor_name} ranked this highly` : 'From people you follow';
    case 'content':
      // The one reason that names a specific film, and the most convincing for
      // it. Without the title it is indistinguishable from "recommended", so it
      // is dropped rather than softened.
      return evidence.because_title ? `Because you loved ${evidence.because_title}` : null;
    case 'fresh':
      return 'New this month';
    case 'curated':
      return 'A good place to start';
    default:
      return null;
  }
}
