-- Close the oracle 20260819000100 opened.
-- Found by: independent review 22, 2026-08-19.

-- ---------------------------------------------------------------------------
-- The same mistake `20260813001900` closed, made again
--
-- `20260819000100` added `can_discover_profile(viewer uuid, subject uuid)` and granted
-- execute to `authenticated`. That is precisely the shape `20260813001900` exists to
-- forbid, in the words of its own header: **combining "bypasses RLS" with "accepts the
-- identity to check as an argument" produces an endpoint that answers questions about
-- other people.**
--
--     select can_discover_profile('<alice>', '<bob>');   -- false
--
-- Profile ids are enumerable — `search_users` and `profile_identity` both return them,
-- which is fine and is the point of them. Given two ids known to name active accounts,
-- a `false` from this function has exactly one remaining cause: **a block between those
-- two people, in one direction or the other.** Repeat over pairs and the private block
-- graph comes back out, which is the one thing `blocks_read` exists to keep in.
--
-- It also answers "is this uuid an active account" for an arbitrary subject, which is a
-- smaller leak and still not the caller's business.
--
-- WHY REVOKING IS THE RIGHT FIX HERE, WHERE IT WAS NOT THERE
--
-- `20260813001900` could not revoke, because a policy is evaluated as the *querying*
-- role and therefore has to be able to call its helpers. It reshaped the signature
-- instead, so the only question a caller can pose is about themselves.
--
-- Nothing analogous applies here. `can_discover_profile` is called by exactly two
-- functions, `search_users` and `profile_identity`, and both are `security definer`
-- themselves — they run as the owner and can call it without any client grant at all.
-- No policy references it. The grant was not load-bearing; it was a line copied from
-- the two beside it without asking what it was for.
--
-- No single-argument `can_i_discover(subject)` is added either. There is no caller for
-- one, and a client-reachable "may I find this uuid" is a question a client has no way
-- to have arrived at honestly: you find people by searching for a name, and
-- `search_users` already applies the rule. An endpoint added on the chance somebody
-- wants it later is the same trade that produced this migration.
-- ---------------------------------------------------------------------------

revoke execute on function can_discover_profile(uuid, uuid) from authenticated, anon;

comment on function can_discover_profile(uuid, uuid) is
  'Whether one account may be *found* by another. Deliberately weaker than can_view_profile, which governs content: a private account is discoverable by name so that somebody who knows them can ask to follow, while everything they wrote stays behind can_view_profile. Blocks in either direction and suspension both make an account undiscoverable, and the caller never discovers themselves. SERVER-ONLY -- 20260819000200 revoked the client grant, because a definer helper that accepts a viewer lets any caller substitute somebody else and read the block graph between third parties (20260813001900 says why, about two other functions).';
