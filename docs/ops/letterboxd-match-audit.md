# Letterboxd match audit and cleanup

Written for: the founder, or whoever is operating production.

## Why this exists

Until `20261024000200`, two free accounts could make a Letterboxd film URI point at the wrong film for everybody (security audit 2026-11-01, M-1). That migration stops it: a mapping now only confirms what a row already says, so a wrong mapping is inert from the moment it applies.

**The migration does not clean anything up.** Two things may already be wrong in production:

1. Rows in `letterboxd_matches` that point at the wrong film. Harmless now, but worth removing.
2. Titles in somebody's collection that an import placed on the wrong film. These are real and they stay until fixed.

## Running the audit

This reads only. Run it in the Supabase SQL editor for the project, or with `psql`, after `20261024000200` is applied:

```sql
begin transaction read only;
-- paste supabase/audits/letterboxd-matches.sql here
rollback;
```

## Reading the result

| `finding` | What it means | What to do |
|---|---|---|
| `slug_disagrees` | The URI itself names a different film | Remove the mapping |
| `contested` | Accounts disagree about this URI | Read the claims, then decide |
| `name_disagrees` | An imported title sits on this film under a different name | Review. Honest alternate titles land here too |

Real exports use `boxd.it` short links, which name nothing, so `slug_disagrees` will usually be empty. `contested` and `name_disagrees` are the useful lists.

To look at who claimed a URI, without printing a handle:

```sql
begin transaction read only;
select c.media_item_id, m.title, c.tier, c.claimed_at, c.user_id, p.created_at as account_created
  from letterboxd_match_claims c
  join media_items m on m.id = c.media_item_id
  join profiles p on p.id = c.user_id
 where c.letterboxd_uri = '<uri>'
 order by c.claimed_at;
rollback;
```

Two accounts created close together, claiming the same URI, with no other import history, is the shape of an attack.

## Cleanup

**Nobody has run this. Do it by hand, once, after reading the audit output, and take a backup first** (`docs/release/backup-and-recovery.md`).

Removing a mapping is safe, because a mapping is a cache. The film goes back to being matched by name and year:

```sql
begin;
delete from letterboxd_matches where letterboxd_uri = '<uri>';
-- Check it removed exactly one row, then:
commit;
```

Leave `letterboxd_match_claims` alone. Those rows are the evidence of who claimed what.

A title already in somebody's collection is theirs, so it is not corrected by SQL here. Ranking, watch history and awards all hang off it, and a bulk update would move those without asking. Contact the person, or let them remove the title and re-import. If the list turns out to be large, that is a separate piece of work to design rather than a script to run.
