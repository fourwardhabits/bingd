/**
 * The browser half: read the URL, ask `router.mjs`, paint the answer.
 *
 * Everything with a decision in it lives in `router.mjs` and is tested there. What is
 * left here is DOM writing and one network call, kept deliberately thin because it is
 * the part no test observes.
 *
 * No framework, no bundler, no dependency. The whole site is four HTML files and two
 * modules, and it is served from a static host — which is also the security story: a
 * page with no server cannot be made to fetch, redirect or render anything an attacker
 * puts in a URL.
 */

import {
  allDestinations,
  appLinkFor,
  detectPlatform,
  destinationFor,
  handleFromPath,
  installLabel,
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
const PLATFORM_LABEL = { ios: 'Get Bingd for iPhone', android: 'Get Bingd for Android' };

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

/**
 * The invitation page, `/i/<token>`.
 *
 * ---------------------------------------------------------------------------
 * What this page does not do
 * ---------------------------------------------------------------------------
 *
 * It does not name the inviter. PRD §17 permits an allowlisted display name and avatar
 * **or** neutral Bingd copy, and neutral is what a static page can say without holding
 * a reader for the `profiles` table — which is the one thing that would make an
 * invitation link a way to learn about an account from outside the app.
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
 * here, and it is the same link either way. Somebody who instead launches Bingd
 * straight from TestFlight or Play arrives with no token and no attribution, and the
 * copy says so rather than implying the invitation is still attached.
 */
function invitePage(cfg) {
  const token = tokenFromPath(location.pathname);
  const platform = detectPlatform(navigator.userAgent, {
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });

  if (!token) {
    // A malformed link, which is overwhelmingly a truncated paste. Not an error page:
    // there is still exactly one useful thing to offer, and it is the same one.
    show('invite-broken');
    show('invite-intro', false);
    paintInstall(cfg, platform);
    return;
  }

  recordOpen(cfg, token, platform);

  const scheme = cfg.distribution?.app?.scheme;
  link('open-app', appLinkFor(scheme, 'i', token), 'I already have Bingd');

  paintInstall(cfg, platform);
}

/** `/u/<handle>` — a profile, named and not read. */
function profilePage(cfg) {
  const handle = handleFromPath(location.pathname);
  const platform = detectPlatform(navigator.userAgent, {
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });

  // Written with textContent, so a handle that somehow passed the regex still cannot
  // become markup. Belt over the braces `handleFromPath` already provides.
  if (handle) text('handle', `@${handle}`);
  else show('handle', false);

  link('open-app', appLinkFor(cfg.distribution?.app?.scheme, 'u', handle), 'Open in Bingd');
  paintInstall(cfg, platform);
}

/** `/title/<id>` — a film or season, identified and not described. */
function titlePage(cfg) {
  const id = titleIdFromPath(location.pathname);
  const platform = detectPlatform(navigator.userAgent, {
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });

  link('open-app', appLinkFor(cfg.distribution?.app?.scheme, 'title', id), 'Open in Bingd');
  paintInstall(cfg, platform);
}

/** Everything else that reached a Bingd route: install, and nothing to open. */
function genericPage(cfg) {
  paintInstall(
    cfg,
    detectPlatform(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints ?? 0 }),
  );
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
