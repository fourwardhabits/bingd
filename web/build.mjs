#!/usr/bin/env node
/**
 * Builds the static site for bingd.app.
 *
 * Two jobs, and the second one is new as of the invitation resolver.
 *
 * **1. The two files that let a tapped link open the app instead of the browser.**
 * Generated rather than committed by hand: both repeat the same identifiers in
 * different shapes, Apple's needs a team prefix that Android's does not, and a mistake
 * in either is invisible. There is no error message when an Apple App Site Association
 * file is malformed — iOS fetches it, fails to parse it, and links quietly keep opening
 * Safari. So the identifiers live in one JSON file and this script refuses to produce
 * output while any of them is missing.
 *
 * **2. The router.** Four pages that answer *you have arrived at a Bingd link and you
 * do not have Bingd*. They exist because a Universal Link that cannot open the app
 * falls back to the web, and what was there before was a single page that said Bingd is
 * in closed testing — which is a dead end for the one visitor who was actually invited.
 *
 * The router is not a marketing site and must not become one. Each page is: what this
 * link is, one dominant install button, and a way to open the app if it is already
 * there. Everything that decides anything is in `src/router.mjs`, which
 * `web/router.test.mjs` runs directly.
 */

import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

const config = JSON.parse(await readFile(join(here, 'deep-links.config.json'), 'utf8'));
const distribution = JSON.parse(await readFile(join(here, 'distribution.config.json'), 'utf8'));

const problems = [];

if (!config.appleTeamId) {
  problems.push(
    'appleTeamId is not set. App Store Connect > Membership Details > Team ID (10 characters).',
  );
} else if (!/^[A-Z0-9]{10}$/.test(config.appleTeamId)) {
  problems.push(`appleTeamId "${config.appleTeamId}" is not 10 uppercase alphanumerics.`);
}

const withFingerprints = config.variants.filter((v) => v.androidSha256.length > 0);

// A missing Android fingerprint is not an error, because it cannot be obtained
// until an Android build exists and the site should not be blocked on that. It is a
// warning, and assetlinks.json is written with an empty statement list.
//
// Writing it empty rather than omitting it is deliberate, and the first attempt got
// this wrong. Omitting the file is only safe if the host answers a missing path with
// a 404; Cloudflare Pages instead falls back to index.html with a 200, and the
// Content-Type rule in _headers then labelled that HTML as application/json. A
// crawler or a debugging session sees a 200 and well-formed-looking headers, and the
// actual problem is invisible. An empty array is valid JSON, correctly typed, and
// reads unambiguously as "no packages are declared here".
for (const variant of config.variants) {
  for (const fingerprint of variant.androidSha256) {
    if (!/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(fingerprint)) {
      problems.push(
        `${variant.name}: "${fingerprint}" is not a SHA-256 fingerprint. Expected 32 ` +
          'colon-separated uppercase hex pairs.',
      );
    }
  }
}

/**
 * Distribution URLs are checked for *shape* and never for presence.
 *
 * Null is the correct value today — no TestFlight link exists — and a build that
 * refused it would block the site on a thing that is not ready. What is refused is a
 * URL that is set and wrong: anything that is not `https://`, because every one of
 * these becomes the destination of a button on a page people reach from an invitation,
 * and that is the single most valuable place in this project to plant a link somewhere
 * else.
 */
const DESTINATIONS = [
  ['ios.betaUrl', distribution.ios?.betaUrl],
  ['ios.storeUrl', distribution.ios?.storeUrl],
  ['android.optInUrl', distribution.android?.optInUrl],
  ['android.betaUrl', distribution.android?.betaUrl],
  ['android.storeUrl', distribution.android?.storeUrl],
];

for (const [name, value] of DESTINATIONS) {
  if (value == null) continue;
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+\//i.test(value)) {
    problems.push(
      `distribution.config.json ${name} is "${value}", which is not an absolute https URL.`,
    );
  }
}

if (distribution.app?.scheme && !/^[a-z][a-z0-9+.-]*$/.test(distribution.app.scheme)) {
  problems.push(`distribution.config.json app.scheme "${distribution.app.scheme}" is not a scheme.`);
}

/**
 * Which Bingd this build is describing.
 *
 * `beta` is the default in every sense that matters: an unset, misspelt or missing
 * value resolves to it, because the failure modes are not symmetric. A site that
 * wrongly says "in closed testing" is a day of stale copy; a site that wrongly says
 * the app is on the App Store sends people to a store page that does not exist and
 * asks Google to keep the claim.
 *
 * **`public` is refused while either store URL is null**, and that lock is the whole
 * reason the mode is safe to leave in the repository. Flipping the flag alone cannot
 * publish launch copy: the URLs the copy promises have to exist first, and they cannot
 * exist before the apps are approved. So the code can be merged, reviewed and sat on
 * until T4/T5 without any window in which pushing it makes bingd.app lie.
 */
/**
 * The placeholder a legal identity goes in.
 *
 * **Deliberately not filled in, and deliberately loud.** A Terms of Use has to name who
 * the agreement is with, and Bingd's answer to that is a decision the founder has not
 * made and this repository holds no evidence of: whether there is a company, what it is
 * called, and where it is registered are facts rather than defaults. Inventing a
 * plausible one — "Bingd Ltd", a jurisdiction picked because it is common — would
 * produce a document that reads as finished and names a party that does not exist,
 * which is worse than an obviously unfinished one.
 *
 * So it renders in the page, in capitals, where neither the founder nor a store
 * reviewer can miss it. web/router.test.mjs asserts it is still present, which turns
 * "remember to fill this in" into a failing test on the day it stops being true.
 */
const LEGAL_ENTITY = '[LEGAL ENTITY / DEVELOPER NAME &mdash; FOUNDER TO CONFIRM]';

/**
 * Where the Terms of Use is in its life: 'draft' or 'final'.
 *
 * A second launch input beside LEGAL_ENTITY, and it exists because the entity check
 * alone had a hole an independent review walked straight through: fill in the entity,
 * set both store URLs, flip the mode — and the site would have published a Terms that
 * names a real party while its own first paragraph still said the document was an
 * unreviewed draft. The most contradictory possible state for exactly that paragraph.
 *
 * So the draft language and this constant are the same fact. While it says 'draft',
 * the page carries the draft-for-review notice and the stamp says so — which is the
 * honest beta state. The build refuses `public` until it says 'final', and 'final' is
 * a word the founder writes deliberately, after L-1 in the risk register is settled:
 * entity confirmed, governing-law decision made, a lawyer has read it. Setting it
 * final is what removes the draft language, so the two can never disagree.
 *
 * Do not set this 'final' to make a build pass. It is the record that legal review
 * happened, and a record written to silence a gate is worse than no record.
 */
const TERMS_STATUS = 'draft';

if (!['draft', 'final'].includes(TERMS_STATUS)) {
  problems.push(`TERMS_STATUS is "${TERMS_STATUS}", which is not 'draft' or 'final'.`);
}

const MODES = ['beta', 'public'];
const mode = distribution.mode ?? 'beta';

if (!MODES.includes(mode)) {
  problems.push(
    `distribution.config.json mode is "${distribution.mode}", which is not one of ${MODES.join(', ')}.`,
  );
}

if (mode === 'public') {
  for (const [name, value] of [
    ['ios.storeUrl', distribution.ios?.storeUrl],
    ['android.storeUrl', distribution.android?.storeUrl],
  ]) {
    if (value == null) {
      problems.push(
        `mode is "public" but ${name} is null. Public copy claims both apps are ` +
          'downloadable now; publishing that over a button with no destination is the ' +
          'one failure this refuses to ship.',
      );
    }
  }

  /**
   * The second half of the lock, and it guards a worse failure than the first.
   *
   * A store button with no destination is embarrassing. A **Terms of Use naming a party
   * that does not exist**, on a public launch, is a contract every new account is asked
   * to agree to at signup and cannot identify the other side of. The draft is entirely
   * appropriate for a closed test whose users all know the founder personally; carrying
   * it across a launch by forgetting about it is not.
   *
   * Enforced by the build rather than left to review, because that is exactly the
   * difference: the placeholder is *designed* to be conspicuous, and a conspicuous thing
   * seen every day for six weeks stops being conspicuous. The build is the reader that
   * does not acclimatise.
   *
   * **Checked here, with the other problems, rather than beside TERMS_BODY where it
   * reads more naturally.** Everything in this block runs before a single file is
   * written; a refusal further down would abort halfway, leaving `dist/` holding the
   * public-mode `_headers` — no noindex — from a build that failed. A partial deploy of
   * exactly the thing the lock exists to prevent is a poor consolation prize.
   */
  if (LEGAL_ENTITY.includes('FOUNDER TO CONFIRM')) {
    problems.push(
      'mode is "public" but the Terms of Use still carries the unconfirmed-entity ' +
        'placeholder. A public launch asks every new account to agree to it at signup, ' +
        'and it does not yet name who the agreement is with. Fill in LEGAL_ENTITY, or ' +
        'stay in beta. See L-1 in docs/release/public-launch-risk-register.md.',
    );
  }

  /**
   * And the third: the entity being filled in does not make the document reviewed.
   *
   * Without this, a launch commit could satisfy every other gate and still publish a
   * Terms whose first paragraph says "Draft for review — not yet reviewed by a
   * lawyer" to every new account being asked to agree to it. The draft language is
   * conditioned on the same TERMS_STATUS this checks, so a public build can never
   * carry it: the build that would has refused to exist.
   */
  if (TERMS_STATUS !== 'final') {
    problems.push(
      'mode is "public" but TERMS_STATUS is still "draft". The Terms page would tell ' +
        'every new account it is agreeing to an unreviewed draft. Settle L-1 in ' +
        'docs/release/public-launch-risk-register.md, have the document read, and set ' +
        "TERMS_STATUS to 'final' in the commit that records that — or stay in beta.",
    );
  }
}

/** True when the site should describe a shipped product rather than a closed test. */
const isPublic = mode === 'public';

if (problems.length > 0) {
  console.error('\nCannot build the site:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nDeploying with these missing or wrong would not break the site. It would make\n' +
      'every invitation and share link open the browser instead of the app, or send\n' +
      'somebody somewhere Bingd does not control, with no error anywhere to explain\n' +
      'why. Refusing instead.\n',
  );
  process.exit(1);
}

await mkdir(join(dist, '.well-known'), { recursive: true });
// `web/public/` is gone as of the public-launch tranche. It held exactly two files —
// `_headers` and `index.html` — and both had to become mode-aware, which a directory
// copied verbatim cannot be. They are generated below. `src/` still copies, because
// `page.mjs` and `router.mjs` are shipped as-is and are run directly by the tests.
await cp(join(here, 'src'), dist, { recursive: true });

/**
 * Cloudflare Pages headers.
 *
 * **Generated rather than committed, as of the public-launch tranche**, and for one
 * reason: `X-Robots-Tag` has to follow the release mode. It was a static file in
 * `web/public/`, which meant the single most consequential line on the site — whether
 * Google may index it — was the one line no configuration could reach. Launch day
 * would have been "remember to edit `_headers` too", and the failure of forgetting is
 * silent in the direction that matters: the site goes public and stays invisible.
 *
 * Everything else in it is unconditional and unchanged from the committed version.
 */
const headers = `# Cloudflare Pages headers.
#
# GENERATED BY web/build.mjs — edit that, not this. The robots directive below
# follows distribution.config.json's \`mode\`, which is why this file is built.

# Apple requires this file be served as JSON despite having no extension. Served
# as text/plain, iOS fetches it and silently declines to parse it, and every
# Universal Link keeps opening Safari with nothing to indicate why.
/.well-known/apple-app-site-association
  Content-Type: application/json
  Cache-Control: public, max-age=3600

/.well-known/assetlinks.json
  Content-Type: application/json
  Cache-Control: public, max-age=3600

# Everything on the site, in four parts.
#
${
  isPublic
    ? `# INDEXING IS ON. mode is "public", so no X-Robots-Tag is sent and the pages carry
# no robots meta either. This is the launch state and it is not quietly reversible:
# a /u/<handle> route that Google has indexed has published a list of Bingd's members,
# and no privacy setting in the app can take that back afterwards. The router pages
# name no account — the handle is read from the URL by the browser and never rendered
# server-side — which is what makes indexing them safe at all.`
    : `# The closed beta is noindex by founder decision (decision log §3). Set as a header
# rather than a meta tag so it also covers the JSON files and anything served that is
# not HTML. It lifts when distribution.config.json's mode becomes "public", which the
# build refuses until both store URLs exist.`
}
#
# bingd.app is the domain an invitation teaches people to trust, which makes it the
# one worth framing inside somebody else's page. Nothing here is clickable into an
# account, so this is not a session-riding risk — it is that a store button rendered
# under another site's chrome sends somebody to an install they did not choose. Both
# framing headers, because the older one is what some corporate proxies enforce.
#
# .app is HSTS-preloaded at the top level, so browsers already refuse plain HTTP
# here. Strict-Transport-Security is stated anyway: preloading is a property of the
# TLD rather than of this site, and not a thing to depend on silently.
#
# Deliberately no script-src, style-src or default-src. Those belong in the security
# tranche, with a real browser to check them in. A wrong script-src does not fail
# loudly — the page still renders and the buttons are simply never painted, which is
# indistinguishable from no install destination being configured, the site's honest
# empty state today. The three directives below cannot cause that, because none of
# them governs whether something loads. What would otherwise justify a strict policy
# is already true by construction and tested in web/router.test.mjs: no innerHTML, no
# destination read out of the URL, and no third-party origin on any page beyond the
# font host the app already uses.
/*
${isPublic ? '' : '  X-Robots-Tag: noindex, nofollow\n'}  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; form-action 'none'
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000; includeSubDomains

# The router's two modules. Cloudflare Pages types .mjs correctly today; stated
# anyway, because a module served as text/plain is refused by the browser outright
# and the page then renders with no buttons at all — which looks exactly like the
# install destinations not being configured.
/*.mjs
  Content-Type: text/javascript; charset=utf-8
  Cache-Control: public, max-age=300
`;

await writeFile(join(dist, '_headers'), headers);

/**
 * Apple. `applinks` claims the paths; `webcredentials` is what lets the keychain
 * offer a saved password and is required for Sign in with Apple's associated
 * domain to behave. Every variant is listed, because a development build has its
 * own bundle identifier and would otherwise be the one place links do not work —
 * which is exactly where they get tested.
 */
const appleAppIds = config.variants.map((v) => `${config.appleTeamId}.${v.bundleId}`);

const aasa = {
  applinks: {
    details: [
      {
        appIDs: appleAppIds,
        components: config.appPaths.map((path) => ({
          '/': path,
          comment: 'Opens in the app when installed',
        })),
      },
    ],
  },
  webcredentials: { apps: appleAppIds },
};

// No file extension, by Apple's requirement. The content type is set in _headers.
await writeFile(
  join(dist, '.well-known', 'apple-app-site-association'),
  `${JSON.stringify(aasa, null, 2)}\n`,
);

/**
 * Android. One statement per package, and a package may list several fingerprints,
 * which is the normal case: the upload key and the Play app-signing key differ
 * whenever Play re-signs.
 */
const assetlinks = withFingerprints.map((variant) => ({
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: variant.bundleId,
    sha256_cert_fingerprints: variant.androidSha256,
  },
}));

await writeFile(
  join(dist, '.well-known', 'assetlinks.json'),
  `${JSON.stringify(assetlinks, null, 2)}\n`,
);

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * Supabase, for the one call the invitation page makes.
 *
 * Read from the environment and **optional**. Absent, the page still renders and
 * simply records no open, which is what a local `npm run build:web` does. The anon key
 * is public by construction — it is in the mobile bundle already, and it is bounded by
 * row level security — so there is no secret here to leak by baking it in.
 */
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? null;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? null;

/**
 * The distribution config with its `$comment` keys dropped.
 *
 * They are documentation for whoever edits the file and are several hundred bytes of
 * prose per page otherwise. Stripped rather than kept: what ships should be what the
 * page reads.
 */
const stripComments = (value) => {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('$'))
        .map(([key, inner]) => [key, stripComments(inner)]),
    );
  }
  return value;
};

const shippedDistribution = stripComments(distribution);

/**
 * `</script>` inside a JSON block would close the tag it is written in. Nothing in
 * these values can currently contain one — they are URLs from a committed file — but
 * the escape costs nothing and the failure it prevents is script injection into every
 * page of the site.
 */
const jsonBlock = (value) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

const styles = `
      /* Values copied from src/ui/tokens/color.ts. The app is the source of truth;
         these pages do not justify a build step to share them. */
      :root {
        --parchment: #f5ebdd;
        --raised: #fcf6ec;
        --maroon: #773744;
        --ink: #242326;
        --secondary: #5f5a56;
        --hairline: rgba(36, 35, 38, 0.08);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 2rem 1.5rem;
        background: var(--parchment);
        color: var(--ink);
        font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      main { max-width: 26rem; width: 100%; text-align: center; }

      h1 {
        margin: 0 0 0.5rem;
        font-family: 'DM Serif Display', Georgia, serif;
        font-size: clamp(2.5rem, 11vw, 3.75rem);
        font-weight: 400;
        letter-spacing: -0.01em;
        color: var(--maroon);
      }

      .tagline {
        margin: 0 0 2rem;
        font-family: 'DM Serif Display', Georgia, serif;
        font-style: italic;
        font-size: clamp(1.05rem, 4.5vw, 1.3rem);
        line-height: 1.4;
      }

      .card {
        background: var(--raised);
        border: 1px solid var(--hairline);
        border-radius: 0.75rem;
        padding: 1.5rem;
        box-shadow: 0 1px 2px rgba(36, 35, 38, 0.06);
        text-align: left;
      }

      p { margin: 0 0 0.75rem; font-size: 0.975rem; line-height: 1.6; color: var(--secondary); }
      p:last-child { margin-bottom: 0; }

      .subject {
        font-family: 'DM Serif Display', Georgia, serif;
        font-size: 1.35rem;
        color: var(--ink);
        margin: 0 0 1.25rem;
        word-break: break-word;
      }

      /* One dominant action, and a quieter one under it. Tap targets are 48px so a
         thumb on a phone is the case being designed for. */
      .actions { display: grid; gap: 0.625rem; margin-top: 1.5rem; }

      a.button {
        display: block;
        min-height: 48px;
        padding: 0.875rem 1.25rem;
        border-radius: 0.625rem;
        background: var(--maroon);
        color: var(--raised);
        font-size: 1rem;
        font-weight: 500;
        text-decoration: none;
      }

      a.button.secondary {
        background: transparent;
        color: var(--maroon);
        border: 1px solid var(--maroon);
      }

      [hidden] { display: none !important; }

      footer { margin-top: 2rem; font-size: 0.8125rem; color: var(--secondary); }
      footer a { color: var(--maroon); text-underline-offset: 2px; }
`;

/**
 * The robots meta tag, or nothing.
 *
 * Belt to `_headers`' braces while the beta is closed — the header covers the JSON
 * files too, and the meta tag survives a host that drops custom headers. Both come
 * from the same `isPublic`, so they cannot disagree, which is the failure a second
 * hardcoded copy of this decision would eventually produce.
 */
const ROBOTS = isPublic ? '' : '\n    <meta name="robots" content="noindex, nofollow" />';

/**
 * One page.
 *
 * `noindex` while the test is closed, by founder decision (decision log §3) — a
 * `/u/<handle>` route that Google indexed would publish a list of Bingd's members,
 * which is a thing no privacy setting in the app would then be able to take back. It
 * lifts with the release mode and not before.
 */
const page = ({ title, kind, heading, tagline, body }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>${ROBOTS}
    <meta name="referrer" content="no-referrer" />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500&display=swap"
      rel="stylesheet"
    />

    <style>${styles}</style>
  </head>

  <body>
    <main>
      <h1>Bingd</h1>
      <p class="tagline">${tagline}</p>

      <div class="card">
${body}

        <div class="actions">
          <a class="button" id="primary-install" hidden href="#"></a>

          <span id="desktop-choices" hidden>
            <a class="button" id="install-ios" hidden href="#"></a>
            <a class="button" id="install-android" hidden href="#"></a>
          </span>

          <a class="button secondary" id="open-app" hidden href="#"></a>
        </div>

        <p id="no-destination" hidden>
          ${isPublic ? 'Bingd is not available for this device yet.' : 'The Bingd beta is not open for this device yet.'} ${heading}
        </p>
      </div>

      <footer>
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> &middot;
        <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a> &middot;
        <a href="/support">Support</a>
      </footer>
    </main>

    <script type="application/json" id="bingd-config">${jsonBlock({
      page: kind,
      distribution: shippedDistribution,
      supabaseUrl,
      supabaseAnonKey,
    })}</script>
    <script type="module" src="/page.mjs"></script>
  </body>
</html>
`;

/**
 * The invitation page's copy, which is the only copy on this site anybody will read
 * twice.
 *
 * The second paragraph is the deferred-install limitation, stated to the person it
 * affects rather than only in a document. It is there because the alternative is
 * somebody installing from TestFlight, launching Bingd from their home screen, and
 * silently losing the invitation with nothing anywhere to say what happened.
 */
/**
 * The invitation's second paragraph, which is the deferred-install limitation stated to
 * the person it affects rather than only in a document.
 *
 * It survives public launch, and the wording is the only part that moves. Bingd
 * deliberately implements no deferred attribution — no Branch, no AppsFlyer, no Install
 * Referrer — so an invitation genuinely does not follow somebody through a store
 * install, and the page has to say so in both modes. What changes is the name of the
 * thing they installed from: "TestFlight or Play" is meaningless to somebody who tapped
 * an App Store button.
 */
const INVITE_RETURN = isPublic
  ? `          <p>
            <strong>After installing Bingd, come back to this page</strong> and tap
            &ldquo;I already have Bingd&rdquo; to finish connecting with your friend.
            Opening the app straight from the store works too, but the invitation will
            not follow you there.
          </p>`
  : `          <p>
            <strong>Come back to this page once Bingd is installed</strong> and tap
            &ldquo;I already have Bingd&rdquo;. Opening the app straight from TestFlight
            or Play works too, but the invitation will not follow you there.
          </p>`;

const INVITE_BODY = `        <span id="invite-intro">
          <p class="subject">You have been invited to Bingd.</p>
          <p>
            Bingd is where you rank what you have watched and see what your friends
            really think.${
              isPublic
                ? ' Get it below, and this invitation connects you when you arrive.'
                : ' It is in closed testing, and this invitation is how you get in.'
            }
          </p>
${INVITE_RETURN}
        </span>
        <p id="invite-broken" hidden>
          That invitation link is incomplete &mdash; messaging apps sometimes cut long
          links in half. Ask for it again, or get Bingd below and use the link from
          inside the app.
        </p>`;

const PROFILE_BODY = `        <p class="subject" id="handle"></p>
        <p>
          This is a Bingd profile. Open it in the app to see what they have ranked and
          what they have written &mdash; a private account stays private, whichever way
          you arrive.
        </p>`;

const TITLE_BODY = `        <p class="subject">A film or series on Bingd</p>
        <p>
          Open it in Bingd to see where your friends placed it, and where you would.
        </p>`;

const GENERIC_BODY = isPublic
  ? `        <p>
          Bingd is where you rank what you have watched and see what your friends really
          think. Get it below.
        </p>`
  : `        <p>
          Bingd is in closed testing. Invitations are going out to a small first group,
          and this page will become the app&rsquo;s public face when it opens up.
        </p>`;

/**
 * The second half of an "unavailable" sentence, and each route's `heading`.
 *
 * In beta it says the test is closed, which is why a stranger who found a profile link
 * cannot get in. After launch that sentence is simply false — anybody can get in — and
 * the only remaining reason a device has no destination is a platform Bingd has not
 * shipped to. Two different facts, so two different sentences rather than one edited
 * to be vague enough for both.
 */
const UNAVAILABLE = isPublic
  ? 'Bingd is not on this platform yet.'
  : 'Bingd is in closed testing.';

/**
 * The one address in this project a stranger is told to write to.
 *
 * Both stores publish it in the listing, so it has to be a mailbox somebody reads
 * rather than a plausible-looking string. It was already in the router's footer; it is
 * a constant now because three more pages say it and a support address that differs
 * between pages is a support address people stop trusting.
 */
const SUPPORT_EMAIL = 'hello@bingd.app';

/**
 * The date on the documents.
 *
 * A literal rather than `new Date()`. A build stamp would move every time Cloudflare
 * rebuilt the site — a redeploy with no text change would claim the policy had been
 * revised, which is the one thing a date on a privacy policy is for.
 */
const DOCUMENT_DATE = '20 August 2026';

/**
 * The Terms' own date, separate from the other three documents'.
 *
 * The Terms was drafted five days after them, and a "last updated" that predates the
 * page's own existence is the kind of small wrongness that makes a reader doubt the
 * large claims around it. Also a literal, for DOCUMENT_DATE's reason.
 *
 * **This is the line to change when the Terms text changes** — most notably in the
 * commit that fills in LEGAL_ENTITY and sets TERMS_STATUS to 'final', which revises
 * the document and should say so.
 */
const TERMS_DATE = '25 August 2026';

const PRIVACY_BODY = `      <p class="lede">
        ${isPublic ? 'Bingd' : 'Bingd is a closed beta. This'} describes what it actually
        stores, why, and who else sees it &mdash; written against the database schema
        rather than from a template.
      </p>

      <h2>Who runs Bingd</h2>
      <p>
        Bingd is made by one independent developer. Questions about anything on this page,
        including a request to see or remove what is held about you, go to
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
      </p>

      <h2>What Bingd stores about you</h2>

      <h3>Your account</h3>
      <ul>
        <li>Your <strong>email address</strong>, and if you signed in with Apple or Google,
          the account identifier that provider returns. Signing in with Apple using
          &ldquo;Hide My Email&rdquo; means Bingd only ever holds the relay address.</li>
        <li>Your <strong>date of birth</strong>, used only to check that you are 13 or
          older. It is never returned by any part of the app, including to you &mdash; only
          a yes/no answer derived from it is readable.</li>
      </ul>

      <h3>Your profile</h3>
      <ul>
        <li>Your handle, display name, an optional short bio, an optional profile picture,
          and whether your account is public or private.</li>
      </ul>

      <h3>What you do in the app</h3>
      <ul>
        <li>The films and seasons you rank, log, or add to a watchlist, and the order you
          put them in.</li>
        <li>Notes and reviews you write, comments you leave, and reactions you give.</li>
        <li>Recommendations you send and receive, and who you tag as having watched
          something with you.</li>
        <li>Who you follow, who follows you, follow requests, and anyone you block.</li>
        <li>Watch goals you set.</li>
      </ul>

      <h3>Invitations</h3>
      <ul>
        <li>If you joined through an invitation link, Bingd records which account invited
          you. That is how the inviter is credited.</li>
      </ul>

      <h2>What Bingd never sends anywhere</h2>
      <p>
        Product analytics carry <strong>no</strong> free text and no content. Enforced by an
        allowlist in the code and asserted by tests, these never leave your device as
        analytics: your email, handle, display name, bio, date of birth, any film or series
        title, anything you typed into search, any note, review or comment, and any
        invitation token. Automatic capture of screens and taps is switched off and stays
        off &mdash; in a film app it would record the titles in your collection.
      </p>
      <p>
        Bingd shows no advertising, runs no advertising or attribution SDK, does not track
        you across other apps or websites, and does not sell or rent anything about you.
      </p>

      <h2>Who else sees it</h2>
      <ul>
        <li><strong>Supabase</strong> hosts the database, authentication and file storage.
          Everything above is stored there.</li>
        <li><strong>Cloudflare</strong> serves this website.</li>
        <li><strong>PostHog</strong> receives product analytics: which steps of the app
          were used, plus your account identifier, the app version and which build you are
          running. No content and no free text.</li>
        <li><strong>Sentry</strong> receives crash and error reports. Personal information
          is switched off, the user object is reduced to an account identifier, request
          bodies, cookies and query strings are stripped, and console logs are dropped.
          Error messages and stack traces are kept, because a crash report without them
          reports nothing.</li>
        <li><strong>TMDB</strong> supplies film and series information. Bingd&rsquo;s
          server asks TMDB for it; your device does not, except that <strong>posters and
          images load directly from TMDB&rsquo;s servers</strong>, which means TMDB sees the
          request the way any website you load an image from would.</li>
        <li><strong>Apple</strong> and <strong>Google</strong>, if you use their sign-in.</li>
      </ul>
      <p>
        Nobody else. There is no data broker, no advertising network and no analytics
        partner beyond the two named above.
      </p>

      <h2>Who can see your profile inside Bingd</h2>
      <p>
        A <strong>public</strong> account can be found and read by any other Bingd user. A
        <strong>private</strong> account can only be read by followers you have approved,
        and follow requests wait for your answer. Blocking someone is a barrier in both
        directions, not a filter. You can change this at any time in Settings &rsaquo;
        Privacy.
      </p>

      <h2>How long it is kept</h2>
      <p>
        Your account data is kept for as long as your account exists. Delete the account
        and it is removed &mdash; see <a href="/account-deletion">deleting your account</a>
        for exactly what goes, what is anonymised, and the one category that is kept.
        Analytics and crash reports are held by PostHog and Sentry under their own
        retention settings and are not removed by deleting your Bingd account. Both carry
        an account identifier. <strong>Analytics carry no content</strong> &mdash; that is
        enforced by the allowlist described above, not by care. <strong>Crash reports are
        the exception</strong>: the error message and stack trace are kept, for the reason
        given above, and an error message can quote something you typed.
      </p>

      <h2>Age</h2>
      <p>
        Bingd is for people aged 13 and over. An account whose date of birth is under 13 is
        refused at sign-up and nothing is retained for it.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Edit or clear your profile, bio and picture in Settings &rsaquo; Edit Profile.</li>
        <li>Make your account private in Settings &rsaquo; Privacy.</li>
        <li>Revoke your invitation link in Settings &rsaquo; Privacy, which stops it working
          for anyone who has it.</li>
        <li>Delete your account, permanently, in Settings &rsaquo; Account &amp; Data.</li>
        <li>Ask for a copy of what is held about you by writing to
          <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</li>
      </ul>

      <h2>Changes</h2>
      <p>
        If this changes in a way that affects what is collected or who sees it, the date at
        the top of this page changes. ${
          isPublic ? 'This page is the record' : 'During the closed beta this page is the record'
        }; there is no mailing list and no in-app announcement to promise you.
      </p>

      <h2>Attribution</h2>
      <p>
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>`;

const SUPPORT_BODY = `      <p class="lede">
        There is no help desk and there is no support team &mdash; there is one address,
        and one person on the other end of it.
      </p>

      <h2>Getting help</h2>
      <p>
        Write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Replies are not
        instant and there is no queue you can check; ${
          isPublic ? 'a small product run by one person' : 'a closed beta run by one person'
        } is exactly as informal as that sounds.
      </p>

      <h2>What to include</h2>
      <p>
        Almost every question is answered faster with these four things:
      </p>
      <ul>
        <li>Your Bingd handle.</li>
        <li>The <strong>version and build number</strong>, from Settings &rsaquo; scroll to
          the bottom. It reads like <em>Bingd 0.1.0 (7)</em>.</li>
        <li>Whether you are on iPhone or Android.</li>
        <li>What you tapped, what you expected, and what happened instead.</li>
      </ul>

      <h2>Things that are not faults</h2>
      <ul>
        <li><strong>Notifications are off until you turn them on.</strong> Bingd may send
          you a notification &mdash; someone commenting on your activity, a follow request,
          an award you earned &mdash; but only if you allowed notifications when the app
          asked. Everything also appears in the app&rsquo;s own inbox, so nothing is missed
          by declining. You can change which kinds are sent in Settings &rsaquo;
          Notifications, and turn them off entirely in your phone&rsquo;s own settings for
          Bingd.</li>
        <li><strong>An invitation link does not follow you through an install.</strong> If
          you install Bingd from a store or from TestFlight and open it from your home
          screen, the invitation is not carried across. Go back to the link you were sent
          and tap &ldquo;I already have Bingd&rdquo;.</li>
        <li><strong>A private account stays private from a link.</strong> Opening someone&rsquo;s
          profile link does not bypass their privacy setting.</li>
      </ul>

      <h2>Account and data</h2>
      <p>
        What is stored and who sees it is on the <a href="/privacy">privacy page</a>.
        Deleting your account is done inside the app and is explained on
        <a href="/account-deletion">this page</a>.
      </p>

      <h2>Reporting something serious</h2>
      <p>
        <strong>Reviews, comments and profiles can be reported from inside the app.</strong>
        Open the review or comment and choose Report, or use Report on somebody&rsquo;s
        profile. It reaches the person who runs Bingd, and the person you reported is
        never told who reported them.
      </p>
      <p>
        For what that does not cover &mdash; somebody impersonating you, or a security
        problem: write to
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with the word
        <strong>URGENT</strong> in the subject. Please do not post security findings
        publicly before they are fixed.
      </p>`;

const DELETION_BODY = `      <p class="lede">
        You can delete your Bingd account yourself, from inside the app, without asking
        anybody. It is immediate and it cannot be undone.
      </p>

      <h2>How</h2>
      <ul>
        <li>Open Bingd and go to <strong>Settings &rsaquo; Account &amp; Data</strong>.</li>
        <li>Type your own handle to confirm &mdash; a yes/no dialog is a mistap, and this is
          the one action in Bingd nothing can reverse.</li>
        <li>Tap <strong>Delete for good</strong>.</li>
      </ul>
      <p>
        If you cannot get into the app, write to
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> from the email address on the
        account and it will be done for you.
      </p>
      <p>
        There is no &ldquo;deactivate&rdquo;. Bingd does not offer a temporary hidden state,
        because a control that pretends to hide an account and only signs it out is worse
        than not having one. To disappear without deleting, set your account to private in
        Settings &rsaquo; Privacy.
      </p>

      <h2>What is deleted</h2>
      <p>Everything below goes, permanently:</p>
      <ul>
        <li>Your login &mdash; email address, phone if present, Apple and Google identities,
          and every signed-in session.</li>
        <li>Your profile: handle, display name, bio, privacy setting, and your date of
          birth.</li>
        <li>Your profile picture. The app deletes every image you have ever uploaded from
          file storage, and the server removes any record of them that is left. One
          residual is worth stating rather than glossing: if the storage request does not
          complete, the image file itself can remain in the bucket with nothing pointing at
          it &mdash; no link resolves to it, because the link is served from the record that
          was deleted, but the bytes sit there until an operator removes them. The app tells
          you when this has happened rather than claiming otherwise.</li>
        <li>Your whole collection: every ranking, comparison and ranking session, everything
          logged, your watchlist and your watch goals.</li>
        <li>Everything you wrote or reacted to: notes, reviews, comments, reactions and
          feed activity.</li>
        <li>Every follow in and out, every follow request, and every block.</li>
        <li>Watch tags &mdash; both the ones you applied to other people and the ones other
          people applied to you.</li>
        <li>Every notification you sent or received, and your notification settings.</li>
        <li>Any list, share link or invitation link you created.</li>
        <li>Everything derived about you: match scores and recommendation history.</li>
      </ul>

      <h2>What is kept without pointing at you</h2>
      <ul>
        <li><strong>Your released handle</strong> stays reserved &mdash; as a word and a
          date, with nothing linking it to you. Otherwise somebody else could take it and
          inherit links that used to be yours.</li>
        <li><strong>Invitation credit</strong> for people who are still here. If you invited
          someone, the record that they arrived through an invitation survives; the pointer
          to your account does not.</li>
        <li>If someone you invited is still using Bingd, their account is untouched.</li>
      </ul>

      <h2>What is kept, and is not anonymous</h2>
      <p>
        <strong>Safety records.</strong> If an account has been reported, or if a moderator
        acted on it, that report and that action are retained &mdash; including the account
        identifier and any text the reporter wrote. This is deliberate: a safety record any
        subject can erase by closing their account is not a safety record. Reports you
        <em>made</em> about other people also survive, with your identity removed from them.
      </p>

      <h2>What deletion does not reach</h2>
      <p>
        Analytics and crash reports already sent to PostHog and Sentry are held by those
        services under their own retention settings. They carry an account identifier.
      </p>
      <p>
        Analytics events carry no content of any kind &mdash; no titles, no notes, no
        search text &mdash; and that is enforced by an allowlist rather than by care.
        <strong>Crash reports are different and the difference is worth stating.</strong>
        Personal information is switched off and request bodies, cookies and query strings
        are stripped, but the error message and the stack trace are kept, because a crash
        report without them reports nothing &mdash; and an error message can in principle
        quote something you typed. See the <a href="/privacy">privacy page</a>.
      </p>`;

/**
 * Terms of Use.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * A **draft for founder and legal review**. No lawyer has read it. It is written under
 * the same rule as the privacy page — every sentence describes what the app and the
 * schema actually do — because the failure mode of a templated Terms is a promise the
 * product cannot keep, and a promise about moderation is the one most likely to be
 * tested by somebody who was harmed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT SAY
 *
 * No governing law, no venue, no arbitration clause, no company number, no address.
 * Each is a fact about a legal entity that no document in this repository establishes,
 * and a Terms that states them wrongly is worse than one that omits them — an
 * arbitration clause in particular is a substantive waiver of a user's rights, and
 * writing one on a guess is not a thing to do quietly. They are founder inputs, listed
 * as such in docs/release/.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MODERATION SECTION IS SPECIFIC
 *
 * Because the backend is. `moderation_actions` accepts exactly six actions —
 * suspend_account, restore_account, remove_content, force_username_change,
 * dismiss_report, warn — and the prohibited-content list is `reports_known_reason`
 * read back in English. Describing powers Bingd does not have is the ordinary way to
 * write this section and would make the document unfalsifiable; describing the ones it
 * does makes it checkable against a migration.
 *
 * Thirteen is not a number chosen here either: `create_profile` collects a date of
 * birth and refuses an under-13 account, so the schema already enforces it and this
 * states it.
 *
 * The licence paragraph is the one clause that is *load-bearing for the product rather
 * than for us*: without permission to store and display what somebody writes, a public
 * review cannot legally be shown on a title page. It is scoped to exactly that and ends
 * with the content, rather than the perpetual worldwide sublicensable grant a template
 * would supply for a product that has no use for one.
 */
/**
 * The draft-for-review notice, present exactly while TERMS_STATUS says 'draft'.
 *
 * One condition for the notice, the stamp and the public-mode refusal, so the three
 * cannot drift: the page stops calling itself a draft in the same commit that records
 * it stopped being one, and no public build exists in between.
 */
const TERMS_DRAFT_NOTICE =
  TERMS_STATUS === 'draft'
    ? `
      <p>
        <strong>Draft for review.</strong> This document has not yet been reviewed by a
        lawyer, and the operating entity named below is not yet confirmed.
      </p>
`
    : '';

const TERMS_BODY = `      <p class="lede">
        These are the terms you agree to by using Bingd. They are written to be read
        &mdash; short sentences, no glossary of defined terms &mdash; and they describe
        what the app actually does.
      </p>
${TERMS_DRAFT_NOTICE}
      <h2>Who these terms are with</h2>
      <p>
        Bingd is made and run by ${LEGAL_ENTITY} (&ldquo;we&rdquo;, &ldquo;us&rdquo;).
        Questions about anything here go to
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
      </p>

      <h2>You need to be 13 or older</h2>
      <p>
        Bingd asks for your date of birth when you create an account, and will not create
        one if you are under 13. If we find out an account belongs to someone younger, we
        delete it. If the law where you live sets a higher age for a service like this,
        that age applies to you instead.
      </p>

      <h2>Your account is yours to look after</h2>
      <ul>
        <li>Keep your sign-in method secure. What happens through your account is treated
          as done by you.</li>
        <li>One person per account. Do not share it, sell it, or transfer it.</li>
        <li>Write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> if you think
          somebody else is using it.</li>
      </ul>

      <h2>What you write on Bingd</h2>
      <p>
        Reviews, comments, your handle and display name, your bio, list titles, and
        anything else you type are <strong>your content</strong>. It stays yours. We do
        not claim ownership of it.
      </p>
      <p>
        We do need your permission to run the app, and it is a narrow one: by posting
        something on Bingd you allow us to store it and to show it to the people your own
        privacy settings allow it to be shown to. That is what lets a public review appear
        on a title page and a private note stay private. The permission lasts as long as
        the content is on Bingd &mdash; delete the content or the account and it ends,
        apart from the safety records described under
        <a href="/account-deletion">deleting your account</a>.
      </p>
      <p>
        You are responsible for what you publish. Post only what you have the right to
        post.
      </p>

      <h2>What you must not post or do</h2>
      <p>Do not use Bingd to post or send:</p>
      <ul>
        <li>Harassment, bullying, or threats.</li>
        <li>Hate speech, or content attacking people for who they are.</li>
        <li>Content encouraging self-harm or suicide.</li>
        <li>Sexual content, or anything that sexualises a minor.</li>
        <li>Impersonation of another person, or of us.</li>
        <li>Illegal content, or content that infringes somebody else&rsquo;s rights.</li>
        <li>Spam, scams, or bulk unsolicited messages.</li>
      </ul>
      <p>
        And do not attack the service itself: no attempting to reach accounts or systems
        you are not entitled to, no scraping, no automated access, no working around the
        limits on what an account may see or do, and no reverse engineering beyond what
        the law permits regardless of this paragraph.
      </p>

      <h2>Reporting, and what we can do about it</h2>
      <p>
        Reviews, comments and profiles can be reported from inside the app. Reports reach
        the person who runs Bingd rather than an automated system, and the person you
        report is never told who reported them.
      </p>
      <p>If something breaks these terms, we may:</p>
      <ul>
        <li>remove the review, comment, or other content;</li>
        <li>require a handle to be changed;</li>
        <li>issue a warning; or</li>
        <li>suspend the account, which hides it and stops it posting.</li>
      </ul>
      <p>
        <strong>Suspension is the strongest of those, and it can be lifted.</strong> We do
        not delete accounts as a punishment &mdash; a suspended account still exists, and
        so does the record of why. Closing one permanently is something we do only where
        we have to, which is covered under <em>Ending it</em> below.
      </p>
      <p>
        We try to match the response to what happened.
        There is no formal appeals process today: if you think we got it wrong, write to
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and a person will read it.
        We are not obliged to monitor everything posted on Bingd, and we do not.
      </p>
      <p>
        You can also block somebody yourself, at any time, without reporting them.
        Blocking and reporting are separate things: a block takes effect immediately and
        is between the two of you, while a report is a message to us.
      </p>

      <h2>Our content, and other people&rsquo;s</h2>
      <p>
        The Bingd name, the app, this site and their design are ours. These terms give you
        no licence to them beyond using the app normally.
      </p>
      <p>
        Film and television information &mdash; titles, artwork, cast, descriptions
        &mdash; comes from TMDB and belongs to TMDB or its contributors. Bingd uses the
        TMDB API but is <strong>not endorsed or certified by TMDB</strong>, and your use
        of that material is also subject to TMDB&rsquo;s own terms. Signing in with Apple
        or Google, and the store you installed from, are governed by those companies&rsquo;
        terms rather than by these.
      </p>
      <p>
        Bingd shows you what other people have ranked and written. Those opinions are
        theirs, not ours.
      </p>

      <h2>The service will change</h2>
      <p>
        Bingd is a small and actively developed product. Features will be added, changed
        and removed, and it will sometimes be unavailable. We do not promise that it will
        always be available, or that it will keep working the way it does today.
      </p>
      <p>
        If we change these terms in a way that affects you, the date at the top of this
        page changes. Continuing to use Bingd after that means the new terms apply.
      </p>

      <h2>Ending it</h2>
      <p>
        You can delete your account at any time from inside the app &mdash; see
        <a href="/account-deletion">deleting your account</a>, which sets out exactly what
        is removed and which safety records are kept.
      </p>
      <p>
        We may suspend or close an account that breaks these terms, and may close an
        account or withdraw the service where we have to for legal or safety reasons.
      </p>

      <h2>Privacy</h2>
      <p>
        What Bingd stores, why, and who else can see it is set out on the
        <a href="/privacy">privacy page</a>, which forms part of your agreement with us.
      </p>

      <h2>Where the law lets us limit things, we do</h2>
      <p>
        Bingd is provided as it is. To the extent the law where you live allows it, we
        give no warranties about the service, and we are not liable for indirect or
        consequential loss, for content other people post, or for anything outside our
        reasonable control.
      </p>
      <p>
        <strong>Nothing here removes rights you have that cannot be removed.</strong>
        Consumer protection law in many countries gives you rights a contract cannot sign
        away. Where any part of these terms conflicts with those, your rights win and the
        rest of this document still stands.
      </p>

      <h2>Contact</h2>
      <p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`;

const DOCUMENTS = [
  {
    dir: 'privacy',
    title: 'Privacy — Bingd',
    heading: 'Privacy',
    stamp: `Last updated ${DOCUMENT_DATE}.${isPublic ? '' : ' Bingd is in closed testing.'}`,
    body: PRIVACY_BODY,
  },
  {
    dir: 'terms',
    title: 'Terms of Use — Bingd',
    heading: 'Terms of Use',
    stamp: `Last updated ${TERMS_DATE}.${
      TERMS_STATUS === 'draft' ? ' Draft &mdash; not yet reviewed by a lawyer.' : ''
    }`,
    body: TERMS_BODY,
  },
  {
    dir: 'support',
    title: 'Support — Bingd',
    heading: 'Support',
    stamp: `Last updated ${DOCUMENT_DATE}.`,
    body: SUPPORT_BODY,
  },
  {
    dir: 'account-deletion',
    title: 'Deleting your Bingd account',
    heading: 'Deleting your account',
    stamp: `Last updated ${DOCUMENT_DATE}.`,
    body: DELETION_BODY,
  },
];

const ROUTES = [
  {
    dir: 'i',
    kind: 'invite',
    title: 'You have been invited to Bingd',
    tagline: 'Rank what you&rsquo;ve watched. See what your friends really think.',
    heading: isPublic
      ? 'Bingd is not on this platform yet.'
      : 'Ask whoever invited you to let you know when it is.',
    body: INVITE_BODY,
  },
  {
    dir: 'u',
    kind: 'profile',
    title: 'A profile on Bingd',
    tagline: 'Rank what you&rsquo;ve watched. See what your friends really think.',
    heading: UNAVAILABLE,
    body: PROFILE_BODY,
  },
  {
    dir: 'title',
    kind: 'title',
    title: 'A title on Bingd',
    tagline: 'Rank what you&rsquo;ve watched. See what your friends really think.',
    heading: UNAVAILABLE,
    body: TITLE_BODY,
  },
  {
    dir: 'lists',
    kind: 'generic',
    title: 'A list on Bingd',
    tagline: 'Rank what you&rsquo;ve watched. See what your friends really think.',
    heading: UNAVAILABLE,
    body: GENERIC_BODY,
  },
];

/**
 * Each route page is one flat file — `i.html`, not `i/index.html` — and the reason is
 * a Cloudflare Pages rule discovered in production on 2026-08-21. A `_redirects` proxy
 * whose destination matches its own source pattern (`/i/*  /i/index.html  200`) is
 * treated by Pages as an infinite loop and silently ignored; with no 404.html in the
 * project, every `/i/<token>` then fell through to SPA fallback and served the root
 * holding page with a 200. The flat file lets the rewrite target be `/i`, which
 * `/i/*` does not match, so the rule survives validation.
 */
for (const route of ROUTES) {
  await writeFile(join(dist, `${route.dir}.html`), page(route));
}

// ---------------------------------------------------------------------------
// The site's root
// ---------------------------------------------------------------------------

/**
 * `/` — the holding page, and Cloudflare Pages' fallback for anything unmatched.
 *
 * **Generated as of the public-launch tranche; it used to be a committed
 * `web/public/index.html`.** It carried its own copy of the colour tokens, its own
 * `noindex` meta and its own hardcoded "Bingd is in closed testing" — which made the
 * front page of the site the one page no release-mode switch could reach. Launch would
 * have flipped every generated page and left the address people actually type saying
 * the product was not out yet.
 *
 * Same content, same shape, same styles as the router pages it sits beside. What it
 * does not have is theirs: no install buttons and no `page.mjs`, because this page is
 * not the end of a link somebody was sent and has no token, handle or title to resolve.
 */
const ROOT_BODY = isPublic
  ? `        <p>
          Bingd is where you rank what you&rsquo;ve watched and see what your friends
          really think &mdash; a ranked list of everything, built one comparison at a
          time.
        </p>`
  : `        <p>
          Bingd is in closed testing. Invitations are going out to a small first group,
          and this page will become the app&rsquo;s public face when it opens up.
        </p>`;

await writeFile(
  join(dist, 'index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bingd</title>
    <meta name="description" content="Rank what you have watched, and see what your friends really think." />${ROBOTS}

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500&display=swap"
      rel="stylesheet"
    />

    <style>${styles}</style>
  </head>

  <body>
    <main>
      <h1>Bingd</h1>
      <p class="tagline">Rank what you&rsquo;ve watched. See what your friends really think.</p>

      <div class="card">
${ROOT_BODY}
      </div>

      <footer>
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> &middot;
        <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a> &middot;
        <a href="/support">Support</a>
      </footer>
    </main>
  </body>
</html>
`,
);

// ---------------------------------------------------------------------------
// The four documents the stores and the Terms require a URL for
// ---------------------------------------------------------------------------

/**
 * `/privacy`, `/support`, `/account-deletion`.
 *
 * These are not marketing pages and they are not the router. They exist because App
 * Store Connect and Play Console each ask for a URL, refuse a submission without one,
 * and fetch it themselves — and because until 2026-08-20 all three of these paths
 * returned Cloudflare Pages' fallback `index.html` with a **200**. A reviewer following
 * the privacy link would have been shown the generic "Bingd is in closed testing" page
 * and would reasonably have concluded there was no policy.
 *
 * Three rules they are written under:
 *
 *   - **Nothing here is aspirational.** Every sentence describes what the schema and the
 *     client actually do today. The deletion inventory is the one in the header of
 *     `20260817000600_account.sql`, in the same categories, because a deletion claim that
 *     is not checkable against the migration is the claim most worth getting wrong.
 *   - **No JavaScript and no `page.mjs`.** The router decides where to send somebody who
 *     tapped an invitation; these are documents, and a document that needs a script to
 *     render is a document a crawler cannot read.
 *   - **Deliberately unclaimed by the app.** They are absent from `appPaths`, so neither
 *     the Apple file nor the Android manifest hands them to the app — which has no screen
 *     for any of them. `web/router.test.mjs` asserts that, in both directions.
 */
const documentStyles = `
      ${styles}

      /* Long-form overrides. The router's pages are one card centred in the viewport;
         these are read top to bottom, so the grid centring above is undone. */
      body { display: block; padding: 3rem 1.5rem 4rem; }
      main { max-width: 42rem; margin: 0 auto; text-align: left; }
      h1 { font-size: clamp(2rem, 8vw, 2.75rem); margin-bottom: 0.25rem; }
      h2 {
        font-family: 'DM Serif Display', Georgia, serif;
        font-weight: 400;
        font-size: 1.4rem;
        margin: 2.5rem 0 0.75rem;
        color: var(--ink);
      }
      h3 { font-size: 1rem; font-weight: 500; margin: 1.5rem 0 0.5rem; color: var(--ink); }
      p, li { color: var(--secondary); font-size: 1rem; line-height: 1.65; }
      ul { padding-left: 1.25rem; margin: 0 0 1rem; }
      li { margin-bottom: 0.4rem; }
      strong { color: var(--ink); font-weight: 500; }
      a { color: var(--maroon); text-underline-offset: 2px; }
      .stamp {
        font-size: 0.8125rem;
        color: var(--secondary);
        margin: 0 0 2rem;
        padding-bottom: 1.5rem;
        border-bottom: 1px solid var(--hairline);
      }
      .lede { font-size: 1.05rem; color: var(--ink); }
      footer {
        margin-top: 3rem;
        padding-top: 1.5rem;
        border-top: 1px solid var(--hairline);
        font-size: 0.8125rem;
      }
`;

const document_ = ({ title, heading, stamp, body }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>${ROBOTS}
    <meta name="referrer" content="no-referrer" />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500&display=swap"
      rel="stylesheet"
    />

    <style>${documentStyles}</style>
  </head>

  <body>
    <main>
      <h1>${heading}</h1>
      <p class="stamp">${stamp}</p>
${body}
      <footer>
        <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a> &middot;
        <a href="/support">Support</a> &middot;
        <a href="/account-deletion">Delete your account</a> &middot;
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>
      </footer>
    </main>
  </body>
</html>
`;

for (const doc of DOCUMENTS) {
  await mkdir(join(dist, doc.dir), { recursive: true });
  await writeFile(join(dist, doc.dir, 'index.html'), document_(doc));
}

/**
 * Cloudflare Pages rewrites, so `/i/<anything>` serves the invitation page.
 *
 * A 200 and not a 301. A redirect would change the address bar, and the address bar is
 * the thing the visitor has to be able to come back to after installing — that URL is
 * the whole deferred-install mechanism this site has.
 *
 * `.well-known` is deliberately not listed and must never be: a rewrite over it would
 * serve HTML where iOS expects JSON, which is the exact failure `_headers` was written
 * to prevent, arriving from the other direction.
 *
 * The destination is `/<dir>`, extensionless, and both halves of that are load-bearing.
 * It must not match the rule's own `/<dir>/*` pattern, or Pages drops the rule as an
 * infinite loop (see the route-page comment above). And it must not be `/<dir>.html`,
 * because Pages 308-normalizes direct `.html` requests to the pretty URL — surfaced
 * through the proxy, that redirect would rewrite the address bar and lose the token,
 * which is the one thing this site exists to preserve.
 */
await writeFile(
  join(dist, '_redirects'),
  ROUTES.map((route) => `/${route.dir}/*  /${route.dir}  200`).join('\n') + '\n',
);

console.log(`Built ${dist}`);
console.log(
  `  apple-app-site-association  ${appleAppIds.length} app IDs, ${config.appPaths.length} paths`,
);
console.log(`  assetlinks.json             ${assetlinks.length} package(s)`);
console.log(`  router                      ${ROUTES.map((r) => `/${r.dir}/*`).join(' ')}`);
console.log(`  documents                   ${DOCUMENTS.map((d) => `/${d.dir}`).join(' ')}`);

const configured = DESTINATIONS.filter(([, value]) => value != null).map(([name]) => name);
console.log(
  `  install destinations        ${configured.length ? configured.join(', ') : 'none configured'}`,
);

if (assetlinks.length === 0) {
  console.log('');
  console.log('  No Android fingerprint, so App Links will not verify and a tapped link');
  console.log('  opens the browser on Android. iOS is unaffected. Add one to');
  console.log('  web/deep-links.config.json once an Android build exists — from');
  console.log('  `eas credentials`, or from Play Console > Setup > App integrity if Play');
  console.log('  re-signs the app.');
}

if (configured.length === 0) {
  console.log('');
  console.log('  No install destination is configured, so every route shows "the Bingd beta');
  console.log('  is not open for this device yet". That is the honest state until a public');
  console.log('  TestFlight link and a Play closed-test opt-in URL exist. Set them in');
  console.log('  web/distribution.config.json — no rebuild of the app, and no reissued');
  console.log('  invitation links, are needed when they arrive.');
}

if (!supabaseUrl || !supabaseAnonKey) {
  console.log('');
  console.log('  EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY were not set, so the invitation page');
  console.log('  records no opens. The page is otherwise complete. Set both in the deploy');
  console.log('  environment to turn the top of the invite funnel on.');
}
