-- The grant a recreated view lost, said out loud.
-- Specification: independent review 17i/17j · founder acceptance corrections 2026-08-17.
--
-- ===========================================================================
-- WHY A ONE-LINE MIGRATION IS WORTH A FILE
--
-- `20260813001400` granted `select on public_profiles to anon, authenticated`. The view has
-- been dropped and recreated **twice** since, and neither one re-granted:
--
--   20260815030000_avatars.sql              drop + create, to add the avatar
--   20260817000800_bio_reviews...sql        drop + create, to add the bio
--
-- **`drop view` takes the grants with it.** So the grant made in `001400` is against an
-- object that stopped existing on 2026-08-15, and from that migration onward the
-- repository does not state who may read this view at all -- what a deployed database
-- permits depends entirely on the project's *default privileges*, which are a property of
-- the environment and the owning role rather than of anything written here.
--
-- Independent review 17k corrected me on that date: I had blamed the founder pass, and the
-- founder pass merely recreated an already-ungranted view. Two days and a whole phase of
-- work sat on top of it, which is the more useful thing to know -- nothing here reported
-- an error at any point, because on this project the defaults happened to cover it.
--
-- On bingd-nonprod it happened to work: `test:remote` probes the view directly and it is
-- readable, so Supabase's defaults did apply. That is the finding rather than the relief.
-- **It was true by luck and not by instruction**, and a fresh deployment under a different
-- owner or different default privileges would return 42501 on the public profile route and
-- on user search, which are the two surfaces that read this view.
--
-- The local suite is structurally incapable of catching it, for the third time in this
-- project and by now the familiar reason: it builds its schema from the files and runs as
-- the table owner, for whom a grant to `anon` is a question that never comes up. Only a
-- deployed probe can see it, which is what `test:remote` now does.
--
-- Both recreating migrations are applied and are therefore immutable in effect -- the
-- lesson `20260817001100` exists to record. So this is a new file rather than an edit, and
-- it is idempotent: a grant that is already held is a no-op, which is what makes it safe to
-- apply without first establishing which of the two states a given database is in.
--
-- `service_role` is deliberately not here. `20260813001400` did not grant it either, and no
-- consumer in the repository needs it -- restoring what was lost is the whole job, and
-- widening the grant while restoring it would be a change wearing a repair's clothes.
-- ===========================================================================

grant select on public_profiles to anon, authenticated;

comment on view public_profiles is
  'Every profile a caller may see, with the bio, resolved through can_view_profile as a security_invoker view. Read by the public profile route and by user search. Dropped and recreated twice since its select grant was made in 20260813001400 -- by 20260815030000 for the avatar and 20260817000800 for the bio -- and a drop takes the grant with it, so from 2026-08-15 the readable set was whatever a project''s default privileges happened to allow. 20260817001200 restores the grant explicitly, so the schema states it again.';
