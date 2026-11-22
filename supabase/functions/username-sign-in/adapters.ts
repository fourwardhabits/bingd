/**
 * The two things the handler talks to, as narrow interfaces, plus their real
 * implementations over supabase-js. The handler never sees a client; the tests never
 * need one.
 */

export type SendOutcome =
  | { outcome: 'limited' }
  | { outcome: 'miss' }
  | { outcome: 'cooldown' }
  | { outcome: 'send'; email: string };

export type BeginOutcome =
  | { outcome: 'limited' }
  | { outcome: 'invalid' }
  | { outcome: 'check'; email: string; user_id: string };

export interface Store {
  send(args: {
    username: string | null;
    identifierHash: string;
    ipHash: string;
    challengeHash: string;
  }): Promise<SendOutcome>;
  verifyBegin(args: { challengeHash: string; ipHash: string }): Promise<BeginOutcome>;
  verifyFinish(args: { challengeHash: string; userId: string }): Promise<boolean>;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
}

export type SendCodeResult = { ok: true } | { ok: false; code: string };

export type VerifyCodeResult =
  | { ok: true; session: Session; userId: string }
  | { ok: false; code: string };

export interface Auth {
  /** Always `shouldCreateUser: false`: this path can never mint an account. */
  sendCode(email: string): Promise<SendCodeResult>;
  verifyCode(email: string, token: string): Promise<VerifyCodeResult>;
  /** Best effort. Used only when a session was minted that must not be handed out. */
  revoke(accessToken: string): Promise<void>;
}

/**
 * GoTrue's error codes are lowercase snake case. Anything else — or anything long enough
 * to be a sentence — is replaced, because a message can quote what it was given.
 */
export const errorClass = (code: unknown): string =>
  typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'unknown';

// ---------------------------------------------------------------------------
// Real implementations
// ---------------------------------------------------------------------------

/** The slice of a supabase-js client the store needs: `.rpc` and nothing else. */
export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export function sqlStore(admin: RpcClient): Store {
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, args);
    // The message is a Postgres one about *this* call, which can include its arguments;
    // it is not propagated.
    if (error) throw new Error(`${fn} failed`);
    return data as T;
  };
  return {
    send: ({ username, identifierHash, ipHash, challengeHash }) =>
      call<SendOutcome>('username_sign_in_send', {
        p_username: username,
        p_identifier_hash: identifierHash,
        p_ip_hash: ipHash,
        p_challenge_hash: challengeHash,
      }),
    verifyBegin: ({ challengeHash, ipHash }) =>
      call<BeginOutcome>('username_sign_in_verify_begin', {
        p_challenge_hash: challengeHash,
        p_ip_hash: ipHash,
      }),
    verifyFinish: ({ challengeHash, userId }) =>
      call<boolean>('username_sign_in_verify_finish', {
        p_challenge_hash: challengeHash,
        p_user_id: userId,
      }),
  };
}

/** The slice of supabase-js `auth` the GoTrue adapter needs. */
export interface GoTrueClient {
  signInWithOtp(args: {
    email: string;
    options: { shouldCreateUser: boolean };
  }): Promise<{ error: { code?: string } | null }>;
  verifyOtp(args: {
    email: string;
    token: string;
    type: 'email';
  }): Promise<{
    data: { session: (Session & { user?: { id: string } }) | null; user: { id: string } | null };
    error: { code?: string } | null;
  }>;
}

export interface AdminSignOut {
  signOut(jwt: string, scope: 'local'): Promise<unknown>;
}

/**
 * `anon` is an anon-key client: requesting and checking a code needs nothing more, and
 * the service role is kept to the three RPCs and the one revoke.
 */
export function goTrueAuth(anon: GoTrueClient, admin: AdminSignOut): Auth {
  return {
    async sendCode(email) {
      const { error } = await anon.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      });
      return error ? { ok: false, code: errorClass(error.code) } : { ok: true };
    },
    async verifyCode(email, token) {
      const { data, error } = await anon.verifyOtp({ email, token, type: 'email' });
      const session = data?.session;
      const userId = data?.user?.id ?? session?.user?.id;
      if (error || !session || !userId) {
        return { ok: false, code: errorClass(error?.code ?? 'no_session') };
      }
      return {
        ok: true,
        userId,
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_in: session.expires_in,
          expires_at: session.expires_at,
          token_type: session.token_type,
        },
      };
    },
    async revoke(accessToken) {
      try {
        await admin.signOut(accessToken, 'local');
      } catch {
        // Best effort: the token expires on its own within the hour.
      }
    },
  };
}
