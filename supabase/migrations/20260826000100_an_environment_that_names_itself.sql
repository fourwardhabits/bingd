-- ---------------------------------------------------------------------------
-- An environment that names itself
--
-- THE BOOTSTRAP TRAP THIS CLOSES
--
-- `20260817001300` seeds `app_config['env.name'] = 'nonprod'` and every reader defaults
-- to `'nonprod'` when the key is missing. That default is correct for the two places it
-- was written for — the local harness and a contributor's project — and it is a trap for
-- exactly one database: **a production project replayed from zero comes up calling itself
-- nonprod**, silently, and every invite token it mints is stamped `nonprod`. PRD §17 says
-- a nonprod token must not resolve in production; a production database that believes it
-- is nonprod satisfies that rule by being wrong about which one it is.
--
-- The seed is deliberately **not** edited. Rewriting a migration that has already run on
-- the friend-Beta project to make a project that does not exist yet come up differently is
-- the kind of history edit that is invisible until the two databases disagree about what
-- they replayed. The correction is an explicit step after replay instead, and this file is
-- the two functions that step needs.
--
-- ---------------------------------------------------------------------------
-- WHY IDENTITY IS READABLE AND WHY THAT IS NOT A LEAK
--
-- `environment_name()` is granted to `anon`. That is a deliberate disclosure of one of two
-- strings, and it buys the only thing that makes any of this testable: `remote-smoke.mjs`
-- runs unauthenticated, against a deployed project, holding nothing but the anon key, and
-- it has to be able to fail a release that points at the wrong database.
--
-- What it discloses is already public. The project ref is in the URL compiled into every
-- binary, and `config/backends.cjs` maps refs to environments in a file anybody can read.
-- An assertion nothing can make is worth less than a fact nobody was hiding.
--
-- `app_config` itself stays closed: its read policy is `key like 'public.%'` and `env.name`
-- is not. One scalar through one named function, rather than a second public config key
-- whose neighbours would then also be public.
-- ---------------------------------------------------------------------------

create or replace function environment_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod');
$$;

comment on function environment_name() is
  'Which Bingd environment this database is: prod or nonprod. Readable by anyone, because remote-smoke.mjs holds nothing but an anon key and a release that cannot check which database it is pointed at is a release that finds out afterwards. Discloses nothing the project ref in the URL does not.';

-- ---------------------------------------------------------------------------
-- Setting it, once, on an empty database
--
-- The whole value of this function is what it **refuses**. Flipping a live nonprod project
-- to `prod` would make every invite token it has already minted — stamped `nonprod`, by
-- `create_invite_link` reading this same key — start resolving as production tokens, and
-- would make a database full of friend-Beta accounts answer `prod` to every check written
-- to keep the two apart. That is the failure this whole tranche exists to prevent, and it
-- would be one `update` away if this were an ordinary config write.
--
-- So a **change** is permitted only while the database is still empty of people. Setting it
-- to what it already is is always allowed, because a bootstrap step that cannot be re-run
-- is a bootstrap step somebody runs once, wrongly, and then works around.
--
-- `profiles` is the test rather than `auth.users`: this schema cannot see `auth.users` from
-- a definer function without a grant it has no other reason to hold, and a Bingd account is
-- a profile. `invite_tokens` is checked as well because a token is the artefact that
-- carries the stamp, and one can outlive the account that minted it.
--
-- service_role only. This is an operator action, and it is the one config write in the
-- schema that changes what the database *is* rather than how it behaves.
-- ---------------------------------------------------------------------------

create or replace function set_environment_name(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text := environment_name();
  v_people  bigint;
  v_tokens  bigint;
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

  if v_people > 0 or v_tokens > 0 then
    raise exception
      'refusing to rename a database that is already in use from % to %: % profiles, % invite tokens',
      v_current, p_name, v_people, v_tokens
      using errcode = '55000',
            hint = 'Invite tokens carry the environment they were minted under (PRD 17). '
                   'Renaming a live database makes every one of them resolve as the other '
                   'environment. Bootstrap identity on a database replayed from zero.';
  end if;

  insert into app_config (key, value, updated_at)
  values ('env.name', to_jsonb(p_name), now())
  on conflict (key) do update
    set value = excluded.value, updated_at = now();

  return jsonb_build_object('status', 'ok', 'environment', p_name, 'was', v_current);
end;
$$;

comment on function set_environment_name(text) is
  'Declares this database prod or nonprod, as the explicit step after a replay from zero. Idempotent, and refuses to CHANGE the answer once any profile or invite token exists -- because invite tokens are stamped with the environment that minted them, so renaming a live database silently re-points every link somebody is already holding. service_role only.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function set_environment_name(text) from public, anon, authenticated;
grant  execute on function set_environment_name(text) to service_role;

grant execute on function environment_name() to anon, authenticated, service_role;
