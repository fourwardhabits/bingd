-- ===========================================================================
-- A NAME THE TEXT CAN SAY FOR ITSELF
--
-- 20260830000100 built the whole of @mentions except the two things a reader
-- can actually perceive, and the founder's report is exactly those two:
--
--   1. **A mention did not look like anything.** Comment bodies render through
--      `SpoilerNote`, which draws one string. `@silky` was the same glyphs in
--      the same colour as the rest of the sentence, so a feature that worked
--      was indistinguishable from one that did not. That half is client-side
--      and is not in this file.
--   2. **A mention only counted if it was clicked into being.** The client
--      sends `p_mention_ids`, and it can only send an id it was handed by the
--      suggestion list. Type `@silky` and post without tapping the row -- which
--      is what anybody who knows their friend's handle does -- and the array is
--      empty. The comment reads as a mention, is spelled as a mention, and
--      notifies nobody. That half is this file.
--
-- ---------------------------------------------------------------------------
-- WHY THE BODY BECOMES THE SOURCE, AND WHAT THAT DOES NOT CHANGE
--
-- 20260830000100's header argues at length that a mention must be a row on ids
-- rather than a substring, and every word of that stands. What is being changed
-- is narrower and worth stating precisely:
--
--   the *ledger* is still ids. What the ledger is built **from** is now the
--   text, resolved server-side, instead of an array the client assembled.
--
-- The three failures that argument names are all still closed, because the
-- ledger closes them and the ledger is untouched:
--
--   - **handles move.** `comment_mentions.handle` freezes what the body spells,
--     and resolution consults it *first* -- so `@ravi` in a body written before
--     a rename still resolves to Ravi, and cannot resolve to whoever took the
--     name afterwards. That preference is the recycled-handle guard, and it is
--     the reason `_resolve_comment_mentions` is three coalesced lookups rather
--     than one join.
--   - **an edit is not a new statement.** `notified_at` is still set once and
--     cleared by nothing. Re-parsing the body on every save is now what happens,
--     and it is harmless precisely because the stamp -- not the parse -- decides
--     who is told.
--   - **removing and re-adding is free.** Still false, same reason. The row
--     survives deactivation with its stamp.
--
-- And the eligibility rule is not weakened by one account. A typed handle is
-- resolved against `_can_mention` -- the people the author follows, plus this
-- conversation's own participants -- exactly as a picked one was. Typing
-- `@somebody_i_have_never_met` resolves to nobody and stays ordinary text. What
-- has gone is only the requirement that the author's *thumb* took a particular
-- path to a person they were always allowed to name.
--
-- ---------------------------------------------------------------------------
-- STRICT FOR WHAT WAS CHOSEN, LENIENT FOR WHAT WAS TYPED
--
-- The two sources fail differently and must be treated differently.
--
-- An id in `p_mention_ids` is a claim the client is making about a control the
-- author used, so an ineligible one is a bug or an attack and the whole call is
-- still refused -- 20260830000100's "refused rather than partially applied",
-- unchanged.
--
-- A handle in the body is prose. `@example` inside a sentence about examples
-- must not make a comment unpostable, so an unresolvable or ineligible one is
-- silently not a mention. It renders as text and notifies nobody, which is what
-- the reader already believes is happening.
--
-- ---------------------------------------------------------------------------
-- ONE ACTION, ONE NOTIFICATION
--
-- 20260830000100 deliberately filed both a `comment` row and a `mention` row for
-- somebody who owned the activity *and* was named in the comment, on the
-- argument that they are two different statements. The founder has overruled
-- that: one action by one person may produce at most one line in somebody's
-- Bell, and where the two collide the specific one wins, because "Suraj
-- mentioned you in a comment" is strictly more informative than "Suraj
-- commented on your ranking".
--
-- So `_add_comment` now resolves the mentions *before* it files the activity-
-- owner and reply-recipient rows, and skips whichever of those two people the
-- comment names. This is safe against the preference trigger rather than merely
-- lucky: `comment` and `mention` both map to the `comments` category
-- (20260831000100), so a reader who has silenced comments loses both rows
-- either way, and one who has not keeps exactly one.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
--
-- `_apply_comment_mentions` is unchanged, and that is the point of splitting
-- resolution out of it: the ledger write, the deactivation sweep and the
-- single-statement `notified_at` claim are the load-bearing parts of the
-- original design and this migration does not touch them.
--
-- `_can_mention`, `mention_candidates`, `activity_comments`, `my_notifications`,
-- `claim_push_batch`, the push copy and `delete_comment` are all unchanged too.
-- The eligibility rule, the autocomplete population, the read-time visibility
-- re-checks and the spoiler-safe inbox previews are 20260830000100's and stay.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. What the text says
-- ---------------------------------------------------------------------------

/**
 * Every handle a body names, lowercased and deduplicated.
 *
 * The charset is `username_format`'s (`^[a-z0-9_]{3,24}$`, 20260813000200) and nothing
 * else, which is what makes the three cases the founder listed fall out rather than be
 * special-cased:
 *
 *   - `@silky thoughts?`  -> silky, because a space is not a handle character;
 *   - `@silky.`           -> silky, because a full stop is not one either, so a comment
 *                            that ends on a name still reads as a sentence;
 *   - `email@example.com` -> nothing, because the `@` is preceded by a letter rather
 *                            than by whitespace or the start of the body.
 *
 * The trailing `(?![a-z0-9_])` is the same guard independent review 68 added to the
 * client's copy of this rule: without it a twenty-five character run matches its first
 * twenty-four and resolves to somebody whose name is not in the text at all.
 *
 * Case-insensitive and then lowered, because `profiles.username` is `citext` and a
 * reader who types `@Silky` has named Silky.
 */
create or replace function _mentioned_handles(p_body text)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(distinct lower(m[1])), '{}'::text[])
    from regexp_matches(
           coalesce(p_body, ''),
           '(?:^|\s)@([a-z0-9_]{3,24})(?![a-z0-9_])',
           'gi'
         ) as m;
$$;

comment on function _mentioned_handles(text) is
  'Every @handle a comment body spells, lowercased and distinct, on username_format''s charset. An @ not preceded by whitespace or the start of the text is not a mention, which is what keeps an email address out. Pure; says nothing about whether anybody holds these names.';

-- ---------------------------------------------------------------------------
-- 2. Who those names are
-- ---------------------------------------------------------------------------

/**
 * The ids one comment should now carry, from what the author picked *and* what the body
 * says. The body is the intersection: a name deleted from the text is not a mention,
 * however it got there, which is still the only gesture for removing one.
 *
 * Each handle resolves through three lookups, in this order, and the order is the whole
 * of the correctness argument:
 *
 *   a. **an active ledger row on this comment whose frozen `handle` is this one.** This
 *      body has meant that person since it was written, and it goes on meaning them
 *      after they rename and after somebody else takes the name they left. Consulting
 *      the ledger first is what makes handle recycling unable to redirect an existing
 *      mention at a stranger.
 *   b. **somebody the author picked in this composer, by their current handle.** Their
 *      eligibility was established strictly above, so this admits a person whom (c)
 *      would refuse -- an author keeping a mention of somebody who has since gone
 *      private, which 20260830000100 already allowed for.
 *   c. **whoever holds the handle now, if `_can_mention` says the author may name them.**
 *      The new case, and the one the founder asked for. Nothing here relaxes
 *      `_can_mention`: a stranger's handle resolves to no row, not to a refused one.
 *
 * Returns `'{}'` and never null, because the callers test membership with `= any(...)`
 * and a null array would make that test null rather than false.
 */
create or replace function _resolve_comment_mentions(
  p_comment_id    uuid,
  p_feed_event_id uuid,
  p_mention_ids   uuid[],
  p_body          text
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max    integer;
  v_picked uuid[];
  v_bad    uuid;
  v_out    uuid[];
begin
  -- Aliased `w(uid)` for 20260830000100's reason, which has not stopped being true: an
  -- unaliased `unnest(...) as id` inside a correlated subquery over a table that has its
  -- own `id` binds to the wrong one, and `set_watch_tags` shipped exactly that.
  select coalesce(array_agg(distinct w.uid), '{}'::uuid[]) into v_picked
    from unnest(coalesce(p_mention_ids, '{}'::uuid[])) as w(uid)
   where w.uid is not null;

  select coalesce((select (value)::integer from app_config where key = 'mentions.max_per_comment'), 10)
    into v_max;

  -- The ceiling applies to the picked array on its own, because that array is a client
  -- assertion and an unbounded one is an array a modified client fills with the graph.
  if coalesce(array_length(v_picked, 1), 0) > v_max then
    raise exception 'you can mention up to % people in one comment', v_max using errcode = '22023';
  end if;

  -- Strict, and 20260830000100's exemption is preserved verbatim: somebody already
  -- actively named on this comment stays nameable even if they have since become
  -- ineligible, so a typo fix does not fail because a friend went private. Their stamp
  -- is spent, so the exemption cannot produce a notification. A block is not exempted --
  -- `_can_mention` fails for the pair, and this only reaches somebody already named.
  select w.uid into v_bad
    from unnest(v_picked) as w(uid)
   where not _can_mention(p_feed_event_id, w.uid)
     and not exists (
       select 1 from comment_mentions m
        where m.comment_id = p_comment_id and m.mentioned_id = w.uid and m.active
     )
   limit 1;

  if v_bad is not null then
    raise exception 'you can only mention people you follow or who are in this conversation'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct r.id), '{}'::uuid[]) into v_out
    from unnest(_mentioned_handles(p_body)) as h(handle)
    cross join lateral (
      select coalesce(
        (select m.mentioned_id
           from comment_mentions m
          where m.comment_id = p_comment_id and m.active and lower(m.handle) = h.handle
          limit 1),
        (select p.id
           from profiles p
          where p.id = any (v_picked) and lower(p.username::text) = h.handle
          limit 1),
        (select p.id
           from profiles p
          where p.username = h.handle::citext
            and _can_mention(p_feed_event_id, p.id)
          limit 1)
      ) as id
    ) r
   where r.id is not null;

  -- Over the ceiling the extra names are dropped rather than the comment refused: they
  -- came from prose, and prose that is one name too long is still something somebody
  -- meant to say. Picked first, so the deterministic thing to lose is the thing nobody
  -- explicitly chose, and `order by id` after that so two identical saves agree.
  if coalesce(array_length(v_out, 1), 0) > v_max then
    select coalesce(array_agg(t.id), '{}'::uuid[]) into v_out
      from (
        select u.id
          from unnest(v_out) as u(id)
         order by (u.id = any (v_picked)) desc, u.id
         limit v_max
      ) t;
  end if;

  return v_out;
end;
$$;

comment on function _resolve_comment_mentions(uuid, uuid, uuid[], text) is
  'Which people one comment names, from the body and the ids the author picked (20260908000100). The body is the intersection, so deleting a name removes the mention. Each handle resolves to this comment''s own frozen ledger row first -- so a rename, or somebody else taking the freed handle, cannot redirect an existing mention -- then to a picked id, then to whoever holds the name now if _can_mention admits them. Picked ids are validated strictly and refuse the call; typed handles are lenient and simply are not mentions. Internal.';

-- ---------------------------------------------------------------------------
-- 3. `_add_comment`, rebuilt from 20260830000100
--
-- Rebuilt in full rather than patched, which is 20260817000200's discipline and
-- 20260826000600's and 20260830000100's: a `create or replace` assembled from
-- the wrong ancestor is how hardening disappears without showing in a diff.
-- Every line below is 20260830000100's -- the two pre-lock visibility checks,
-- the deterministic pair-lock order, the `for share` pin on the parent, the
-- re-resolution under the locks -- with two changes and no others:
--
--   * the mention set is resolved between the insert and the notifications,
--     because the notifications now depend on it;
--   * the activity-owner row and the reply row are skipped for anybody that set
--     contains.
-- ---------------------------------------------------------------------------

create or replace function _add_comment(
  p_operation_id  uuid,
  p_feed_event_id uuid,
  p_body          text,
  p_has_spoilers  boolean,
  p_parent_id     uuid,
  p_mention_ids   uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid;
  v_body         text := btrim(coalesce(p_body, ''));
  v_id           uuid;
  v_root         uuid := null;
  v_reply_author uuid := null;
  v_reply_to     uuid := null;
  v_deleted_at   timestamptz;
  v_counterpart  uuid;
  v_mentions     uuid[];
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'add_comment') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('add_comment', 'comments.max_per_day', 100);

  perform _assert_comment_length(v_body);

  select e.actor_id into v_actor
    from feed_events e
   where e.id = p_feed_event_id
     and can_view_profile(auth.uid(), e.actor_id);

  if v_actor is null then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  if p_parent_id is not null then
    v_root := _comment_root(p_parent_id, p_feed_event_id);

    if v_root is null then
      raise exception 'no such comment' using errcode = 'P0002';
    end if;

    select c.author_id, c.deleted_at
      into v_reply_author, v_deleted_at
      from comments c
     where c.id = p_parent_id;

    if v_reply_author is null or not can_view_profile(auth.uid(), v_reply_author) then
      raise exception 'no such comment' using errcode = 'P0002';
    end if;

    if v_deleted_at is null then
      v_reply_to := v_reply_author;
    end if;
  end if;

  for v_counterpart in
    select c.u
      from (select v_actor as u union select v_reply_author) as c
     where c.u is not null
       and c.u <> auth.uid()
     order by c.u
  loop
    perform _lock_pair(auth.uid(), v_counterpart);
  end loop;

  if not can_view_profile(auth.uid(), v_actor) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  if p_parent_id is not null then
    perform 1 from comments c where c.id = p_parent_id for share;

    v_root := _comment_root(p_parent_id, p_feed_event_id);

    select c.author_id, c.deleted_at
      into v_reply_author, v_deleted_at
      from comments c
     where c.id = p_parent_id;

    if v_root is null
       or v_reply_author is null
       or not can_view_profile(auth.uid(), v_reply_author) then
      raise exception 'no such comment' using errcode = 'P0002';
    end if;

    v_reply_to := case when v_deleted_at is null then v_reply_author end;
  end if;

  insert into comments (feed_event_id, author_id, body, has_spoilers, parent_id)
  values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers, false), v_root)
  returning id into v_id;

  /**
   * Resolved before either notification is filed, and that ordering is the founder's
   * "one action, one notification" rule made mechanical.
   *
   * The comment is brand new, so every id this returns is a mention with no notified_at
   * yet -- which is what makes the two skips below safe rather than merely likely. On an
   * *edit* the same statement can return somebody already told, but `_edit_comment` files
   * no `comment` rows at all, so there is nothing there to suppress.
   */
  v_mentions := _resolve_comment_mentions(v_id, p_feed_event_id, p_mention_ids, v_body);

  -- "There is a new remark on your post", unless the remark is addressed to them, in
  -- which case the mention row below says so and says it better.
  if v_actor <> auth.uid() and not coalesce(v_actor = any (v_mentions), false) then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id));
  end if;

  -- The same rule for the person being replied to. Both rows open the same conversation,
  -- so losing the generic one costs the reader no destination.
  if v_reply_to is not null and v_reply_to <> auth.uid() and v_reply_to <> v_actor
     and not coalesce(v_reply_to = any (v_mentions), false) then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_reply_to, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id, 'reply_to', p_parent_id));
  end if;

  -- A mention of yourself files nothing: `_can_mention` excludes `auth.uid()`, so the
  -- author is never in `v_mentions` and never suppresses their own rows either.
  perform _apply_comment_mentions(v_id, p_feed_event_id, v_mentions, p_parent_id is not null);

  return jsonb_build_object('status', 'ok', 'comment_id', v_id, 'parent_id', v_root);
end;
$$;

comment on function _add_comment(uuid, uuid, text, boolean, uuid, uuid[]) is
  'The whole of posting a comment, behind both published signatures so the five-argument form a phone predating 20260830000100 still calls cannot drift from the six-argument one. Since 20260908000100 the mentions are resolved from the body as well as from the picked ids, and whoever the comment names does not also get the generic comment or reply row -- one action, one notification, and the specific one wins. Internal.';

-- ---------------------------------------------------------------------------
-- 4. `_edit_comment`, rebuilt from 20260830000100
--
-- One line changes: the ids handed to `_apply_comment_mentions` come from
-- `_resolve_comment_mentions` rather than straight from the client.
--
-- `p_apply_mentions` keeps its exact meaning. It separates "this caller says
-- nobody is mentioned" from "this caller does not know about mentions", and the
-- four-argument `edit_comment` still passes false -- so a phone predating
-- 20260830000100 editing a comment cannot deactivate mentions it never read.
-- Making the old signature parse the body would be defensible now that the body
-- is authoritative, and it is deliberately not done here: it would change what
-- an un-relaunched phone does to rows it cannot see, for no case the founder
-- reported.
-- ---------------------------------------------------------------------------

create or replace function _edit_comment(
  p_operation_id   uuid,
  p_comment_id     uuid,
  p_body           text,
  p_has_spoilers   boolean,
  p_mention_ids    uuid[],
  p_apply_mentions boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body  text := btrim(coalesce(p_body, ''));
  v_at    timestamptz;
  v_event uuid;
  v_reply boolean;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'edit_comment') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_comment_length(v_body);

  update comments
     set body         = v_body,
         has_spoilers = coalesce(p_has_spoilers, has_spoilers),
         edited_at    = now()
   where id = p_comment_id
     and author_id = auth.uid()
     and deleted_at is null
  returning edited_at, feed_event_id, parent_id is not null
       into v_at, v_event, v_reply;

  if v_at is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  if p_apply_mentions then
    perform _apply_comment_mentions(
      p_comment_id,
      v_event,
      _resolve_comment_mentions(p_comment_id, v_event, p_mention_ids, v_body),
      v_reply
    );
  end if;

  return jsonb_build_object('status', 'ok', 'edited_at', v_at);
end;
$$;

comment on function _edit_comment(uuid, uuid, text, boolean, uuid[], boolean) is
  'The whole of editing a comment, behind both published signatures. p_apply_mentions separates "this caller says nobody is mentioned" from "this caller does not know about mentions" -- the four-argument form passes false, so an old bundle editing a comment cannot silently deactivate its mentions. Since 20260908000100 the ids come from the body as well as from the picked array, so adding a name by typing it notifies that person once and leaving it there notifies nobody again. Internal.';

-- ---------------------------------------------------------------------------
-- 5. What a client may not call
--
-- Both new functions are internal for `_can_mention`'s reason: between them they
-- answer questions about a named third party's follow graph and about what a
-- body would resolve to, neither of which is a question a client may ask
-- directly. `_mentioned_handles` is pure and harmless, and is revoked anyway --
-- a function that exists only to be called by two definers has no business
-- being reachable, and the cheapest place to enforce that is here.
--
-- `create function` after a `drop` starts with no grant at all, but `create or
-- replace` keeps whatever the previous definition had -- so these revokes are
-- what actually decides it, not the absence of a grant.
-- ---------------------------------------------------------------------------

revoke execute on function _mentioned_handles(text)
  from public, anon, authenticated;
revoke execute on function _resolve_comment_mentions(uuid, uuid, uuid[], text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Two docstrings that are now wrong
--
-- Neither function's body changes. Both describe themselves as carrying no
-- mentions, which was true when the picked array was the only source and is
-- misleading now that the body is: a phone predating 20260830000100 posts through
-- the five-argument signature, and its comments do name people. A function
-- comment is where somebody checks this, so it is worth the two statements.
-- ---------------------------------------------------------------------------

comment on function add_comment(uuid, uuid, text, boolean, uuid) is
  'Posts one comment, or one reply, on a feed event. Since 20260830000100 a thin delegate to _add_comment, and since 20260908000100 one that still names people: it passes no mention ids, but _add_comment resolves the body itself, so a bundle published before either migration posts working mentions. All of 20260826000600''s behaviour is unchanged and now lives in one place: threads exactly one level deep, both visibility checks before any lock, every notifiable pair locked in ascending counterpart-uuid order, the parent pinned with `for share`, and an inbox row for the activity''s actor and the person replied to -- never twice for one person, never to oneself, never to a tombstone, and since 20260908000100 never alongside a mention row for that same person.';

comment on function add_comment(uuid, uuid, text, boolean, uuid, uuid[]) is
  'Posts one comment or reply and records who it names (20260830000100). Ids rather than handles, so the association survives a rename; every one is checked with _can_mention against this activity, and the whole call is refused rather than partially applied if any is ineligible. Since 20260908000100 the ids are a preference rather than the source -- the body is parsed server-side and its handles resolved through the same _can_mention, so a handle typed rather than picked names its person too, and one that resolves to nobody is quietly not a mention. At most one mention notification per (comment, person), ever. p_mention_ids is deliberately not defaulted, so this signature and the five-argument one stay unambiguous to PostgREST and a phone that has not taken this bundle goes on posting.';

-- ---------------------------------------------------------------------------
-- 7. Grants that must survive
--
-- Unchanged definitions, stated rather than assumed, because `create or replace`
-- on a definer is exactly where an ACL has silently gone missing in this repo
-- before (20260830000100, section 8).
-- ---------------------------------------------------------------------------

grant execute on function add_comment(uuid, uuid, text, boolean, uuid)         to authenticated;
grant execute on function add_comment(uuid, uuid, text, boolean, uuid, uuid[]) to authenticated;
grant execute on function edit_comment(uuid, uuid, text, boolean)              to authenticated;
grant execute on function edit_comment(uuid, uuid, text, boolean, uuid[])      to authenticated;
