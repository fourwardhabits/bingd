/**
 * The decisions bingd.app makes, with no DOM in sight.
 *
 * This file is the router. `page.mjs` is the wiring that reads a URL out of the
 * browser and paints the answer; everything that could be *wrong* is here, so it can
 * be tested by `node --test` without a headless browser (`web/router.test.mjs`).
 *
 * Shipped verbatim: `build.mjs` copies it to `dist/` and the pages import it as an ES
 * module from the same origin. There is no bundler and there is nothing to inline, so
 * what the tests import is byte-for-byte what a phone runs.
 *
 * ---------------------------------------------------------------------------
 * The one rule this file exists to keep
 * ---------------------------------------------------------------------------
 *
 * **Nothing the visitor sends decides where they are sent.** Every destination comes
 * from `distribution.config.json`, baked in at build time. The URL contributes one
 * thing — an identifier — and each identifier is validated against a shape before it
 * is used for anything at all.
 *
 * That is what closes the open redirect. A page that reads `?next=` or `?store=` and
 * follows it is a redirector on a domain people have been taught to trust from an
 * invitation, which is the most useful possible domain to have one on.
 */

/**
 * Which of the three platforms this browser is, from the user agent and nothing else.
 *
 * No feature detection, no fingerprint, no attempt to be clever: the answer picks a
 * button label and a store link, and an unknown browser gets both buttons rather than
 * a guess. The cost of being wrong is a wasted tap; the cost of guessing confidently
 * is somebody sent to the wrong store.
 *
 * iPadOS 13 and later report a *macOS* user agent by default, which is why the touch
 * test is there: a desktop Safari and an iPad look identical to a regex otherwise, and
 * an iPad is a device that can install the app.
 */
export function detectPlatform(userAgent, { maxTouchPoints = 0 } = {}) {
  const ua = String(userAgent ?? '');

  // Android first. Every Android browser also says "Linux", and Chrome on Android
  // says "Mobile Safari", so an iOS test that ran first would claim it.
  if (/android/i.test(ua)) return 'android';

  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';

  // Desktop-mode iPad. Real Macs report maxTouchPoints 0.
  if (/macintosh/i.test(ua) && maxTouchPoints > 1) return 'ios';

  return 'other';
}

/**
 * Where an uninstalled visitor should be sent, given the platform and the configured
 * destinations.
 *
 * Returns `null` when there is nothing honest to offer for a platform, and inventing
 * something would produce a button that 404s. The page renders "bingd. is not on this
 * platform yet" instead — see `distribution.config.json`.
 *
 * **The ordering is the same on both platforms and the public listing wins.** It is
 * written as one rule rather than two because the Android half used to be the other way
 * round: while Play was a closed test, `optInUrl` led, because a closed test is not
 * reachable from the store listing until the tester has opted in and somebody sent to
 * the plain listing first is told the app is unavailable for their device.
 *
 * That reason expired when the app went to the Play production track. A public listing
 * is reachable by everybody, so it is the better destination for everybody the moment
 * it exists, and `optInUrl` drops to what `ios.betaUrl` already is: the fallback if the
 * listing is ever pulled. Nothing about a visitor decides this — the order is fixed
 * here and the URLs come from a committed file.
 */
export function destinationFor(platform, distribution) {
  const dist = distribution ?? {};

  if (platform === 'ios') {
    const ios = dist.ios ?? {};
    // Store before beta once the app is public: a public listing is the better
    // destination for everybody the moment it exists, and it is set exactly once.
    if (ios.storeUrl) return { platform: 'ios', kind: 'store', url: ios.storeUrl };
    if (ios.betaUrl) return { platform: 'ios', kind: 'testflight', url: ios.betaUrl };
    return null;
  }

  if (platform === 'android') {
    const android = dist.android ?? {};
    if (android.storeUrl) return { platform: 'android', kind: 'store', url: android.storeUrl };
    if (android.optInUrl) return { platform: 'android', kind: 'play-opt-in', url: android.optInUrl };
    if (android.betaUrl) return { platform: 'android', kind: 'play', url: android.betaUrl };
    return null;
  }

  return null;
}

/**
 * Both platforms' destinations, for the desktop and unknown-browser case.
 *
 * §3 of the beta contract: an unknown browser is offered *Get Bingd for iPhone* and
 * *Get Bingd for Android* and is never thrown into either one. Somebody opening an
 * invitation on a laptop is the ordinary case — the link arrived by email — and the
 * useful thing to give them is the pair, so they can carry on from the phone in their
 * hand.
 */
export function allDestinations(distribution) {
  return ['ios', 'android']
    .map((platform) => destinationFor(platform, distribution))
    .filter(Boolean);
}

/**
 * What the one dominant install button says, for a destination `destinationFor` chose.
 *
 * Here rather than in `page.mjs`, because it is a decision and this file's rule is
 * that decisions live where the tests run. It used to be a map keyed on `kind` alone
 * in the paint layer, and that had a defect no beta build could surface: both
 * platforms' public listings share `kind: 'store'`, so the day the Play listing went
 * live, every Android visitor's button would have read "Get Bingd for iPhone". The
 * beta never rendered that kind for Android — the closed test took the `play-opt-in`
 * branch — which is exactly why the wrong label sat unnoticed. **That day has now
 * arrived**, `store` is the kind every Android visitor gets, and the label is right
 * because it reads the platform.
 *
 * **The wordmark is lowercase with the full stop, everywhere a person reads it.** It was
 * "Bingd" here until 2026-09-03, which is the brand written the way a sentence wants it
 * rather than the way the product is named. The legal documents still say Bingd, and
 * deliberately: naming the entity formally in Terms is a different job from addressing
 * somebody on a landing page.
 */
export function installLabel(destination) {
  if (!destination) return null;

  switch (destination.kind) {
    case 'testflight':
      return 'Get the bingd. beta for iPhone';
    case 'play-opt-in':
      return 'Join the bingd. Android beta';
    case 'play':
      return 'Get bingd. on Google Play';
    case 'store':
      return destination.platform === 'android'
        ? 'Get bingd. on Google Play'
        : 'Get bingd. on the App Store';
    default:
      return null;
  }
}

/**
 * The token in `/i/<token>`, or null.
 *
 * The shape is `create_invite_link`'s: `gen_random_uuid()` with the dashes removed, so
 * 32 lowercase hex characters exactly. Anything else is not a token — a truncated
 * paste, a tracking suffix a messaging app appended, or somebody probing — and is
 * treated as no token at all rather than passed on.
 *
 * **This validation is what makes the token safe to put in a `bingd://` URL and in an
 * RPC argument.** Both are string concatenations, and the alphabet permitted here
 * contains no character that means anything in either context. A path traversal, a
 * quote, a scheme, a `<`, a `%` — none of them survives this regex.
 */
export function tokenFromPath(pathname) {
  const match = /^\/i\/([^/?#]+)\/?$/.exec(String(pathname ?? ''));
  if (!match) return null;

  // Decoded before matching, so that a percent-encoded traversal is measured against
  // the same alphabet as a plain one rather than sliding through as opaque bytes.
  let candidate;
  try {
    candidate = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  return /^[0-9a-f]{32}$/.test(candidate) ? candidate : null;
}

/**
 * The handle in `/u/<username>`, or null.
 *
 * The shape is `create_profile`'s: 3 to 24 characters of lowercase letters, digits and
 * underscore. The page displays it, so the alphabet is also the escaping story — there
 * is no character in it that can close an attribute or open a tag.
 *
 * Nothing is fetched about the account. A private profile must not become readable by
 * being asked for over the web, and the cheapest way to guarantee that is for the web
 * to hold no reader at all: `bingd.app/u/x` says *this is a Bingd profile, here is how
 * to open it*, and the app applies `can_view_profile` as it always has.
 */
export function handleFromPath(pathname) {
  const match = /^\/u\/([^/?#]+)\/?$/.exec(String(pathname ?? ''));
  if (!match) return null;

  let candidate;
  try {
    candidate = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  return /^[a-z0-9_]{3,24}$/.test(candidate) ? candidate : null;
}

/**
 * The media item id in `/title/<uuid>`, or null.
 *
 * Kept at `/title/` rather than renamed to `/t/`: the path is already claimed in the
 * Apple App Site Association file, already handled by `app/title/[id].tsx`, and
 * already inside links people have been sent. Renaming it would break those to gain
 * two characters.
 *
 * A uuid, because that is what `media_items.id` is. Nothing about the title is fetched
 * or shown — a Bingd title page is not a public film database, and building one would
 * be the whole marketing site this router exists to avoid.
 */
export function titleIdFromPath(pathname) {
  const match = /^\/title\/([^/?#]+)\/?$/.exec(String(pathname ?? ''));
  if (!match) return null;

  let candidate;
  try {
    candidate = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate)
    ? candidate
    : null;
}

/**
 * The deep link that opens an installed app at the same place this page describes.
 *
 * A custom scheme, and it has to be. **A link to bingd.app clicked on bingd.app is a
 * same-domain navigation, and iOS deliberately does not hand those to the app** — so
 * the one button that has to work the moment somebody comes back from the App Store
 * cannot be an https link to this site. Android is more permissive, but one mechanism
 * that works on both is better than two that each work on one.
 *
 * The scheme is configuration and the path is built from an already-validated
 * identifier, so there is no input here that could turn this into a link to somewhere
 * else. Returns null when there is no identifier, rather than a bare `bingd://`, which
 * would open the app at whatever it happened to show last and look like a bug.
 *
 * ---------------------------------------------------------------------------
 * What a custom scheme cannot do
 * ---------------------------------------------------------------------------
 *
 * **A custom scheme proves nothing about who receives it.** `applinks:` is verified —
 * the domain names the app and the OS checks it. `bingd://` is not: any app on the
 * device may declare the same scheme, iOS's choice between two claimants is documented
 * as undefined, and Android shows a chooser. So an app installed for the purpose can
 * receive whatever this link carries.
 *
 * Review 27 raised that as a Major on the grounds that it leaks an invitation token.
 * **It was downgraded, and the reason is what the token actually is.** `invite_tokens`
 * holds *one reusable personal link per user* (PRD §17), and `create_invite_link`
 * deliberately never rotates it — a link that changed on every share would detach
 * everybody already holding the old one. It is built to be forwarded into group chats
 * by people who do not know each other. It is a referral code, not a ticket and not a
 * credential.
 *
 * So an app that intercepts one can do exactly what any forwarded recipient can do:
 * redeem it under its own account, once, and be attributed to that inviter. It cannot
 * authenticate as anyone, cannot take an attribution that already exists
 * (`on conflict (invitee_id) do nothing`), and cannot deny the real invitee theirs —
 * the token stays live and their redemption is a separate row. Redemption still
 * requires an account, still refuses self-invites, blocks and inactive inviters.
 *
 * What is genuinely residual is smaller and worth naming: the token is a stable
 * identifier for one inviter, so an app collecting them could correlate who is inviting
 * whom, and a successful redemption returns the inviter's username. Both are true of
 * the link itself in any group chat it is pasted into.
 *
 * Carried into the security tranche (hardening blocker F) at that severity rather than
 * redesigned here — and the alternatives are worse in any case. The token has to reach
 * the app somehow; iOS will not hand a same-domain navigation to the app, which rules
 * out the https link on the one page that most needs it; and asking somebody to paste a
 * link they already tapped moves the same value through the clipboard, which is read
 * far more casually than a URL scheme is hijacked.
 */
export function appLinkFor(scheme, route, identifier) {
  if (!scheme || !identifier) return null;
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
  if (!['i', 'u', 'title'].includes(route)) return null;
  return `${scheme}://${route}/${identifier}`;
}
// ---------------------------------------------------------------------------
// Shared-content context
//
// Enough to tell a visitor "yes, this is the thing your friend sent you", and
// deliberately not one field more.
//
// ---------------------------------------------------------------------------
// Why this is allowed to read the database at all
// ---------------------------------------------------------------------------
//
// Because it is not a new read path. Two policies that already exist decide
// everything here, and both were written for the app rather than for this page:
//
//   - `media_items_read` is `using (true)`. The film catalogue is TMDB data with no
//     person attached to it, and it has been world readable since 20260813000400.
//   - `profiles_read` is `using (can_i_view(id))`, and `can_view_profile` answers a
//     *null viewer* with `visibility = 'public' and status = 'active'` and nothing
//     else. A private account, a suspended account and a handle that does not exist
//     are one case from out here: zero rows.
//
// So the privacy rule is enforced by Postgres, on the same policy the app obeys, and
// this page cannot widen it. It holds the anon key, which is the key the mobile
// bundle already ships and which RLS bounds. **If a private profile ever appeared on
// this page it would mean `can_view_profile` had changed**, and it would be visible
// in the app long before it was visible here.
//
// What is deliberately not read: `profiles.bio` (readable, and still nobody's
// business on a link preview), anything under `user_media`, `rankings`, `follows` or
// `feed_events`. The page shows what was shared, never what anyone did with it.

/** TMDB's image CDN, the same host `src/lib/images.ts` builds app poster URLs from. */
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/**
 * A poster path from `media_items.poster_path` as a URL, or null.
 *
 * The shape check is the security half. `poster_path` arrives from the server rather
 * than from the URL, so it is not attacker controlled in the ordinary sense, but it is
 * still the one value on this page that comes from outside the build, and it ends up
 * in `img.src`. Constraining it to TMDB's own form means the result cannot become a
 * `javascript:` URL, cannot leave the CDN, and cannot carry a quote into markup even
 * if somebody later reaches for `innerHTML`.
 *
 * w342 matches the app's row size, which is the width this page draws it at on a phone.
 */
export function posterUrl(posterPath, size = 'w342') {
  if (typeof posterPath !== 'string') return null;
  if (!/^\/[A-Za-z0-9._-]{1,120}\.(jpg|jpeg|png|webp)$/.test(posterPath)) return null;
  if (!/^w\d{2,4}$/.test(size)) return null;
  return `${TMDB_IMAGE_BASE}/${size}${posterPath}`;
}

/**
 * A `profiles.avatar_path` as a public storage URL, or null.
 *
 * The `avatars` bucket is public, which is a property of the bucket rather than a
 * decision taken here: the app serves the same URLs to signed-out readers of a public
 * profile. The path is `<uuid>/<file>`, and the pattern pins it to that so a value
 * cannot climb out of the bucket with `..` or point at another origin.
 */
export function avatarUrl(supabaseUrl, avatarPath) {
  if (typeof supabaseUrl !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(supabaseUrl)) return null;
  if (typeof avatarPath !== 'string') return null;
  if (!/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/.test(avatarPath)) return null;
  return `${supabaseUrl}/storage/v1/object/public/avatars/${avatarPath}`;
}

/**
 * The PostgREST request that resolves a title, or null when there is nothing to ask.
 *
 * Built here rather than in `page.mjs` because it is a string concatenation with an
 * identifier in it, which is exactly the kind of thing this file exists to keep under
 * test. The id has already been through `titleIdFromPath`, so it is a uuid and nothing
 * else; the embedded `parent:parent_id(title, genres)` is what turns a season row into
 * "The Last of Us, S1" without a second round trip, and what gives it any genres at all.
 *
 * **The parent's genres are load-bearing and not a nicety.** `tmdb_upsert_seasons`
 * writes no genres onto a season, because TMDB publishes them on the series: every one
 * of the 2,067 seasons in the production catalogue carries an empty array. Without the
 * embed, half the titles anybody shares would show no genres and it would look like the
 * preview was broken rather than like the column was empty. This is the same own-then-
 * parent rule `src/lib/media-metadata.ts` applies in the app, in the one shape this page
 * needs.
 *
 * `select` names its columns, and that is a privacy rule rather than a bandwidth one. A
 * `select=*` would quietly start shipping any column added later, and the table this
 * reads is the one table in the schema whose read policy is `using (true)`.
 *
 * **The columns grew with the public title preview and every one of them is TMDB's.**
 * `overview`, `runtime_minutes`, `genres` and `episode_count` describe the film or the
 * season and describe nobody. Nothing from `user_media`, `rankings`, `follows`,
 * `title_recommendations` or `feed_events` is reachable from this request: they are
 * different tables, behind policies that answer a null viewer with zero rows, and no
 * embed here names one. A personal score, a Following score, a recommendation note, a
 * watch date and a predicted score are all on that side of the line.
 */
export function titleContextRequest(supabaseUrl, id) {
  if (typeof supabaseUrl !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(supabaseUrl)) return null;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return null;
  }
  const select =
    'kind,title,release_date,season_number,poster_path,overview,runtime_minutes,genres,' +
    'episode_count,parent:parent_id(title,genres)';
  return `${supabaseUrl}/rest/v1/media_items?id=eq.${id}&select=${select}&limit=1`;
}

/**
 * The PostgREST request that resolves a public profile, or null.
 *
 * Three columns. The handle is already `handleFromPath`-validated, so it is
 * `[a-z0-9_]{3,24}` and safe in a query string.
 */
export function profileContextRequest(supabaseUrl, handle) {
  if (typeof supabaseUrl !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(supabaseUrl)) return null;
  if (typeof handle !== 'string' || !/^[a-z0-9_]{3,24}$/.test(handle)) return null;
  return `${supabaseUrl}/rest/v1/profiles?username=eq.${handle}&select=display_name,username,avatar_path&limit=1`;
}

/** `2023` from `2023-01-15`, and nothing from a null or a malformed date. */
const yearOf = (date) => {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(String(date ?? ''));
  return match ? match[1] : null;
};

/**
 * What a resolved title row should read as, or null when the row cannot carry a name.
 *
 * This is `compactName` from `src/lib/titles.ts`, in the one shape this page needs. It
 * is reimplemented rather than imported because the app is React Native and this file
 * runs in a browser with no bundler, and it is nine lines. The rule it copies: a season
 * says the show and the season together, because "Season 1" on its own names nothing.
 *
 * Seasons TMDB has named after the show — limited series do this — would read as
 * "The Last of Us, The Last of Us", so the season's own title wins when it already
 * contains the show's.
 */
export function titleDisplay(row) {
  if (!row || typeof row !== 'object') return null;
  const own = typeof row.title === 'string' ? row.title.trim() : '';
  if (!own) return null;

  const year = yearOf(row.release_date);

  if (row.kind !== 'season') {
    return { name: own, detail: year };
  }

  const series = typeof row.parent?.title === 'string' ? row.parent.title.trim() : '';
  if (!series || own.toLowerCase().includes(series.toLowerCase())) {
    return { name: own, detail: year };
  }

  const number = Number.isInteger(row.season_number) ? row.season_number : null;
  // Season 0 is TMDB's specials bucket, and "S0" is not a thing anybody says.
  const suffix = number && number > 0 ? `S${number}` : own;
  return { name: `${series}, ${suffix}`, detail: year };
}

/**
 * `109` as `1h 49m`, and nothing from a runtime the catalogue does not hold.
 *
 * Minutes is what TMDB gives and `1h 49m` is what a person reads, so the conversion is
 * here rather than in the paint layer. A runtime under an hour keeps the minutes alone
 * and a round two hours drops the trailing `0m`, because "2h 0m" is a number nobody
 * writes down.
 *
 * Anything that is not a positive whole number of minutes is no runtime at all. TMDB
 * stores 0 for a film it has no duration for, and "0m" under a poster reads as a bug.
 */
export function runtimeText(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 100000) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/**
 * A synopsis, collapsed and cut to something a card can carry.
 *
 * Whitespace is collapsed because TMDB overviews arrive with newlines in them and the
 * page writes this with `textContent`, which renders them as spaces at unpredictable
 * places. The cut is at a word boundary and only when there is enough over the limit to
 * be worth cutting, so a 330-character overview is not given an ellipsis to save four
 * characters.
 *
 * Done here rather than with a CSS line clamp because the limit is then a tested fact
 * rather than a rendering accident, and because a clamp still ships the whole paragraph
 * to a page whose job is to be quick.
 */
export function synopsisText(overview, limit = 320) {
  if (typeof overview !== 'string') return null;
  const collapsed = overview.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (collapsed.length <= limit + 40) return collapsed;

  const cut = collapsed.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  const head = (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:]+$/, '');
  return `${head}…`;
}

/**
 * The public preview of a title: what `/title/<id>` shows somebody who does not have
 * the app, built from the catalogue row and from nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN IT, AND WHY THAT IS THE LINE
 * ---------------------------------------------------------------------------
 *
 * Every field here is TMDB's description of a film or a season. `media_items_read` is
 * `using (true)` and has been since the catalogue was built, because catalogue metadata
 * is not user data — so naming the film, its year, its length, its genres and its
 * synopsis discloses nothing about anybody and makes the page worth arriving at.
 *
 * **What is deliberately absent is every opinion of it.** No personal score, no
 * Following score, no community score, no recommendation note, no sender, no watch
 * date, no predicted score. Those are `user_media`, `rankings` and
 * `title_recommendations`, they are behind policies that answer a signed-out reader
 * with zero rows, and this page holds no account to read them with even if they were
 * not. An anonymous community score is the one that keeps being asked for and it is
 * still out: it needs an RPC that does not exist, and a number invented to fill the
 * space would be the most believed wrong thing on the site.
 *
 * ---------------------------------------------------------------------------
 * SHAPE
 * ---------------------------------------------------------------------------
 *
 * `meta` is the line under the name — kind, year, then length — and every part of it is
 * dropped rather than guessed when the row does not carry it. A season says its own
 * number, because "Season" on its own is the one word that does not identify which.
 * Season 0 is TMDB's specials bucket and is named rather than numbered.
 *
 * Returns null exactly when `titleDisplay` does, so the caller has one check.
 */
export function titlePreview(row) {
  const display = titleDisplay(row);
  if (!display) return null;

  const number = Number.isInteger(row.season_number) ? row.season_number : null;
  const kindLabel =
    row.kind === 'season'
      ? number === 0
        ? 'Specials'
        : number
          ? `Season ${number}`
          : 'Season'
      : row.kind === 'series'
        ? 'Series'
        : 'Film';

  const episodes = Number.isInteger(row.episode_count) && row.episode_count > 0
    ? `${row.episode_count} episode${row.episode_count === 1 ? '' : 's'}`
    : null;

  const meta = [
    kindLabel,
    display.detail,
    row.kind === 'movie' ? runtimeText(row.runtime_minutes) : episodes,
  ].filter(Boolean);

  // Own genres first, then the series'. A season carries none of its own — TMDB
  // publishes genres on the series and `tmdb_upsert_seasons` writes what TMDB gives —
  // so without the fallback every television share would show a blank line where the
  // genres go. Own-first rather than parent-first, because a season that ever does
  // carry its own is the more specific truth. Same rule as `resolveMetadata` in the app.
  //
  // Postgres hands these over as an array of strings. Anything else in it is dropped
  // rather than coerced: this is written with `textContent`, so a stray object would
  // render as "[object Object]" under a poster.
  const clean = (value) =>
    (Array.isArray(value) ? value : [])
      .filter((genre) => typeof genre === 'string')
      .map((genre) => genre.trim())
      .filter(Boolean);

  const own = clean(row.genres);
  const genres = (own.length > 0 ? own : clean(row.parent?.genres)).slice(0, 3);

  return { name: display.name, meta, genres, synopsis: synopsisText(row.overview) };
}

/**
 * What a resolved profile row should read as, or null.
 *
 * The display name is optional in the app, so the handle is the fallback and never the
 * other way round. Nothing else from the row reaches the page.
 */
export function profileDisplay(row) {
  if (!row || typeof row !== 'object') return null;
  const handle = typeof row.username === 'string' ? row.username.trim() : '';
  if (!handle) return null;
  const display = typeof row.display_name === 'string' ? row.display_name.trim() : '';
  return { name: display || handle, handle: `@${handle}` };
}
