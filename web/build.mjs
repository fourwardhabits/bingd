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
await cp(join(here, 'public'), dist, { recursive: true });
await cp(join(here, 'src'), dist, { recursive: true });

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
 * One page.
 *
 * `noindex` on every route, by founder decision (decision log §3) and reinforced by
 * the `X-Robots-Tag` in `_headers` — a `/u/<handle>` route that Google indexed would
 * publish a list of Bingd's members, which is a thing no privacy setting in the app
 * would then be able to take back.
 */
const page = ({ title, kind, heading, tagline, body }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="robots" content="noindex, nofollow" />
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
          The Bingd beta is not open for this device yet. ${heading}
        </p>
      </div>

      <footer>
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> &middot;
        <a href="/privacy">Privacy</a> &middot; <a href="/support">Support</a>
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
const INVITE_BODY = `        <span id="invite-intro">
          <p class="subject">You have been invited to Bingd.</p>
          <p>
            Bingd is where you rank what you have watched and see what your friends
            really think. It is in closed testing, and this invitation is how you get in.
          </p>
          <p>
            <strong>Come back to this page once Bingd is installed</strong> and tap
            &ldquo;I already have Bingd&rdquo;. Opening the app straight from TestFlight
            or Play works too, but the invitation will not follow you there.
          </p>
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

const GENERIC_BODY = `        <p>
          Bingd is in closed testing. Invitations are going out to a small first group,
          and this page will become the app&rsquo;s public face when it opens up.
        </p>`;

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

const PRIVACY_BODY = `      <p class="lede">
        Bingd is a closed beta. This describes what it actually stores, why, and who else
        sees it &mdash; written against the database schema rather than from a template.
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
        retention settings and are not removed by deleting your Bingd account; they carry
        an account identifier and no content.
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
        the top changes and testers are told in the app.
      </p>

      <h2>Attribution</h2>
      <p>
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>`;

const SUPPORT_BODY = `      <p class="lede">
        Bingd is in closed testing. There is no help desk &mdash; there is one address, and
        it is read by the person who builds the app.
      </p>

      <h2>Getting help</h2>
      <p>
        Write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Expect a reply
        within a few days.
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
        <li><strong>Bingd sends no push notifications.</strong> Notifications appear in the
          app&rsquo;s own inbox and nowhere else. That is deliberate for this beta.</li>
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
        Abuse, impersonation, or a security problem: write to
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
        <li>Your profile picture, removed from file storage.</li>
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
        services under their own retention settings. They carry an account identifier and
        never any content &mdash; no titles, no notes, no search text. See the
        <a href="/privacy">privacy page</a>.
      </p>`;

const DOCUMENTS = [
  {
    dir: 'privacy',
    title: 'Privacy — Bingd',
    heading: 'Privacy',
    stamp: `Last updated ${DOCUMENT_DATE}. Bingd is in closed testing.`,
    body: PRIVACY_BODY,
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
    heading: 'Ask whoever invited you to let you know when it is.',
    body: INVITE_BODY,
  },
  {
    dir: 'u',
    kind: 'profile',
    title: 'A profile on Bingd',
    tagline: 'Rank what you&rsquo;ve watched. See what your friends really think.',
    heading: 'Bingd is in closed testing.',
    body: PROFILE_BODY,
  },
  {
    dir: 'title',
    kind: 'title',
    title: 'A title on Bingd',
    tagline: 'Rank what you&rsquo;ve watched. See what your friends really think.',
    heading: 'Bingd is in closed testing.',
    body: TITLE_BODY,
  },
  {
    dir: 'lists',
    kind: 'generic',
    title: 'A list on Bingd',
    tagline: 'Rank what you&rsquo;ve watched. See what your friends really think.',
    heading: 'Bingd is in closed testing.',
    body: GENERIC_BODY,
  },
];

for (const route of ROUTES) {
  await mkdir(join(dist, route.dir), { recursive: true });
  await writeFile(join(dist, route.dir, 'index.html'), page(route));
}

// ---------------------------------------------------------------------------
// The three documents both stores require a URL for
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
    <title>${title}</title>
    <meta name="robots" content="noindex, nofollow" />
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
        <a href="/privacy">Privacy</a> &middot; <a href="/support">Support</a> &middot;
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
 */
await writeFile(
  join(dist, '_redirects'),
  ROUTES.map((route) => `/${route.dir}/*  /${route.dir}/index.html  200`).join('\n') + '\n',
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
