/**
 * The email Bingd sends must contain a code, and must not contain a link.
 *
 * This is the check that did not exist, and its absence is the whole of why a
 * friend-beta tester spent a week unable to sign in while every test in this repository
 * was green. `methods.email.test.ts` asserts that `sendEmailCode` calls `signInWithOtp`
 * and that `verifyEmailCode` calls `verifyOtp({ type: 'email' })` — and both of those
 * assertions passed, and were correct, and always had been. **The client was never
 * wrong.** What nobody had written down was what the *project* should send back, so there
 * was nothing for the deployed configuration to have drifted from.
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
   * **One call reaches both.** `sendEmailCode` passes `shouldCreateUser: true`, and
   * Supabase picks by the address: no account yet gets **Confirm signup**, an existing
   * account gets **Magic Link**. Fixing only one produces an app where one population can
   * get in and the other cannot, invisible to whoever is testing — and since a new
   * address is the one routed through Confirm signup, the invisible half is every new
   * user.
   */
  it('covers both templates the one email flow can reach', () => {
    const keys = manifest.templates.map((t) => t.bodyKey).sort();
    assert.deepEqual(keys, [
      'mailer_templates_confirmation_content',
      'mailer_templates_magic_link_content',
    ]);
  });

  /**
   * Both codes are verified with the same `EmailOtpType`, and that sameness is the
   * assertion.
   *
   * `@supabase/auth-js` documents `'email'` as the type for a code "sent to the user's
   * email during sign-up or sign-in" and marks `signup` and `magiclink` **deprecated**.
   * GoTrue resolves `'email'` against whichever column holds the token, which is what
   * lets one client call and one screen serve a new address and a returning one. A
   * manifest that gave the two templates different types would be describing a client
   * that has to know which kind of address it is holding — and no such client exists here
   * any more.
   */
  it('verifies both templates with the single type the client sends', () => {
    assert.deepEqual(
      Object.fromEntries(manifest.templates.map((t) => [t.bodyKey, t.verifiedAs])),
      {
        mailer_templates_confirmation_content: 'email',
        mailer_templates_magic_link_content: 'email',
      },
    );

    const methods = readFileSync(join(here, '..', 'src', 'features', 'auth', 'methods.ts'), 'utf8');
    assert.match(
      methods,
      /EMAIL_OTP_TYPE = 'email'/,
      "methods.ts must verify every emailed code as type 'email'",
    );
    // The deprecated pair, refused by name. Reintroducing either means reintroducing the
    // question "is this address new?", which the sign-in screen no longer asks.
    assert.doesNotMatch(methods, /type:\s*'signup'/, "'signup' is the deprecated type");
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
        // "sign-in code" in both, because a new address and a returning one get the same
        // sentence — see the indistinguishability assertion below.
        assert.match(body, /sign-in code/i);
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
   * The two emails must be indistinguishable, and that is a product requirement rather
   * than tidiness.
   *
   * Which template arrived is the one fact this flow is careful never to disclose: the
   * code screen says the same thing to a new address and a returning one, and
   * `signInWithOtp` answers both identically. An email that opened "welcome to bingd."
   * would give it away in the one place the app cannot see, to the one person who cannot
   * be told it does not matter.
   */
  it('says the same thing to a new address and a returning one', () => {
    const rendered = manifest.templates.map((t) => ({
      subject: t.subject,
      // Comments differ by design — each names the population its template reaches — and
      // Supabase strips nothing, but a comment is not what anybody reads. Line endings
      // are normalised because this repository checks out CRLF on Windows and LF in CI,
      // and a guard that failed on one of those would be turned off rather than fixed.
      body: bodyOf(t).replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').trim(),
    }));
    for (const other of rendered.slice(1)) {
      assert.equal(other.subject, rendered[0].subject, 'both subjects must read identically');
      assert.equal(other.body, rendered[0].body, 'both rendered bodies must read identically');
    }
  });

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
  const methodsSource = () =>
    readFileSync(join(here, '..', 'src', 'features', 'auth', 'methods.ts'), 'utf8');

  it('sends no emailRedirectTo with the code request', () => {
    const call = /signInWithOtp\(\{[\s\S]*?\n\s*\}\);/.exec(methodsSource());
    assert.ok(call, 'sendEmailCode must still call signInWithOtp');
    assert.doesNotMatch(
      call[0],
      /emailRedirectTo/,
      'emailRedirectTo turns the OTP email back into a magic link',
    );
  });

  it('verifies as an OTP rather than as a link token', () => {
    const methods = methodsSource();
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
   * The email flow must be able to create an account, and this is where that is pinned.
   *
   * It ran briefly with `shouldCreateUser: false`, when a password was the way in. With
   * the password path gone that setting would be a locked door: a new person types their
   * address, is refused, and has nothing else on the screen to try. It is also what
   * restores anti-enumeration — `false` answers a known address and an unknown one
   * differently, and `true` answers both with a send.
   */
  it('lets the one email flow create the account it is the only door to', () => {
    const call = /signInWithOtp\(\{[\s\S]*?\n\s*\}\);/.exec(methodsSource());
    assert.ok(call);
    assert.match(call[0], /shouldCreateUser:\s*true/);
  });

  /**
   * Ordinary account creation must not involve a password, and the durable form of that
   * rule is that this module never calls `signUp` at all.
   *
   * `signInWithPassword` stays — it is how a store reviewer gets in
   * (`docs/release/store-review-access.md`) — but the call that *mints* an account from
   * an email and a password is gone, and a screen cannot offer what the module cannot do.
   */
  it('offers no way to create an account with a password', () => {
    const methods = methodsSource();
    assert.doesNotMatch(
      methods,
      /supabase\.auth\.signUp\(/,
      'ordinary users do not create passwords in v1; the code flow is the only door',
    );
    assert.match(
      methods,
      /supabase\.auth\.signInWithPassword\(/,
      'password sign-in is retained for store review',
    );
  });
});
