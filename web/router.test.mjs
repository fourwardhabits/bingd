import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

  it('carries the friend-beta install destinations for both platforms', () => {
    // These are the two links behind every button on the invitation page. Pinned as
    // exact values: a typo here is a store button that 404s on a page a friend was
    // sent, and nothing else in the build would catch it.
    const invite = read('i', 'index.html');
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

  it('serves the three documents the stores demand a URL for', () => {
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
      ['support', /Support/, new RegExp('hello@bingd\\.app')],
      ['account-deletion', /Deleting your account/, /Settings &rsaquo; Account &amp; Data/],
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

  it('lets no store document be claimed by the app', () => {
    /**
     * The other half. These pages have no screen behind them, so a claim on any of them
     * means Android or iOS opens Bingd onto `+not-found` when a reviewer taps the very
     * link the store listing published. The Android manifest claimed the entire host
     * until the same day these pages were written, which is exactly how that would have
     * happened.
     */
    const documents = ['privacy', 'support', 'account-deletion'];
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
