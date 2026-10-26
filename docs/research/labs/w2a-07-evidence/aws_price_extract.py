import json, sys
base='/private/tmp/claude-501/-Users-owner/2e31ae61-4460-4879-804d-f5507c05cdbe/scratchpad/w2a07/dl/aws-price/'
def load(fn): return json.load(open(base+fn))
def rows(d, pred):
    out=[]
    for sku,p in d['products'].items():
        a=p.get('attributes',{})
        if not pred(a): continue
        terms=d['terms']['OnDemand'].get(sku,{})
        for t in terms.values():
            for pd in t['priceDimensions'].values():
                out.append((a, pd['beginRange'], pd['endRange'], pd['unit'], pd['pricePerUnit'].get('USD'), pd['description'][:140]))
    return out
# Data transfer out to Internet, us-east-1
d=load('dt-us-east-1.json')
print('== AWSDataTransfer us-east-1: out to internet ==', d['publicationDate'])
for a,b,e,u,p,desc in sorted(rows(d, lambda a: a.get('fromLocation')=='US East (N. Virginia)' and a.get('toLocation')=='External' and 'DataTransfer-Out-Bytes' in a.get('usagetype','')), key=lambda r: float(r[1])):
    print(a.get('usagetype'), b, e, u, p, '|', desc)
# S3 us-east-1 storage standard + requests
s=load('s3-us-east-1.json')
print('== S3 us-east-1 ==', s['publicationDate'])
for a,b,e,u,p,desc in sorted(rows(s, lambda a: a.get('usagetype') in ('TimedStorage-ByteHrs','Requests-Tier1','Requests-Tier2')), key=lambda r:(r[0].get('usagetype'),float(r[1]))):
    print(a.get('usagetype'), a.get('storageClass'), a.get('volumeType'), b, e, u, p, '|', desc)
# CloudFront
c=load('cf.json')
print('== CloudFront ==', c['publicationDate'])
want=('US-DataTransfer-Out-Bytes','US-Requests-Tier1','US-Requests-Tier2-HTTPS','Requests-Tier2-HTTPS','US-Requests-Tier2-HTTP-Proxy')
for a,b,e,u,p,desc in sorted(rows(c, lambda a: a.get('location') in ('United States',) or a.get('fromLocation') in ('United States',)), key=lambda r:(r[0].get('usagetype',''),float(r[1]))):
    ut=a.get('usagetype','')
    if 'Out-Bytes' in ut or 'Requests-Tier' in ut or 'Invalidation' in ut or 'FunctionInvocations' in ut:
        print(ut, a.get('location'), b, e, u, p, '|', desc)
