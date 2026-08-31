-- A database that can be promoted.
-- Founder tranche 2026-08-31: the friend-Beta project becomes production, keeping every
-- account, ranking, follow, notification and avatar exactly where it is.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS CHANGES, AND WHY IT IS NOT A LOOPHOLE
--
-- `20260826000100` gave `set_environment_name` a guard: a database with any profile or
-- any invite token in it may not change what it calls itself. That guard is correct and
-- it is staying. Its reasoning, in its own words:
--
--   'Invite tokens carry the environment they were minted under (PRD 17). Renaming a
--    live database makes every one of them resolve as the other environment. Bootstrap
--    identity on a database replayed from zero.'
--
-- Read that closely: the harm is not the rename. The harm is **the stamps left behind**.
-- `resolve_invite_token` matches `invite_tokens.env` against `environment_name()`, so a
-- database renamed on its own strands every link somebody is already holding.
--
-- The founder's decision on 2026-08-31 is to promote the populated project rather than
-- ship a public release against an empty one and ask real users -- fourteen profiles, two
-- hundred and forty-two collection rows, two hundred and thirty-nine rankings -- to
-- register again. So the operation the guard forbids is the operation that has to happen,
-- and the honest way to have it is to remove the *reason* rather than the check.
--
-- **`p_promote` migrates the stamps in the same call.** One `plpgsql` function body is
-- one transaction, so the tokens and the name move together or neither moves: there is no
-- instant at which a link resolves as the wrong environment. That is the whole of what the
-- guard was protecting, done rather than refused.
--
-- ---------------------------------------------------------------------------
-- WHY THE DEFAULT IS FALSE, AND STAYS FALSE
--
-- Every existing caller keeps the existing behaviour. `scripts/bootstrap-production.mjs`
-- calls this with one argument and gets the refusal it has always got, which is right:
-- bootstrapping a fresh project must not quietly promote a populated one it was pointed
-- at by mistake. Promotion is a second, explicit argument that somebody has to type, once,
-- knowing what it does.
--
-- It is not a one-shot migration for the same reason `20260826000100` is not one. A
-- migration that promoted whatever database it was replayed onto would promote the
-- staging project too, on its own next replay -- silently, and at the worst moment.
-- Identity is an operator action against a named project, and this only makes the
-- operator's tool able to express it.
--
-- ---------------------------------------------------------------------------
-- THE OVERLOAD, AND WHY THE OLD ARITY GOES
--
-- `create or replace` with a new defaulted parameter OVERLOADS rather than replaces, and a
-- one-argument call against both is ambiguous. Same treatment, same reason, as
-- `_maybe_award_unlocks` on 20260902000100 and `_maybe_goal_completion` on 20260901000100:
-- create the new arity, then drop the old one. The one-argument callers resolve to the new
-- function's default and are unchanged.
-- ---------------------------------------------------------------------------

create or replace function set_environment_name(
  p_name text,
  -- Permit the change on a populated database, and carry the invite-token stamps with it.
  -- Default false: the refusal `20260826000100` wrote is the behaviour every existing
  -- caller keeps.
  p_promote boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text := environment_name();
  v_people  bigint;
  v_tokens  bigint;
  v_moved   bigint := 0;
begin
  if p_name is null or p_name not in ('prod', 'nonprod') then
    raise exception 'environment must be prod or nonprod, not %', coalesce(p_name, 'null')
      using errcode = '22023';
  end if;

  if v_current = p_name then
    return jsonb_build_object('status', 'unchanged', 'environment', p_name);
  end if;

  select count(*) into v_people from profiles;
  select count(*) into v_tokens from invite_tokens;

  if (v_people > 0 or v_tokens > 0) and not p_promote then
    raise exception
      'refusing to rename a database that is already in use from % to %: % profiles, % invite tokens',
      v_current, p_name, v_people, v_tokens
      using errcode = '55000',
            hint = 'Invite tokens carry the environment they were minted under (PRD 17). '
                   'Renaming a live database makes every one of them resolve as the other '
                   'environment. Bootstrap identity on a database replayed from zero, or '
                   'pass p_promote => true to move the tokens with the name in one '
                   'transaction (20260905000100).';
  end if;

  -- The stamps first, and in the same transaction as the name. Scoped to the environment
  -- being left behind: a token already carrying the target name -- there is no way to mint
  -- one, but the predicate says so rather than relying on that -- is left alone, and a
  -- revoked token is migrated too, because `resolve_invite_token` reads `env` before it
  -- reads `revoked_at` and a revoked link should stay revoked rather than become unknown.
  if p_promote then
    update invite_tokens set env = p_name where env = v_current;
    get diagnostics v_moved = row_count;
  end if;

  insert into app_config (key, value, updated_at)
  values ('env.name', to_jsonb(p_name), now())
  on conflict (key) do update
    set value = excluded.value, updated_at = now();

  return jsonb_build_object(
    'status', 'ok',
    'environment', p_name,
    'was', v_current,
    'promoted', p_promote,
    'invite_tokens_moved', v_moved
  );
end;
$$;

-- The one-argument arity goes, so a one-argument call is not ambiguous against the two.
drop function if exists set_environment_name(text);

revoke execute on function set_environment_name(text, boolean) from public, anon, authenticated;
grant  execute on function set_environment_name(text, boolean) to service_role;

comment on function set_environment_name(text, boolean) is
  'Declares this database prod or nonprod. Idempotent, and by default refuses to CHANGE the answer once any profile or invite token exists -- because invite tokens are stamped with the environment that minted them, so renaming a live database silently re-points every link somebody is already holding. Since 20260905000100, p_promote => true performs that change anyway and moves every invite_tokens.env from the old name to the new one in the SAME transaction, which is what the refusal was protecting: the stamps and the name are never observably out of step. Used once, on 2026-08-31, to promote the friend-Beta project to production without asking fourteen real accounts to register again. service_role only.';
