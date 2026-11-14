/**
 * The social QA fixture's data, as a pure value.
 *
 * Nothing here touches the network, the clock or randomness: `buildPlan()` called twice
 * returns two deep-equal objects, every entry has a stable id, and every operation id is
 * derived from that id (a UUID v5-style hash), so a retried RPC after a dropped response is
 * the same operation rather than a second one.
 *
 * Titles are named by TMDB id and kind, never by uuid: a media_items uuid differs per
 * project, and the fixture never inserts catalogue rows. A title the target does not hold
 * is logged and its entries are skipped.
 *
 * See README.md for the scenario table.
 */
import { createHash } from 'node:crypto';

/** Written into every fixture account's `app_metadata`. Ownership requires it. */
export const FIXTURE_MARKER = 'social-v1';
export const MARKER_KEY = 'qa_fixture';

/** Accounts the fixture must never write to, edit or delete. */
export const PROTECTED_HANDLES = Object.freeze(['qa_refine_g3', 'bingdtest2']);
/**
 * The only accounts `--link-qa-accounts` may name, and only as the *target* of a follow or
 * a recommendation sent FROM a fixture account.
 */
export const QA_LINK_HANDLES = PROTECTED_HANDLES;

export const USERNAME_RULE = /^[a-z0-9_]{3,24}$/; // profiles.username_format, 20260813000200
export const FIXTURE_USERNAME_RULE = /^qa_fx_social_[1-9](_g[0-9]{1,3})?$/;
export const FIXTURE_EMAIL_DOMAIN = 'example.invalid'; // RFC 2606: never deliverable
export const DATE_OF_BIRTH = '1990-01-01';

/** Fixed namespace for operation ids. Changing it changes every operation id. */
const OPERATION_NAMESPACE = '6f1d3c52-5a0e-4c47-9a39-1b4f0e7c2a10';

function uuidBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** RFC 4122 §4.3 name-based UUID (version 5, SHA-1). */
export function uuidV5(name, namespace = OPERATION_NAMESPACE) {
  const hash = createHash('sha1')
    .update(uuidBytes(namespace))
    .update(String(name), 'utf8')
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The operation id for one RPC of one entry. Includes the generation, so a fresh
 * generation (after a teardown) never replays a ledger row; the ledger is per user anyway.
 */
export function operationId(generation, entryId, suffix = 'op') {
  return uuidV5(`qa-fixture:${FIXTURE_MARKER}:g${generation}:${entryId}:${suffix}`);
}

/**
 * Usernames are permanently reserved once a profile is deleted (`username_history`,
 * 20260813001500), so a teardown retires a generation's handles for good. Generation 1 is
 * the canonical `qa_fx_social_N`; a later generation suffixes `_gK`.
 */
export function usernameFor(index, generation = 1) {
  return generation === 1 ? `qa_fx_social_${index}` : `qa_fx_social_${index}_g${generation}`;
}

export const TITLES = Object.freeze([
  { key: 'tmdb150540', kind: 'movie', tmdbId: 150540, label: 'Inside Out (2015)' },
  { key: 'tmdb361743', kind: 'movie', tmdbId: 361743, label: 'Top Gun: Maverick (2022)' },
  { key: 'tmdb2062', kind: 'movie', tmdbId: 2062, label: 'Ratatouille (2007)' },
]);

const ACCOUNT_SHAPES = [
  { key: 'fx1', index: 1, visibility: 'public' },
  { key: 'fx2', index: 2, visibility: 'public' },
  { key: 'fx3', index: 3, visibility: 'public' },
  { key: 'fx4', index: 4, visibility: 'public' },
  { key: 'fx5', index: 5, visibility: 'private' },
];

/*
 * The scenario, in execution order. Order matters twice: a ranking's position depends on
 * what the same user had ranked before it, and a follow must exist before a
 * recommendation or a Helpful that depends on it.
 */
const RANKINGS = [
  // user, title, bucket, placement within the bucket's band at the moment it is ranked
  ['fx1', 'tmdb150540', 'loved', 'top', '2026-03-07'],
  ['fx1', 'tmdb2062', 'loved', 'bottom', '2026-03-14'],
  ['fx1', 'tmdb361743', 'fine', 'top', '2026-03-21'],
  ['fx2', 'tmdb361743', 'loved', 'top', '2026-04-04'],
  ['fx2', 'tmdb150540', 'fine', 'top', '2026-04-11'],
  ['fx3', 'tmdb150540', 'not_for_me', 'top', '2026-05-02'],
  ['fx3', 'tmdb2062', 'fine', 'top', '2026-05-09'],
  ['fx4', 'tmdb2062', 'loved', 'top', '2026-06-06'],
  ['fx4', 'tmdb150540', 'loved', 'bottom', '2026-06-13'],
  ['fx5', 'tmdb361743', 'loved', 'top', '2026-07-04'],
];

/** Watched, bucketed through `log_title`, never ranked: score is null on the Reviews tab. */
const LOGS = [
  ['fx2', 'tmdb2062', 'fine', '2026-04-18'],
  ['fx4', 'tmdb361743', 'loved', '2026-06-20'],
];

const NOTES = [
  // user, title, visibility, spoilers, text
  [
    'fx1',
    'tmdb150540',
    'public',
    false,
    'QA fixture review: the core memories sequence still lands.',
  ],
  [
    'fx2',
    'tmdb150540',
    'public',
    false,
    'QA fixture review: fine, a little long in the middle.',
  ],
  [
    'fx3',
    'tmdb150540',
    'public',
    true,
    'QA fixture review (spoilers): Bing Bong does not make it out.',
  ],
  [
    'fx4',
    'tmdb150540',
    'public',
    false,
    'QA fixture review: loved it, just not as much as Ratatouille.',
  ],
  ['fx1', 'tmdb2062', 'public', false, 'QA fixture review: the critic monologue is the film.'],
  [
    'fx2',
    'tmdb2062',
    'public',
    false,
    'QA fixture review on an unranked log: no score on purpose.',
  ],
  ['fx3', 'tmdb2062', 'public', false, 'QA fixture review: charming, forgettable.'],
  ['fx4', 'tmdb2062', 'public', false, 'QA fixture review: the best Pixar film, ranked first.'],
  ['fx1', 'tmdb361743', 'public', false, 'QA fixture review: fine, loud, efficient.'],
  ['fx4', 'tmdb361743', 'public', false, 'QA fixture review on an unranked log of Top Gun.'],
  [
    'fx2',
    'tmdb361743',
    'private',
    false,
    'QA fixture PRIVATE note: must never be visible to anybody else.',
  ],
  [
    'fx5',
    'tmdb361743',
    'public',
    false,
    'QA fixture review from a private account: approved followers only.',
  ],
];

const FOLLOWS = [
  // follower, followee, state the follow call itself answers
  ['fx1', 'fx2', 'approved'],
  ['fx2', 'fx1', 'approved'],
  ['fx2', 'fx3', 'approved'],
  ['fx3', 'fx2', 'approved'],
  ['fx4', 'fx1', 'approved'],
  ['fx3', 'fx5', 'pending'],
  ['fx4', 'fx5', 'pending'],
];

/** fx5 (private) approves fx3 and leaves fx4 pending. */
const APPROVALS = [['fx5', 'fx3']];

const RECOMMENDATIONS = [
  // sender, recipient, title, expected state, what the recipient does with it
  ['fx1', 'fx2', 'tmdb2062', 'delivered', 'opened'],
  ['fx3', 'fx2', 'tmdb150540', 'delivered', 'seen'],
  ['fx2', 'fx3', 'tmdb361743', 'delivered', 'unread'],
  ['fx2', 'fx1', 'tmdb150540', 'delivered', 'unread'],
  ['fx4', 'fx1', 'tmdb361743', 'pending', 'unread'],
  ['fx3', 'fx5', 'tmdb2062', 'pending', 'unread'],
];

const HELPFUL = [
  // voter, review entry id
  ['fx2', 'review:fx1:tmdb150540'],
  ['fx3', 'review:fx1:tmdb150540'],
  ['fx4', 'review:fx1:tmdb150540'],
  ['fx1', 'review:fx2:tmdb150540'],
  ['fx1', 'review:fx2:tmdb2062'],
  ['fx3', 'review:fx5:tmdb361743'],
];

/** `--link-qa-accounts` only. Fixture → QA, never the other way. */
const LINK_FOLLOWS = [
  ['fx1', 'qa_refine_g3'],
  ['fx1', 'bingdtest2'],
  ['fx2', 'qa_refine_g3'],
  ['fx2', 'bingdtest2'],
];
const LINK_RECOMMENDATIONS = [
  ['fx1', 'qa_refine_g3', 'tmdb150540'],
  ['fx1', 'bingdtest2', 'tmdb150540'],
];

function noteId(user, title, visibility) {
  return `${visibility === 'public' ? 'review' : 'note'}:${user}:${title}`;
}

/**
 * @param {{ generation?: number, linkQaAccounts?: boolean }} [options]
 */
export function buildPlan({ generation = 1, linkQaAccounts = false } = {}) {
  if (!Number.isInteger(generation) || generation < 1 || generation > 999) {
    throw new Error(`generation must be an integer from 1 to 999, not ${generation}`);
  }
  const op = (id, suffix) => operationId(generation, id, suffix);

  const accounts = ACCOUNT_SHAPES.map(({ key, index, visibility }) => {
    const username = usernameFor(index, generation);
    return {
      key,
      username,
      displayName:
        generation === 1 ? `QA Fixture ${index}` : `QA Fixture ${index} (g${generation})`,
      email: `${username}@${FIXTURE_EMAIL_DOMAIN}`,
      dateOfBirth: DATE_OF_BIRTH,
      visibility,
    };
  });

  const entries = [];

  for (const account of accounts) {
    if (account.visibility !== 'public') {
      const id = `visibility:${account.key}`;
      entries.push({
        id,
        type: 'visibility',
        actor: account.key,
        visibility: account.visibility,
        operationId: op(id),
      });
    }
  }

  for (const [actor, title, bucket, placement, watchedOn] of RANKINGS) {
    const id = `ranking:${actor}:${title}`;
    entries.push({
      id,
      type: 'ranking',
      actor,
      title,
      bucket,
      placement,
      watchedOn,
      operationIds: { start: op(id, 'rank_start'), watchDate: op(id, 'set_watch_date') },
    });
  }

  for (const [actor, title, bucket, watchedOn] of LOGS) {
    const id = `log:${actor}:${title}`;
    entries.push({
      id,
      type: 'log',
      actor,
      title,
      bucket,
      watchedOn,
      operationId: op(id, 'log_title'),
    });
  }

  for (const [actor, title, visibility, spoilers, text] of NOTES) {
    const id = noteId(actor, title, visibility);
    entries.push({
      id,
      type: 'note',
      actor,
      title,
      visibility,
      spoilers,
      text,
      operationId: op(id, 'save_note'),
    });
  }

  for (const [actor, target, state] of FOLLOWS) {
    const id = `follow:${actor}>${target}`;
    entries.push({
      id,
      type: 'follow',
      actor,
      target,
      expectedState: state,
      operationId: op(id, 'follow'),
    });
  }

  for (const [actor, requester] of APPROVALS) {
    const id = `approve:${actor}<${requester}`;
    entries.push({
      id,
      type: 'approve',
      actor,
      requester,
      operationId: op(id, 'respond_follow_request'),
    });
  }

  for (const [actor, recipient, title, expectedState, readState] of RECOMMENDATIONS) {
    const id = `rec:${actor}>${recipient}:${title}`;
    entries.push({
      id,
      type: 'recommend',
      actor,
      recipient,
      title,
      message: `QA fixture recommendation ${actor} to ${recipient}.`,
      expectedState,
      readState,
      operationIds: {
        send: op(id, 'recommend_title'),
        seen: op(id, 'mark_recommendations_seen'),
      },
    });
  }

  for (const [actor, review] of HELPFUL) {
    const id = `helpful:${actor}>${review}`;
    entries.push({
      id,
      type: 'helpful',
      actor,
      review,
      operationId: op(id, 'set_review_helpful'),
    });
  }

  if (linkQaAccounts) {
    for (const [actor, handle] of LINK_FOLLOWS) {
      const id = `link-follow:${actor}>@${handle}`;
      entries.push({
        id,
        type: 'follow',
        link: true,
        actor,
        target: `@${handle}`,
        expectedState: 'approved|pending',
        operationId: op(id, 'follow'),
      });
    }
    for (const [actor, handle, title] of LINK_RECOMMENDATIONS) {
      const id = `link-rec:${actor}>@${handle}:${title}`;
      entries.push({
        id,
        type: 'recommend',
        link: true,
        actor,
        recipient: `@${handle}`,
        title,
        message: 'QA fixture recommendation for manual QA.',
        expectedState: 'delivered|pending',
        readState: 'untouched',
        operationIds: {
          send: op(id, 'recommend_title'),
          seen: op(id, 'mark_recommendations_seen'),
        },
      });
    }
  }

  const plan = {
    marker: FIXTURE_MARKER,
    generation,
    linkQaAccounts: Boolean(linkQaAccounts),
    accounts,
    titles: TITLES.map((title) => ({ ...title })),
    entries,
  };
  validatePlan(plan);
  return plan;
}

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

/** A `@handle` reference, which only link entries may carry. */
export function externalHandle(ref) {
  return typeof ref === 'string' && ref.startsWith('@') ? ref.slice(1) : null;
}

/**
 * Refuses any plan that would write to, or as, anything but a fixture account.
 *
 * Every actor is a fixture key. Every follow, approval, recommendation and Helpful targets a
 * fixture key, except a `link: true` follow or recommendation, which may target exactly one
 * of QA_LINK_HANDLES and nothing else. Protected handles may never appear anywhere else.
 */
export function validatePlan(plan) {
  const keys = new Set();
  const usernames = new Set();
  for (const account of plan.accounts) {
    if (!/^fx[1-9]$/.test(account.key)) throw new PlanError(`bad account key ${account.key}`);
    if (
      !USERNAME_RULE.test(account.username) ||
      !FIXTURE_USERNAME_RULE.test(account.username)
    ) {
      throw new PlanError(`${account.username} is not a fixture username`);
    }
    if (PROTECTED_HANDLES.includes(account.username)) {
      throw new PlanError(`${account.username} is a protected QA account`);
    }
    if (account.email !== `${account.username}@${FIXTURE_EMAIL_DOMAIN}`) {
      throw new PlanError(
        `${account.username} must use ${account.username}@${FIXTURE_EMAIL_DOMAIN}`,
      );
    }
    if (account.displayName.length > 50)
      throw new PlanError(`${account.key} display name too long`);
    keys.add(account.key);
    usernames.add(account.username);
  }

  const titleKeys = new Set(plan.titles.map((t) => t.key));
  const ids = new Set();
  const opIds = new Set();
  const reviewAuthors = new Map();

  const isFixture = (ref) => keys.has(ref);
  const assertFixture = (entry, ref, role) => {
    if (!isFixture(ref)) {
      throw new PlanError(
        `${entry.id}: ${role} ${JSON.stringify(ref)} is not a fixture account`,
      );
    }
  };

  for (const entry of plan.entries) {
    if (ids.has(entry.id)) throw new PlanError(`duplicate entry id ${entry.id}`);
    ids.add(entry.id);
    for (const value of [entry.operationId, ...Object.values(entry.operationIds ?? {})]) {
      if (value === undefined) continue;
      if (opIds.has(value)) throw new PlanError(`${entry.id}: duplicate operation id`);
      opIds.add(value);
    }

    assertFixture(entry, entry.actor, 'actor');
    if (entry.title !== undefined && !titleKeys.has(entry.title)) {
      throw new PlanError(`${entry.id}: unknown title ${entry.title}`);
    }

    const targetRef = entry.target ?? entry.recipient ?? entry.requester;
    if (targetRef !== undefined) {
      const handle = externalHandle(targetRef);
      if (handle !== null) {
        if (!entry.link)
          throw new PlanError(
            `${entry.id}: only --link-qa-accounts entries may name @${handle}`,
          );
        if (!QA_LINK_HANDLES.includes(handle)) {
          throw new PlanError(`${entry.id}: @${handle} is not one of the QA link handles`);
        }
        if (entry.type !== 'follow' && entry.type !== 'recommend') {
          throw new PlanError(
            `${entry.id}: a QA account may only be followed or recommended to`,
          );
        }
      } else {
        assertFixture(entry, targetRef, 'target');
        if (targetRef === entry.actor)
          throw new PlanError(`${entry.id}: an account cannot target itself`);
      }
    }
    if (entry.link && externalHandle(targetRef) === null) {
      throw new PlanError(`${entry.id}: a link entry must target a QA handle`);
    }

    if (entry.type === 'note' && entry.visibility === 'public')
      reviewAuthors.set(entry.id, entry.actor);
    if (entry.type === 'helpful') {
      const author = reviewAuthors.get(entry.review);
      if (author === undefined)
        throw new PlanError(`${entry.id}: ${entry.review} is not an earlier public review`);
      if (author === entry.actor)
        throw new PlanError(`${entry.id}: self-votes are not allowed`);
    }
    if (
      (entry.type === 'ranking' || entry.type === 'log') &&
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.watchedOn)
    ) {
      throw new PlanError(`${entry.id}: watchedOn must be a fixed ISO date`);
    }
  }

  // Protected handles may only appear as link targets; usernames never collide with them.
  for (const handle of PROTECTED_HANDLES) {
    if (usernames.has(handle)) throw new PlanError(`plan names protected account ${handle}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Expectations derived from the plan, for verify and for the in-memory fake.
// ---------------------------------------------------------------------------

/** `score_for` (20260815010000), transcribed. Mirrors src/features/collection/score.ts. */
export function scoreFor(bucket, bandRank, bandSize) {
  const high = bucket === 'loved' ? 10.0 : bucket === 'fine' ? 6.9 : 3.4;
  const low = bucket === 'loved' ? 7.0 : bucket === 'fine' ? 3.5 : 0.0;
  let value;
  if (bandSize <= 1 || bandRank <= 1) value = high;
  else if (bandRank >= bandSize) value = low;
  else value = high - ((bandRank - 1) * (high - low)) / (bandSize - 1);
  return Math.round(value * 10) / 10;
}

/** Final band order per user and bucket, from the ranking entries in order. */
export function expectedBands(plan, skipped = new Set()) {
  const bands = {};
  for (const entry of plan.entries) {
    if (entry.type !== 'ranking' || skipped.has(entry.id)) continue;
    bands[entry.actor] ??= { loved: [], fine: [], not_for_me: [] };
    const band = bands[entry.actor][entry.bucket];
    if (entry.placement === 'top') band.unshift(entry.title);
    else band.push(entry.title);
  }
  return bands;
}

/** `{ [user]: { [title]: score } }` for every ranked title. Unranked titles are absent. */
export function expectedScores(plan, skipped = new Set()) {
  const out = {};
  for (const [user, buckets] of Object.entries(expectedBands(plan, skipped))) {
    out[user] = {};
    for (const [bucket, titles] of Object.entries(buckets)) {
      titles.forEach((title, i) => {
        out[user][title] = scoreFor(bucket, i + 1, titles.length);
      });
    }
  }
  return out;
}

/** Final follow state follower → followee among fixture accounts. */
export function expectedFollowStates(plan) {
  const states = {};
  for (const entry of plan.entries) {
    if (entry.type === 'follow' && !entry.link)
      states[`${entry.actor}>${entry.target}`] = entry.expectedState;
    if (entry.type === 'approve') states[`${entry.requester}>${entry.actor}`] = 'approved';
  }
  return states;
}

/** Whether `viewer` may read `author`'s public writing, by the plan's own graph. */
export function expectedCanView(plan, viewer, author) {
  if (viewer === author) return true;
  const account = plan.accounts.find((a) => a.key === author);
  if (account?.visibility !== 'private') return true;
  return expectedFollowStates(plan)[`${viewer}>${author}`] === 'approved';
}

/** `{ [review entry id]: count }` for every public review. */
export function expectedHelpfulCounts(plan, skipped = new Set()) {
  const counts = {};
  for (const entry of plan.entries) {
    if (entry.type === 'note' && entry.visibility === 'public' && !skipped.has(entry.id))
      counts[entry.id] = 0;
  }
  for (const entry of plan.entries) {
    if (entry.type === 'helpful' && !skipped.has(entry.id)) counts[entry.review] += 1;
  }
  return counts;
}

/** Entries that touch a given title, for skip propagation when the title is missing. */
export function entriesForTitle(plan, titleKey) {
  return plan.entries.filter(
    (e) => e.title === titleKey || (e.review && e.review.endsWith(`:${titleKey}`)),
  );
}
