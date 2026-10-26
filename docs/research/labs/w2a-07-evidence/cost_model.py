#!/usr/bin/env python3
"""w2a-07: monthly cost of the WEB-SEED host (not the shell host) for magnet-web, from list prices read on 2026-10-17.
MODEL, not measurement.  Prices and the page each came from are in the research file (section 3).  Run: python3 -I cost_model.py
Per cold visit the web seed sees: P + F - 1 range GETs (P = pieces of 256 KiB, F = files; one GET per piece x file overlap, webconn.js),
plus F CORS preflights when the stock WebTorrent headers are used (cache-control/user-agent are not CORS-safelisted), plus the .torrent.
Warm visits (served from IndexedDB) cost the web seed nothing.  Peers are assumed to carry p2p of the payload bytes (default 0, see the offload model).
"""
import math

PIECE = 256 * 1024

def scenario(name, visits_day, S_bytes, F, cold=0.30, extra_spike_visits=0, spike_cold=0.8, p2p=0.0, stock_headers=True, days=30):
    cold_visits = visits_day * days * cold + extra_spike_visits * spike_cold
    P = math.ceil(S_bytes / PIECE)
    req_per_cold = 1 + (P + F - 1) + (F if stock_headers else 0)      # .torrent + range GETs + preflights
    gb = cold_visits * S_bytes * (1 - p2p) / 1e9
    req = cold_visits * req_per_cold
    return dict(name=name, cold_visits=cold_visits, P=P, F=F, req_per_cold=req_per_cold, GB=gb, req=req, S=S_bytes)

def tiered(gb, free_gb, tiers):
    """tiers = [(size_gb, usd_per_gb), ...]; the last tier may use size None (unbounded). free_gb is subtracted first."""
    left = max(0.0, gb - free_gb); total = 0.0
    for size, rate in tiers:
        take = left if size is None else min(left, size)
        total += take * rate; left -= take
        if left <= 0: break
    return total
S3_OUT = [(10240, 0.09), (40960, 0.085), (102400, 0.07), (None, 0.05)]          # AWSDataTransfer us-east-1 price list, published 2026-09-16
CF_OUT = [(10240, 0.085), (40960, 0.080), (102400, 0.060), (None, 0.040)]       # CloudFront US price list, published 2026-10-03
def cost_s3_direct(sc, store_gb):
    egress = tiered(sc['GB'], 100, S3_OUT)                           # first 100 GB/month free (aggregated across services)
    return 0.023 * store_gb + egress + sc['req'] * 0.0000004          # GET $0.40 per million (S3 price list 2026-10-15)
def cost_cloudfront_payg(sc, store_gb):
    egress = tiered(sc['GB'], 1024, CF_OUT)                          # 1 TB/month always-free
    reqs = max(0.0, sc['req'] - 10e6) * 0.000001                     # 10 M/month free, then $0.0100 per 10,000 HTTPS = $1.00/M
    return 0.023 * store_gb + egress + reqs
def cost_cloudfront_flat(sc, store_gb):
    for price, reqs, gb in ((0, 1e6, 100), (15, 10e6, 50000), (200, 125e6, 50000), (1000, 500e6, 50000)):
        if sc['req'] <= reqs and sc['GB'] <= gb: return price
    return None
def cost_r2(sc, store_gb, hit=0.9):
    b = sc['req'] * (1 - hit)                                        # only cache misses reach R2 when a custom domain + cache rule fronts it (ASSUMPTION)
    return max(0.0, store_gb - 10) * 0.015 + max(0.0, b - 10e6) * 0.36 / 1e6
def cost_r2_nocache(sc, store_gb):
    return max(0.0, store_gb - 10) * 0.015 + max(0.0, sc['req'] - 10e6) * 0.36 / 1e6
def cost_b2_cloudflare(sc, store_gb):
    return max(0.0, store_gb - 10) * 0.00695                         # $6.95/TB-month, first 10 GB free; egress to Cloudflare free; Class A/B/C calls free
def cost_b2_direct(sc, store_gb):
    free = 3 * store_gb
    return max(0.0, store_gb - 10) * 0.00695 + max(0.0, sc['GB'] - free) * 0.01
def cost_bunny(sc, store_gb, rate=0.01):
    return max(1.0, store_gb * 0.01 + sc['GB'] * rate)               # Standard network EU/NA $0.01/GB, storage $0.01/GB-month single region, $1 minimum, no request fees
def cost_do(sc, store_gb):
    gib = sc['GB'] * 1e9 / 1024**3
    return 5.0 + max(0.0, gib - 1024) * 0.01 + max(0.0, store_gb * 1e9 / 1024**3 - 250) * 0.02
def cost_storj(sc, store_gb):
    return max(5.0, store_gb / 1000 * 7 + sc['GB'] / 1000 * 7)
def cost_netlify(sc, store_gb):
    credits = 20 * sc['GB'] + 2 * sc['req'] / 10000.0
    best = []
    if credits <= 300: best.append(('Free', 0.0))
    best.append(('Personal', 9 + max(0.0, credits - 1000) * 0.01))
    best.append(('Pro', 20 + max(0.0, credits - 3000) * (10.0 / 1500)))
    return min(best, key=lambda x: x[1]), credits
def cost_vercel(sc, store_gb):
    # Pro $20/mo; Flat Rate CDN tiers: included 1M req / 1 TB; $20 -> 10M / 50 TB; $100 -> 50M / 50 TB; $300 -> 150M / 50 TB  (docs last_updated 2026-09-14)
    for tier, reqs, gb in ((0, 1e6, 1000), (20, 10e6, 50000), (100, 50e6, 50000), (300, 150e6, 50000)):
        if sc['req'] <= reqs and sc['GB'] <= gb: return 20 + tier
    return None
def cost_pinata(sc, store_gb):
    # Picnic $20: 1 TB storage, 500 GB bandwidth then $0.10/GB, 1 M requests then $0.20 per 10k = $20/M
    return 20 + max(0.0, sc['GB'] - 500) * 0.10 + max(0.0, sc['req'] - 1e6) * 20 / 1e6
def cost_filebase_ipfs(sc, store_gb):
    return 7.5 + max(0.0, sc['GB'] - 250) * 0.015

PROVIDERS = [
    ('S3 REST direct (HTTPS, no CDN)', lambda sc, g: cost_s3_direct(sc, g)),
    ('CloudFront pay-as-you-go + S3', lambda sc, g: cost_cloudfront_payg(sc, g)),
    ('CloudFront flat-rate plan (strict allowances)', lambda sc, g: cost_cloudfront_flat(sc, g)),
    ('Cloudflare R2 + custom domain, 90 % cache hit', lambda sc, g: cost_r2(sc, g)),
    ('Cloudflare R2, every request reaches R2', lambda sc, g: cost_r2_nocache(sc, g)),
    ('Backblaze B2 behind Cloudflare (Bandwidth Alliance)', lambda sc, g: cost_b2_cloudflare(sc, g)),
    ('Backblaze B2 direct (3x free egress)', lambda sc, g: cost_b2_direct(sc, g)),
    ('Bunny Storage + CDN Standard (EU/NA)', lambda sc, g: cost_bunny(sc, g)),
    ('Bunny Storage + CDN Volume network', lambda sc, g: cost_bunny(sc, g, 0.005)),
    ('DigitalOcean Spaces (+CDN)', lambda sc, g: cost_do(sc, g)),
    ('Storj (Standard tier)', lambda sc, g: cost_storj(sc, g)),
    ('Netlify (credits)', None),
    ('Vercel Pro (+Flat Rate CDN tier)', lambda sc, g: cost_vercel(sc, g)),
    ('Pinata Picnic (gateway)', lambda sc, g: cost_pinata(sc, g)),
    ('Filebase Pro (IPFS egress)', lambda sc, g: cost_filebase_ipfs(sc, g)),
]

def fmt(v):
    if v is None: return '>tier'
    return '$%.2f' % v if v < 1000 else '$%.0f' % v

def main():
    scs = [
        ('A blog 2 MB, 40 files, 1k visits/day', dict(visits_day=1000, S_bytes=2e6, F=40)),
        ('B docs 8 MB, 200 files, 10k visits/day', dict(visits_day=10000, S_bytes=8e6, F=200)),
        ('B2 same, single-file layout (F=1)', dict(visits_day=10000, S_bytes=8e6, F=1)),
        ('B3 same, single-file layout and patched headers (no preflight)', dict(visits_day=10000, S_bytes=8e6, F=1, stock_headers=False)),
        ('C media 60 MB, 300 files, 10k visits/day', dict(visits_day=10000, S_bytes=60e6, F=300)),
        ('D viral: B plus 200k visits in one day (80 % cold)', dict(visits_day=10000, S_bytes=8e6, F=200, extra_spike_visits=200000)),
        ('E large: 25 MB, 100 files, 100k visits/day', dict(visits_day=100000, S_bytes=25e6, F=100)),
    ]
    for p2p in (0.0, 0.5):
        print('\n## p2p share of payload bytes = %d %%' % (p2p * 100))
        print('| scenario | cold visits/mo | req per cold visit | web-seed GB/mo | web-seed requests/mo |')
        print('|---|---|---|---|---|')
        rows = []
        for name, kw in scs:
            sc = scenario(name, p2p=p2p, **kw)
            rows.append(sc)
            print('| %s | %s | %d | %s | %.1f M |' % (name, '{:,.0f}'.format(sc['cold_visits']), sc['req_per_cold'], '{:,.0f}'.format(sc['GB']), sc['req'] / 1e6))
        print()
        hdr = '| provider | ' + ' | '.join(r['name'].split(' ')[0] for r in rows) + ' |'
        print(hdr); print('|---|' + '---|' * len(rows))
        for pname, fn in PROVIDERS:
            cells = []
            for sc in rows:
                store_gb = max(0.05, sc['S'] / 1e9 * 3)             # 3 retained versions of the site
                if pname.startswith('Netlify'):
                    (plan, c), credits = cost_netlify(sc, store_gb)
                    cells.append('%s (%s)' % (fmt(c), plan))
                else:
                    cells.append(fmt(fn(sc, store_gb)))
            print('| %s | %s |' % (pname, ' | '.join(cells)))

if __name__ == '__main__':
    main()
