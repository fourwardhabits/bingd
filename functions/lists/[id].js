/**
 * The link preview for `bingd.app/lists/<id>` — a Cloudflare Pages Function.
 *
 * L5 of `docs/product/lists-prd.md` §O, under the decision at §P.3.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES, AND THE ONE THING IT MUST NEVER DO
 * ---------------------------------------------------------------------------
 *
 * It serves the ordinary static page and rewrites four `<meta>` tags on the way out, so
 * that a list pasted into iMessage, WhatsApp or Slack unfurls as *the list* rather than
 * as "Open on bingd." Nothing about the page a human sees changes; `page.mjs` still
 * fetches and paints exactly as it does without this Function.
 *
 * **The owner is named only when the owner's profile is public.** `list_preview` applies
 * that rule server-side — it returns a null `owner_label` for a private account — and
 * this file never reconstructs one. The reasoning is §F.9: holding the URL already
 * grants the list, so naming the list is no disclosure; but a third-party unfurl cache
 * is a place the owner did not choose, and a private account's handle does not go into
 * one.
 *
 * ---------------------------------------------------------------------------
 * EVERY FAILURE IS THE STATIC CARD
 * ---------------------------------------------------------------------------
 *
 * No id, a malformed id, no configuration, a network failure, a non-200, zero rows — all
 * of them fall through to the page exactly as built. That is not defensive padding: zero
 * rows is how the server says *private, hidden, deleted, suspended or nonexistent*, and
 * those five must be indistinguishable from out here. A Function that distinguished them
 * would be the oracle the whole visibility model is written to avoid.
 *
 * ---------------------------------------------------------------------------
 * IT HOLDS THE ANON KEY AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * `list_preview` is granted to `anon` and to nobody else, and it is gated on
 * `_list_readable(id, null)`. A service key here would buy nothing and would put a
 * bypass of every policy in the request path of an unauthenticated page.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS FILE HAS TO LIVE
 * ---------------------------------------------------------------------------
 *
 * Cloudflare Pages looks for `functions/` in the **project's root directory**, which for
 * a git-connected project defaults to the repository root — which is where the site's
 * build command (`npm run build:web`) is run from. `docs/architecture/web-deployment.md`
 * is explicit that the root directory and output directory are *inferred from deployed
 * bytes* rather than confirmed against the dashboard, so this is the one piece of the
 * tranche whose placement should be eyeballed on a preview URL before production:
 * Cloudflare dashboard → Workers & Pages → `bingd` → Settings → Builds & deployments.
 *
 * **Verify it by unfurling a preview link, not by loading the page.** A misplaced
 * Function is invisible to a browser — the static page renders either way — and shows up
 * only as a generic card in a message thread.
 */

/** Five minutes. Long enough to absorb an unfurl storm, short enough that a rename lands. */
const CACHE_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The same escaping rule the rest of this site keeps, in the one place it cannot use
 * `textContent`.
 *
 * A `<meta content="…">` attribute is markup, so a title carrying a quote would close it
 * and everything after would be parsed as attributes. All five characters, not the two
 * that are strictly necessary, because a list of exceptions is how the sixth gets
 * forgotten.
 */
const attr = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * `14 titles · a list by @maya on bingd.`, or the same without the handle.
 *
 * One function so the two forms cannot drift, and so the private-owner case is a
 * *branch on data the server already decided* rather than a decision taken here.
 */
const describe = (count, ownerLabel) => {
  const titles = `${count} ${count === 1 ? 'title' : 'titles'}`;
  return ownerLabel
    ? `${titles} · a list by ${ownerLabel} on bingd.`
    : `${titles} · a list on bingd.`;
};

/** Rewrites one `<meta>` whose `property`/`name` matches, leaving everything else alone. */
class MetaContent {
  constructor(value) {
    this.value = value;
  }

  element(element) {
    element.setAttribute('content', this.value);
  }
}

export async function onRequest(context) {
  const { env, next, params } = context;

  // Always resolve the page first. Whatever happens below, this is what is served.
  const response = await next();

  const id = typeof params?.id === 'string' ? params.id : null;
  if (!id || !UUID.test(id)) return response;

  const supabaseUrl = env?.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = env?.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return response;

  // Only HTML is rewritten. A Function on `/lists/*` should never touch an asset that
  // happens to be requested under it.
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;

  let row = null;
  try {
    const answer = await fetch(`${supabaseUrl}/rest/v1/rpc/list_preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({ p_list_id: id }),
      // Cloudflare's own edge cache, so an unfurl storm on one link is one origin
      // request. The TTL is the same five minutes the response carries.
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    if (!answer.ok) return response;
    const payload = await answer.json();
    row = Array.isArray(payload) ? (payload[0] ?? null) : payload;
  } catch {
    return response;
  }

  const title = typeof row?.title === 'string' ? row.title.trim() : '';
  if (!title) return response;

  const count = Number.isInteger(row.item_count) ? row.item_count : 0;
  // Server-decided. Null for a private-profile owner, and this file does not second-guess it.
  const ownerLabel = typeof row.owner_label === 'string' ? row.owner_label.trim() : '';

  const safeTitle = attr(title);
  const safeDescription = attr(describe(count, ownerLabel || null));

  const rewritten = new HTMLRewriter()
    .on('meta[property="og:title"]', new MetaContent(safeTitle))
    .on('meta[name="twitter:title"]', new MetaContent(safeTitle))
    .on('meta[property="og:description"]', new MetaContent(safeDescription))
    .on('meta[name="twitter:description"]', new MetaContent(safeDescription))
    .transform(response);

  const headers = new Headers(rewritten.headers);
  headers.set('cache-control', `public, max-age=${CACHE_SECONDS}`);

  /**
   * **`og:image` and `og:url` are deliberately untouched.**
   *
   * The image stays the generic 1200×630 card. A poster collage is approved in principle
   * for later (§J) and is image generation in a Worker, which is a different piece of
   * work with a different failure mode.
   *
   * `og:url` stays the route *prefix* that `build.mjs` wrote — `https://bingd.app/lists/`
   * — and not the visited URL. That is the site's existing rule and it matters more here
   * than anywhere else on it: a link-only list's id is the whole of its access control,
   * and a preview is a thing a third party fetches, logs and keeps. The identifier stays
   * in the message.
   */
  return new Response(rewritten.body, {
    status: rewritten.status,
    statusText: rewritten.statusText,
    headers,
  });
}
