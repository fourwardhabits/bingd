/**
 * An in-memory stand-in for the Supabase surface the fixture uses, for the unit tests.
 *
 * It implements the client interface in `client.mjs` (admin, signIn, rpc, select,
 * environmentName) over a small model of the real rules the fixture depends on: operation
 * ids claimed per user, public vs private profiles and approved/pending follows,
 * recommendations that need an approved follow and are delivered only to a follower, a
 * Helpful that refuses self-votes and invisible reviews, binary-insertion ranking with
 * `score_for`, usernames reserved after deletion, and `delete_account` cascading.
 *
 * It is deliberately NOT a re-implementation of the database: `supabase/tests/*.test.mjs`
 * prove the SQL. This proves the fixture's own logic: what it reads, what it writes, in
 * which order, as whom, and that a second run writes nothing.
 *
 * Every mutating call is appended to `writes` as { actor, name }; reads are not.
 */
import { scoreFor } from './plan.mjs';

const BUCKET_ORDER = ['loved', 'fine', 'not_for_me'];

class RpcRefusal extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createFakeBackend({
  environment = 'nonprod',
  media,
  appMetadataWritable = true,
} = {}) {
  let seq = 0;
  const nextId = (prefix) => {
    seq += 1;
    const hex = seq.toString(16).padStart(12, '0');
    return `${prefix.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${hex}`;
  };

  const users = new Map(); // id -> auth user
  const profiles = new Map(); // id -> profile
  const reserved = new Set();
  const userMedia = new Map(); // `${user}:${media}` -> row
  const rankings = new Map(); // user -> [{ media, bucket }] in position order
  const sessions = new Map(); // session id -> { user, media, bucket, lo, hi }
  const follows = new Map(); // `${a}>${b}` -> state
  const recs = []; // { id, sender, recipient, media, state, opened_at, seen_at, message }
  const votes = new Set(); // `${reviewId}:${user}`
  const operations = new Map(); // `${user}:${op}` -> { kind, result }
  const notifications = []; // { recipient, type, actor }
  const deviceTokens = [];
  const writes = [];
  const calls = [];
  let clock = Date.parse('2026-11-14T12:00:00Z');
  const now = () => new Date((clock += 1000)).toISOString();

  const mediaItems = (
    media ?? [
      { tmdb_id: 150540, title: 'Inside Out', release_date: '2015-06-19' },
      { tmdb_id: 361743, title: 'Top Gun: Maverick', release_date: '2022-05-27' },
      { tmdb_id: 2062, title: 'Ratatouille', release_date: '2007-06-29' },
    ]
  ).map((m) => ({ id: nextId('media'), kind: 'movie', ...m }));

  const tokens = new Map(); // token -> user id
  const tokenFor = (id) => `eyJfake.${id}.sig-${id.slice(-6)}`;

  // -------------------------------------------------------------------------
  // helpers mirroring the SQL predicates
  // -------------------------------------------------------------------------
  const isApproved = (a, b) => follows.get(`${a}>${b}`) === 'approved';
  const canView = (viewer, author) => {
    const p = profiles.get(author);
    if (!p || p.status !== 'active') return false;
    return viewer === author || p.visibility === 'public' || isApproved(viewer, author);
  };
  const ranksOf = (user) => {
    if (!rankings.has(user)) rankings.set(user, []);
    return rankings.get(user);
  };
  const band = (user, bucket) => ranksOf(user).filter((r) => r.bucket === bucket);
  const scoreOf = (user, mediaId) => {
    const r = ranksOf(user).find((x) => x.media === mediaId);
    if (!r) return null;
    const members = band(user, r.bucket);
    return scoreFor(r.bucket, members.indexOf(r) + 1, members.length);
  };
  const claim = (user, op, kind) => {
    if (!op) throw new RpcRefusal(400, '22023', 'operation_id is required');
    const key = `${user}:${op}`;
    const prior = operations.get(key);
    if (prior) {
      if (prior.kind !== kind)
        throw new RpcRefusal(
          400,
          '22023',
          'operation id already used for a different operation',
        );
      return { claimed: false, prior: prior.result };
    }
    operations.set(key, { kind, result: null });
    return { claimed: true };
  };
  const record = (user, op, value) => {
    const entry = operations.get(`${user}:${op}`);
    if (entry) entry.result = value;
    return value;
  };
  const ensureRow = (user, mediaId, fields = {}) => {
    const key = `${user}:${mediaId}`;
    if (!userMedia.has(key)) {
      userMedia.set(key, {
        id: nextId('um'),
        user_id: user,
        media_item_id: mediaId,
        bucket: null,
        note: null,
        note_visibility: 'private',
        note_has_spoilers: false,
        note_updated_at: null,
        watched_on: null,
        watch_events: 1, // the seen-implies-a-watch backstop
      });
    }
    return Object.assign(userMedia.get(key), fields);
  };
  const finalize = (user, s, index) => {
    const list = ranksOf(user);
    const members = band(user, s.bucket);
    const entry = { media: s.media, bucket: s.bucket };
    if (members.length === 0) {
      // Insert after every higher bucket's members.
      const before = list.filter(
        (r) => BUCKET_ORDER.indexOf(r.bucket) <= BUCKET_ORDER.indexOf(s.bucket),
      ).length;
      list.splice(before, 0, entry);
    } else if (index >= members.length) {
      list.splice(list.indexOf(members[members.length - 1]) + 1, 0, entry);
    } else {
      list.splice(list.indexOf(members[index]), 0, entry);
    }
    ensureRow(user, s.media, { bucket: s.bucket });
    sessions.delete(s.id);
    return { done: true, media_item_id: s.media, bucket: s.bucket };
  };
  const comparison = (s) => {
    const members = band(s.user, s.bucket);
    const pivot = Math.floor((s.lo + s.hi) / 2);
    s.pivot = pivot;
    return { done: false, session_id: s.id, pivot: members[pivot].media };
  };
  const notify = (recipient, type, actor) => notifications.push({ recipient, type, actor });

  // -------------------------------------------------------------------------
  // RPCs
  // -------------------------------------------------------------------------
  const RPC = {
    environment_name: { read: true, fn: () => environment },

    create_profile(uid, { p_username, p_display_name }) {
      if (profiles.has(uid)) throw new RpcRefusal(409, '42710', 'profile already exists');
      const username = String(p_username).toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(username))
        throw new RpcRefusal(400, '22023', 'bad username');
      const taken =
        [...profiles.values()].some((p) => p.username === username) || reserved.has(username);
      if (taken) throw new RpcRefusal(409, '23505', 'username unavailable');
      profiles.set(uid, {
        id: uid,
        username,
        display_name: p_display_name ?? username,
        visibility: 'public',
        status: 'active',
      });
      return { ok: true };
    },

    set_profile_visibility(uid, { p_operation_id, p_visibility }) {
      if (!claim(uid, p_operation_id, 'set_profile_visibility').claimed)
        return { status: 'already_applied' };
      profiles.get(uid).visibility = p_visibility;
      if (p_visibility === 'public') {
        for (const [k, v] of follows)
          if (k.endsWith(`>${uid}`) && v === 'pending') follows.set(k, 'approved');
      }
      return { status: 'ok' };
    },

    rank_start(uid, { p_media_item_id, p_bucket, p_operation_id }) {
      const c = claim(uid, p_operation_id, 'rank_start');
      if (!c.claimed) return c.prior ?? { done: false, already_applied: true };
      if (!mediaItems.some((m) => m.id === p_media_item_id))
        throw new RpcRefusal(404, 'P0002', 'no such title');
      if (ranksOf(uid).some((r) => r.media === p_media_item_id))
        throw new RpcRefusal(400, '22023', 'already ranked');
      const s = {
        id: nextId('sess'),
        user: uid,
        media: p_media_item_id,
        bucket: p_bucket,
        lo: 0,
        hi: band(uid, p_bucket).length,
      };
      sessions.set(s.id, s);
      return record(uid, p_operation_id, s.lo >= s.hi ? finalize(uid, s, 0) : comparison(s));
    },

    rank_answer(uid, { p_session_id, p_winner, p_operation_id }) {
      const c = claim(uid, p_operation_id, 'rank_answer');
      if (!c.claimed) return c.prior ?? { done: false, already_applied: true };
      const s = sessions.get(p_session_id);
      if (!s || s.user !== uid) throw new RpcRefusal(404, 'P0002', 'no such ranking session');
      const pivotMedia = band(uid, s.bucket)[s.pivot].media;
      if (p_winner !== s.media && p_winner !== pivotMedia)
        throw new RpcRefusal(400, '22023', 'winner must be one of the two');
      if (p_winner === s.media) s.hi = s.pivot;
      else s.lo = s.pivot + 1;
      return record(uid, p_operation_id, s.lo >= s.hi ? finalize(uid, s, s.lo) : comparison(s));
    },

    set_watch_date(uid, { p_operation_id, p_media_item_id, p_watched_on }) {
      const c = claim(uid, p_operation_id, 'set_watch_date');
      if (!c.claimed) return c.prior ?? { status: 'already_applied' };
      const row = userMedia.get(`${uid}:${p_media_item_id}`);
      if (!row) throw new RpcRefusal(404, 'P0002', 'title is not in your collection');
      if (row.watch_events > 1) throw new RpcRefusal(400, 'P0001', 'multiple_watches');
      row.watched_on = p_watched_on;
      return record(uid, p_operation_id, { status: 'ok' });
    },

    log_title(uid, { p_operation_id, p_media_item_id, p_bucket, p_watched_on }) {
      const c = claim(uid, p_operation_id, 'log_title');
      if (!c.claimed) return c.prior ?? { status: 'already_applied' };
      if (ranksOf(uid).some((r) => r.media === p_media_item_id))
        throw new RpcRefusal(400, '22023', 'already ranked');
      const existed = userMedia.has(`${uid}:${p_media_item_id}`);
      ensureRow(uid, p_media_item_id, {
        bucket: p_bucket,
        ...(existed ? {} : { watched_on: p_watched_on }),
      });
      return record(uid, p_operation_id, { status: 'ok', created: !existed });
    },

    save_note(
      uid,
      {
        p_operation_id,
        p_media_item_id,
        p_note,
        p_base_updated_at,
        p_note_visibility,
        p_note_spoilers,
      },
    ) {
      if (!claim(uid, p_operation_id, 'save_note').claimed)
        return { status: 'already_applied' };
      const row = userMedia.get(`${uid}:${p_media_item_id}`);
      if (!row) throw new RpcRefusal(404, 'P0002', 'not in your collection');
      if (
        p_base_updated_at &&
        row.note_updated_at &&
        p_base_updated_at !== row.note_updated_at
      ) {
        throw new RpcRefusal(409, '55000', 'the note changed elsewhere');
      }
      const fresh = row.note_updated_at === null;
      row.note = p_note;
      row.note_visibility = p_note_visibility ?? (fresh ? 'private' : row.note_visibility);
      row.note_has_spoilers = p_note_spoilers ?? (fresh ? false : row.note_has_spoilers);
      row.note_updated_at = now();
      return { status: 'ok', note_version: row.note_updated_at };
    },

    follow(uid, { p_operation_id, p_followee_id }) {
      if (!claim(uid, p_operation_id, 'follow').claimed) return { status: 'already_applied' };
      const target = profiles.get(p_followee_id);
      if (!target || target.status !== 'active' || p_followee_id === uid)
        throw new RpcRefusal(404, 'P0002', 'not found');
      const key = `${uid}>${p_followee_id}`;
      if (follows.has(key)) return { status: 'ok', state: follows.get(key) };
      const state = target.visibility === 'private' ? 'pending' : 'approved';
      follows.set(key, state);
      notify(p_followee_id, state === 'approved' ? 'follow' : 'follow_request', uid);
      return { status: 'ok', state };
    },

    respond_follow_request(uid, { p_operation_id, p_requester_id, p_approve }) {
      if (!claim(uid, p_operation_id, 'respond_follow_request').claimed)
        return { status: 'already_applied' };
      const key = `${p_requester_id}>${uid}`;
      if (follows.get(key) !== 'pending') return { status: 'ok', found: false };
      if (p_approve) follows.set(key, 'approved');
      else follows.delete(key);
      return { status: 'ok', found: true };
    },

    recommend_title(uid, { p_operation_id, p_recipient_id, p_media_item_id, p_message }) {
      if (!claim(uid, p_operation_id, 'recommend_title').claimed)
        return { status: 'already_applied' };
      if (p_recipient_id === uid) return { status: 'refused', reason: 'yourself' };
      if (!isApproved(uid, p_recipient_id))
        return { status: 'refused', reason: 'not_following' };
      const direct = isApproved(p_recipient_id, uid);
      let row = recs.find(
        (r) =>
          r.sender === uid && r.recipient === p_recipient_id && r.media === p_media_item_id,
      );
      const created = !row;
      if (!row) {
        const pending = recs.filter(
          (r) => r.sender === uid && r.recipient === p_recipient_id && r.state === 'pending',
        ).length;
        if (!direct && pending >= 5) return { status: 'refused', reason: 'too_many_pending' };
        row = {
          id: nextId('rec'),
          sender: uid,
          recipient: p_recipient_id,
          media: p_media_item_id,
          state: direct ? 'delivered' : 'pending',
          opened_at: null,
          seen_at: null,
          message: p_message,
          recommended_at: now(),
        };
        recs.push(row);
        if (row.state === 'delivered') notify(p_recipient_id, 'recommendation', uid);
      }
      return { status: 'ok', created, id: row.id, delivered: row.state === 'delivered' };
    },

    mark_recommendation_opened(uid, { p_recommendation_id }) {
      const row = recs.find(
        (r) => r.id === p_recommendation_id && r.recipient === uid && r.opened_at === null,
      );
      if (row) row.opened_at = now();
      return { status: 'ok', opened: Boolean(row) };
    },

    mark_recommendations_seen(uid, { p_operation_id, p_ids }) {
      if (!claim(uid, p_operation_id, 'mark_recommendations_seen').claimed)
        return { status: 'already_applied' };
      let marked = 0;
      for (const r of recs) {
        if (
          p_ids.includes(r.id) &&
          r.recipient === uid &&
          r.state === 'delivered' &&
          r.seen_at === null
        ) {
          r.seen_at = now();
          marked += 1;
        }
      }
      return { status: 'ok', marked };
    },

    set_review_helpful(uid, { p_operation_id, p_review_id, p_helpful }) {
      const row = [...userMedia.values()].find((r) => r.id === p_review_id);
      const author =
        row && row.note && row.note_visibility === 'public' && canView(uid, row.user_id)
          ? row.user_id
          : null;
      if (!author) throw new RpcRefusal(404, 'P0002', 'no such review');
      if (author === uid)
        throw new RpcRefusal(403, '42501', 'you cannot mark your own review helpful');
      if (claim(uid, p_operation_id, 'set_review_helpful').claimed) {
        if (p_helpful) votes.add(`${p_review_id}:${uid}`);
        else votes.delete(`${p_review_id}:${uid}`);
      }
      return {
        status: 'ok',
        review_id: p_review_id,
        helpful_count: [...votes].filter((v) => v.startsWith(`${p_review_id}:`)).length,
      };
    },

    delete_account(uid, { p_confirmation }) {
      const p = profiles.get(uid);
      if (!p) return { status: 'already_applied' };
      if (String(p_confirmation).toLowerCase() !== p.username)
        throw new RpcRefusal(400, '22023', 'type your username to confirm');
      removeUser(uid);
      return { status: 'ok', avatars_remaining: 0 };
    },

    register_device_token(uid) {
      deviceTokens.push(uid);
      return { status: 'ok' };
    },

    follow_state_with: {
      read: true,
      fn: (uid, { p_user_ids }) =>
        p_user_ids.map((id) => ({
          user_id: id,
          following: follows.get(`${uid}>${id}`) ?? null,
          followed_by: follows.get(`${id}>${uid}`) ?? null,
          blocked: false,
        })),
    },

    recommendations_to_me: {
      read: true,
      fn: (uid) =>
        recs
          .filter((r) => r.recipient === uid && r.state === 'delivered')
          .map((r) => ({
            id: r.id,
            sender_id: r.sender,
            media_item_id: r.media,
            opened_at: r.opened_at,
            seen_at: r.seen_at,
            message: r.message,
          })),
    },

    recommendation_requests: {
      read: true,
      fn: (uid) =>
        recs
          .filter((r) => r.recipient === uid && r.state === 'pending')
          .map((r) => ({ id: r.id, sender_id: r.sender, media_item_id: r.media })),
    },

    title_reviews_v2: {
      read: true,
      fn: (uid, { p_media_item_id, p_limit }) =>
        [...userMedia.values()]
          .filter(
            (r) =>
              r.media_item_id === p_media_item_id &&
              r.note &&
              r.note_visibility === 'public' &&
              canView(uid, r.user_id),
          )
          .map((r) => {
            const mine = [...votes].filter((v) => v.startsWith(`${r.id}:`));
            return {
              id: r.id,
              user_id: r.user_id,
              username: profiles.get(r.user_id).username,
              display_name: profiles.get(r.user_id).display_name,
              note: r.note,
              has_spoilers: r.note_has_spoilers,
              updated_at: r.note_updated_at,
              score: scoreOf(r.user_id, p_media_item_id),
              reaction_count: 0,
              helpful_count: mine.length,
              viewer_helpful: votes.has(`${r.id}:${uid}`),
            };
          })
          .slice(0, p_limit ?? 25),
    },

    title_review_count: {
      read: true,
      fn: (uid, { p_media_item_id }) =>
        [...userMedia.values()].filter(
          (r) =>
            r.media_item_id === p_media_item_id &&
            r.note &&
            r.note_visibility === 'public' &&
            canView(uid, r.user_id),
        ).length,
    },

    search_users: {
      read: true,
      fn: (uid, { p_query, p_limit }) =>
        [...profiles.values()]
          .filter(
            (p) => p.status === 'active' && p.username.includes(String(p_query).toLowerCase()),
          )
          .slice(0, p_limit ?? 10)
          .map((p) => ({
            id: p.id,
            username: p.username,
            display_name: p.display_name,
            visibility: p.visibility,
          })),
    },
  };

  function removeUser(uid) {
    const p = profiles.get(uid);
    if (p) reserved.add(p.username);
    profiles.delete(uid);
    users.delete(uid);
    for (const [k, r] of userMedia) {
      if (r.user_id === uid) {
        userMedia.delete(k);
        for (const v of [...votes]) if (v.startsWith(`${r.id}:`)) votes.delete(v);
      }
    }
    rankings.delete(uid);
    for (const k of [...follows.keys()])
      if (k.startsWith(`${uid}>`) || k.endsWith(`>${uid}`)) follows.delete(k);
    for (let i = recs.length - 1; i >= 0; i -= 1)
      if (recs[i].sender === uid || recs[i].recipient === uid) recs.splice(i, 1);
    for (const v of [...votes]) if (v.endsWith(`:${uid}`)) votes.delete(v);
    for (const k of [...operations.keys()]) if (k.startsWith(`${uid}:`)) operations.delete(k);
    for (const [t, id] of tokens) if (id === uid) tokens.delete(t);
  }

  // -------------------------------------------------------------------------
  // selects (RLS approximated: own rows, or what can_view_profile allows)
  // -------------------------------------------------------------------------
  const TABLES = {
    profiles: (uid) => [...profiles.values()].filter((p) => canView(uid, p.id)),
    user_media: (uid) => [...userMedia.values()].filter((r) => r.user_id === uid),
    rankings: (uid) =>
      [...rankings.entries()].flatMap(([user, list]) =>
        canView(uid, user)
          ? list.map((r, i) => ({
              user_id: user,
              media_item_id: r.media,
              bucket: r.bucket,
              position: i + 1,
            }))
          : [],
      ),
    title_recommendations: (uid) =>
      recs
        .filter((r) => r.sender === uid || (r.recipient === uid && r.state === 'delivered'))
        .map((r) => ({
          id: r.id,
          sender_id: r.sender,
          recipient_id: r.recipient,
          media_item_id: r.media,
          message: r.message,
        })),
    media_items: () => mediaItems,
  };

  const userFromToken = (token) => {
    const uid = tokens.get(token);
    if (!uid || !users.has(uid)) return null;
    return uid;
  };

  const backend = {
    kind: 'fake',
    writes,
    calls,
    notifications,
    deviceTokens,
    state: { users, profiles, follows, recs, votes, userMedia, rankings, reserved, mediaItems },

    async environmentName() {
      calls.push({ name: 'environment_name' });
      return environment;
    },

    admin: {
      async findUsersByEmail(email) {
        calls.push({ name: 'admin.find' });
        return [...users.values()]
          .filter((u) => u.email.toLowerCase() === String(email).toLowerCase())
          .map((u) => structuredClone(u));
      },
      async listMarkedUsers(key, value) {
        calls.push({ name: 'admin.list' });
        return [...users.values()]
          .filter((u) => u.app_metadata?.[key] === value || u.user_metadata?.[key] === value)
          .map((u) => structuredClone(u));
      },
      async createUser({ email, password, email_confirm, app_metadata, user_metadata }) {
        writes.push({ actor: 'service_role', name: 'admin.create_user' });
        if ([...users.values()].some((u) => u.email === email))
          throw new Error('admin create user failed: email exists');
        const id = nextId('user');
        const user = {
          id,
          email,
          password,
          email_confirmed_at: email_confirm ? now() : null,
          app_metadata: { provider: 'email', ...(appMetadataWritable ? app_metadata : {}) },
          user_metadata: { ...(user_metadata ?? {}) },
        };
        users.set(id, user);
        const visible = structuredClone(user);
        delete visible.password;
        return visible;
      },
      async deleteUser(id) {
        writes.push({ actor: 'service_role', name: 'admin.delete_user', target: id });
        if (!users.has(id)) throw new Error('admin delete user failed with 404');
        removeUser(id);
        return true;
      },
    },

    async signIn(email, password) {
      calls.push({ name: 'signIn' });
      const user = [...users.values()].find((u) => u.email === email);
      if (!user || user.password !== password) throw new Error('sign-in failed with 400');
      const token = tokenFor(user.id);
      tokens.set(token, user.id);
      return { token, userId: user.id };
    },

    async rpc(token, name, args) {
      const uid = userFromToken(token);
      if (!uid) return { status: 401, body: { message: 'JWT invalid' } };
      const handler = RPC[name];
      if (!handler)
        return { status: 404, body: { code: 'PGRST202', message: `no function ${name}` } };
      const isRead = typeof handler === 'object' && handler.read;
      if (isRead) calls.push({ actor: uid, name });
      else writes.push({ actor: uid, name });
      try {
        const fn = isRead ? handler.fn : handler;
        return { status: 200, body: structuredClone(fn(uid, args ?? {})) };
      } catch (error) {
        if (error instanceof RpcRefusal)
          return { status: error.status, body: { code: error.code, message: error.message } };
        throw error;
      }
    },

    async select(token, table, { columns = ['*'], eq = {}, limit } = {}) {
      const uid = userFromToken(token);
      if (!uid) return { status: 401, body: { message: 'JWT invalid' } };
      calls.push({ actor: uid, name: `select ${table}` });
      const source = TABLES[table];
      if (!source) return { status: 404, body: { message: `no table ${table}` } };
      let rows = source(uid).filter((row) =>
        Object.entries(eq).every(([k, v]) => String(row[k]) === String(v)),
      );
      if (limit !== undefined) rows = rows.slice(0, limit);
      const pick = (row) =>
        columns.includes('*')
          ? { ...row }
          : Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));
      return { status: 200, body: structuredClone(rows.map(pick)) };
    },

    /** Test helper: an existing account that is not the fixture's (a QA account, a lookalike). */
    seedAccount({
      email,
      username,
      password = 'not-a-fixture-password',
      appMetadata = {},
      userMetadata = {},
      visibility = 'public',
    }) {
      const id = nextId('user');
      users.set(id, {
        id,
        email,
        password,
        email_confirmed_at: now(),
        app_metadata: { provider: 'email', ...appMetadata },
        user_metadata: userMetadata,
      });
      if (username)
        profiles.set(id, {
          id,
          username,
          display_name: username,
          visibility,
          status: 'active',
        });
      return id;
    },
  };
  return backend;
}
