import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';
import { AdapterError, searchCast, type CastSearchResult } from '@/lib/tmdb-adapter';

import {
  clearProviderCooldown,
  noteProviderRateLimited,
  PROVIDER_CACHE_MS,
  providerCooldownUntil,
  providerQueryOf,
} from './provider-budget';
import { PROVIDER_DEBOUNCE_MS, useDebounced } from './use-title-search';

export type { CastSearchResult };

/** Below this every name matches half of TMDB, and a request is spent to learn nothing. */
const MIN_QUERY_LENGTH = 2;

/**
 * Cast search: performers TMDB knows by the name being typed.
 *
 * **Only while the Cast chip is selected** (`enabled`). Every call spends a provider
 * request against the reader's hourly ceiling, so running it beside every title search
 * would double what an ordinary search costs to fill a list nobody had asked to see.
 *
 * **The provider pass's rules, not a second set.** The same 800ms debounce, the same
 * normalised query as the cache key, the same half-hour cache, no automatic retry, and the
 * same cooldown — a refusal here is a refusal for the title search too, because it is one
 * budget.
 *
 * There is no local half. Bingd has no person table to search (20260817000500), and
 * `person_cache` only holds people somebody has already opened.
 */
export function useCastSearch(input: string, enabled: boolean) {
  const typed = providerQueryOf(input);
  const settled = providerQueryOf(useDebounced(input, PROVIDER_DEBOUNCE_MS));
  const cooldownUntil = providerCooldownUntil();

  const long = settled.length >= MIN_QUERY_LENGTH;
  const active = enabled && long && settled === typed && cooldownUntil === null;

  const query = useQuery({
    queryKey: queryKeys.castSearch(settled),
    enabled: active,
    // The last answer stays up while the next name settles, rather than blinking to a
    // skeleton on every keystroke. Dimmed by the screen, which reads `isPlaceholderData`.
    placeholderData: keepPreviousData,
    staleTime: PROVIDER_CACHE_MS,
    retry: false,
    queryFn: async () => {
      try {
        return await searchCast(settled);
      } catch (cause) {
        if (cause instanceof AdapterError && cause.isRateLimit) noteProviderRateLimited();
        throw cause;
      }
    },
  });

  // An answer already held for this name is still an answer during the cooldown.
  const held = query.data !== undefined && !query.isPlaceholderData;
  const rateLimited =
    enabled &&
    ((cooldownUntil !== null && !held) ||
      (query.error instanceof AdapterError && query.error.isRateLimit));

  return {
    /** Too little typed to search, which is not an empty result. */
    idle: typed.length < MIN_QUERY_LENGTH,
    results: query.data ?? [],
    /** Typing has not settled yet, or the request is out. Either way no answer is final. */
    searching: enabled && !rateLimited && (typed !== settled || query.isFetching),
    stale: query.isPlaceholderData,
    rateLimited,
    /** When Cast search comes back, while it is rate limited. */
    availableAt: rateLimited ? cooldownUntil : null,
    failed: enabled && Boolean(query.error) && !rateLimited,
    /** Asked and answered, with nothing — the one state "nobody by that name" is true in. */
    // From `held` rather than `active`: an empty answer already cached for this name is
    // still an answer while the cooldown holds the query disabled, and gating on `active`
    // left that case on a skeleton until the reader typed again.
    answered: enabled && long && settled === typed && held && !query.isFetching && !query.error,
    retry: () => {
      clearProviderCooldown();
      if (long) void query.refetch();
    },
  };
}
