# Authorized historical consolidation (founder, 2026-11-17). Sequential, verified, stop-on-mismatch.
#   consol-run.py check            re-plan every window read-only and compare to the approved dry run
#   consol-run.py apply --authorized
import json, sys, datetime, subprocess
S = '/tmp/claude-0/-home-user-bingd/d9ab9398-3aea-5caf-bad6-b4303c2d90da/scratchpad'
sys.path.insert(0, S)
REF = 'abheeqyjzekiowkztfxv'
START = datetime.datetime(2026, 8, 14, tzinfo=datetime.timezone.utc)
END = datetime.datetime(2026, 11, 17, tzinfo=datetime.timezone.utc)


def query(sql, read_only):
    out = subprocess.run(['curl', '-sS', '--max-time', '300', '-X', 'POST',
                          f'https://api.supabase.com/v1/projects/{REF}/database/query',
                          '-H', 'content-type: application/json', '--data-binary', '@-'],
                         input=json.dumps({'query': sql, 'read_only': read_only}), capture_output=True, text=True).stdout
    d = json.loads(out)
    if isinstance(d, dict) and ('message' in d or 'error' in d):
        raise SystemExit(f'STOP: query failed: {d}')
    return d


def windows():
    a, n = START, 1
    while a < END:
        b = min(a + datetime.timedelta(days=8), END)
        yield f'history-20261117-w{n:02d}', a, b
        a, n = b, n + 1


# The approved SQL dry run, per window and family.
approved = json.load(open(f'{S}/prod-dryrun-full-history.json'))
expected = {}
for (batch, a, b), row in zip(windows(), approved):
    groups, members = row[2], row[3]
    expected[batch] = {
        'ranking': groups['ranking'], 'watchlist': groups['watchlist'],
        'members': members['ranking'] + members['watchlist'],
        # Ranking members are all hidden behind a new group; a watchlist burst promotes its
        # earliest post and hides the rest.
        'hidden': members['ranking'] + members['watchlist'] - groups['watchlist'],
    }


def call(batch, a, b, apply):
    c = f"select consolidate_feed_history('{batch}', '{a.isoformat()}', '{b.isoformat()}', {'true' if apply else 'false'}) as r"
    res = query(c if apply else f'begin transaction read only; {c}; rollback;', False)
    if not (isinstance(res, list) and res and 'r' in res[0]):
        raise SystemExit(f'STOP: unexpected result for {batch}: {res!r}')
    return res[0]['r']


def plan_ok(batch, r):
    p, e = r['planned_groups'], expected[batch]
    got = {'ranking': p['ranking'], 'watchlist': p['watchlist'], 'members': p['members']}
    want = {k: e[k] for k in got}
    return got == want, got, want


mode = sys.argv[1]
if mode == 'apply' and '--authorized' not in sys.argv:
    raise SystemExit('STOP: apply needs --authorized')

tot = {'groups': 0, 'members': 0, 'hidden': 0}
for batch, a, b in windows():
    r = call(batch, a, b, False)
    ok, got, want = plan_ok(batch, r)
    if not ok:
        raise SystemExit(f'STOP: {batch} plan {got} differs from the approved dry run {want}')
    if mode != 'apply':
        print(batch, 'plan matches', got)
        tot['groups'] += got['ranking'] + got['watchlist']; tot['members'] += got['members']
        continue
    applied = call(batch, a, b, True)
    ag = applied['applied_groups']
    e = expected[batch]
    if (ag['ranking'], ag['watchlist'], applied['hidden_posts']) != (e['ranking'], e['watchlist'], e['hidden']):
        raise SystemExit(f'STOP: {batch} applied {ag} hidden {applied["hidden_posts"]}, expected {e}')
    logged = query(f"select count(*) filter (where member_event_id is null)::int groups, count(*) filter (where member_event_id is not null)::int members from feed_consolidation_log where batch = '{batch}'", True)[0]
    print(batch, a.date(), b.date(), 'applied', ag, 'hidden', applied['hidden_posts'], 'log', logged, flush=True)
    tot['groups'] += ag['ranking'] + ag['watchlist']; tot['members'] += e['members']; tot['hidden'] += applied['hidden_posts']
print('TOTAL', json.dumps(tot), 'APPLIED' if mode == 'apply' else 'CHECK ONLY: nothing written')
