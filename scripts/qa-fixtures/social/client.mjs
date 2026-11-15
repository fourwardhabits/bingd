/**
 * The fixture's only door to a Supabase project, over HTTP.
 *
 * The runner in `fixture.mjs` talks to an object with exactly this shape, and the tests
 * hand it an in-memory fake (`fake-backend.mjs`) instead. Nothing else in the fixture calls
 * `fetch`.
 *
 *   environmentName()                          anon key only; the guard's question
 *   admin.findUsersByEmail(email)              service role; exact-match, paginated
 *   admin.listMarkedUsers(key, value)          service role; every user carrying the marker
 *   admin.createUser(attributes)               service role
 *   admin.deleteUser(id)                       service role
 *   signIn(email, password) -> {token, userId} anon key; password grant
 *   rpc(token, name, args)  -> {status, body}  user JWT
 *   select(token, table, {columns, eq, limit}) user JWT, PostgREST GET
 *
 * The service role is used for the four admin calls and nothing else: every product write
 * is an RPC under the fixture user's own JWT, exactly as the app makes it.
 *
 * Errors never carry request headers, so a thrown message cannot contain a key or a token.
 */

const PER_PAGE = 200;
const MAX_PAGES = 500;

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * @param {{ origin: string, anonKey: string, serviceKey?: string, fetchImpl?: typeof fetch }} options
 *   `origin` is the guard's parsed origin, never the raw environment string.
 */
export function createHttpClient({
  origin,
  anonKey,
  serviceKey,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof origin !== 'string' || !origin)
    throw new Error('createHttpClient needs the guarded origin');
  if (!anonKey) throw new Error('createHttpClient needs the anon key');

  const requireService = () => {
    if (!serviceKey) throw new Error('the service-role key is required for admin calls');
    return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  };

  async function adminFetch(path, init = {}) {
    const res = await fetchImpl(`${origin}${path}`, {
      ...init,
      headers: {
        ...requireService(),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    return { ok: res.ok, status: res.status, body: await readBody(res) };
  }

  async function listUsers(onPage) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await adminFetch(`/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}`);
      if (!res.ok) throw new Error(`admin user listing failed with ${res.status}`);
      const users = res.body?.users ?? [];
      onPage(users);
      if (users.length < PER_PAGE) return;
    }
    // A bound that throws rather than truncating silently: "nothing found" after a capped
    // listing is a claim with no basis (two-user-acceptance.mjs, sweepByEmail).
    throw new Error(`stopped listing users after ${MAX_PAGES} pages`);
  }

  return {
    kind: 'http',

    async environmentName() {
      const res = await fetchImpl(`${origin}/rest/v1/rpc/environment_name`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const body = await readBody(res);
      if (!res.ok) throw new Error(`environment_name answered ${res.status}`);
      return typeof body === 'string' ? body : null;
    },

    admin: {
      async findUsersByEmail(email) {
        const wanted = String(email).toLowerCase();
        const found = [];
        // `filter` is sent as a hint and the answer is checked, never believed.
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const res = await adminFetch(
            `/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}&filter=${encodeURIComponent(email)}`,
          );
          if (!res.ok) throw new Error(`admin user lookup failed with ${res.status}`);
          const users = res.body?.users ?? [];
          for (const user of users)
            if (String(user.email ?? '').toLowerCase() === wanted) found.push(user);
          if (users.length < PER_PAGE) return found;
        }
        throw new Error(`stopped listing users after ${MAX_PAGES} pages`);
      },

      async listMarkedUsers(key, value) {
        const found = [];
        await listUsers((users) => {
          for (const user of users) {
            if (user.app_metadata?.[key] === value || user.user_metadata?.[key] === value)
              found.push(user);
          }
        });
        return found;
      },

      async createUser(attributes) {
        const res = await adminFetch('/auth/v1/admin/users', {
          method: 'POST',
          body: JSON.stringify(attributes),
        });
        if (!res.ok) {
          const reason =
            res.body?.msg ?? res.body?.message ?? res.body?.error_description ?? res.status;
          throw new Error(`admin create user failed: ${reason}`);
        }
        return res.body;
      },

      async deleteUser(id) {
        const res = await adminFetch(`/auth/v1/admin/users/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error(`admin delete user failed with ${res.status}`);
        return true;
      },
    },

    async signIn(email, password) {
      const res = await fetchImpl(`${origin}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await readBody(res);
      if (!res.ok || typeof body?.access_token !== 'string') {
        // Status only: the body of a failed sign-in names nothing useful, and a successful
        // one is the token itself.
        throw new Error(`sign-in failed with ${res.status}`);
      }
      return { token: body.access_token, userId: body.user?.id ?? null };
    },

    async rpc(token, name, args) {
      const res = await fetchImpl(`${origin}/rest/v1/rpc/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args ?? {}),
      });
      return { status: res.status, body: await readBody(res) };
    },

    async select(token, table, { columns = ['*'], eq = {}, limit } = {}) {
      const params = new URLSearchParams();
      params.set('select', columns.join(','));
      for (const [column, value] of Object.entries(eq)) params.set(column, `eq.${value}`);
      if (limit !== undefined) params.set('limit', String(limit));
      const res = await fetchImpl(`${origin}/rest/v1/${encodeURIComponent(table)}?${params}`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: await readBody(res) };
    },
  };
}
