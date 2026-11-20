# Read-only production verification for the #319 migrations. Runs the invariant checkers inside a
# READ ONLY transaction that is rolled back, and reports function signatures and grants. No writes.
import json, subprocess, sys
REF = 'abheeqyjzekiowkztfxv'
def q(sql, ro):
    out = subprocess.run(['curl','-sS','--max-time','300','-X','POST',f'https://api.supabase.com/v1/projects/{REF}/database/query','-H','content-type: application/json','--data-binary','@-'],
                         input=json.dumps({'query': sql, 'read_only': ro}), capture_output=True, text=True).stdout
    return json.loads(out)
print('head:', q("select max(version) v, count(*) n from supabase_migrations.schema_migrations", True))
for name in ['assert_watch_history_valid()', 'assert_placements_valid()']:
    r = q(f"begin transaction read only; select {name}; rollback;", False)
    print(name, 'OK' if not (isinstance(r, dict) and ('message' in r or 'error' in r)) else ('FAIL: ' + str(r.get('message', r))[:300]))
r = q("""begin transaction read only;
  do $$ declare u record; c text; begin
    for u in select distinct user_id from rankings loop
      foreach c in array array['movies','tv_seasons','tv_shows'] loop
        perform assert_ranking_valid(u.user_id, c::ranking_category);
      end loop;
    end loop; end $$;
  rollback;""", False)
print('assert_ranking_valid (every user, every pool)', 'OK' if not (isinstance(r, dict) and ('message' in r or 'error' in r)) else ('FAIL: ' + str(r.get('message', r))[:300]))
print('functions:', q("""select p.oid::regprocedure::text sig, has_function_privilege('authenticated', p.oid, 'execute') auth,
   has_function_privilege('anon', p.oid, 'execute') anon from pg_proc p
   where proname in ('rank_reorder','rank_promote_show','rank_unpromote_show') order by 1""", True))
print('objects:', q("select to_regclass('public.show_promotions') is not null as show_promotions, (select count(*) from pg_trigger where tgname='user_media_placed_show_keeps_its_evidence') as evidence_trigger", True))
