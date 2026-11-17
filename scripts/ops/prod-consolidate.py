# Historical consolidation on PRODUCTION, one 8-day window per batch (20261128000100).
#
#   prod-consolidate.py plan                 function dry run per window, READ-ONLY transaction
#   prod-consolidate.py apply --authorized   real run; each window is its own batch and its own transaction
#   prod-consolidate.py revert --authorized  reverts every batch this script names, newest first
#
# Batches are history-20261117-wNN; revert_feed_consolidation(batch) undoes one window.
import datetime, json, subprocess, sys

import os
REF = os.environ.get('CONSOLIDATE_REF', 'abheeqyjzekiowkztfxv')
START = datetime.datetime(2026, 8, 14, tzinfo=datetime.timezone.utc)
# The end of history to consolidate: before the grouped-feed release, so nothing a reader is
# creating today is touched.
END = datetime.datetime(2026, 11, 17, 0, 0, tzinfo=datetime.timezone.utc)
PREFIX = 'history-20261117-w'


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


def windows():
    a, n = START, 1
    while a < END:
        b = min(a + datetime.timedelta(days=8), END)
        yield f'{PREFIX}{n:02d}', a, b
        a, n = b, n + 1


mode = sys.argv[1]
if mode in ('apply', 'revert') and '--authorized' not in sys.argv:
    raise SystemExit('STOP: apply and revert need --authorized (a separate founder authorization)')

if mode == 'revert':
    for batch, _, _ in reversed(list(windows())):
        r = query(f"select revert_feed_consolidation('{batch}') as r", False)
        print(batch, json.dumps(r[0]['r']))
    sys.exit(0)

totals = {'groups': 0, 'hidden': 0}
for batch, a, b in windows():
    apply = 'true' if mode == 'apply' else 'false'
    call = f"select consolidate_feed_history('{batch}', '{a.isoformat()}', '{b.isoformat()}', {apply}) as r"
    # The read-only role cannot execute the function, so a plan runs under the operator role
    # inside a transaction declared READ ONLY: any write would fail rather than land.
    sql = call if mode == 'apply' else f'begin transaction read only; {call}; rollback;'
    res = query(sql, False)
    r = res[0]['r'] if isinstance(res, list) and res and 'r' in res[0] else None
    if r is None:
        raise SystemExit(f'STOP: unexpected result for {batch}: {res!r}')
    print(batch, a.date(), b.date(), json.dumps({k: r.get(k) for k in ('planned_groups', 'applied_groups', 'hidden_posts')}))
    g = r['applied_groups'] if mode == 'apply' else r['planned_groups']
    totals['groups'] += int(g.get('ranking', 0)) + int(g.get('watchlist', 0))
    totals['hidden'] += int(r.get('hidden_posts') or 0) if mode == 'apply' else int(g.get('members', 0))
print('TOTAL', json.dumps(totals), 'APPLIED' if mode == 'apply' else 'DRY RUN: nothing written')
