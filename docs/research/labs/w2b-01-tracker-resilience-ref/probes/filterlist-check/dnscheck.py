# usage: python3 -I dnscheck.py <dir with DNS lists (hosts / adblock ||domain^ / plain domain lines)>
# Prints, per list, which CANDS hostnames (or a parent domain) are blocked. Edit CANDS to the hostnames in src/loader/config.js.
import re, sys, os, json
D = sys.argv[1]
CANDS = """tracker.openwebtorrent.com openwebtorrent.com tracker.webtorrent.dev webtorrent.dev webtorrent.io open.ftorrent.com ftorrent.com
tracker.novage.com.ua novage.com.ua tracker.btorrent.xyz btorrent.xyz tracker.fastcast.nz tracker.files.fm files.fm
nos.lol relay.damus.io relay.primal.net relay.nostr.band broker.emqx.io broker.hivemq.com test.mosquitto.org public.cloud.shiftr.io
stun.l.google.com stun.cloudflare.com global.stun.twilio.com cloudflare-dns.com dns.google 0.peerjs.com
tracker.example-site.org rtc.example-site.org signal.example-site.org""".split()
def parse(path):
    block, allow = set(), set()
    with open(path, 'r', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line or line[0] in '#!':
                continue
            m = re.match(r'^@@\|\|([a-z0-9._*-]+)\^', line, re.I)
            if m: allow.add(m.group(1).lower()); continue
            m = re.match(r'^\|\|([a-z0-9._*-]+)\^', line, re.I)
            if m: block.add(m.group(1).lower()); continue
            m = re.match(r'^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9._-]+)', line, re.I)
            if m: block.add(m.group(1).lower()); continue
            if re.match(r'^[a-z0-9._-]+$', line, re.I) and '.' in line:
                block.add(line.lower())
    return block, allow
def hit(d, S):
    parts = d.split('.')
    for i in range(len(parts) - 1):
        s = '.'.join(parts[i:])
        if s in S: return s
    return None
files = [f for f in sorted(os.listdir(D)) if f.endswith('.txt') and f not in ('fanboy-enhanced.txt',)]
res = {}
for f in files:
    b, a = parse(os.path.join(D, f))
    res[f] = {'n_block': len(b), 'hits': {}}
    for c in CANDS:
        h = hit(c, b)
        if h: res[f]['hits'][c] = ('BLOCK via ' + h) + (' (but allow-listed via %s)' % hit(c, a) if hit(c, a) else '')
for f, r in res.items():
    print('%-28s entries=%-9d hits=%s' % (f, r['n_block'], json.dumps(r['hits']) if r['hits'] else 'none'))
