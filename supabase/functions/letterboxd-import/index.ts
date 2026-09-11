/**
 * letterboxd-import — the provider tier of the import matcher, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SO SMALL
 *
 * Matching a Letterboxd row to a bingd title is mostly a local question, and
 * `_import_match_batch` answers it in SQL: the shared film-URI cache first, then exactly
 * one catalogue movie whose squashed title matches and whose year is within one. A job
 * completes with or without this function; rows it cannot place simply end unmatched.
 *
 * What SQL cannot do is talk to TMDB. So this is the only part that does, and it is
 * deliberately the only part that holds a key.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THE ACCOUNTING IS NOT IN HERE
 *
 * The claim, the per-row attempt ceiling and the terminal states live in
 * `_import_provider_claim` and `_import_provider_resolve`, where they can be tested
 * without a provider at all. This function is a loop between them. That split is the
 * reason the backoff behaviour has real coverage: a test can spend a row's three attempts
 * and watch it settle as unmatched without ever issuing an HTTP request.
 *
 * ---------------------------------------------------------------------------
 * SERVICE ROLE ONLY, AND THE CALLER IS THE DATABASE
 *
 * `_drain_import_jobs` posts here on a pg_cron tick, with the service key from the vault —
 * the same path `push-sender` uses. No device ever calls this and no device ever holds the
 * key that would let it: the client's whole surface is `import_create`, `import_stage`,
 * `import_ready` and `import_status`, all of which run as the caller under RLS.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/**
 * The confidence rule lives in `match.mjs` — plain JavaScript with no imports, so that
 * `node --test` can exercise every branch of it on a machine with no Deno installed. It is
 * the only part of this function that makes a decision, and therefore the only part worth
 * a suite of its own.
 */
import { pick } from './match.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

/**
 * TMDB's guidance is to stay well inside fifty requests a second. Eight at a time keeps a
 * batch under a couple of seconds without approaching it, and matches the concurrency the
 * catalogue adapter already settled on.
 */
const CONCURRENCY = 8;

/** One invocation's ceiling. The tick calls again while rows remain. */
const BATCH = 50;

export type Claim = { row_id: string; name: string; year: number | null };
export type ProviderResult = { id: number; title: string; release_date?: string | null };

async function search(claim: Claim, key: string, bearer: string | null): Promise<ProviderResult[]> {
  const url = new URL('https://api.themoviedb.org/3/search/movie');
  url.searchParams.set('query', claim.name);
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('include_adult', 'false');
  if (claim.year !== null) url.searchParams.set('primary_release_year', String(claim.year));
  if (!bearer) url.searchParams.set('api_key', key);

  const response = await fetch(url, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });

  // 429 is the provider asking for room. Throwing here leaves the row's status untouched
  // and its attempt spent, so the next tick retries it — which is the backoff: fewer rows
  // reach the provider per tick until it stops saying 429.
  if (response.status === 429) throw new Error('provider rate limited');
  if (!response.ok) throw new Error(`provider ${response.status}`);

  const body = await response.json();
  return Array.isArray(body?.results) ? body.results : [];
}

/**
 * Writes a resolved title through the catalogue adapter's own upsert, so a film the
 * provider found enters `media_items` exactly as a search would have put it there —
 * one row per (kind, tmdb_id), with the provenance the catalogue expects.
 */
async function upsert(db: SupabaseClient, result: ProviderResult): Promise<string | null> {
  const { data, error } = await db.rpc('tmdb_upsert_titles', {
    p_titles: [
      {
        kind: 'movie',
        tmdb_id: result.id,
        title: result.title,
        release_date: result.release_date ?? null,
      },
    ],
  });
  if (error) return null;
  return Array.isArray(data) && data.length > 0 ? (data[0].id ?? null) : null;
}

async function resolveBatch(db: SupabaseClient, key: string, bearer: string | null) {
  const { data: claims, error } = await db.rpc('_import_provider_claim', { p_limit: BATCH });
  if (error) throw new Error(error.message);
  if (!Array.isArray(claims) || claims.length === 0) return { claimed: 0, matched: 0 };

  let matched = 0;
  let rateLimited = false;

  for (let i = 0; i < claims.length; i += CONCURRENCY) {
    const slice = claims.slice(i, i + CONCURRENCY) as Claim[];

    await Promise.all(
      slice.map(async (claim) => {
        try {
          const chosen = pick(claim, await search(claim, key, bearer));
          const mediaItemId = chosen ? await upsert(db, chosen) : null;
          await db.rpc('_import_provider_resolve', {
            p_row_id: claim.row_id,
            p_media_item_id: mediaItemId,
          });
          if (mediaItemId) matched += 1;
        } catch (cause) {
          // The attempt is already spent by the claim. Leaving the row alone is the whole
          // of the retry: it stays `needs_provider` until its third attempt, and settles
          // as unmatched after that.
          if (String(cause).includes('rate limited')) rateLimited = true;
        }
      }),
    );

    // Stop the invocation the moment the provider pushes back rather than working through
    // the rest of the batch collecting 429s.
    if (rateLimited) break;
  }

  return { claimed: claims.length, matched, rateLimited };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const authorization = request.headers.get('Authorization') ?? '';

  // ---------------------------------------------------------------------------
  // The database is the only caller. `verify_jwt` has already proven the token genuine;
  // this checks it is the service role rather than a signed-in person.
  //
  // `push-sender`'s shape: compare the stripped token to the key, and fall back to the
  // `role` claim, because Supabase now issues `sb_secret_…` keys alongside the legacy JWTs
  // and which one the platform injects is not this function's business.
  //
  // **The empty-key case is refused explicitly.** An earlier version tested
  // `authorization.includes(serviceKey)`, which is true of every string when `serviceKey`
  // is `''` — so a project with the env var missing skipped the role check entirely. It
  // happened to fail later, when `createClient(url, '')` could not authenticate, which is
  // failing closed by accident rather than by design.
  // ---------------------------------------------------------------------------
  const token = authorization.replace(/^Bearer\s+/i, '').trim();

  const claimsServiceRole = (() => {
    if (serviceKey !== '' && token === serviceKey) return true;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    try {
      // base64**url** — `atob` wants `+` and `/` and demands padding, so a raw JWT payload
      // throws without these two lines and the fallback is silently dead. `push-sender`
      // does the same conversion, and the fallback exists for the same reason it does
      // there: Supabase issues `sb_secret_…` keys alongside the legacy JWTs, so an equality
      // test against the env var is not always the whole answer.
      const padded = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')))?.role === 'service_role';
    } catch {
      return false;
    }
  })();

  if (!claimsServiceRole) {
    return json({ error: { code: 'BG403', message: 'service role required' } }, 403);
  }

  if (serviceKey === '' || url === '') {
    return json({ error: { code: 'BG500', message: 'function is not configured' } }, 500);
  }

  const tmdbKey = Deno.env.get('TMDB_API_KEY') ?? '';
  const tmdbBearer = Deno.env.get('TMDB_READ_TOKEN') ?? null;
  if (!tmdbKey && !tmdbBearer) {
    // Not an error. A project with no provider configured still imports; it places fewer
    // titles, and the rows say so.
    return json({ status: 'no_provider' });
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  try {
    return json({ status: 'ok', ...(await resolveBatch(db, tmdbKey, tmdbBearer)) });
  } catch (cause) {
    return json({ error: { code: 'BG500', message: String(cause) } }, 500);
  }
});
