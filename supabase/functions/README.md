# Edge Functions

Deno, not React Native. The app's `tsconfig.json` and `eslint.config.js` both exclude this
directory, because the code here imports with `.ts` extensions, resolves `npm:` specifiers,
and uses the `Deno` global — all of which the Expo toolchain correctly reports as errors for
a runtime it does not target. Use `npm run functions:check` and `npm run functions:lint`
instead, which run `deno check` and `deno lint` against `tmdb-adapter/deno.json`. Deno is a
devDependency, so neither needs a separate install, and CI runs both.

## `tmdb-adapter`

The sole holder of the TMDB key and the sole caller of TMDB
([AD-8](../../docs/architecture/README.md), [PRD §19](../../docs/product/PRD.md)). Nothing
else in the repository may call `api.themoviedb.org`, and no TMDB credential may appear in
`.env`, `app.config.ts`, or anything else that reaches a client bundle.

| Action | Caller | Does |
|---|---|---|
| `search` | signed-in user | Searches TMDB, writes results into `media_items`, returns them Bingd-shaped |
| `detail` | signed-in user | Fills one title in: runtime, overview, artwork, seasons, credits |
| `enrich` | `service_role` | Drains `tmdb_enrich_due` — the seed catalogue's missing artwork |
| `refresh` | `service_role` | Drains `media_refresh_due` — the six-month retention window |

Writes go through the four functions in `20260815000000_tmdb_adapter.sql` rather than
through PostgREST, because `media_items_tmdb` is a partial unique index that `.upsert()`
cannot infer, and `media_cache.expires_at` has to come from `app_config`.

### The credential

Either works, and TMDB shows both on the same settings page:

| Secret | Which one | Sent as |
|---|---|---|
| `TMDB_ACCESS_TOKEN` | API Read Access Token (v4) | `Authorization: Bearer` header |
| `TMDB_API_KEY` | API Key (v3) | `api_key` query parameter |

**Prefer the read access token.** A query parameter is written into request logs, proxy logs
and error traces; a header is not. When both are set the token wins and the key is dead
configuration.

```powershell
npx supabase secrets set TMDB_ACCESS_TOKEN="eyJhbGciOi..." --project-ref abheeqyjzekiowkztfxv
```

Rotating is self-service, under **Regenerate Key** on the same TMDB page. Rotate whenever a
credential has been pasted anywhere it might persist — a screenshot, a chat, a ticket — then
re-run the command above. Nothing else needs redeploying: the function reads the secret at
request time.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform and must not be
set by hand.

### Deploying

```powershell
npx supabase login
npx supabase functions deploy tmdb-adapter --project-ref abheeqyjzekiowkztfxv
```

The migration has to be applied first, or every write returns "function does not exist":

```powershell
npx supabase db push --project-ref abheeqyjzekiowkztfxv
```

### Running it locally

```powershell
npx supabase functions serve tmdb-adapter --env-file supabase/functions/.env
```

`supabase/functions/.env` holds `TMDB_ACCESS_TOKEN` for local runs only and is git-ignored
by the root `.gitignore` (`.env` matches at any depth). It is never deployed; the deployed
function reads the secret set above.

### Filling the catalogue

The seed catalogue is Wikidata's: correct titles and years, no artwork at all. One pass
gives every row a poster, an overview, genres, a runtime and its cast.

```powershell
npm run catalogue:enrich
```

That needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` (git-ignored, and
deliberately not `.env`, which holds only values that are safe to publish). It calls this
function rather than TMDB, so the key stays in one place.

### Quota

`tmdb_note_request` counts every user-initiated call against `app_config`'s
`tmdb.max_requests_per_hour`, currently 120, and raises `53400` past it — which the adapter
maps to `BG429` rather than letting PostgREST render it as a 500
([api.md §8](../../docs/architecture/api.md)). The `enrich` and `refresh` actions are not
counted: they run as `service_role`, on demand from an operator, and are already bounded by
their batch size.
