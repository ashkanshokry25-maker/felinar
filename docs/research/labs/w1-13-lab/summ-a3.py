import json,sys
for eng in sys.argv[1:]:
    p=f'$HOME/Documents/Projects/magnet-web/docs/research/labs/w1-13-lab/results/a3-xs-cors-{eng}.json'
    try: d=json.load(open(p))
    except Exception as e: print(eng,'ERR',e); continue
    r=d['results'].get(eng,{})
    print('==',eng,r.get('version'),r.get('fatal','')[:100])
    if 'features' in r: print('features:',json.dumps(r['features']))
    for k,v in r.get('scenarios',{}).items():
        pf=','.join(x for x in v['preflightRequestedHeaders'] if x) if v['preflights'] else '-'
        print(f"{k:78s} {v['status']:9s} {str(v['ms']):>5s}ms sha={str(v.get('sha256Match')):5s} OPTIONS={v['preflights']:2d}[{pf}] GET={v['getCount']:2d}({v['getStatuses']}) ua={'WT' if v['getHadUserAgentHeader'] else 'no'} w={v['warnings'][:1]} pe={v['pageErrors'][:1]}")
