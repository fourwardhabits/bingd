import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  allDestinations,
  appLinkFor,
  destinationFor,
  detectPlatform,
  handleFromPath,
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
      assert.ok(read(path, 'index.html').includes('<html'), `no page is served for /${path}/*`);
      assert.match(rewrites, new RegExp(`^/${path}/\\*\\s`, 'm'), `no rewrite for /${path}/*`);
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

  it('ships the router the tests just exercised, unmodified', () => {
    assert.equal(read('router.mjs'), readFileSync(join(here, 'src', 'router.mjs'), 'utf8'));
  });

  it('carries no distribution destination today, and says so', () => {
    const invite = read('i', 'index.html');
    const config = JSON.parse(
      /<script type="application\/json" id="bingd-config">(.*?)<\/script>/s.exec(invite)[1],
    );
    assert.equal(config.page, 'invite');
    assert.equal(config.distribution.ios.betaUrl, null);
    assert.equal(config.distribution.android.optInUrl, null);
    assert.equal(config.distribution.app.scheme, 'bingd');
    assert.match(invite, /not open for this device yet/);
  });

  it('drops the $comment prose rather than shipping it to every visitor', () => {
    const invite = read('i', 'index.html');
    assert.doesNotMatch(invite, /\$comment/);
    assert.doesNotMatch(invite, /TestFlight link, of the form/);
  });

  it('tells the invited visitor what the store round trip costs them', () => {
    // The deferred-install limitation, said to the person it affects rather than only
    // in a document. Without it somebody installs from TestFlight, launches from the
    // home screen, and silently loses the invitation.
    const invite = read('i', 'index.html');
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
    for (const file of ['i/index.html', 'u/index.html', 'title/index.html', 'page.mjs', 'router.mjs']) {
      const source = read(...file.split('/'));
      assert.doesNotMatch(source, /location\.search|URLSearchParams|document\.referrer/);
      assert.doesNotMatch(source, /location\.href\s*=/);
      assert.doesNotMatch(source, /innerHTML/);
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
