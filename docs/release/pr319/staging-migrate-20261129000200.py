# Applies pending migrations to STAGING (bingd-staging) one file per transaction, recording history like `db push`.
# Usage: prod-migrate.py dry-run | apply      (run from a clean checkout of the release SHA)
import glob, json, os, subprocess, sys
REF = 'fjxhcbowoxuzulwirzyr'
EXPECTED = ['20261129000200']

def query(sql, read_only):
    body = json.dumps({'query': sql, 'read_only': read_only})
    out = subprocess.run(['curl', '-sS', '--max-time', '300', '-X', 'POST',
                          f'https://api.supabase.com/v1/projects/{REF}/database/query',
                          '-H', 'content-type: application/json', '--data-binary', '@-'],
                         input=body, capture_output=True, text=True).stdout
    data = json.loads(out)
    if isinstance(data, dict) and ('message' in data or 'error' in data):
        raise SystemExit(f'query failed: {data}')
    return data

applied = {r['version'] for r in query('select version from supabase_migrations.schema_migrations', True)}
files = sorted(glob.glob('supabase/migrations/*.sql'))
local = {os.path.basename(f).split('_', 1)[0]: f for f in files}
missing_locally = sorted(applied - set(local))
pending = sorted(set(local) - applied)
print('staging applied:', len(applied), 'head:', max(applied))
print('on staging but not in this checkout:', missing_locally or 'none')
print('pending:', pending)
if missing_locally or pending != EXPECTED:
    raise SystemExit('STOP: pending set differs from the verified plan')
if sys.argv[1] != 'apply':
    print('DRY RUN: nothing applied')
    sys.exit(0)
for v in pending:
    path = local[v]
    sql = open(path, encoding='utf8').read()
    name = os.path.basename(path)[len(v) + 1:-4]
    tag = '$mig' + v + '$'
    assert tag not in sql
    query('begin;\n' + sql + f"\ninsert into supabase_migrations.schema_migrations (version, name, statements) values ('{v}', '{name}', array[{tag}{sql}{tag}]);\ncommit;", False)
    ok = query(f"select count(*)::int as n from supabase_migrations.schema_migrations where version = '{v}'", True)[0]['n']
    print('applied', v, name, 'recorded' if ok == 1 else 'NOT RECORDED')
    if ok != 1:
        raise SystemExit('STOP')
print('done')
