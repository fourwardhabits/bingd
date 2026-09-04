import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  allDestinations,
  appLinkFor,
  avatarUrl,
  destinationFor,
  detectPlatform,
  handleFromPath,
  installLabel,
  posterUrl,
  profileContextRequest,
  profileDisplay,
  titleContextRequest,
  titleDisplay,
  titleIdFromPath,
  tokenFromPath,
} from './src/router.mjs';

/**
 * The bingd.app router.
 *
 * `src/router.mjs` is shipped verbatim — `build.mjs` copies it into `dist/` and the
 * pages import it from the same origin — so what these tests import is byte-for-byte
 * what a phone runs. There is no bundler between the two and nothing to keep in step.
 *
 * The second half of this file runs the build and reads its output, because half of
 * what could be wrong here is not a function: a route that emits no page, a rewrite
 * that swallows `.well-known`, or a distribution URL that is not ours.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

describe('detectPlatform', () => {
  it('reads an iPhone', () => {
    assert.equal(detectPlatform(UA.iphone), 'ios');
  });

  it('reads Android before iOS, because every Android browser also claims Safari', () => {
    // Chrome on Android ends "Mobile Safari/537.36". An ordering that tested iOS first
    // would send every Android phone to the App Store.
    assert.equal(detectPlatform(UA.androidChrome), 'android');
    assert.equal(detectPlatform(UA.androidFirefox), 'android');
  });

  it('reads an iPad in desktop mode, which is the default since iPadOS 13', () => {
    // Indistinguishable from a Mac by user agent alone. The touch count is the only
    // thing that separates them, and an iPad is a device that can install the app.
    assert.equal(detectPlatform(UA.ipadDesktopMode, { maxTouchPoints: 5 }), 'ios');
  });

  it('does not mistake a real Mac for an iPad', () => {
    assert.equal(detectPlatform(UA.ipadDesktopMode, { maxTouchPoints: 0 }), 'other');
    assert.equal(detectPlatform(UA.mac), 'other');
    assert.equal(detectPlatform(UA.windows), 'other');
  });

  it('answers other for nonsense rather than guessing', () => {
    for (const ua of ['', null, undefined, 'curl/8.4.0', '<script>']) {
      assert.equal(detectPlatform(ua), 'other');
    }
  });
});

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

const NOTHING = { ios: { betaUrl: null, storeUrl: null }, android: {} };

describe('destinationFor', () => {
  it('offers nothing when nothing is configured, which is today', () => {
    // The state this beta starts in. `null` is what makes the page say "not open for
    // this device yet" instead of rendering a button that 404s.
    assert.equal(destinationFor('ios', NOTHING), null);
    assert.equal(destinationFor('android', NOTHING), null);
    assert.deepEqual(allDestinations(NOTHING), []);
  });

  it('sends iPhone to TestFlight while that is the only iOS destination', () => {
    const d = destinationFor('ios', { ios: { betaUrl: 'https://testflight.apple.com/join/abc' } });
    assert.deepEqual(d, {
      platform: 'ios',
      kind: 'testflight',
      url: 'https://testflight.apple.com/join/abc',
    });
  });

  it('prefers the store over the beta once the app is public', () => {
    const d = destinationFor('ios', {
      ios: { betaUrl: 'https://testflight.apple.com/join/abc', storeUrl: 'https://apps.apple.com/x' },
    });
    assert.equal(d.kind, 'store');
  });

  it('sends Android to the closed-test opt-in page before the store listing', () => {
    /**
     * The ordering that is easy to get wrong and expensive to get wrong. A closed test
     * is not reachable from the listing until the tester has opted in — Play shows
     * "this app is not available for your device", which reads as *Bingd is broken*
     * rather than *you have not joined yet*.
     */
    const d = destinationFor('android', {
      android: {
        optInUrl: 'https://play.google.com/apps/testing/app.bingd',
        betaUrl: 'https://play.google.com/store/apps/details?id=app.bingd',
      },
    });
    assert.equal(d.kind, 'play-opt-in');
    assert.equal(d.url, 'https://play.google.com/apps/testing/app.bingd');
  });

  it('falls back to the listing on the day the track goes open', () => {
    const d = destinationFor('android', {
      android: { betaUrl: 'https://play.google.com/store/apps/details?id=app.bingd' },
    });
    assert.equal(d.kind, 'play');
  });

  it('never sends a desktop browser to a store', () => {
    // §3 of the beta contract. Both are offered and neither is chosen for the visitor.
    const full = {
      ios: { betaUrl: 'https://testflight.apple.com/join/abc' },
      android: { optInUrl: 'https://play.google.com/apps/testing/app.bingd' },
    };
    assert.equal(destinationFor('other', full), null);
    assert.deepEqual(
      allDestinations(full).map((d) => d.platform),
      ['ios', 'android'],
    );
  });

  it('survives a missing config rather than throwing on a page nobody can then read', () => {
    assert.equal(destinationFor('ios', undefined), null);
    assert.deepEqual(allDestinations(undefined), []);
  });
});

describe('installLabel', () => {
  /**
   * The wordmark is lowercase with its full stop, on every button a person reads.
   *
   * These read "Bingd" until 2026-09-03. The founder's instruction is that the brand is
   * `bingd.` in product copy, and an install button is the most product-facing copy on
   * the site. Pinned as exact strings for the same reason they always were: a button
   * label is the last thing anybody re-reads before tapping.
   */
  it('names the beta destinations in the brand’s own casing', () => {
    assert.equal(
      installLabel({ platform: 'ios', kind: 'testflight', url: 'x' }),
      'Get the bingd. beta for iPhone',
    );
    assert.equal(
      installLabel({ platform: 'android', kind: 'play-opt-in', url: 'x' }),
      'Join the bingd. Android beta',
    );
    assert.equal(
      installLabel({ platform: 'android', kind: 'play', url: 'x' }),
      'Get bingd. on Google Play',
    );
  });

  it('labels the iOS store button for an iPhone', () => {
    assert.equal(
      installLabel(destinationFor('ios', { ios: { storeUrl: 'https://apps.apple.com/x' } })),
      'Get bingd. on the App Store',
    );
  });

  /**
   * The public-mode defect an independent review found before it could ship.
   *
   * Both platforms' public listings share `kind: 'store'`, and the label used to be a
   * map keyed on kind alone — so the day the Play listing went live, every Android
   * visitor's one dominant button would have read "Get Bingd for iPhone". Invisible in
   * beta because Android's closed test takes the `play-opt-in` branch, which is
   * exactly why it needs a test rather than an eye.
   */
  it('never labels the Android store button as an iPhone one', () => {
    const label = installLabel(
      destinationFor('android', {
        android: { storeUrl: 'https://play.google.com/store/apps/details?id=app.bingd' },
      }),
    );
    assert.equal(label, 'Get bingd. on Google Play');
    assert.ok(!/iphone/i.test(label), 'the Android button must not name an iPhone');
  });

  it('answers null for nothing, matching destinationFor', () => {
    assert.equal(installLabel(null), null);
    assert.equal(installLabel({ platform: 'ios', kind: 'nonsense', url: 'x' }), null);
  });
});

// ---------------------------------------------------------------------------
// Identifiers out of paths
// ---------------------------------------------------------------------------

const TOKEN = 'a3f19c2b4d5e6f708192a3b4c5d6e7f8';

describe('tokenFromPath', () => {
  it('takes a token in the shape create_invite_link mints', () => {
    assert.equal(tokenFromPath(`/i/${TOKEN}`), TOKEN);
    assert.equal(tokenFromPath(`/i/${TOKEN}/`), TOKEN);
  });

  it('refuses anything that is not 32 lowercase hex characters', () => {
    for (const path of [
      '/i/',
      '/i/short',
      `/i/${TOKEN.toUpperCase()}`,
      `/i/${TOKEN}x`,
      `/i/${TOKEN.slice(0, 31)}`,
      '/i/../../etc/passwd',
      '/i/%2e%2e%2f%2e%2e%2fetc',
      '/u/somebody',
      '/',
      null,
    ]) {
      assert.equal(tokenFromPath(path), null, `${path} must not resolve to a token`);
    }
  });

  it('measures a percent-encoded traversal against the same alphabet as a plain one', () => {
    // Decoded before matching, so an encoded payload cannot slide through as opaque
    // bytes and be decoded by something downstream.
    assert.equal(tokenFromPath('/i/%2e%2e'), null);
    assert.equal(tokenFromPath(`/i/${encodeURIComponent('../' + TOKEN)}`), null);
  });

  it('refuses a token carrying anything that means something in a URL', () => {
    for (const nasty of [
      'javascript:alert(1)',
      'https://evil.example/',
      `${TOKEN}?next=https://evil.example`,
      `${TOKEN}#x`,
      '<img src=x onerror=alert(1)>',
      "' or 1=1--",
    ]) {
      assert.equal(tokenFromPath(`/i/${nasty}`), null, `${nasty} must not resolve to a token`);
    }
  });

  it('does not treat a malformed percent escape as a crash', () => {
    // decodeURIComponent throws on a lone %. A page that threw here would render
    // nothing at all, which is a worse outcome than a broken-link message.
    assert.equal(tokenFromPath('/i/%'), null);
  });
});

describe('handleFromPath', () => {
  it('takes a handle in the shape create_profile enforces', () => {
    assert.equal(handleFromPath('/u/saisuraj'), 'saisuraj');
    assert.equal(handleFromPath('/u/a_1'), 'a_1');
    assert.equal(handleFromPath('/u/' + 'a'.repeat(24)), 'a'.repeat(24));
  });

  it('refuses everything the username rule refuses', () => {
    for (const path of [
      '/u/',
      '/u/ab',
      '/u/' + 'a'.repeat(25),
      '/u/MixedCase',
      '/u/has-dash',
      '/u/has.dot',
      '/u/<b>x</b>',
      '/u/%22onmouseover%3d%22x',
      '/i/' + TOKEN,
    ]) {
      assert.equal(handleFromPath(path), null, `${path} must not resolve to a handle`);
    }
  });
});

describe('titleIdFromPath', () => {
  const id = '0f9c1e2a-3b4c-4d5e-8f60-112233445566';

  it('takes a uuid, which is what media_items.id is', () => {
    assert.equal(titleIdFromPath(`/title/${id}`), id);
  });

  it('refuses the old three-segment share shape rather than half-matching it', () => {
    // `RecommendSheet` used to build /title/<kind>/<id>, which no in-app route serves.
    // It resolves to nothing here for the same reason it resolved to +not-found there.
    assert.equal(titleIdFromPath(`/title/movie/${id}`), null);
  });

  it('refuses anything that is not a uuid', () => {
    for (const path of ['/title/', '/title/1', `/title/${id}x`, '/title/../../x']) {
      assert.equal(titleIdFromPath(path), null);
    }
  });
});

// ---------------------------------------------------------------------------
// The app link
// ---------------------------------------------------------------------------

describe('appLinkFor', () => {
  it('builds the custom-scheme link the continuation button needs', () => {
    // https to bingd.app would not work here, and that is an iOS rule rather than a
    // preference: a same-domain navigation is deliberately not handed to the app.
    assert.equal(appLinkFor('bingd', 'i', TOKEN), `bingd://i/${TOKEN}`);
    assert.equal(appLinkFor('bingd', 'u', 'saisuraj'), 'bingd://u/saisuraj');
  });

  it('returns null rather than a bare scheme when there is nothing to open', () => {
    // `bingd://` alone opens the app wherever it happened to be, which reads as a bug.
    assert.equal(appLinkFor('bingd', 'i', null), null);
    assert.equal(appLinkFor(null, 'i', TOKEN), null);
  });

  it('refuses a route it does not serve and a scheme that is not one', () => {
    assert.equal(appLinkFor('bingd', 'settings', TOKEN), null);
    assert.equal(appLinkFor('javascript:alert(1)//', 'i', TOKEN), null);
    assert.equal(appLinkFor('https://evil.example/?x=', 'i', TOKEN), null);
  });
});

// ---------------------------------------------------------------------------
// The build, and its output
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared-content context
//
// The page names the film or the public profile behind a link, so a recipient can see
// that the link worked before deciding whether to install anything. Everything here is
// bounded by two policies that already existed: `media_items_read`, which is
// `using (true)`, and `profiles_read`, which is `using (can_i_view(id))` and answers a
// signed-out reader with public, active accounts only.
//
// These tests cover the half that is ours: the URLs built from an identifier, and the
// shape of what gets displayed. The privacy half is Postgres's and is tested there.
// ---------------------------------------------------------------------------

const SUPA = 'https://abheeqyjzekiowkztfxv.supabase.co';
const UUID = '95f212bb-9bbc-4889-a466-94d1a69875ce';

describe('posterUrl', () => {
  it('builds a TMDB URL from a stored path', () => {
    assert.equal(
      posterUrl('/iQVrouWJHrrY4CXDIJBj1skMix3.jpg'),
      'https://image.tmdb.org/t/p/w342/iQVrouWJHrrY4CXDIJBj1skMix3.jpg',
    );
  });

  it('refuses anything that is not TMDB’s own path shape', () => {
    /**
     * `poster_path` is the one value on this page that comes from outside the build, and
     * it ends up in `img.src`. Nothing here is expected to be hostile, and the pattern is
     * what makes that expectation unnecessary: the result cannot become a `javascript:`
     * URL, cannot leave the CDN, and cannot carry a quote into markup.
     */
    for (const bad of [
      null,
      undefined,
      42,
      '',
      'no-leading-slash.jpg',
      '/../../etc/passwd',
      '/evil.jpg"onerror=alert(1)',
      '/evil.svg',
      'javascript:alert(1)',
      '//evil.example/x.jpg',
      '/a.jpg?x=1',
    ]) {
      assert.equal(posterUrl(bad), null, String(bad));
    }
  });

  it('refuses a size that is not a TMDB width bucket', () => {
    assert.equal(posterUrl('/a.jpg', '../../secret'), null);
    assert.equal(posterUrl('/a.jpg', 'w500'), 'https://image.tmdb.org/t/p/w500/a.jpg');
  });
});

describe('avatarUrl', () => {
  it('builds a public storage URL for a stored avatar', () => {
    const path = '11111111-2222-3333-4444-555555555555/a.jpg';
    assert.equal(
      avatarUrl(SUPA, path),
      `${SUPA}/storage/v1/object/public/avatars/${path}`,
    );
  });

  it('refuses a path that could climb out of the bucket or change origin', () => {
    for (const bad of ['../../secret', 'a.jpg', '/leading/slash.jpg', null, 42, '../x/y.jpg']) {
      assert.equal(avatarUrl(SUPA, bad), null, String(bad));
    }
    assert.equal(avatarUrl('https://evil.example/?x=', '1111/a.jpg'), null);
    assert.equal(avatarUrl('not-a-url', '11111111-2222-3333-4444-555555555555/a.jpg'), null);
  });
});

describe('the context requests', () => {
  it('asks for one title by id, naming its columns', () => {
    const url = titleContextRequest(SUPA, UUID);
    assert.ok(url.startsWith(`${SUPA}/rest/v1/media_items?id=eq.${UUID}`));
    assert.ok(url.includes('limit=1'));
    // Named columns, so a column added to `media_items` later is not shipped to every
    // visitor by accident. `overview` is the one that would hurt: a plot synopsis.
    assert.ok(!url.includes('select=*'));
    assert.ok(!url.includes('overview'));
  });

  it('asks for one profile by handle, and for three columns only', () => {
    const url = profileContextRequest(SUPA, 'fourward');
    assert.ok(url.startsWith(`${SUPA}/rest/v1/profiles?username=eq.fourward`));
    assert.ok(url.includes('display_name'));
    assert.ok(url.includes('avatar_path'));
    // `bio` is readable for a public profile and is still nobody's business on a link
    // preview, and nothing under it is a visibility question this page should reopen.
    assert.ok(!url.includes('bio'));
    assert.ok(!url.includes('email'));
  });

  it('refuses an identifier that did not come from the path validators', () => {
    // Belt over the braces `titleIdFromPath` and `handleFromPath` already provide: these
    // strings are concatenated into a query, so the shapes are checked twice.
    assert.equal(titleContextRequest(SUPA, 'not-a-uuid'), null);
    assert.equal(titleContextRequest(SUPA, `${UUID}&select=*`), null);
    assert.equal(profileContextRequest(SUPA, 'Has.Capitals'), null);
    assert.equal(profileContextRequest(SUPA, 'ok&or=(1.eq.1)'), null);
    assert.equal(titleContextRequest('https://evil.example/x', UUID), null);
  });
});

describe('titleDisplay', () => {
  it('names a film and its year', () => {
    assert.deepEqual(
      titleDisplay({ kind: 'movie', title: 'Amadeus', release_date: '1984-09-19' }),
      { name: 'Amadeus', detail: '1984' },
    );
  });

  it('names a season by its show, because "Season 6" names nothing', () => {
    assert.deepEqual(
      titleDisplay({
        kind: 'season',
        title: 'Season 6',
        season_number: 6,
        release_date: '2005-09-22',
        parent: { title: 'CSI: Crime Scene Investigation' },
      }),
      { name: 'CSI: Crime Scene Investigation, S6', detail: '2005' },
    );
  });

  it('does not say the show twice when TMDB named the season after it', () => {
    // Limited series do this: one season, named for the show.
    assert.equal(
      titleDisplay({
        kind: 'season',
        title: 'Chernobyl',
        season_number: 1,
        parent: { title: 'Chernobyl' },
      }).name,
      'Chernobyl',
    );
  });

  it('names the specials bucket after its show, and never calls it S0', () => {
    assert.equal(
      titleDisplay({
        kind: 'season',
        title: 'Specials',
        season_number: 0,
        parent: { title: 'Barakamon' },
      }).name,
      'Barakamon, Specials',
    );
  });

  it('falls back to the season alone when the parent did not come back', () => {
    assert.equal(
      titleDisplay({ kind: 'season', title: 'Season 2', season_number: 2, parent: null }).name,
      'Season 2',
    );
  });

  it('answers null for a row that cannot carry a name', () => {
    for (const bad of [null, undefined, {}, { title: '   ' }, 'string']) {
      assert.equal(titleDisplay(bad), null, JSON.stringify(bad));
    }
    // A malformed date is no year rather than a wrong one.
    assert.equal(titleDisplay({ kind: 'movie', title: 'X', release_date: 'soon' }).detail, null);
  });
});

describe('profileDisplay', () => {
  it('prefers the display name and always keeps the handle', () => {
    assert.deepEqual(
      profileDisplay({ display_name: 'bingd. founder', username: 'fourward' }),
      { name: 'bingd. founder', handle: '@fourward' },
    );
  });

  it('falls back to the handle, never the other way round', () => {
    assert.deepEqual(profileDisplay({ display_name: '  ', username: 'ada' }), {
      name: 'ada',
      handle: '@ada',
    });
  });

  it('answers null without a handle, which is the row not existing', () => {
    for (const bad of [null, undefined, {}, { display_name: 'Ada' }]) {
      assert.equal(profileDisplay(bad), null);
    }
  });
});

describe('the built site', () => {
  const read = (...parts) => readFileSync(join(dist, ...parts), 'utf8');

  before(() => {
    execFileSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'pipe' });
  });

  after(() => {
    // Rebuilt without the environment a test may have set, so the working tree is left
    // as an ordinary `npm run build:web` would leave it.
    execFileSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'pipe' });
  });

  it('serves a page for every claimed app path', () => {
    /**
     * The invariant that keeps the two halves of a deep link in step. A path claimed in
     * the Apple App Site Association file but not served here is a link that opens
     * Safari on a 404 for anybody without the app — and a path served here but not
     * claimed opens the browser for everybody, including people who have the app. Both
     * look like "invitations do not work" and neither looks like a missing file.
     */
    const aasa = JSON.parse(read('.well-known', 'apple-app-site-association'));
    const claimed = aasa.applinks.details[0].components.map((c) => c['/'].replace(/^\/|\/\*$/g, ''));
    const rewrites = read('_redirects');

    for (const path of claimed) {
      assert.ok(read(`${path}.html`).includes('<html'), `no page is served for /${path}/*`);
      // The exact rule shape is pinned, because Cloudflare Pages silently drops a proxy
      // whose destination matches its own source pattern as an "infinite loop" — which
      // is how /i/<token> served the root holding page in production on 2026-08-21.
      // The destination must stay extensionless and outside the pattern it serves.
      assert.match(
        rewrites,
        new RegExp(`^/${path}/\\*\\s+/${path}\\s+200$`, 'm'),
        `no valid rewrite for /${path}/*`,
      );
    }
  });

  it('claims /lists/* and not /list/*, because app/lists/[id].tsx is the route', () => {
    const aasa = read('.well-known', 'apple-app-site-association');
    assert.match(aasa, /"\/lists\/\*"/);
    assert.doesNotMatch(aasa, /"\/list\/\*"/);
  });

  it('never rewrites .well-known, whatever the routes are', () => {
    // A rewrite over it would serve HTML where iOS expects JSON — the same failure
    // `_headers` exists to prevent, arriving from the other direction.
    const rewrites = read('_redirects');
    assert.doesNotMatch(rewrites, /well-known/);
    assert.doesNotMatch(rewrites, /^\/\*\s/m);
  });

  /**
   * The preview card, which is the only thing about a bingd.app link most people ever
   * see before deciding whether to tap it.
   *
   * Every route unfurled as a bare URL until this pass, and a bare URL in a group chat
   * reads as a link the sender is not sure about. What the card says is deliberately
   * generic — the site holds no reader for a profile or a title and is not getting one
   * — so these tests pin the two halves of that: the card exists, and it claims nothing
   * it cannot know.
   */
  it('gives every share route a preview card with an absolute image', () => {
    for (const route of ['i', 'u', 'title', 'lists']) {
      const html = read(`${route}.html`);
      assert.ok(html.includes('<meta property="og:site_name" content="bingd." />'), route);
      // Absolute, because a relative og:image is dropped silently by every unfurler.
      // A card with no picture is indistinguishable from a card nobody wrote.
      assert.ok(
        html.includes('<meta property="og:image" content="https://bingd.app/social-card.png" />'),
        route,
      );
      assert.ok(html.includes('<meta property="og:url" content="https://bingd.app/'), route);
      assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image" />'), route);
    }
    // And the image is actually served, at exactly the path the tag names, in the shape
    // the tag promises. A 1200x630 declared and a square delivered is a cropped card.
    assert.ok(readFileSync(join(dist, 'social-card.png')).length > 0);
    const card = read('title.html');
    assert.ok(card.includes('<meta property="og:image:width" content="1200" />'));
    assert.ok(card.includes('<meta property="og:image:height" content="630" />'));
  });

  it('claims nothing in a card that the site cannot know', () => {
    /**
     * The title route is the one under pressure, and it is now under more of it: the
     * *page* resolves the film's name in the browser, so the obvious next edit is to put
     * that name in the card too. It cannot go there. These files are static, one per
     * route, so a `<meta>` tag is the same bytes for every visitor; naming the film would
     * need a Worker doing a lookup on every unfurl request, which is the rich-preview
     * work this tranche deferred.
     *
     * So the card stays generic and the page does not, and the test says so.
     */
    const title = read('title.html');
    assert.ok(title.includes('<meta property="og:title" content="Open on bingd." />'));
    assert.ok(
      title.includes(
        '<meta property="og:description" content="See where it ranks with friends, or rank it yourself." />',
      ),
    );
    assert.ok(title.includes('<meta property="og:image:alt" content="The bingd. wordmark" />'));
    // No poster host anywhere in the card, even though the page loads from one.
    const head = title.slice(0, title.indexOf('</head>'));
    assert.ok(!head.includes('image.tmdb.org'));
    assert.ok(!head.includes('themoviedb'));
  });

  it('names the invitation in its own card rather than borrowing the share one', () => {
    // An invitation is the one link whose preview should say what it is before it is
    // opened. The other three are content, and "Open on bingd." is the honest line for
    // a card that cannot name the content.
    assert.ok(
      read('i.html').includes('<meta property="og:title" content="You have been invited to bingd." />'),
    );
    assert.ok(read('u.html').includes('<meta property="og:title" content="Open on bingd." />'));
  });


  it('keeps the identifier out of the card, because a preview is fetched by strangers', () => {
    // og:url is the route prefix. A token, handle or media id copied into it would be
    // handed to whichever messaging service unfurls the link, logged and cached there —
    // on behalf of a sender who pasted the link into one conversation. The pages are
    // static files, identical for every visitor, so there is nowhere for one to arrive
    // from; this is the assertion that keeps it that way.
    for (const [route, prefix] of [
      ['i', '/i/'],
      ['u', '/u/'],
      ['title', '/title/'],
    ]) {
      const html = read(`${route}.html`);
      const url = /<meta property="og:url" content="([^"]+)"/.exec(html)[1];
      assert.equal(url, `https://bingd.app${prefix}`);
    }
  });

  it('ships the two screenshots the page draws, and no third', () => {
    // The page references them by name, so a build that stopped copying `src/` would
    // otherwise show two broken frames and still pass every other test here.
    for (const shot of ['shot-collection.jpg', 'shot-ranking.jpg']) {
      assert.ok(readFileSync(join(dist, shot)).length > 0, shot);
      assert.ok(read('title.html').includes(`/${shot}`), shot);
    }
    // Every route gets the same two, because there is one page and it is reusable.
    for (const route of ['i', 'u', 'title', 'lists']) {
      const html = read(`${route}.html`);
      assert.ok(html.includes('shot-collection.jpg'), route);
      assert.ok(html.includes('shot-ranking.jpg'), route);
    }
  });

  it('gives both screenshots dimensions and alt text', () => {
    /**
     * `width`/`height` so the layout does not jump when they decode, which on a phone is
     * the install button moving under a thumb. Alt text because a link somebody was sent
     * is exactly the page a screen reader lands on cold.
     */
    const html = read('title.html');
    assert.match(html, /shot-collection\.jpg" width="720" height="\d+"/);
    assert.match(html, /shot-ranking\.jpg" width="720" height="\d+"/);
    assert.match(html, /alt="A bingd\. collection of ranked series[^"]*"/);
    assert.ok(html.includes('loading="lazy"'));
  });

  it('holds the context block hidden, with a generic line for it to replace', () => {
    /**
     * Both states ship in the markup and one is hidden, so the page has its final shape
     * before any network call finishes. A card that grows a poster a second after it is
     * read is the layout jumping under somebody's thumb, which is the thing the width
     * and height attributes above exist to prevent everywhere else.
     */
    for (const route of ['u', 'title']) {
      const html = read(`${route}.html`);
      assert.match(html, /<div id="context" class="context" hidden>/, route);
      assert.match(html, /<img id="context-art"[^>]*hidden/, route);
      assert.match(html, /id="generic-subject"/, route);
    }
    // The invitation has no content to resolve: a token names a person, and turning one
    // into a person is the lookup an invitation link must not offer.
    assert.ok(!read('i.html').includes('id="context"'));
  });

  it('renders no content into the shipped HTML, only the places for it', () => {
    // The names arrive in the browser and are written with textContent. Nothing about a
    // film or an account is in the bytes Cloudflare serves, which is what keeps these
    // four files identical for every visitor and cacheable at the edge.
    for (const route of ['u', 'title']) {
      const html = read(`${route}.html`);
      // The slots are empty in the shipped bytes.
      assert.match(html, /<p class="subject" id="context-name"><\/p>/, route);
      assert.match(html, /<p class="context-detail" id="context-detail"><\/p>/, route);
    }
    for (const route of ['i', 'u', 'title', 'lists']) {
      const html = read(`${route}.html`);
      assert.ok(!html.includes('image.tmdb.org'), route);
      assert.ok(!html.includes('/rest/v1/'), route);
    }
  });

  it('says bingd. the way the brand is written', () => {
    // The wordmark is lowercase with the full stop everywhere a person reads it. The
    // legal documents keep "Bingd", deliberately: naming the entity in Terms is a
    // different job from addressing somebody on a landing page.
    for (const route of ['i', 'u', 'title', 'lists']) {
      const html = read(`${route}.html`);
      const body = html.slice(html.indexOf('<body>'));
      assert.ok(body.includes('<h1>bingd.</h1>'), route);
      assert.ok(!/\bBingd\b/.test(body), `${route} still capitalises the wordmark`);
    }
  });

  it('ships the router the tests just exercised, unmodified', () => {
    assert.equal(read('router.mjs'), readFileSync(join(here, 'src', 'router.mjs'), 'utf8'));
  });

  it('carries the friend-beta install destinations for both platforms', () => {
    // These are the two links behind every button on the invitation page. Pinned as
    // exact values: a typo here is a store button that 404s on a page a friend was
    // sent, and nothing else in the build would catch it.
    const invite = read('i.html');
    const config = JSON.parse(
      /<script type="application\/json" id="bingd-config">(.*?)<\/script>/s.exec(invite)[1],
    );
    assert.equal(config.page, 'invite');
    assert.equal(config.distribution.ios.betaUrl, 'https://testflight.apple.com/join/kkgaYsqx');
    assert.equal(
      config.distribution.android.optInUrl,
      'https://play.google.com/apps/testing/app.bingd',
    );
    assert.equal(config.distribution.app.scheme, 'bingd');
    // The empty state must still exist for the 'other' platform and for any future
    // un-configured window — it is painted by page.mjs, not removed by configuration.
    assert.match(invite, /not open for this device yet/);
  });

  it('drops the $comment prose rather than shipping it to every visitor', () => {
    const invite = read('i.html');
    assert.doesNotMatch(invite, /\$comment/);
    assert.doesNotMatch(invite, /TestFlight link, of the form/);
  });

  it('tells the invited visitor what the store round trip costs them', () => {
    // The deferred-install limitation, said to the person it affects rather than only
    // in a document. Without it somebody installs from TestFlight, launches from the
    // home screen, and silently loses the invitation.
    const invite = read('i.html');
    assert.match(invite, /Come back to this page/);
    assert.match(invite, /the invitation will not follow you there/);
  });

  it('refuses to build a destination that is not an absolute https URL', () => {
    /**
     * The open-redirect gate, and the reason it is a build failure rather than a
     * runtime check: these buttons sit on a page people reach from an invitation, which
     * is the most valuable place in this project to plant a link somewhere else.
     */
    const path = join(here, 'distribution.config.json');
    const original = readFileSync(path, 'utf8');
    for (const bad of [
      'javascript:alert(1)',
      'http://testflight.apple.com/join/x',
      '//evil.example/x',
      'x',
    ]) {
      try {
        const config = JSON.parse(original);
        config.ios.betaUrl = bad;
        writeFileSync(path, JSON.stringify(config, null, 2));
        assert.throws(
          () => execFileSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'pipe' }),
          `the build accepted ${bad} as an install destination`,
        );
      } finally {
        writeFileSync(path, original);
      }
    }
  });

  it('renders no page that reads a destination out of the URL', () => {
    /**
     * Stated as a property of the shipped bytes rather than of the source, because this
     * is the one thing on this domain that would be worth an attacker's time. Every
     * destination is baked in at build time; nothing here reads `location.search`,
     * `document.referrer` or a hash.
     */
    for (const file of ['i.html', 'u.html', 'title.html', 'page.mjs', 'router.mjs']) {
      const source = read(...file.split('/'));
      assert.doesNotMatch(source, /location\.search|URLSearchParams|document\.referrer/);
      assert.doesNotMatch(source, /location\.href\s*=/);

      /**
       * Every way a string becomes markup, rather than the bare word.
       *
       * This matched `/innerHTML/` anywhere in the file until 2026-09-03, which had the
       * perverse effect that `page.mjs` could not *write down* the rule it obeys: the
       * comment explaining why nothing there assembles HTML was itself a failure. The
       * patterns below catch the assignment and the three insertion APIs, which is what
       * the test was ever trying to say.
       */
      assert.doesNotMatch(source, /\.(inner|outer)HTML\s*=/);
      assert.doesNotMatch(source, /insertAdjacentHTML|document\.write|createContextualFragment/);
    }
  });

  it('serves the four documents the stores and the Terms demand a URL for', () => {
    /**
     * Until 2026-08-20 all three of these returned Cloudflare Pages' fallback
     * `index.html` with a **200**. That is the worst possible shape for this failure:
     * a reviewer following the privacy URL out of App Store Connect got the generic
     * "Bingd is in closed testing" page and a success status, and no check anywhere —
     * curl, a link checker, this suite — could tell it apart from a policy.
     *
     * So the test is not "does the path answer". It is "does the path answer with the
     * document it claims to be".
     */
    const expected = [
      ['privacy', /Privacy/, /never leaves your device as\s+analytics|allowlist/],
      // The support page's h1 became the invitation it is rather than the word
      // "Support" (2026-09-04); its marker is the address every action on it writes
      // to, which is the one string the page cannot be useful without.
      ['support', /Need a hand\?/, new RegExp('support@bingd\\.app')],
      ['account-deletion', /Deleting your account/, /Settings &rsaquo; Account &amp; Data/],
      // The Terms, whose own marker is the moderation list: it is the section that has
      // to stay checkable against `moderation_actions`' six allowed actions, and a
      // Terms rendered from the wrong constant would still have the right heading.
      ['terms', /Terms of Use/, /suspend the account, which hides it and stops it posting/],
    ];

    for (const [dir, heading, marker] of expected) {
      const html = read(dir, 'index.html');
      assert.match(html, /<html/, `/${dir} is not a page`);
      assert.match(html, new RegExp(`<h1>${heading.source}</h1>`), `/${dir} has the wrong heading`);
      assert.match(html, marker, `/${dir} does not carry its own content`);

      // A document, not the router. `page.mjs` decides where somebody who tapped an
      // invitation is sent; a store's crawler runs no JavaScript, and a policy that
      // needs a script to render is a policy that cannot be read.
      assert.doesNotMatch(html, /page\.mjs/, `/${dir} loads the router`);
      assert.doesNotMatch(html, /<script/, `/${dir} contains script`);
    }
  });

  it('does not tell the reader Bingd sends no push notifications', () => {
    /**
     * **It said exactly that, and it stopped being true.**
     *
     *     "Bingd sends no push notifications. Notifications appear in the app's own
     *      inbox and nowhere else. That is deliberate for this beta."
     *
     * It was accurate when it was written and it was filed under *Things that are not
     * faults*, so it was doing real work: somebody who had allowed notifications and
     * received none was being told not to report it. Push has since been turned on --
     * `config/push.cjs` entitles the beta lane to the production APNs environment, the
     * client asks for permission and writes tokens, and the sender is deployed -- so the
     * page now tells a reader their phone is behaving correctly when it is not, on the
     * one page they would consult before writing in.
     *
     * Pinned as an absence and not only as a presence. The replacement wording is one
     * sentence somebody could rewrite; the false claim is what must never come back, and
     * a substring assertion is what says so whatever the surrounding copy becomes.
     */
    const html = read('support', 'index.html');

    assert.doesNotMatch(html, /sends no push notifications/i);
    assert.doesNotMatch(html, /nowhere else/i);

    // Conservative rather than promotional: what *may* happen, that the inbox is the
    // fallback, and where the reader turns it off. Both routes are named, because the
    // in-app preference cannot override an OS-level denial and vice versa.
    // Plain substrings over the HTML with its whitespace collapsed, so the assertion is
    // about the sentence rather than about where the source happens to wrap it.
    //
    // The wording moved on 2026-09-04 when this stopped being a bullet under *Things
    // that are not faults* and became the answer to "how do I change which
    // notifications I get". The three facts it has to carry did not move.
    const prose = html.replace(/\s+/g, ' ');
    assert.ok(
      prose.includes('only reaches your phone if you allowed'),
      'no honest notification sentence',
    );
    assert.ok(prose.includes('Settings &rsaquo; Notification Settings'), 'no in-app route named');
    assert.ok(prose.includes('phone&rsquo;s own settings'), 'no OS-level route named');
    assert.ok(prose.includes('in-app inbox'), 'the inbox fallback is not stated');
  });

  it('lets no store document be claimed by the app', () => {
    /**
     * The other half. These pages have no screen behind them, so a claim on any of them
     * means Android or iOS opens Bingd onto `+not-found` when a reviewer taps the very
     * link the store listing published. The Android manifest claimed the entire host
     * until the same day these pages were written, which is exactly how that would have
     * happened.
     */
    const documents = ['privacy', 'terms', 'support', 'account-deletion'];
    const aasa = JSON.parse(read('.well-known', 'apple-app-site-association'));
    const claimed = aasa.applinks.details[0].components.map((c) => c['/']);
    const appConfig = readFileSync(join(here, '..', 'app.config.ts'), 'utf8');
    const filters = /intentFilters: \[([\s\S]*?)\n {4}\],/.exec(appConfig)?.[1] ?? '';
    const prefixes = [...filters.matchAll(/pathPrefix: '([^']+)'/g)].map(([, value]) => value);

    for (const dir of documents) {
      for (const path of claimed) {
        assert.ok(
          !`/${dir}`.startsWith(path.replace(/\*$/, '')),
          `Apple claims ${path}, which covers /${dir}`,
        );
      }
      for (const prefix of prefixes) {
        assert.ok(!`/${dir}/`.startsWith(prefix), `Android claims ${prefix}, which covers /${dir}`);
      }
      // And the rewrite table must not swallow them either.
      assert.doesNotMatch(read('_redirects'), new RegExp(`^/${dir}\\b`, 'm'));
    }
  });

  it('puts no token anywhere but the path it came from', () => {
    // The page reports an open and nothing else. No token in a query string, no token
    // in an analytics call, no third-party origin on the page at all beyond the font
    // host the app already uses.
    const source = read('page.mjs');
    assert.match(source, /record_invite_open/);
    assert.doesNotMatch(source, /posthog|sentry|google-analytics|gtag/i);
  });
});

// ---------------------------------------------------------------------------
// The identities on the other side of the link
// ---------------------------------------------------------------------------

/**
 * Everything above proves the site is internally consistent. Nothing above proves it
 * describes *this app*.
 *
 * That gap is not hypothetical. `/list/*` was claimed for weeks against a route called
 * `app/lists/[id].tsx`, and every test passed the whole time, because the two halves
 * were only ever checked against themselves. The deployed Apple App Site Association
 * file still carries that typo today.
 *
 * A deep link is a claim made in four places with no compiler between them —
 * `app.config.ts` (the entitlement and the manifest), `deep-links.config.json` (the
 * identifiers), the generated `.well-known` files, and the Expo Router tree that has to
 * render whatever arrives. Every mismatch among them fails the same way: the link opens
 * the browser, or opens the app onto `+not-found`, and there is no error anywhere. This
 * block is the compiler.
 */
describe('the app the site claims to open', () => {
  const appConfig = readFileSync(join(here, '..', 'app.config.ts'), 'utf8');
  const links = JSON.parse(readFileSync(join(here, 'deep-links.config.json'), 'utf8'));
  const read = (...parts) => readFileSync(join(dist, ...parts), 'utf8');
  const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * `app.config.ts` is TypeScript and cannot be imported by `node --test`, so the
   * variant table is read out of the source. Brittle on purpose: if the shape of that
   * table changes this fails and somebody looks, which is the correct outcome. A softer
   * read would return an empty list and quietly assert nothing.
   */
  const declaredVariants = [
    ...appConfig.matchAll(/^ {2}(\w+): \{ name: '[^']*', bundleId: '([^']+)'/gm),
  ].map(([, name, bundleId]) => ({ name, bundleId }));

  it('reads every variant out of app.config.ts, or the rest of this block asserts nothing', () => {
    assert.equal(declaredVariants.length, 3, `parsed ${JSON.stringify(declaredVariants)}`);
    assert.deepEqual(
      declaredVariants.map((v) => v.bundleId).sort(),
      links.variants.map((v) => v.bundleId).sort(),
      'app.config.ts and deep-links.config.json do not build the same set of applications',
    );
  });

  it('claims the bundle identifiers the app is actually built with', () => {
    /**
     * The Apple App Site Association appID is `<team>.<bundle>`, and iOS compares it
     * against the binary's own identifier with no tolerance. Rename a variant in
     * app.config.ts and every Universal Link for that variant stops opening the app —
     * silently, because a non-matching appID is indistinguishable on the device from a
     * domain that never claimed the app at all.
     */
    const aasa = JSON.parse(read('.well-known', 'apple-app-site-association'));
    const claimed = new Set(aasa.applinks.details[0].appIDs);

    for (const variant of declaredVariants) {
      const appId = `${links.appleTeamId}.${variant.bundleId}`;
      assert.ok(
        claimed.has(appId),
        `${variant.name} builds ${variant.bundleId}, which is unclaimed as ${appId}`,
      );
    }
    assert.equal(claimed.size, declaredVariants.length, 'the file claims an appID no variant builds');

    // webcredentials carries the same list, and is what lets the keychain offer a saved
    // password and Sign in with Apple's associated domain behave.
    assert.deepEqual([...aasa.webcredentials.apps].sort(), [...claimed].sort());
  });

  it('is entitled for the domain it publishes the file on', () => {
    /**
     * The requirement stated as a test rather than as a sentence in a report: the binary
     * has to carry `applinks:bingd.app` or the file on bingd.app is read by nobody. This
     * is what keeps that true for the Preview and TestFlight builds nobody has made yet.
     */
    const domains = /associatedDomains: \[([^\]]*)\]/.exec(appConfig)?.[1] ?? '';
    assert.match(domains, new RegExp(`'applinks:${literal(links.domain)}'`));
  });

  it('registers the Android intent filter for that same domain, and verifies it', () => {
    // autoVerify is what makes Android fetch assetlinks.json at install time. Without it
    // the intent filter still matches, but the app appears in a chooser instead of
    // opening — which reads as the link not working rather than as a missing flag.
    const filters = /intentFilters: \[([\s\S]*?)\n {4}\],/.exec(appConfig)?.[1] ?? '';
    assert.match(filters, /autoVerify: true/);
    assert.match(filters, /scheme: 'https'/);
    assert.match(filters, new RegExp(`host: '${literal(links.domain)}'`));
  });

  it('claims the same four paths on Android as it does on iOS', () => {
    /**
     * The two halves of one claim, which nothing else compares.
     *
     * Apple's file lists paths; Android's manifest lists path prefixes; and until this
     * test existed the manifest listed *no* path at all, which claims the entire domain.
     * Both directions of drift are silent and both are damaging:
     *
     *   - **Android claiming more than iOS** hands the app URLs it has no screen for. The
     *     moment bingd.app serves /privacy — which the stores require — an over-broad
     *     filter turns a store's own compliance link into `+not-found` on Android and a
     *     working page on iOS.
     *   - **Android claiming less** is the `/list/*` failure again, on one platform only:
     *     the link opens Chrome, the same link opens the app on an iPhone, and nothing
     *     anywhere reports a mismatch.
     *
     * `pathPrefix` is the exact Android spelling of Apple's `/x/*`: both match every URL
     * beginning with `/x/`. So the comparison is a rewrite of one into the other, and any
     * claim in `deep-links.config.json` that is not of the `/<segment>/*` shape fails
     * rather than being silently skipped.
     */
    const filters = /intentFilters: \[([\s\S]*?)\n {4}\],/.exec(appConfig)?.[1] ?? '';
    const prefixes = [...filters.matchAll(/pathPrefix: '([^']+)'/g)].map(([, value]) => value);

    const expected = links.appPaths.map((claimed) => {
      const segment = /^\/([^/]+)\/\*$/.exec(claimed)?.[1];
      assert.ok(segment, `${claimed} is not a /<segment>/* claim`);
      return `/${segment}/`;
    });

    assert.deepEqual(
      [...prefixes].sort(),
      [...expected].sort(),
      'app.config.ts intent filters and deep-links.config.json appPaths claim different paths',
    );

    // Every path entry carries its own scheme and host, because Android unions <data>
    // attributes across the filter rather than pairing them up. A bare pathPrefix would
    // widen the claim instead of narrowing it.
    const entries = [...filters.matchAll(/\{[^{}]*pathPrefix: '[^']+'[^{}]*\}/g)].map(
      ([entry]) => entry,
    );
    assert.equal(entries.length, prefixes.length);
    for (const entry of entries) {
      assert.match(entry, /scheme: 'https'/, entry);
      assert.match(entry, new RegExp(`host: '${literal(links.domain)}'`), entry);
    }
  });

  it('claims no path the app has no screen for', () => {
    /**
     * The `/list/*` defect, made impossible to reintroduce.
     *
     * A claimed path with no Expo Router route opens the app onto `+not-found`, which is
     * strictly worse than opening the browser: the visitor now believes Bingd is broken
     * rather than that they need it. So the claim is checked against the router tree on
     * disk, which is the only thing that decides what actually renders.
     */
    for (const claimed of links.appPaths) {
      const segment = /^\/([^/]+)\/\*$/.exec(claimed)?.[1];
      assert.ok(segment, `${claimed} is not a /<segment>/* claim`);

      const routeDir = join(here, '..', 'app', segment);
      assert.ok(existsSync(routeDir), `${claimed} is claimed and app/${segment}/ does not exist`);

      const dynamic = readdirSync(routeDir).filter((file) => /^\[.+\]\.tsx$/.test(file));
      assert.ok(
        dynamic.length > 0,
        `${claimed} matches any identifier and app/${segment}/ has no [param].tsx to receive one`,
      );
    }
  });

  it('writes an Android statement for every variant that has a certificate', () => {
    /**
     * Three variants, two statements, and the missing one is correct.
     *
     * `app.bingd.dev` has no fingerprint because no development build has been made, and
     * a statement cannot be invented for a certificate that does not exist. The
     * consequence is worth stating here rather than discovering on a device: **an
     * Android development build cannot verify App Links.** Physical Android testing has
     * to use the Preview build, whose fingerprint is present.
     *
     * The production entry carries two fingerprints: the EAS upload key, and the Play
     * app-signing key that Play substitutes when it re-signs. Both stay — a device that
     * installed from Play checks the Play key, and one that installed a production
     * build straight from EAS checks the upload key.
     */
    const statements = JSON.parse(read('.well-known', 'assetlinks.json'));
    const declared = new Set(declaredVariants.map((v) => v.bundleId));
    const withFingerprints = links.variants.filter((v) => v.androidSha256.length > 0);

    assert.equal(statements.length, withFingerprints.length);

    for (const statement of statements) {
      assert.deepEqual(statement.relation, ['delegate_permission/common.handle_all_urls']);
      assert.equal(statement.target.namespace, 'android_app');
      assert.ok(
        declared.has(statement.target.package_name),
        `${statement.target.package_name} is not an applicationId app.config.ts builds`,
      );
      assert.ok(statement.target.sha256_cert_fingerprints.length > 0);
      for (const fingerprint of statement.target.sha256_cert_fingerprints) {
        assert.match(fingerprint, /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
      }
    }
  });

  it('keeps the two .well-known files typed as JSON, which is the whole of whether they work', () => {
    /**
     * Apple requires apple-app-site-association be served as `application/json`, and it
     * has no extension for a host to infer that from. Served as text/plain, iOS fetches
     * it, declines to parse it, and every Universal Link keeps opening Safari with
     * nothing anywhere to say why — the most expensive silent failure available on this
     * domain, and it is one edit of `_headers` away at all times.
     */
    const headers = read('_headers');
    for (const file of ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json']) {
      assert.match(
        headers,
        new RegExp(`^${literal(file)}\\r?\\n(?: +.*\\r?\\n)*? +Content-Type: application/json`, 'm'),
        `${file} is not typed application/json by _headers`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// What the host is told to send
// ---------------------------------------------------------------------------

/**
 * The Terms of Use, and the two things about it that are worth a test.
 *
 * Not the prose — a test that asserts paragraphs is a test that fails on every edit and
 * teaches people to update it without reading. These are the two claims that would be
 * *wrong* rather than merely different if they changed by accident.
 */
describe('the Terms of Use', () => {
  // Defined here and called inside the tests: the site is built by the first suite's
  // `before`, so a read at this level would run during collection and fail on a clean
  // tree.
  const read = (...parts) => readFileSync(join(dist, ...parts), 'utf8');

  /**
   * The operator, and the thing it must never be read as.
   *
   * This test used to assert the **placeholder** was still there, on the reasoning that
   * a reminder living in a failing test cannot be lost, and that its own comment said
   * it would be deleted in the commit that supplied the real answer. That commit is
   * 2026-09-04, and the answer is the one the placeholder could not hold: there is no
   * company. The legal operator is a person, Suraj Kandukuri, and FourwardStudios is a
   * developer name used in Google Play and similar contexts.
   *
   * So the test inverts rather than disappearing. **The old risk was naming a company
   * that does not exist; the new one is implying that FourwardStudios is one**, which
   * is what any of "FourwardStudios LLC", "FourwardStudios, Inc", "a company called
   * FourwardStudios" or the assumed-name form "d/b/a" would assert. Each is a
   * registration nobody has filed, on the document a person points at when they say
   * Bingd agreed to something. The page has to name the person, disclaim the company,
   * and use none of those.
   */
  it('names the operator, and never dresses the developer name up as a company', () => {
    const html = read('terms', 'index.html');
    const prose = html.replace(/\s+/g, ' ');

    assert.ok(!html.includes('FOUNDER TO CONFIRM'), 'the entity placeholder is back');
    assert.ok(prose.includes('Suraj Kandukuri'), 'the Terms names no operator');
    assert.ok(
      prose.includes('FourwardStudios is a developer name rather than a company'),
      'the Terms does not say what FourwardStudios is',
    );
    assert.ok(
      prose.includes('agreement with Suraj Kandukuri personally'),
      'the Terms does not say who the contracting party is',
    );

    /**
     * **And the privacy policy has to say the same thing**, which it did not until
     * 2026-09-04. It said "Bingd is made by one independent developer" and named
     * nobody, so the two documents a reader can compare disagreed about who is on the
     * other side of them: one named a person, the other named no one. A privacy policy
     * is also where the responsible party is asked for by name — GDPR calls it the data
     * controller — and "one independent developer" is not an answer to that.
     *
     * Asserted here rather than in a test of its own because it is the same fact, and
     * one fact split across two tests is how the two documents drifted apart in the
     * first place.
     */
    const privacy = read('privacy', 'index.html');
    const privacyProse = privacy.replace(/\s+/g, ' ');
    assert.ok(
      privacyProse.includes('Bingd is operated by <strong>Suraj Kandukuri</strong>'),
      'the privacy policy names no operator',
    );
    assert.ok(
      privacyProse.includes('FourwardStudios is a developer name rather than a company'),
      'the privacy policy does not say what FourwardStudios is',
    );
    assert.ok(
      privacyProse.includes('data controller'),
      'the privacy policy names nobody responsible for the personal data',
    );

    // The entity types nobody has registered, and the assumed-name construction that
    // asserts a filing of its own. Anchored to FourwardStudios so either document can
    // still use the ordinary words about somebody else's company. Checked against both,
    // because the claim is equally false on either page.
    for (const wrong of [
      /FourwardStudios[^.<]{0,20}\b(?:LLC|L\.L\.C|Inc|Incorporated|Ltd|Limited|Corp|Corporation|GmbH|Pty|PLC)\b/i,
      /\bd\/b\/a\b/i,
      /\bdoing business as\b/i,
      /\btrading as\b/i,
      /FourwardStudios[^.<]{0,30}\bis a (?:company|corporation|partnership|legal entity)\b/i,
    ]) {
      assert.doesNotMatch(html, wrong, 'the Terms claims a registration nobody has filed');
      assert.doesNotMatch(
        privacy,
        wrong,
        'the privacy policy claims a registration nobody has filed',
      );
    }

    // `\s+` rather than a space: the source wraps at 90 columns, so a literal match
    // here would break on a reflow that changed nothing about the meaning. The draft
    // status stands — the operator was L-1 item 1, and items 2 to 5 are open.
    assert.match(html, /not yet been reviewed by a\s+lawyer/, 'the draft status must be stated');
  });

  /**
   * The date is a source literal, and it is the Terms' own.
   *
   * `TERMS_DATE` rather than the shared `DOCUMENT_DATE`, because the Terms was drafted
   * five days after the other three documents and a "last updated" predating a page's
   * own existence is the small wrongness that makes its large claims doubtable. A
   * build stamp would be worse — a redeploy with no text change would claim a
   * revision — so both dates are literals, and the finalisation commit is what moves
   * this one.
   */
  it('dates itself from its own deterministic revision date', () => {
    assert.match(read('terms', 'index.html'), /Last updated 4 September 2026\./);
    // The other three keep the shared date; the Terms did not drag them forward.
    assert.match(read('privacy', 'index.html'), /Last updated 20 August 2026\./);
  });

  /**
   * Every power the moderation section claims has to exist in `moderation_actions`.
   *
   * A Terms is the one document where an unbacked promise is worse than silence: it is
   * what somebody points at when they say Bingd said it would act. The six actions
   * below are the check constraint in 20260813001700, and the document may describe
   * those and nothing more.
   */
  it('claims only powers the moderation schema actually has', () => {
    const html = read('terms', 'index.html');
    for (const claim of [
      /remove the review, comment, or other content/,
      /require a handle to be changed/,
      /issue a warning/,
      /suspend the account/,
    ]) {
      assert.match(html, claim, 'a stated moderation power is missing from the Terms');
    }

    /**
     * **And the enumerated list stops there**, because `moderation_actions` does.
     *
     * Its check constraint allows six values — suspend_account, restore_account,
     * remove_content, force_username_change, dismiss_report, warn — and none of them is
     * "delete this account". A Terms that listed account removal beside the four above
     * would claim a routine enforcement power the operator system cannot record, which
     * is the class of over-claim this whole document is written to avoid. Permanent
     * closure is covered separately under "Ending it", where it is tied to a legal or
     * safety obligation rather than offered as a response to a report.
     */
    assert.doesNotMatch(
      html.split('<h2>Our content')[0],
      /<li>remove the account/,
      'the Terms lists an enforcement action moderation_actions has no value for',
    );

    // And the ones it must not claim, because nothing implements them. An appeals
    // process and automated detection are both things a templated Terms supplies by
    // default and this product does not have.
    assert.doesNotMatch(html, /automated (?:detection|moderation|systems? (?:detect|scan))/i);
    assert.match(
      html,
      /no formal appeals process/,
      'the absence of an appeals process must be stated rather than implied',
    );
  });

  it('is reachable from every other document and from the router pages', () => {
    for (const dir of ['privacy', 'support', 'account-deletion']) {
      assert.match(read(dir, 'index.html'), /href="\/terms"/, `/${dir} does not link the Terms`);
    }
    assert.match(read('i.html'), /href="\/terms"/, 'the invitation page does not link the Terms');
    assert.match(read('index.html'), /href="\/terms"/, 'the root page does not link the Terms');
  });
});

/**
 * The support page, which is the only page on this site somebody is meant to *act* on.
 *
 * Everything above proves the site describes the app. This suite proves the one page
 * that asks for a reply can actually take one, because every way it silently stops
 * working looks identical to it working:
 *
 *   - A `mailto:` whose subject was interpolated rather than encoded is a link that
 *     opens an empty draft, or no draft, depending on the client.
 *   - An address that drifts from the one the app drafts to splits one conversation
 *     across two mailboxes, and the founder reads only the one they set up.
 *   - Cloudflare's Scrape Shield rewrites every `mailto:` on this zone into a decoder
 *     link (docs/architecture/web-deployment.md). On a policy page that is cosmetic; on
 *     the page whose whole purpose is the mail links, a round-trip that loses a query
 *     string is the page failing with nothing to show for it.
 *
 * None of the three produces an error anywhere. They produce silence, which on a
 * support page is indistinguishable from nobody having anything to say.
 */
describe('the support page', () => {
  const read = (...parts) => readFileSync(join(dist, ...parts), 'utf8');
  const support = () => read('support', 'index.html');
  const bodyOf = (html) => html.slice(html.indexOf('<body>'));
  const hrefs = (html) => [...bodyOf(html).matchAll(/href="(mailto:[^"]+)"/g)].map(([, u]) => u);

  /** The app's own copy of the address and the subjects it drafts to. */
  const appSupport = () => readFileSync(join(here, '..', 'src', 'lib', 'support.ts'), 'utf8');

  it('offers the four ways in, each as a draft addressed and titled for it', () => {
    /**
     * The four subjects are the only routing this channel has. There is no queue, no
     * form and no ticket id — a filter on the subject is how "something is broken"
     * gets separated from "here is an idea", so a subject that fails to survive the
     * link is the whole triage mechanism gone.
     */
    const required = [
      'bingd. support - problem report',
      'bingd. feedback - idea',
      'bingd. account and privacy help',
      'bingd. safety report',
    ];
    const links = hrefs(support());

    for (const subject of required) {
      const wanted = `subject=${encodeURIComponent(subject)}`;
      assert.ok(
        links.some((u) => u.includes(wanted)),
        `no action on the support page drafts "${subject}"`,
      );
    }

    // And a fifth, unqualified one: the hero. Somebody who does not recognise their
    // problem in any of the four still has one press that works.
    assert.match(support(), /class="button"[^>]*href="mailto:/, 'the hero has no mail action');
  });

  it('encodes every draft rather than interpolating it', () => {
    /**
     * A subject with a space in it is not a valid URL. Some clients tolerate it, some
     * truncate the subject at the space, and some drop the query string entirely — and
     * which one the reader has is not knowable from here. `src/lib/support.ts` learned
     * this for the app; the site builds its own and has to be held to the same rule.
     */
    for (const url of hrefs(support())) {
      assert.doesNotMatch(url, /[\s"'<>]/, `unencoded character in ${url}`);
      const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      if (query) {
        assert.doesNotMatch(query, /&(?!amp;|$)[a-z]+=(?!)/i);
        assert.match(query, /^subject=[A-Za-z0-9._~%-]+$/, `not a subject-only query: ${url}`);
      }
    }
  });

  it('writes to the address the app drafts to, and to no other', () => {
    /**
     * The identity check, in the spirit of the deep-link ones above: the site and the
     * app are two uncompiled halves of one support channel and were only ever checked
     * against themselves. They disagreed for two weeks — the site said
     * `hello@bingd.app`, the app and the founder's Play listing said
     * `support@bingd.app` — which is SUPPORT-1 in
     * docs/release/store-privacy-inventory.md and is what this test now prevents
     * recurring.
     */
    const inApp = /SUPPORT_EMAIL = '([^']+)'/.exec(appSupport())?.[1];
    assert.ok(inApp, 'src/lib/support.ts no longer declares SUPPORT_EMAIL');

    const addresses = new Set(hrefs(support()).map((u) => u.slice('mailto:'.length).split('?')[0]));
    addresses.delete('hello@bingd.app'); // the general address, deliberately kept
    assert.deepStrictEqual(
      [...addresses],
      [inApp],
      'the support page writes to an address the app does not',
    );
  });

  it('extends the two subjects the app already sends rather than replacing them', () => {
    /**
     * The app drafts `bingd. support` and `bingd. feedback`. The page's four are
     * prefixed with those two on purpose, so one mail rule keeps catching both routes
     * and a person who wrote in from the app and then from the web lands in one thread.
     */
    const source = appSupport();
    for (const [topic, prefix] of [
      ['feedback', 'bingd. feedback'],
      ['problem', 'bingd. support'],
    ]) {
      assert.match(
        source,
        new RegExp(`${topic}: '${prefix}'`),
        `the app's ${topic} subject is no longer "${prefix}"`,
      );
    }
    const subjects = hrefs(support())
      .filter((u) => u.includes('subject='))
      .map((u) => decodeURIComponent(u.split('subject=')[1]));
    for (const subject of subjects) {
      assert.ok(
        subject.startsWith('bingd. support') ||
          subject.startsWith('bingd. feedback') ||
          subject.startsWith('bingd. account') ||
          subject.startsWith('bingd. safety'),
        `"${subject}" falls outside the four the founder settled`,
      );
    }
  });

  it('exempts its mail links from the zone-wide email obfuscator', () => {
    /**
     * Cloudflare Scrape Shield is on for this zone and rewrites `mailto:` links into
     * `/cdn-cgi/l/email-protection` with an injected decoder. `email_off` is its own
     * opt-out and is a comment, so it costs nothing anywhere else and cannot be linted
     * away as dead markup. Asserted per link rather than once, because the failure is
     * one link losing its subject while the rest keep theirs.
     */
    const body = bodyOf(support());
    const wrapped = [...body.matchAll(/<!--email_off-->([\s\S]*?)<!--\/email_off-->/g)]
      .map(([, inner]) => inner)
      .join('\n');
    for (const url of hrefs(support())) {
      assert.ok(wrapped.includes(url), `${url} is not wrapped in email_off`);
    }
  });

  it('is the page the app sends people to for help', () => {
    /**
     * Settings › Help & Support › Help Center opens a URL from `src/lib/legal.ts`. If
     * that path and this page's directory ever disagree, the app's only in-product
     * route to help is a 404 that nothing on either side reports.
     */
    const legal = readFileSync(join(here, '..', 'src', 'lib', 'legal.ts'), 'utf8');
    const url = /support: '([^']+)'/.exec(legal)?.[1];
    assert.ok(url, 'src/lib/legal.ts no longer publishes a support URL');
    assert.strictEqual(new URL(url).pathname, '/support');
  });

  it('reaches every surface a consumer app has to publish', () => {
    /**
     * The store forms take a privacy URL, a support URL and an account-deletion URL,
     * and Apple's reviewers follow them. Somebody who lands on the support page has to
     * be able to get to the other three and to a general address without going back to
     * a search engine.
     */
    const html = support();
    for (const path of ['/privacy', '/terms', '/account-deletion']) {
      assert.match(html, new RegExp(`href="${path}"`), `the support page does not link ${path}`);
    }
    assert.match(html, /hello@bingd\.app/, 'the general contact address is missing');
  });

  it('promises no support operation that does not exist', () => {
    /**
     * One person reads this mailbox. Every phrase below implies otherwise, and each is
     * what a template supplies by default: a queue somebody can check, a chat widget, a
     * reply time, a team. The first person to test one finds out, and what they find
     * out is that the rest of the page might be written the same way.
     */
    const body = bodyOf(support());
    for (const phrase of [
      /submit a ticket/i,
      /ticket number/i,
      /support team/i,
      /live chat/i,
      /knowledge ?base/i,
      /help ?desk/i,
      /within \d+ (?:hours|business days|days)/i,
      /we (?:will|aim to) (?:reply|respond) within/i,
      /24[/ ]?7/,
    ]) {
      assert.doesNotMatch(body, phrase, `the support page promises "${phrase}"`);
    }
  });

  it('carries no em dash, and no date it would have to be trusted to keep', () => {
    /**
     * Two founder rules, both about how the page reads rather than what it says.
     *
     * The em dash is a house style decision for this page's copy (the policy documents
     * keep theirs). The stamp is the more consequential one: the other three documents
     * date themselves because a reader needs to know which version they are looking at,
     * and a support page that says "last updated" six weeks ago answers a question
     * nobody asked with the fact most likely to stop somebody writing in.
     */
    const body = bodyOf(support());
    assert.doesNotMatch(body, /&mdash;|—/, 'an em dash reached the support copy');
    assert.doesNotMatch(body, /class="stamp"/, 'the support page grew a date stamp');
  });

  it('descends through its headings without skipping one', () => {
    /**
     * The page is read on a phone and by a screen reader, and the reader's shortcut for
     * both is the heading list. One h1, sections at h2, questions at h3, nothing jumped.
     */
    const levels = [...bodyOf(support()).matchAll(/<h([1-6])[ >]/g)].map(([, n]) => Number(n));
    assert.strictEqual(levels.filter((n) => n === 1).length, 1, 'not exactly one h1');
    assert.strictEqual(levels[0], 1, 'the page does not open on its h1');
    for (let i = 1; i < levels.length; i += 1) {
      assert.ok(levels[i] <= levels[i - 1] + 1, `h${levels[i - 1]} is followed by h${levels[i]}`);
    }
  });

  it('answers only what the build can be held to', () => {
    /**
     * Nine answers, each checkable against the code or a migration. Two candidates were
     * dropped rather than guessed and are pinned as absences, because the failure mode
     * of a help page is a confident sentence about behaviour that changed:
     *
     *   - the **match score**, whose calculation is not settled across the surfaces
     *     that show it;
     *   - **Group Picks**, merged but with its RPC undeployed, so the page would
     *     describe something nobody can reach.
     */
    const body = bodyOf(support());
    assert.doesNotMatch(body, /match score is (?:calculated|worked out)/i);
    assert.doesNotMatch(body, /Group Picks/);

    // And the answers that are there stay tied to what they were checked against.
    for (const claim of [
      /I liked it/, // BUCKET_LABEL, src/features/collection/score.ts
      /Settings &rsaquo; Account &amp; Data/, // app/settings/account.tsx
      /Settings &rsaquo; Notification Settings/, // app/settings/notification-preferences.tsx
      /not endorsed or certified by TMDB/, // the attribution TMDB's terms require
    ]) {
      assert.match(body, claim, 'an answer lost the wording it was checked against');
    }
  });
});

/**
 * The four documents are one column at every width.
 *
 * They share their stylesheet with the router, whose pages become a two-column grid at
 * 56rem so the screenshots can sit beside the pitch. A document has no second column to
 * put anything in, and until 2026-09-04 it got one anyway: `display: grid` is declared
 * only inside that media query, so the long-form override of `main` had nothing to win
 * against and reset only the width. Above 896px every heading, paragraph and list item
 * became a grid cell and the privacy policy read in two interleaved columns.
 *
 * The failure is invisible below the breakpoint and invisible to every other test here,
 * which all read the HTML. So this one reads the CSS, and asserts the reset exists at
 * the same breakpoint the grid is declared at — because the grid rule moving is the way
 * this comes back.
 */
describe('the documents\' layout', () => {
  const read = (...parts) => readFileSync(join(dist, ...parts), 'utf8');

  it('cancels the router\'s two-column grid at the width it is declared', () => {
    const source = readFileSync(join(here, 'build.mjs'), 'utf8');
    const grid = /@media \(min-width: (\d+rem)\) \{[^}]*?body \{ display: block; padding-top/.exec(
      source,
    );
    assert.ok(grid, "the router's wide-screen block is no longer recognisable");
    const breakpoint = grid[1];

    for (const dir of ['privacy', 'terms', 'support', 'account-deletion']) {
      const css = read(dir, 'index.html');
      const reset = new RegExp(
        `@media \\(min-width: ${breakpoint}\\) \\{\\s*main \\{ display: block;`,
      );
      assert.match(css, reset, `/${dir} inherits the router's grid above ${breakpoint}`);

      // And the reset has to come after the rule it cancels, or it does nothing.
      assert.ok(
        css.lastIndexOf('grid-template-columns: 26rem 1fr') <
          css.search(new RegExp(`@media \\(min-width: ${breakpoint}\\) \\{\\s*main \\{ display: block;`)),
        `/${dir} declares its reset before the grid it undoes`,
      );
    }
  });
});

/**
 * The account-deletion page, which is the one document a person follows like a recipe.
 *
 * Apple requires an in-app deletion path and a URL describing it, and a reviewer walks
 * the steps. Until 2026-09-04 this page listed three steps and the middle control was
 * missing: it said to type the handle and then tap **Delete for good**, which is the
 * confirmation dialog's button, not the one on the screen. Somebody typing their handle
 * and looking for that label finds **Delete my account** instead and reasonably
 * concludes the page describes a different version of the app.
 *
 * Both labels come from `app/settings/account.tsx`, so the test reads them from there
 * rather than repeating them, which is the difference between checking the page against
 * itself and checking it against the screen.
 */
describe('the account-deletion page', () => {
  const read = (...parts) => readFileSync(join(dist, ...parts), 'utf8');

  it('names the controls the screen actually shows, in the order it shows them', () => {
    const screen = readFileSync(join(here, '..', 'app', 'settings', 'account.tsx'), 'utf8');
    const button = /label=\{busy \? '[^']*' : '([^']+)'\}/.exec(screen)?.[1];
    const confirm = /text: '([^']+)',\s*\n\s*style: 'destructive'/.exec(screen)?.[1];
    assert.ok(button, 'the deletion screen no longer declares its button label');
    assert.ok(confirm, 'the deletion screen no longer declares its destructive action');

    const html = read('account-deletion', 'index.html');
    const steps = html.slice(html.indexOf('<h2>How</h2>'), html.indexOf('<h2>What is deleted'));

    assert.ok(steps.includes(button), `the page never names the "${button}" button`);
    assert.ok(steps.includes(confirm), `the page never names the "${confirm}" confirmation`);
    assert.ok(
      steps.indexOf(button) < steps.indexOf(confirm),
      'the page lists the confirmation before the button that raises it',
    );
    assert.match(steps, /Settings &rsaquo; Account &amp; Data/, 'the route to the screen is gone');
  });

  it('sends a locked-out person to the support address rather than the general one', () => {
    /**
     * The one deletion route that is not in the app. It is a support request and it now
     * arrives under a support subject, which is what tells it apart from the general
     * mail the front page and the policies collect.
     */
    const html = read('account-deletion', 'index.html');
    const paragraph = /If you cannot get into the app[\s\S]*?<\/p>/.exec(html)?.[0];
    assert.ok(paragraph, 'the page no longer says what to do when the app cannot be opened');
    assert.match(paragraph, /mailto:support@bingd\.app\?subject=/);
  });
});

/**
 * The release mode, which is the switch the whole public launch turns on.
 *
 * These run against the *built* site, so they assert the state that would actually be
 * deployed if this commit were pushed — which is the only version of this question
 * worth answering. `web/mutation-check.mjs` covers the other direction.
 */
describe('the release mode', () => {
  const distribution = JSON.parse(
    readFileSync(join(here, 'distribution.config.json'), 'utf8'),
  );
  const read = (...parts) => readFileSync(join(dist, ...parts), 'utf8');

  /**
   * **The lock, stated as a test.**
   *
   * Bingd is not public today. A commit that flips this to "public" while the store
   * URLs are still null cannot build at all — but a commit that flips it *and* invents
   * URLs would build, and this is the line that says the decision is deliberate. It
   * fails on launch day and is updated then, by somebody who meant to.
   */
  it('is still beta, because the apps are not on the stores', () => {
    assert.equal(
      distribution.mode ?? 'beta',
      'beta',
      'mode is no longer beta — if the apps really have launched, update this test with the commit that launched them',
    );
  });

  it('keeps the closed test honestly described while it is a closed test', () => {
    assert.match(read('index.html'), /closed testing/, 'the front page must say so');
    assert.match(read('i.html'), /closed testing/, 'the invitation page must say so');
  });

  /**
   * The two halves of noindex, which must agree.
   *
   * The header covers the JSON files and anything not HTML; the meta tag survives a
   * host that drops custom headers. Both come from one `isPublic`, and this asserts
   * they landed together rather than one of them being edited alone.
   */
  it('asks not to be indexed, in the header and in the pages', () => {
    assert.match(read('_headers'), /X-Robots-Tag: noindex, nofollow/);
    for (const file of ['index.html', 'i.html', 'u.html']) {
      assert.match(
        read(file),
        /<meta name="robots" content="noindex, nofollow" \/>/,
        `${file} is missing the robots meta`,
      );
    }
    assert.match(read('terms', 'index.html'), /<meta name="robots"/);
  });

  /**
   * Store URLs are null, and the copy must not have got ahead of them.
   *
   * The failure this prevents is subtle and would ship silently: a page that says
   * "download it from the App Store" over a button whose destination is null renders a
   * dead control and reads as a broken product rather than an unlaunched one.
   */
  it('promises no store while no store URL exists', () => {
    assert.equal(distribution.ios?.storeUrl ?? null, null);
    assert.equal(distribution.android?.storeUrl ?? null, null);
    for (const file of ['index.html', 'i.html', 'u.html', 'title.html', 'lists.html']) {
      assert.doesNotMatch(
        read(file),
        /apps\.apple\.com|play\.google\.com\/store/,
        `${file} names a store that has no URL configured`,
      );
    }
  });
});

/**
 * The public build, exercised for real — in a sandbox, one launch input at a time.
 *
 * Everything above asserts the beta; nothing there can answer the adversarial
 * question, which is what a `mode: "public"` build would actually publish. An
 * independent review answered it by hand and found a hole: fill in the entity, set
 * both store URLs, flip the mode, and the site would have shipped a Terms whose first
 * paragraph still called itself an unreviewed draft.
 *
 * So this copies the site's sources into a scratch directory, applies the launch
 * commit's edits step by step, and runs the real `build.mjs` there. The working tree
 * is never touched, which is what lets these run beside the beta assertions.
 */
describe('the public build, in a sandbox', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'bingd-public-build-'));
  const sandboxDist = join(sandbox, 'dist');

  const patch = (file, edits) => {
    let source = readFileSync(join(sandbox, file), 'utf8');
    for (const [from, to] of edits) source = source.replace(from, to);
    writeFileSync(join(sandbox, file), source);
  };

  /** Runs the sandbox build; returns what it refused with, or null on success. */
  const build = () => {
    try {
      execFileSync(process.execPath, [join(sandbox, 'build.mjs')], { stdio: 'pipe' });
      return null;
    } catch (error) {
      return String(error.stderr);
    }
  };

  before(() => {
    for (const file of ['build.mjs', 'deep-links.config.json', 'distribution.config.json']) {
      cpSync(join(here, file), join(sandbox, file));
    }
    cpSync(join(here, 'src'), join(sandbox, 'src'), { recursive: true });

    // The launch commit's first edit: the mode, with both store URLs real.
    patch('distribution.config.json', [
      ['"mode": "beta"', '"mode": "public"'],
      ['"storeUrl": null', '"storeUrl": "https://apps.apple.com/app/id0000000000"'],
      ['"storeUrl": null', '"storeUrl": "https://play.google.com/store/apps/details?id=app.bingd"'],
    ]);
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('refuses while the draft status stands, whatever else is settled', () => {
    const refusal = build();
    assert.ok(refusal, 'the build must refuse public with the legal inputs unresolved');
    assert.match(refusal, /TERMS_STATUS is still "draft"/);
    // And refused before writing anything: a partial dist/ holding public-mode
    // _headers — no noindex — from a failed build is the half-deploy the gate's
    // ordering exists to prevent.
    assert.ok(!existsSync(sandboxDist), 'a refused build must write no output');
  });

  it('still refuses with the entity settled, because settling it is not a legal read', () => {
    /**
     * This step used to patch the placeholder to "Example Operator" first. Since
     * 2026-09-04 the entity is settled in the source, so there is nothing to patch and
     * the patch was removed rather than left as a silent no-op: `patch` does a plain
     * `String.replace`, which finds nothing and writes the file back unchanged, and a
     * test whose setup quietly stopped happening is worse than one that was deleted.
     *
     * The assertion is the one that mattered and is now checked against the real
     * source: **a named operator does not open the gate.** TERMS_STATUS is what does,
     * and it is a record that a lawyer read the document.
     */
    const refusal = build();
    assert.ok(refusal, 'a settled entity alone must not open the gate');
    assert.match(refusal, /TERMS_STATUS is still "draft"/);
    assert.ok(!existsSync(sandboxDist), 'a refused build must write no output');
  });

  it('builds once the Terms is final, and ships no draft language anywhere', () => {
    patch('build.mjs', [["const TERMS_STATUS = 'draft';", "const TERMS_STATUS = 'final';"]]);

    assert.equal(build(), null, 'the full launch commit must build');

    const terms = readFileSync(join(sandboxDist, 'terms', 'index.html'), 'utf8');
    assert.doesNotMatch(terms, /Draft for review/);
    assert.doesNotMatch(terms, /not yet (?:been )?reviewed by a\s+lawyer/);
    assert.doesNotMatch(terms, /FOUNDER TO CONFIRM/);
    assert.match(terms, /Suraj Kandukuri/, 'the settled operator must be the one named');
    // And a launch build must not quietly acquire a company either.
    assert.doesNotMatch(terms, /FourwardStudios[^.<]{0,20}\b(?:LLC|Inc|Ltd|Corp)\b/i);

    // And the launch state around it is the one the flag promises.
    const headers = readFileSync(join(sandboxDist, '_headers'), 'utf8');
    assert.doesNotMatch(headers, /X-Robots-Tag: noindex/);
    const front = readFileSync(join(sandboxDist, 'index.html'), 'utf8');
    assert.doesNotMatch(front, /closed testing/);
    assert.doesNotMatch(front, /<meta name="robots"/);
  });
});

/**
 * `_headers` is the only part of this site that is not code and cannot be run, and it
 * is also the part with the most expensive silent failure in it — see the JSON typing
 * test above. These are the rest of its guarantees, pinned so that editing the file
 * has to be deliberate.
 */
describe('_headers', () => {
  const headers = readFileSync(join(dist, '_headers'), 'utf8');

  /** The directives under one `_headers` rule, as a map. */
  const rule = (pattern) => {
    const block = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n((?: +.*\\r?\\n?)*)`, 'm');
    const body = block.exec(headers)?.[1] ?? '';
    return Object.fromEntries(
      body
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          const at = line.indexOf(':');
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );
  };

  it('refuses to be framed, by both the header browsers read and the one proxies do', () => {
    // A store button rendered under somebody else's chrome sends a person to an
    // install they did not choose, on the one domain an invitation taught them to
    // trust. Nothing on this site is worth a session-riding attack; this is about the
    // page being presented as something it is not.
    const site = rule('/*');
    assert.match(site['Content-Security-Policy'] ?? '', /frame-ancestors 'none'/);
    assert.equal(site['X-Frame-Options'], 'DENY');
  });

  it('pins the base URI and form action, which are the two the pages never set', () => {
    const site = rule('/*');
    assert.match(site['Content-Security-Policy'], /base-uri 'none'/);
    assert.match(site['Content-Security-Policy'], /form-action 'none'/);
  });

  it('states HSTS rather than depending on .app being preloaded', () => {
    const site = rule('/*');
    assert.match(site['Strict-Transport-Security'] ?? '', /max-age=\d{7,}/);
  });

  it('adds no directive that can stop the page painting its buttons', () => {
    /**
     * The guard on this file, and the reason the policy is three directives rather
     * than nine.
     *
     * `script-src`, `style-src` and `default-src` are the ones that fail *quietly*: the
     * page still renders, `page.mjs` is simply never executed, and what a visitor sees
     * is a card with no install button — which is exactly what the site shows when no
     * destination is configured, its honest state today. Nothing in this repository can
     * tell those two apart, because there is no browser here to run the policy.
     *
     * So a loading directive may not be added from a test run. It may be added with a
     * real browser pointed at a real deploy, and this assertion changed in the same
     * commit that proves it.
     */
    const policy = rule('/*')['Content-Security-Policy'] ?? '';
    for (const directive of ['default-src', 'script-src', 'style-src', 'font-src', 'connect-src', 'img-src']) {
      assert.doesNotMatch(
        policy,
        new RegExp(`(^|;)\\s*${directive}\\b`),
        `${directive} governs whether something loads and cannot be verified without a browser`,
      );
    }
  });

  it('keeps noindex on everything, including the files that are not HTML', () => {
    // A /u/<handle> route that Google indexed would publish a list of Bingd's members,
    // which no privacy setting in the app could then take back. A header rather than a
    // meta tag, so it also covers the two .well-known files.
    assert.equal(rule('/*')['X-Robots-Tag'], 'noindex, nofollow');
    assert.equal(rule('/*')['X-Content-Type-Options'], 'nosniff');
  });
});
