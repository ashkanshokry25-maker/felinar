import json,sys
def ok(name, c):
    if not c: return '----'
    if not c.get('ok'): return 'FAIL'
    v=c.get('v')
    if name.startswith('worker-classic'):
        good = isinstance(v,dict) and isinstance(v.get('fetchAbs'),dict) and v.get('importScripts')=='imp-ok'
        return 'PASS' if good else 'FAIL'
    if name.startswith('worker-module'):
        good = isinstance(v,dict) and isinstance(v.get('fetchAbs'),dict) and v.get('dep')=='dep-ok'
        return 'PASS' if good else 'FAIL'
    if name.startswith('sw-register-root-abs'):
        return 'PASS' if isinstance(v,dict) and str(v.get('script','')).endswith('/sw.js') else 'FAIL'
    if v is False or v==0: return 'FAIL'
    if isinstance(v,str) and v.startswith('ERR'): return 'FAIL'
    return 'PASS'
rows={}
for site in sys.argv[1:]:
    d=json.load(open(f'results-{site}.json'))
    modes=['prefix','remap','true']
    names=list(d['true']['checks'].keys())
    print(f'\n### site={site}   columns: prefix | remap | true')
    for n in names:
        print(f'{n:40s}', ' | '.join(ok(n, d[m]["checks"].get(n)) for m in modes))
    for m in modes:
        if 'NONE' in d[m]['checks']: print(f'  [{m}] the site main script never ran (root-absolute <script src> 404)')
    print('  network leaks after load (count):', {m: len(d[m]['leaksAfterLoad']) for m in modes})
    for m in modes: print(f'   [{m}]', d[m]['leaksAfterLoad'])
