#!/usr/bin/env python3
# Parametric relay-cost model for magnet-web (all inputs are ASSUMPTIONS except provider prices, which come from vendor pages read 2026-10-17)
GB = 1e9   # vendors bill in decimal GB (Cloudflare "GB", Twilio "GB"); we treat 1 GB = 1e9 bytes
MB = 1e6

prices = {
  'Cloudflare TURN ($0.05/GB after 1,000 GB free/month)': dict(free_gb=1000, per_gb=0.05),
  'Twilio NTS US/EU ($0.40/GB, no free)': dict(free_gb=0, per_gb=0.40),
  'ExpressTURN Premium ($9/mo incl 5,000 GB, overage unknown)': dict(free_gb=0, per_gb=None, flat=9, incl_gb=5000),
}

def relayed_bytes_per_visit(site_mb, peer_frac, relay_share, gossip_kb=50, policy='A'):
    """policy A: ICE decides, only pairs that need it are relayed -> relay_share of peer bytes + gossip
       policy B: control-only: only gossip is relayed, bulk goes to web seed
       policy C: relay-only privacy mode: 100% of peer bytes + gossip relayed"""
    bulk = site_mb * MB * peer_frac
    g = gossip_kb * 1e3
    if policy == 'A': return bulk * relay_share + g * relay_share
    if policy == 'B': return g * relay_share
    if policy == 'C': return bulk + g
    raise ValueError

def table():
    rows = []
    for site_mb in (1, 3, 10):
        for peer_frac in (0.1, 0.5, 0.9):
            for pol, rs in (('A', 0.15), ('A', 0.30), ('B', 0.30), ('C', 1.0)):
                b = relayed_bytes_per_visit(site_mb, peer_frac, rs, policy=pol)
                rows.append((site_mb, peer_frac, pol, rs, b))
    return rows

if __name__ == '__main__':
    print('| site MB | peer-sourced | policy | relay share | relayed KB/visit | visits/mo covered by CF free 1,000 GB | CF $ per extra 1M visits | Twilio $ per 1M visits |')
    print('|---|---|---|---|---|---|---|---|')
    for site_mb, pf, pol, rs, b in table():
        if (site_mb, pf) not in ((1, 0.5), (3, 0.5), (3, 0.9), (10, 0.5), (3, 0.1)): continue
        visits_free = 1000 * GB / b
        cf = b * 1e6 / GB * 0.05
        tw = b * 1e6 / GB * 0.40
        print(f'| {site_mb} | {int(pf*100)}% | {pol} | {int(rs*100)}% | {b/1e3:,.0f} | {visits_free/1e6:,.2f} M | ${cf:,.2f} | ${tw:,.2f} |')
    print()
    # web-seed egress comparison: what P2P offload saves
    print('Offload value per 1M visits (bytes served by peers instead of web seed), at host egress price:')
    for site_mb, pf in ((3, 0.1), (3, 0.5), (3, 0.9)):
        off = site_mb * MB * pf * 1e6 / GB
        print(f'  site {site_mb} MB, peer fraction {int(pf*100)}%: {off:,.0f} GB per 1M visits -> CloudFront $0.085/GB: ${off*0.085:,.0f}; S3->CF same; Cloudflare Pages/R2 egress: $0 (no stated bandwidth charge on limits page)')
    print()
    # self-hosted break-even
    print('Self-hosted vs Cloudflare break-even (GB relayed per month):')
    for name, monthly, incl_gb in (('DigitalOcean $6 droplet (1,000 GiB incl.)', 6, 1073.7), ('DigitalOcean $24 droplet (4,000 GiB incl.)', 24, 4294.97)):
        # CF cost for X GB = max(0, X-1000)*0.05 ; self-host fixed monthly (within included transfer)
        x = 1000 + monthly / 0.05
        print(f'  {name}: Cloudflare costs more than ${monthly}/mo once relayed volume > {x:,.0f} GB/month (self-host capped at ~{incl_gb:,.0f} GB incl.)')
    # allocation load model
    print()
    print('TURN allocation churn if TURN is configured on EVERY RTCPeerConnection (WebTorrent tracker offers):')
    for trackers in (2, 4):
        offers_per_min = 5 * (60 / 30) * trackers      # 5 offers per announce, announce interval 30 s (bittorrent-tracker 11.2.3 websocket-tracker.js)
        for reqs_per_pc in (4,):
            for conc in (100, 1000, 10000):
                pcs_per_s = conc * offers_per_min / 60
                print(f'  trackers={trackers}: initiator PCs/min/visitor={offers_per_min:.0f}; concurrent visitors={conc:>6}: {pcs_per_s:,.0f} new PCs/s => {pcs_per_s*reqs_per_pc:,.0f} TURN requests/s (Binding + Allocate(401) + Allocate(auth) + Refresh(0), measured in Chromium 156 and WebKit 27.2, per PC per TURN/UDP URL), plus answerer-side PCs')
