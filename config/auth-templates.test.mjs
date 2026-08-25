/**
 * The email Bingd sends must contain a code, and must not contain a link.
 *
 * This is the check that did not exist, and its absence is the whole of why a
 * friend-beta tester spent a week unable to sign in while every test in this repository
 * was green. `methods.password.test.ts` asserts that `sendEmailCode` calls
 * `signInWithOtp` and that `verifyEmailCode` calls `verifyOtp({ type: 'email' })` — and
 * both of those assertions passed, and were correct, and always had been. **The client
 * was never wrong.** What nobody had written down was what the *project* should send
 * back, so there was nothing for the deployed configuration to have drifted from.
 *
 * So this asserts the shape of `supabase/auth-templates/`, which is now that written-down
 * thing. It is deliberately a *static* test:
 *
 *   - it makes no network call, so it runs on a fork's pull request with no secrets;
 *   - it scrapes nothing, which is the founder's rule for this guard;
 *   - and it cannot go green because somebody's inbox happened to work today.
 *
 * The live half — "and is the project actually configured this way" — is
 * `scripts/check-auth-config.mjs`, which needs a personal access token and therefore
 * belongs in the bootstrap and release runbooks rather than in every CI run.
 *
 * It is in `config/` rather than beside the templates because `npm run test:config`
 * already globs `config/*.test.mjs` and CI already runs it. Adding a script to
 * `package.json` would have been the obvious alternative and is not available: that
 * block is a fingerprint source, and editing it moves the runtime version of the
 * published friend-beta binary, which stops that binary receiving over-the-air updates
 * (`config/push.cjs`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'supabase', 'auth-templates');

const manifest = JSON.parse(readFileSync(join(templatesDir, 'templates.json'), 'utf8'));
const bodyOf = (entry) => readFileSync(join(templatesDir, entry.bodyFile), 'utf8');

describe('the canonical auth email templates', () => {
  /**
   * Two, and the count is the assertion.
   *
   * Since the password-first amendment the two are reached by two *different calls*
   * rather than by one call meeting two kinds of address: `signUp` triggers **Confirm
   * signup**, and `signInWithOtp` triggers **Magic Link**. That makes fixing only one of
   * them even easier than before, and the consequence is unchanged — an app where one
   * population can get in and the other cannot, invisible to whoever is testing.
   */
  it('covers both templates the two email flows can reach', () => {
    const keys = manifest.templates.map((t) => t.bodyKey).sort();
    assert.deepEqual(keys, [
      'mailer_templates_confirmation_content',
      'mailer_templates_magic_link_content',
    ]);
  });

  /**
   * Each template names the `EmailOtpType` its code is verified with, and the pair has to
   * match what `methods.ts` actually passes.
   *
   * A signup token and a magic-link token look identical in an inbox and are stored in
   * different columns, so verifying one as the other answers `otp_expired` — reported by
   * every screen as "that code did not work". A correct code called wrong, with nothing
   * anywhere saying why. This is the one place both halves are visible together.
   */
  it('verifies each template’s code with the type the client actually sends', () => {
    assert.deepEqual(
      Object.fromEntries(manifest.templates.map((t) => [t.bodyKey, t.verifiedAs])),
      {
        mailer_templates_confirmation_content: 'signup',
        mailer_templates_magic_link_content: 'email',
      },
    );

    const methods = readFileSync(join(here, '..', 'src', 'features', 'auth', 'methods.ts'), 'utf8');
    assert.match(
      methods,
      /signup:\s*'signup'/,
      'methods.ts must verify a Confirm-signup token as type signup',
    );
    assert.match(
      methods,
      /passwordless:\s*'email'/,
      'methods.ts must verify a passwordless token as type email',
    );
  });

  for (const entry of manifest.templates) {
    describe(entry.name, () => {
      it('interpolates the one-time code', () => {
        assert.match(
          bodyOf(entry),
          /\{\{\s*\.Token\s*\}\}/,
          `${entry.bodyFile} must contain {{ .Token }}: it is the only thing verifyOtp accepts`,
        );
      });

      /**
       * The defect itself, stated as a refusal.
       *
       * `{{ .ConfirmationURL }}` completes the sign-in in a browser and produces a
       * session Bingd never sees — the tester's "the confirm link just opens in the
       * email browser". Go's template engine substitutes it wherever it appears,
       * including inside an HTML comment, so this looks at the whole file rather than at
       * the rendered part of it.
       */
      it('carries no confirmation URL', () => {
        assert.doesNotMatch(
          bodyOf(entry),
          /ConfirmationURL|TokenHash|RedirectTo/,
          `${entry.bodyFile} must not offer a link: a link beside a code is a link somebody taps`,
        );
      });

      /**
       * And no link at all, which is the stronger and more durable form of the rule
       * above. Somebody adding "having trouble? open bingd." with an `href` would pass
       * the previous assertion and reintroduce exactly the dead end being fixed.
       */
      it('contains no anchor for anyone to tap', () => {
        assert.doesNotMatch(bodyOf(entry), /<a\b|href=/i, `${entry.bodyFile} must contain no links`);
      });

      it('is branded and says what to do with the code', () => {
        const body = bodyOf(entry);
        assert.match(body, /bingd\./, 'the brand is "bingd." — lowercase, with the period');
        // "verification code" for a new account, "sign-in code" for a returning one.
        // They are different acts and the two emails stopped being identical when
        // password became the default; a template that says the wrong one is a person
        // told they are signing in when they are finishing a signup.
        assert.match(body, /(verification|sign-in) code/i);
        // The copy promises ten minutes; `settings.mailer_otp_exp` has to agree, and the
        // pair is asserted below rather than left to whoever edits one of them.
        assert.match(body, /expires in 10 minutes/i);
      });

      it('names a subject', () => {
        assert.equal(typeof entry.subject, 'string');
        assert.ok(entry.subject.includes('bingd.'));
        assert.ok(entry.subject.length <= 60, 'a subject line is truncated by every mail client');
      });
    });
  }

  /**
   * The two halves of "six digits" have to agree, and they live in three files.
   *
   * `verify.tsx` enables its button on `/^\d{6}$/` and truncates input at six. The
   * project was at one point issuing **eight**-digit codes, which would have produced a
   * code that arrives correctly and cannot be typed — a failure that looks like the app
   * rejecting a valid code. This is that pair, asserted.
   */
  it('asks for a code the verify screen can accept', () => {
    assert.equal(manifest.settings.mailer_otp_length, 6);

    const verify = readFileSync(join(here, '..', 'app', '(auth)', 'verify.tsx'), 'utf8');
    assert.match(verify, /\\d\{6\}/, 'verify.tsx must accept exactly six digits');
  });

  it('expires the code when the email says it does', () => {
    assert.equal(manifest.settings.mailer_otp_exp, 600, '600s is the "10 minutes" both bodies promise');
  });
});

/**
 * And the client half, asserted from the other direction.
 *
 * `sendEmailCode` must not pass `emailRedirectTo`. Passing one is how an app opts into
 * the link half of this flow, and it would put a URL back in the email regardless of
 * what the templates above say — the one way the fix could be undone from inside this
 * repository rather than from a dashboard.
 */
describe('the client never asks for a link', () => {
  it('sends no emailRedirectTo with the code request', () => {
    const methods = readFileSync(join(here, '..', 'src', 'features', 'auth', 'methods.ts'), 'utf8');
    const call = /signInWithOtp\(\{[\s\S]*?\n\s*\}\);/.exec(methods);
    assert.ok(call, 'sendEmailCode must still call signInWithOtp');
    assert.doesNotMatch(
      call[0],
      /emailRedirectTo/,
      'emailRedirectTo turns the OTP email back into a magic link',
    );
  });

  it('sends no emailRedirectTo with the sign-up request either', () => {
    const methods = readFileSync(join(here, '..', 'src', 'features', 'auth', 'methods.ts'), 'utf8');
    const call = /supabase\.auth\.signUp\(\{[\s\S]*?\}\);/.exec(methods);
    assert.ok(call, 'signUpWithEmailPassword must still call signUp');
    assert.doesNotMatch(
      call[0],
      /emailRedirectTo/,
      'emailRedirectTo puts a link back in the Confirm signup email',
    );
  });

  it('verifies as an OTP rather than as a link token', () => {
    const methods = readFileSync(join(here, '..', 'src', 'features', 'auth', 'methods.ts'), 'utf8');
    assert.doesNotMatch(
      methods,
      /type:\s*'magiclink'/,
      'magiclink is the link flow, not the code flow',
    );
    // `verifyTokenHash` is the other way a link gets back in: it takes the hash out of a
    // `{{ .ConfirmationURL }}` rather than a typed code.
    assert.doesNotMatch(methods, /token_hash|TokenHash/, 'a token hash comes out of a link');
  });

  /**
   * Passwordless sign-in must not be a second registration route.
   *
   * It was `shouldCreateUser: true` while the code flow was the door. As a secondary
   * sign-in that would mint a permanent account for every mistyped address, from a
   * screen whose sibling is the one that sets a password — and nothing else in the app
   * would ever say it had happened.
   */
  it('does not let a passwordless sign-in create an account', () => {
    const methods = readFileSync(join(here, '..', 'src', 'features', 'auth', 'methods.ts'), 'utf8');
    const call = /signInWithOtp\(\{[\s\S]*?\n\s*\}\);/.exec(methods);
    assert.ok(call);
    assert.match(call[0], /shouldCreateUser:\s*false/);
  });
});
