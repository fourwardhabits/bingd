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
  listDisplay,
  listIdFromPath,
  listItemsRequest,
  listViewRequest,
  posterUrl,
  profileContextRequest,
  profileDisplay,
  titleContextRequest,
  titleIdFromPath,
  titlePreview,
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

/**
 * Every element this name paints: the one holding the id, plus any mirror of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE MIRRORS
 * ---------------------------------------------------------------------------
 *
 * The router's four pages are one card with one install row, so an id was enough. The
 * front page is a landing page now, and it needs the same row in three places: the
 * hero, the closing band, and a sticky bar on a phone. An id cannot appear three times
 * and copying the decision three times is how two of them end up disagreeing, which is
 * exactly the defect `installLabel` was moved into `router.mjs` to prevent.
 *
 * So the decision stays in one place and is *mirrored*. `data-install="primary-install"`
 * means "whatever the primary install button became, be that too". Nothing here decides
 * anything: the id is still what `paintInstall` addresses, and a page with no mirrors
 * behaves exactly as it did.
 *
 * The selector is built from a literal argument, never from the URL, which is the same
 * rule this file keeps for `href`.
 */
const targets = (id) => {
  const found = [];
  const byId = document.getElementById(id);
  if (byId) found.push(byId);
  for (const el of document.querySelectorAll(`[data-install="${id}"]`)) found.push(el);
  return found;
};

const show = (id, visible = true) => {
  for (const el of targets(id)) el.hidden = !visible;
};

/** Fills an anchor and reveals it. `href` is always ours; see `router.mjs`. */
const link = (id, href, label) => {
  const found = targets(id);
  if (found.length === 0 || !href) return false;
  for (const el of found) {
    el.href = href;
    if (label) el.textContent = label;
    el.hidden = false;
  }
  return true;
};

/**
 * The desktop pair's fallback wording, used only if `installLabel` has nothing to say.
 *
 * It used to be what the desktop pair actually rendered, and that made the two halves of
 * the site disagree: a phone was told "Join the bingd. Android beta" while a laptop
 * showing both options was told "Get bingd. for Android" — the same closed test, one
 * description honest about it and one not. Since 2026-09-10 the pair asks `installLabel`
 * first, so both surfaces describe the same destination the same way, and iOS reads "Get
 * bingd. on the App Store" now that the listing is public.
 */
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
function paintContext({ name, detail, art, artAlt, note, shape = null }) {
  // A profile picture is a circle, a poster is not, and the poster on a title page is
  // drawn larger than the one on a card that only confirms a name. All three are
  // styling facts rather than rendering ones, so the difference travels as a class.
  if (shape) document.getElementById('context')?.classList.add(`is-${shape}`);

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
    link(
      `install-${destination.platform}`,
      destination.url,
      installLabel(destination) ?? PLATFORM_LABEL[destination.platform],
    );
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
      shape: 'profile',
    });
  });
}

/**
 * `/title/<id>` — a film or a season, previewed rather than merely named.
 *
 * `media_items` is world readable and has been since the catalogue was built: it is
 * TMDB's data about films, with nobody attached to it. So the page shows the poster,
 * the name, the year, whether it is a film or which season, the length or the episode
 * count, the genres and the synopsis — enough that somebody who followed a link from a
 * group chat learns what the title is without being asked to install anything first.
 *
 * **It is a preview and not a wall.** The install button is under the content rather
 * than over it, and nothing is blurred or cut off to make a point.
 *
 * What is still not shown is anyone's *opinion* of it. No personal score, no Following
 * score, no community score, no recommendation note, no sender, no watch date, no
 * predicted score. Those live behind an account and this page has none — see
 * `titlePreview`, which is where that line is drawn and tested.
 *
 * A row that does not resolve leaves the page exactly as it was built: the generic line,
 * the two CTAs, and no empty frames. The preview is an improvement on that page, never
 * a precondition for it.
 */
function titlePage(cfg) {
  const id = titleIdFromPath(location.pathname);
  const platform = platformNow();

  link('open-app', appLinkFor(cfg.distribution?.app?.scheme, 'title', id), 'Open in bingd.');
  paintInstall(cfg, platform);

  if (!id) return;

  void readOne(titleContextRequest(cfg.supabaseUrl, id), cfg.supabaseAnonKey).then((row) => {
    const preview = titlePreview(row);
    if (!preview) return;

    paintContext({
      name: preview.name,
      // The kind, year and length line, which supersedes the bare year `titleDisplay`
      // carries for the profile-shaped card. A middle dot rather than a comma, because
      // two of the three parts are already phrases with their own spacing.
      detail: preview.meta.join(' · '),
      art: posterUrl(row.poster_path),
      artAlt: `Poster for ${preview.name}`,
      note: 'Shared from bingd.',
      shape: 'title',
    });

    if (preview.genres.length > 0) text('title-genres', preview.genres.join(', '));
    else show('title-genres', false);

    if (preview.synopsis) text('title-synopsis', preview.synopsis);
    else show('title-synopsis', false);

    // The attribution rides with the block it describes, so a page that resolved
    // nothing carries no credit for data it did not show.
    show('title-preview', true);
  });
}

/**
 * `/lists/<id>` — a public or link-only list, rendered for somebody with no account.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE PAGE ON THIS SITE THAT SHOWS SOMEBODY'S OWN WORDS
 * ---------------------------------------------------------------------------
 *
 * A list title and description are typed by a person, which makes this the place the
 * file's opening rule has to hold absolutely: **every user string is set with
 * `textContent`**, and no `innerHTML` path touches a title, a description or a name.
 * The poster URLs go through `posterUrl`, which pins them to TMDB's own shape, and the
 * one href on the page — the owner's handle — is built by `listDisplay` from an
 * already-validated alphabet and is null for a private account.
 *
 * ---------------------------------------------------------------------------
 * ZERO ROWS KEEPS THE GENERIC PAGE
 * ---------------------------------------------------------------------------
 *
 * Private, deleted, hidden and suspended all read the same from out here, because
 * `_list_readable(id, null)` answers them all the same way. The page that results still
 * says what bingd is and still offers the install: the list is an improvement on that
 * page, never a precondition for it.
 *
 * The progress line is deliberately **absent**. `list_viewer_progress` is not granted to
 * anon at all, and "You've seen X of N" is a fact about a reader this page does not
 * have.
 */
function listsPage(cfg) {
  const id = listIdFromPath(location.pathname);
  const platform = platformNow();

  link('open-app', appLinkFor(cfg.distribution?.app?.scheme, 'lists', id), 'Open in bingd.');
  paintInstall(cfg, platform);

  if (!id) return;

  // Fire and forget, and every failure swallowed: a metric must never be the reason
  // somebody cannot read the page they were sent. The server records only when the list
  // is readable by an anonymous viewer, so this is not a probe either.
  recordListOpen(cfg, id, platform);

  void rpcOne(listViewRequest(cfg.supabaseUrl, id), cfg.supabaseAnonKey, { p_list_id: id }).then(
    (row) => {
      const display = listDisplay(row);
      if (!display) return;

      paintList(display);
      void rpcRows(listItemsRequest(cfg.supabaseUrl, id), cfg.supabaseAnonKey, {
        p_list_id: id,
        p_after_position: null,
        p_limit: 100,
      }).then((items) => paintListItems(items, display.count));
    },
  );
}

/** Reports that a list's web page was opened. See `recordOpen` for the whole argument. */
function recordListOpen(cfg, listId, platform) {
  const { supabaseUrl, supabaseAnonKey } = cfg;
  if (!supabaseUrl || !supabaseAnonKey || !listId) return;

  try {
    fetch(`${supabaseUrl}/rest/v1/rpc/record_list_open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ p_list_id: listId, p_platform: platform }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* no network, no metric, no problem */
  }
}

/**
 * One RPC, answered or not.
 *
 * `readOne`'s contract with a POST body: every failure is one answer, null, and the page
 * keeps the generic copy it was built with. PostgREST returns a scalar function's result
 * as the body itself rather than as a row array, which is why this does not index.
 */
async function rpcOne(url, anonKey, body) {
  if (!url || !anonKey) return null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return Array.isArray(payload) ? (payload[0] ?? null) : payload;
  } catch {
    return null;
  }
}

/** The same, for a set-returning function. An empty array on every failure. */
async function rpcRows(url, anonKey, body) {
  const payload = await rpcOne(url, anonKey, body);
  if (Array.isArray(payload)) return payload;
  return payload ? [payload] : [];
}

/** The list's own header block. Every string through `textContent`. */
function paintList(display) {
  text('list-title', display.title);

  if (display.owner) {
    /**
     * A link **only** for a public profile.
     *
     * For a private one the same words are drawn into a different element — a `span`
     * that is not an anchor at all — which is the §F.2 rule made structural rather than
     * conditional. The decision itself is `listDisplay`'s, in `router.mjs`, where the
     * tests can reach it.
     */
    if (display.owner.href) {
      text('list-owner-name', display.owner.name);
      text('list-owner-handle', display.owner.handle);
      link('list-owner-link', display.owner.href);
    } else {
      text('list-owner-plain', `${display.owner.name} ${display.owner.handle}`);
      show('list-owner-plain', true);
    }
    show('list-owner', true);
  }

  if (display.description) {
    text('list-description', display.description);
    show('list-description', true);
  }

  text('list-facts', display.facts);
  show('list-facts', true);

  show('generic-subject', false);
  show('list', true);
}

/**
 * The rows: a number, a poster, a name and a year.
 *
 * No seen marks, no bookmarks and **no scores** — the same rule the app's rows follow
 * (§F.11), and out here there is not even a viewer to have an opinion.
 *
 * Built with `createElement` and `textContent` rather than a template string, which is
 * the whole reason this page is safe to give somebody else's words to.
 */
function paintListItems(rows, total) {
  const container = document.getElementById('list-items');
  if (!container || !Array.isArray(rows) || rows.length === 0) return;

  for (const row of rows) {
    const name = typeof row?.title === 'string' ? row.title.trim() : '';
    if (!name) continue;

    const item = document.createElement('li');
    item.className = 'list-item';

    const ordinal = document.createElement('span');
    ordinal.className = 'list-item-ordinal';
    ordinal.textContent = Number.isInteger(row.ordinal) ? String(row.ordinal) : '';
    item.append(ordinal);

    const art = posterUrl(row.poster_path);
    if (art) {
      const img = document.createElement('img');
      img.className = 'list-item-art';
      img.loading = 'lazy';
      img.alt = '';
      img.src = art;
      item.append(img);
    }

    const lines = document.createElement('div');
    lines.className = 'list-item-lines';

    const label = document.createElement('p');
    label.className = 'list-item-name';
    // A season's own row already says the show, because `list_items_page` returns the
    // parent title and the app compacts it — out here the plain title is what the
    // server sent, and it is set as text either way.
    label.textContent =
      row.kind === 'season' && typeof row.parent_title === 'string' && row.parent_title
        ? `${row.parent_title}, ${name}`
        : name;
    lines.append(label);

    if (Number.isInteger(row.year)) {
      const year = document.createElement('p');
      year.className = 'list-item-year';
      year.textContent = String(row.year);
      lines.append(year);
    }

    item.append(lines);
    container.append(item);
  }

  show('list-items', true);

  // "See all 400 in the app" only when there genuinely are more. The first page is 100,
  // which is the server's cap.
  if (total > rows.length) {
    text('list-more', `See all ${total} in the app`);
    show('list-more', true);
  }
}

/** Everything else that reached a Bingd route: install, and nothing to open. */
function genericPage(cfg) {
  paintInstall(cfg, platformNow());
}

const PAGES = {
  invite: invitePage,
  profile: profilePage,
  title: titlePage,
  list: listsPage,
  generic: genericPage,
};

export function start() {
  const cfg = config();
  (PAGES[cfg.page] ?? genericPage)(cfg);
}

start();
