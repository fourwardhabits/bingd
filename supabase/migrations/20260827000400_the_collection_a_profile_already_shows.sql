-- The logged collection, projected down to what a profile is already allowed to say.
-- Specification: PRD §22 (Logged inherits profile visibility; the date and the note do
-- not) · the Awards progress-integrity fix of 2026-08-27.
--
-- ===========================================================================
-- WHY THIS VIEW EXISTS
--
-- The founder opened another account's bingd. Awards and read `Movie Muncher 0 / 50`
-- over a profile that says `Movies: 34`. Both numbers were computed honestly. The
-- profile counts `rankings`, whose policy is `can_i_view(user_id)`; the award counts
-- the watched collection, which the client reads from `user_media` — and
-- `user_media_own` (20260813000500) is `user_id = auth.uid()`, deliberately and
-- permanently, because the row carries `watched_on` and `note`, which PRD §22 keeps
-- private at every visibility level. So a visitor's read of somebody else's collection
-- returns **zero rows and no error**, and the award states a zero the database never
-- asserted. The sheet was right about the reader and wrong about everybody else.
--
-- PRD §22's actual rule is narrower than the policy that enforces it: the *collection*
-- — which titles an account has logged — inherits profile visibility, exactly as
-- rankings and the watchlist do; only the watch date and the note text are always
-- private. Until now nothing readable expressed that difference, and every cross-user
-- surface routed around it through `rankings` (`use-public-profile.ts`, deliberately).
-- Awards cannot: a logged-but-unranked title genuinely counts toward Movie Muncher,
-- and an award computed from a narrower set than the owner's own sheet would disagree
-- with it by exactly that margin.
--
-- So: one projection of `user_media`, carrying the three facts about a collection row
-- that are public whenever the profile is —
--
--   user_id           whose collection
--   media_item_id     which title (the catalogue itself is world-readable)
--   has_public_note   that a public review exists on it, note *text* not carried —
--                     the same existence fact `public_notes` already exposes, here so
--                     Comment Gremlin can count reviews without the note bodies and
--                     without `public_notes`' fifty-author/hundred-row bounds
--
-- and nothing else. No `watched_on`, no `note`, no `note_has_spoilers`, no bucket, no
-- progress: a column that is not in the view cannot be selected, which is a stronger
-- statement than a policy about it.
--
-- ===========================================================================
-- WHY A DEFINER VIEW AND NOT ANOTHER RPC
--
-- The awards read pages to exhaustion by keyset and embeds `media_items` for the
-- thirteen tracks that need genres (`use-awards.ts`). A view keeps both: PostgREST
-- resolves the `media_item_id → media_items` relationship through a view, and the
-- ordinary `gt`/`order`/`limit` grammar applies. `public_notes` is the wrong shape on
-- purpose — it exists to hand over note *text*, so it is bounded hard; this view hands
-- over membership, which is as unbounded as the collection it describes.
--
-- Not `security_invoker`, unlike `public_profiles`: the base table's policy is
-- owner-only, so an invoker view would return a visitor nothing — the exact defect
-- this migration removes. The view runs as its owner, and the `can_i_view` predicate
-- inside it is the entire authorisation, the same oracle every viewer-relative policy
-- in the schema uses (AD-5: blocks, suspension, private accounts, approved follows,
-- one place). `security_barrier` so a caller's function cannot be pushed down below
-- that predicate and shown rows it filters.
--
-- `can_i_view` rather than `can_view_profile(auth.uid(), …)`: functions in a view are
-- executed with the *caller's* privileges, and the two-argument oracle was withdrawn
-- from clients by 20260813001900 precisely so nobody can ask about third-party pairs.
-- `can_i_view` is the granted, caller-pinned form policies already use.
--
-- The grant is explicit, and `anon` is revoked rather than merely not granted:
-- 20260817001200 is this schema's own record of a view whose readable set was decided
-- by default privileges for two days, and a *definer* view left to defaults would be
-- the same mistake with sharper teeth. `authenticated` only; `can_i_view(null → …)`
-- would admit an anonymous reader for a public account, and no signed-out surface
-- reads collections.
-- ===========================================================================

create view logged_collection with (security_barrier = true) as
select um.user_id,
       um.media_item_id,
       (um.note is not null and um.note_visibility = 'public') as has_public_note
  from user_media um
 where can_i_view(um.user_id);

revoke all on logged_collection from anon, public;
grant select on logged_collection to authenticated;

comment on view logged_collection is
  'Which titles an account has logged, for any caller can_i_view admits — the PRD §22 projection of user_media: the collection inherits profile visibility, the watch date and note text never do. Three columns on purpose; a column absent from a definer view cannot be selected. has_public_note is the existence fact behind Comment Gremlin''s review count, not the note itself — text stays behind public_notes. Read by the awards of somebody else''s profile (use-awards.ts); the owner''s own awards still read user_media, which additionally carries the dates their drill-downs may show. security_barrier, owner-run, authenticated only, anon revoked explicitly (the 20260817001200 lesson).';
