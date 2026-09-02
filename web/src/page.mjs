/**
 * The browser half: read the URL, ask `router.mjs`, paint the answer.
 *
 * Everything with a decision in it lives in `router.mjs` and is tested there. What is
 * left here is DOM writing and two network calls, kept deliberately thin because it is
 * the part no test observes.
 *
 * No framework, no bundler, no dependency. The whole site is a handful of HTML files
 * and two modules, served from a static host, which is also the security story: a page
 * with no server cannot be made to fetch, redirect or render anything an attacker puts
 * in a URL.
 *
 * ---------------------------------------------------------------------------
 * Nothing here writes markup
 * ---------------------------------------------------------------------------
 *
 * Every value that reaches the page goes through `textContent` or through `img.src`
 * with a URL `router.mjs` built from a pattern. There is no `innerHTML` in this file
 * and there must not be one: the moment a title from the catalogue or a display name
 * from a profile is concatenated into markup, this page becomes the one place in Bingd
 * where somebody else's text is executed.
 */

import {
  allDestinations,
  appLinkFor,
  avatarUrl,
  detectPlatform,
  destinationFor,
  handleFromPath,
  installLabel,
  posterUrl,
  profileContextRequest,
  profileDisplay,
  titleContextRequest,
  titleDisplay,
  titleIdFromPath,
  tokenFromPath,
} from './router.mjs';

/**
 * Build-time values, written into the page by `build.mjs` as a JSON script block.
 *
 * A block rather than globals, because JSON cannot execute: whatever ends up in it is
 * data. `textContent` is not parsed as HTML, so the values cannot escape the tag they
 * live in even if one day something less trustworthy than a committed config file ends
 * up here.
 */
function config() {
  const el = document.getElementById('bingd-config');
  if (!el) return {};
  try {
    return JSON.parse(el.textContent);
  } catch {
    return {};
  }
}

const text = (id, value) => {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
};

const show = (id, visible = true) => {
  const el = document.getElementById(id);
  if (el) el.hidden = !visible;
};

/** Fills an anchor and reveals it. `href` is always ours; see `router.mjs`. */
const link = (id, href, label) => {
  const el = document.getElementById(id);
  if (!el || !href) return false;
  el.href = href;
  if (label) el.textContent = label;
  el.hidden = false;
  return true;
};

// The button's wording is `installLabel` in router.mjs — a decision, so it lives with
// the tests. What stays here is the desktop pair, which is platform-keyed already.
const PLATFORM_LABEL = { ios: 'Get bingd. for iPhone', android: 'Get bingd. for Android' };

/**
 * Reports that the invitation page was opened.
 *
 * Fire and forget, and every failure is swallowed on purpose: a metric must never be
 * the reason somebody cannot read the page they were invited to. The call is
 * `record_invite_open`, which returns void whatever the token was — so nothing about
 * the answer is worth waiting for, and there is nothing in it to read back.
 *
 * Skipped entirely when the build had no Supabase URL, which is the ordinary state of
 * a local `npm run build:web`.
 */
function recordOpen(cfg, token, platform) {
  const { supabaseUrl, supabaseAnonKey } = cfg;
  if (!supabaseUrl || !supabaseAnonKey || !token) return;

  try {
    fetch(`${supabaseUrl}/rest/v1/rpc/record_invite_open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ p_token: token, p_platform: platform }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* no network, no metric, no problem */
  }
}

/**
 * One row from PostgREST, or null.
 *
 * Every failure is one answer: null, and the page keeps the generic copy it was built
 * with. A visitor who is offline, or who arrives at a handle that does not resolve, or
 * whose request is refused, sees a page that still says what Bingd is and still offers
 * the install. The context is an improvement on that page, never a precondition for it.
 *
 * **Zero rows is the ordinary answer, not an error.** A private profile, a suspended
 * one and a handle nobody has are indistinguishable from here by design: RLS filters
 * rather than refuses, so the page cannot tell them apart and has no business trying.
 */
async function readOne(url, anonKey) {
  if (!url || !anonKey) return null;
  try {
    const response = await fetch(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const rows = await response.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * Paints the resolved context, or leaves the generic copy alone.
 *
 * The artwork is loaded rather than reserved: `img` stays hidden until it decodes, so a
 * poster TMDB no longer serves leaves a page with a name on it instead of a broken
 * image frame. That is also why the name is written before the picture is asked for.
 */
function paintContext({ name, detail, art, artAlt, note, round = false }) {
  // A profile picture is a circle and a poster is not, which is a styling fact rather
  // than a rendering one, so it travels as a class.
  if (round) document.getElementById('context')?.classList.add('is-profile');

  text('context-name', name);
  if (detail) text('context-detail', detail);
  else show('context-detail', false);
  if (note) text('context-note', note);

  show('generic-subject', false);
  show('context', true);

  const img = document.getElementById('context-art');
  if (img && art) {
    img.alt = artAlt ?? '';
    img.addEventListener('load', () => {
      img.hidden = false;
    });
    img.src = art;
  }
}

/**
 * Paints the install choices for one route.
 *
 * On a known platform this is one dominant button. On an unknown one it is both, and
 * neither is chosen for the visitor — §3 of the beta contract, and the reason is that
 * the wrong store is a dead end somebody has to work out for themselves.
 *
 * When nothing is configured the page says so. That is the honest state before
 * TestFlight exists, and it is better than a button: a person who taps a broken store
 * link concludes the app does not exist, and the person who invited them never hears
 * about it.
 */
function paintInstall(cfg, platform) {
  const dist = cfg.distribution ?? {};

  if (platform === 'ios' || platform === 'android') {
    const destination = destinationFor(platform, dist);
    if (destination && link('primary-install', destination.url, installLabel(destination))) {
      return;
    }
    show('no-destination');
    return;
  }

  const both = allDestinations(dist);
  for (const destination of both) {
    link(`install-${destination.platform}`, destination.url, PLATFORM_LABEL[destination.platform]);
  }
  if (both.length > 0) show('desktop-choices');
  else show('no-destination');
}

const platformNow = () =>
  detectPlatform(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints ?? 0 });

/**
 * The invitation page, `/i/<token>`.
 *
 * ---------------------------------------------------------------------------
 * What this page does not do
 * ---------------------------------------------------------------------------
 *
 * It does not name the inviter. PRD §17 permits an allowlisted display name and avatar
 * **or** neutral Bingd copy, and neutral is what a static page can say without holding
 * a reader for the `profiles` table keyed on a token. That is a different question from
 * `/u/<handle>`, where the visitor already has the handle in their hand: here the token
 * is the only input, and turning a token into a person is exactly the lookup an
 * invitation link must not offer.
 *
 * It does not validate the token. Doing so would need an answer from the server about
 * whether a token is real, and a page that gives that answer is a token oracle for
 * anybody who wants one. Validity is established at redemption, inside the app, by an
 * account.
 *
 * ---------------------------------------------------------------------------
 * The deferred-install limit, said out loud
 * ---------------------------------------------------------------------------
 *
 * A token does not survive a trip through the App Store or Play. Universal Links and
 * App Links carry one only when the app is *already installed*, and this build has no
 * install-referrer path and no attribution SDK — deliberately, because the alternatives
 * are fingerprinting and clipboard reading.
 *
 * So the continuation is manual and honest: install, come back to this page, tap the
 * button. The URL is in the visitor's history and in the message that brought them
 * here, and it is the same link either way.
 */
function invitePage(cfg) {
  const token = tokenFromPath(location.pathname);
  const platform = platformNow();

  if (!token) {
    // A malformed link, which is overwhelmingly a truncated paste. Not an error page:
    // there is still exactly one useful thing to offer, and it is the same one.
    show('invite-broken');
    show('invite-intro', false);
    paintInstall(cfg, platform);
    return;
  }

  recordOpen(cfg, token, platform);

  link('open-app', appLinkFor(cfg.distribution?.app?.scheme, 'i', token), 'I already have bingd.');

  paintInstall(cfg, platform);
}

/**
 * `/u/<handle>` — a public profile, confirmed and not opened up.
 *
 * The name and picture come from `profiles` under `profiles_read`, which answers a
 * signed-out reader with public, active accounts and nothing else. So the page can say
 * *this is who your friend sent you* for the accounts that are already public, and says
 * the generic line for every account that is not, without knowing which it was looking
 * at. Nothing about what they have watched, ranked or written is read here.
 */
function profilePage(cfg) {
  const handle = handleFromPath(location.pathname);
  const platform = platformNow();

  link('open-app', appLinkFor(cfg.distribution?.app?.scheme, 'u', handle), 'Open in bingd.');
  paintInstall(cfg, platform);

  if (!handle) return;

  void readOne(profileContextRequest(cfg.supabaseUrl, handle), cfg.supabaseAnonKey).then((row) => {
    const display = profileDisplay(row);
    if (!display) return;
    paintContext({
      name: display.name,
      detail: display.handle,
      art: avatarUrl(cfg.supabaseUrl, row.avatar_path),
      artAlt: '',
      note: 'Shared from bingd.',
      round: true,
    });
  });
}

/**
 * `/title/<id>` — a film or a season, named so the visitor knows the link worked.
 *
 * `media_items` is world readable and has been since the catalogue was built: it is
 * TMDB's data about films, with nobody attached to it. Naming the title here is
 * therefore not a disclosure, it is the difference between a page that reassures
 * somebody and a page that makes them wonder whether they tapped the right thing.
 *
 * What is still not shown is anyone's *opinion* of it. No rating, no ranking, no who
 * shared it. Those live behind an account, and this page has none.
 */
function titlePage(cfg) {
  const id = titleIdFromPath(location.pathname);
  const platform = platformNow();

  link('open-app', appLinkFor(cfg.distribution?.app?.scheme, 'title', id), 'Open in bingd.');
  paintInstall(cfg, platform);

  if (!id) return;

  void readOne(titleContextRequest(cfg.supabaseUrl, id), cfg.supabaseAnonKey).then((row) => {
    const display = titleDisplay(row);
    if (!display) return;
    paintContext({
      name: display.name,
      detail: display.detail,
      art: posterUrl(row.poster_path),
      artAlt: `Poster for ${display.name}`,
      note: 'Shared from bingd.',
    });
  });
}

/** Everything else that reached a Bingd route: install, and nothing to open. */
function genericPage(cfg) {
  paintInstall(cfg, platformNow());
}

const PAGES = {
  invite: invitePage,
  profile: profilePage,
  title: titlePage,
  generic: genericPage,
};

export function start() {
  const cfg = config();
  (PAGES[cfg.page] ?? genericPage)(cfg);
}

start();
