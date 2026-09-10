import { nextRoute, type RoutingInput } from './session';

/**
 * Where a user is sent, and — the part independent review found broken — where they are
 * deliberately left alone.
 *
 * A table rather than a rendered hook. The first attempt at this file mocked
 * `useAuthRouting`'s own module to replace `useAuth`, which cannot work: the hook holds a
 * direct reference to the real one past `requireActual`, so every assertion passed
 * because auth was stuck at `loading` and nothing was ever routed. Tests that pass for a
 * reason unrelated to their subject are worse than no tests, which is why the decision is
 * now a function.
 */
const decide = (input: Partial<RoutingInput>) =>
  nextRoute({
    status: 'ready',
    group: undefined,
    screen: undefined,
    tasteNeeded: false,
    tastePending: false,
    /**
     * `null` is *read, and there is no stage* — an account that has never been in the
     * flow. `undefined` would be "not read yet", which routing deliberately waits on, and
     * defaulting to it would make every unrelated case a test of the hold.
     */
    stage: null,
    tasteRanked: 0,
    ...input,
  });

describe('nextRoute', () => {
  describe('before it knows', () => {
    it('moves nobody while auth is loading', () => {
      expect(decide({ status: 'loading' })).toBeNull();
    });

    it('moves nobody when auth failed, because not knowing is not a destination', () => {
      // Sending a signed-in user with a flaky connection to sign-in would ask them to
      // claim a username they already own.
      expect(decide({ status: 'error' })).toBeNull();
    });

    it('waits for the first-run check rather than flashing the feed', () => {
      expect(decide({ tastePending: true, tasteNeeded: undefined })).toBeNull();
    });
  });

  describe('signed out and half signed up', () => {
    it('sends a signed-out user to sign in', () => {
      expect(decide({ status: 'signed-out' })).toBe('/(auth)/sign-in');
    });

    it('leaves a signed-out user already in the auth group', () => {
      expect(decide({ status: 'signed-out', group: '(auth)', screen: 'sign-in' })).toBeNull();
    });

    it('sends an authenticated user with no profile to the first step of the flow', () => {
      expect(decide({ status: 'onboarding' })).toBe('/onboarding/motivations');
    });

    it('pulls them back if they wander to another auth screen', () => {
      expect(decide({ status: 'onboarding', group: '(auth)', screen: 'sign-in' })).toBe(
        '/onboarding/motivations',
      );
    });
  });

  /**
   * **The founder's reordering of 2026-09-09, as a table.**
   *
   * Motivations and *How bingd. helps* moved in front of the profile form: they cost the
   * reader nothing and are what earn the form, while a username, a birthday, a visibility
   * choice and a Terms acceptance are the expensive part.
   *
   * The invariant that must survive it is the one the founder named — ranking writes need
   * an account row, and the age and Terms gate belongs to `create_profile` — so the
   * hardest case here is the one that matters most: **nothing past the two value screens
   * is reachable without a profile.**
   */
  describe('the two value screens, which run before the profile exists', () => {
    it('starts a brand new account on motivations', () => {
      expect(decide({ status: 'onboarding', stage: null })).toBe('/onboarding/motivations');
    });

    it('leaves somebody who is already on it alone', () => {
      expect(
        decide({ status: 'onboarding', group: 'onboarding', screen: 'motivations' }),
      ).toBeNull();
    });

    it('carries them on to the answers screen, and leaves them there', () => {
      expect(decide({ status: 'onboarding', stage: 'answers' })).toBe('/onboarding/answers');
      expect(
        decide({
          status: 'onboarding',
          stage: 'answers',
          group: 'onboarding',
          screen: 'answers',
        }),
      ).toBeNull();
    });

    it('sends them back to the step they left, not forward to the form', () => {
      // A resume mid-flow. The stage is the authority, exactly as it is after the form.
      expect(
        decide({
          status: 'onboarding',
          stage: 'motivations',
          group: '(auth)',
          screen: 'verify',
        }),
      ).toBe('/onboarding/motivations');
    });

    it('moves nobody while the stage has not been read', () => {
      // The same hold the ready branch takes, for the same reason: guessing sends
      // somebody back a step. Bounded by hydrateStage own four seconds.
      expect(decide({ status: 'onboarding', stage: undefined })).toBeNull();
    });

    it.each(['taste', 'people', 'notifications', 'done'] as const)(
      'refuses to let a %s stage past the form while there is no profile',
      (stage) => {
        // **The invariant.** Ranking writes need an account row and the age gate belongs
        // to create_profile, so no stage beyond the two value screens is reachable until
        // one exists — including a device that thinks the flow is over.
        expect(decide({ status: 'onboarding', stage })).toBe('/(auth)/create-profile');
      },
    );

    it('leaves them on the form once they are there', () => {
      expect(
        decide({
          status: 'onboarding',
          stage: 'taste',
          group: '(auth)',
          screen: 'create-profile',
        }),
      ).toBeNull();
    });

    it('sends a finished form straight on to the picker', () => {
      // The status flips to ready the moment the profile query answers, and the stage the
      // answers screen wrote is what says where the flow was up to.
      expect(decide({ status: 'ready', stage: 'taste', tasteNeeded: true })).toBe(
        '/onboarding/taste',
      );
    });
  });

  describe('resuming a flow that is longer than the ranking run', () => {
    /**
     * **The defect the stage rule exists to prevent, stated as a test.**
     *
     * Five rankings used to mean the flow was over, and `readState` still settles an
     * `active` account with five of them to `done` so a summary cannot repeat for ever.
     * The run is step 7 of ten now: an account that closed the app on the People step has
     * five rankings and a taste query that answers "not needed". Asking taste first would
     * open the Feed with People and the notification question silently skipped.
     */
    it('returns somebody to the step they left, even though taste says they are done', () => {
      expect(decide({ stage: 'people', tasteNeeded: false })).toBe('/onboarding/people');
    });

    it('returns them to the notification step for the same reason', () => {
      expect(decide({ stage: 'notifications', tasteNeeded: false })).toBe(
        '/onboarding/notifications',
      );
    });

    /**
     * A finished flow falls through to the ordinary rules rather than being routed by
     * this one. Where the app opens after onboarding is the exiting screen's decision —
     * the Feed when a connection was made, For You when none was — and a stage rule that
     * answered here would overrule it every time.
     */
    it('stops answering once the flow is done', () => {
      expect(decide({ stage: 'done', tasteNeeded: false })).toBe('/(tabs)/feed');
    });

    /**
     * The stage outranks a taste check that has not come back, which is what stops the
     * resume flashing the wrong screen: without this, a cold start on the People step
     * would sit on `/` until two count queries answered a question that cannot change
     * where this person belongs.
     */
    it('does not wait for the taste check when the stage already answers', () => {
      expect(decide({ stage: 'people', tastePending: true, tasteNeeded: undefined })).toBe(
        '/onboarding/people',
      );
    });

    it('still refuses to pull anybody out of a flow that is still running', () => {
      expect(decide({ group: 'onboarding', screen: 'people', stage: 'people' })).toBeNull();
    });

    /**
     * **And this is the half of that rule that was too strong.**
     *
     * It used to be `return null` for the whole group, which protected a running flow and
     * a finished one alike. A finished flow is not a thing that needs protecting: it left
     * `/onboarding/motivations` reachable by anybody who could type it, and that screen
     * calls `begin()`, so an established account arriving there had its phase written to
     * `active` and could walk the first-run steps with a collection already behind it.
     *
     * The exiting screen still owns where the app opens. `finish` resolves its destination
     * before it writes `done`, so the write and the navigation are adjacent and this
     * branch has no commit to answer in — see `app/onboarding/notifications.tsx`.
     */
    it('does take somebody out of a flow that is over', () => {
      expect(decide({ group: 'onboarding', screen: 'people', stage: 'done' })).toBe(
        '/(tabs)/feed',
      );
    });
  });

  /**
   * The three defects independent review found in the first draft of this flow. Each is a
   * sequence rather than a state, and each ends with somebody looped or silently skipped
   * past a step, so each is pinned here as arithmetic.
   */
  describe('a stage that could not be read', () => {
    /**
     * **Not knowing is not a reason to guess**, and guessing cost two different failures.
     *
     * Treating an unread stage as absent sent an account resting on People back to step 3;
     * and because `readState` settles such an account to `done` on the way past, the next
     * launch fell through to the app with People and the notification question skipped.
     * The wait is bounded in `hydrateStage`, which resolves a dead Keychain to `null`.
     */
    it('moves nobody while the stage preference has not been answered', () => {
      expect(decide({ stage: undefined, tasteNeeded: true })).toBeNull();
    });

    /**
     * The safety net for a stage that was lost rather than merely slow. Five rankings is
     * proof the ranking run finished, and People is the step after it — so the flow
     * resumes there rather than at the motivation question, which would make somebody
     * repeat the expensive step they had already done.
     */
    it('resumes after the ranking run when the stage is gone but the rankings are not', () => {
      expect(decide({ stage: null, tasteNeeded: true, tasteRanked: 5 })).toBe(
        '/onboarding/people',
      );
    });

    it('still starts a genuinely new account at the top', () => {
      expect(decide({ stage: null, tasteNeeded: true, tasteRanked: 0 })).toBe(
        '/onboarding/motivations',
      );
    });

    it('does not treat a part-finished run as a finished one', () => {
      expect(decide({ stage: null, tasteNeeded: true, tasteRanked: 3 })).toBe(
        '/onboarding/motivations',
      );
    });
  });

  describe('a completion whose two writes did not both land', () => {
    /**
     * **The stage is the flow's authority, so `done` answers on its own.**
     *
     * The two authorities are separate preference keys, so the transition is not atomic. A
     * completion whose *taste* write is lost leaves `stage: 'done'` beside a phase still
     * marked `active` — and this rule used to fall through to the taste rule, which would
     * send a fully onboarded account back to step 3 to walk all ten again.
     */
    it('opens the app for a finished flow even when the taste phase disagrees', () => {
      expect(decide({ stage: 'done', tasteNeeded: true })).toBe('/(tabs)/feed');
    });

    it('leaves a finished account alone once it is inside the app', () => {
      expect(decide({ stage: 'done', group: '(tabs)', screen: 'feed', tasteNeeded: true })).toBeNull();
    });
  });
  describe('the first-run flow', () => {
    /**
     * The flow now begins at the motivation question rather than at the picker.
     *
     * The account exists by this point — auth is step 2 — so there is somewhere to put
     * an answer, and the two value screens come before the reader is asked to spend any
     * effort on a five-film selection.
     */
    it('sends a brand-new account to the top of the flow', () => {
      expect(decide({ tasteNeeded: true })).toBe('/onboarding/motivations');
    });

    it('sends an established account to the feed instead', () => {
      expect(decide({ tasteNeeded: false })).toBe('/(tabs)/feed');
    });

    /**
     * The blocker independent review found.
     *
     * Bucketing the first film writes a `user_media` row, so the account stops looking
     * new — which is the flow doing its job. Routing read that as a reason to end it and
     * replaced the screen with the feed at one of five; closing the app mid-flow did the
     * same on reopening. Routing now sends people *into* the flow and never takes them
     * out. The screen owns its exit.
     */
    it('leaves somebody in the flow once their first film makes them look established', () => {
      expect(
        decide({ group: 'onboarding', screen: 'taste', stage: 'taste', tasteNeeded: false }),
      ).toBeNull();
    });

    it('leaves them in it at five of five, so the summary is reachable', () => {
      expect(
        decide({ group: 'onboarding', screen: 'taste', stage: 'taste', tasteNeeded: false }),
      ).toBeNull();
    });

    /**
     * **Both cases above now carry a stage, and that is the change worth being explicit
     * about rather than quietly making.**
     *
     * They were written before the stage existed, when `tasteNeeded: false` inside the
     * group was the only description available of "mid-run, and the run itself is why you
     * look established". It is no longer a description of only that: with no stage at all
     * it is also, and much more commonly, an established account that opened an onboarding
     * link. The two were indistinguishable, so one of them had to lose.
     *
     * Sending the established account away is the right loser, because the state the old
     * rule protected is not reachable in a live session any more. Reaching an onboarding
     * route at all requires either a stage — which `advanceStage` writes to memory
     * synchronously, so it survives any failed disk write for the life of the process — or
     * `tasteNeeded`, which is what carries somebody with no stage in. A reader on the
     * picker walked through Motivations and Answers to get there and holds `taste`; the
     * bucketing that flips `tasteNeeded` underneath them cannot take that away.
     */
    it('sends an established account away from a link into the flow it never started', () => {
      expect(
        decide({ group: 'onboarding', screen: 'motivations', stage: null, tasteNeeded: false }),
      ).toBe('/(tabs)/feed');
    });

    it('and does not wait for anything to say so when the stage already has', () => {
      expect(
        decide({ group: 'onboarding', screen: 'answers', stage: 'done', tastePending: true }),
      ).toBe('/(tabs)/feed');
    });

    /**
     * The other side of it, which is the one that must not regress: an account that is
     * genuinely part-way through and has lost its stage is still carried by the phase.
     * `readState` answers **needed** for an `active` account even at five rankings,
     * because leaving is an act and not a count — so this stays.
     */
    it('keeps an incomplete account whose stage was lost', () => {
      expect(
        decide({ group: 'onboarding', screen: 'people', stage: null, tasteNeeded: true }),
      ).toBeNull();
    });

    it('does not bounce them out while the check is still pending either', () => {
      expect(
        decide({ group: 'onboarding', screen: 'taste', tastePending: true, tasteNeeded: undefined }),
      ).toBeNull();
    });

    it('never sends a signed-out user into it', () => {
      expect(decide({ status: 'signed-out', tasteNeeded: true })).toBe('/(auth)/sign-in');
    });

    it('never sends a user without a profile into it', () => {
      // The picker calls `useCurrentProfile`, which throws outside a ready session — and
      // the ranking it starts needs an account row anyway. An account that has walked the
      // two value screens and has no profile gets the form; one that has not gets the step
      // it is on. Neither is the picker.
      expect(decide({ status: 'onboarding', stage: 'taste', tasteNeeded: true })).toBe(
        '/(auth)/create-profile',
      );
      expect(decide({ status: 'onboarding', stage: null, tasteNeeded: true })).toBe(
        '/onboarding/motivations',
      );
    });
  });

  describe('a settled user', () => {
    it('is moved off the root index, which serves nothing', () => {
      expect(decide({ group: undefined })).toBe('/(tabs)/feed');
    });

    it('is moved out of the auth group once signed in', () => {
      expect(decide({ group: '(auth)', screen: 'sign-in' })).toBe('/(tabs)/feed');
    });

    it('is left alone anywhere else, so pushed detail routes are not yanked back', () => {
      expect(decide({ group: 'title', screen: '[id]' })).toBeNull();
      expect(decide({ group: '(tabs)', screen: 'feed' })).toBeNull();
      expect(decide({ group: 'settings' })).toBeNull();
    });
  });

  it('never returns the route it was already on, so there is no redirect loop', () => {
    // Every destination this can return, fed back in as the current location.
    const cases: { input: Partial<RoutingInput>; settled: string }[] = [
      { input: { status: 'signed-out', group: '(auth)', screen: 'sign-in' }, settled: 'sign-in' },
      {
        input: {
          status: 'onboarding',
          stage: 'taste',
          group: '(auth)',
          screen: 'create-profile',
        },
        settled: 'create-profile',
      },
      {
        input: { status: 'onboarding', group: 'onboarding', screen: 'motivations' },
        settled: 'motivations',
      },
      {
        input: {
          status: 'onboarding',
          stage: 'answers',
          group: 'onboarding',
          screen: 'answers',
        },
        settled: 'answers',
      },
      { input: { group: 'onboarding', screen: 'taste', tasteNeeded: true }, settled: 'taste' },
      { input: { group: '(tabs)', screen: 'feed' }, settled: 'feed' },
    ];

    for (const { input } of cases) expect(decide(input)).toBeNull();
  });
});
