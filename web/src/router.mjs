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
 * Returns `null` when there is nothing honest to offer, which is the state this beta
 * starts in: no TestFlight link exists yet, and inventing one would produce a button
 * that 404s. The page renders "not available for this device yet" instead — see
 * `distribution.config.json`.
 *
 * The Android ordering is the part that is easy to get wrong. A closed test is not
 * reachable from the store listing until the tester has opted in, so the opt-in page
 * is the destination whenever it is set, and the plain listing is the fallback for the
 * day the track goes open. Sending somebody to the listing first shows them "this app
 * is not available for your device", which reads as *Bingd is broken* rather than as
 * *you have not joined yet*.
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
