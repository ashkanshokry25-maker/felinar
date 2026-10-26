#!/usr/bin/python3
import json, re, urllib.request
want = ["0.13.0","0.14.0","0.15.0","0.16.0","0.17.0","0.18.0","0.19.0","0.20.0","0.20.1","0.21.0","0.21.8","0.22.0","0.23.0","0.24.0","0.25.0","0.26.0"]
paths = ["src/nostr.js","src/nostr.ts","src/strategies/nostr.js","packages/nostr/src/index.ts","packages/nostr/src/nostr.ts"]
def get(u):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "magnet-web-research"}), timeout=20) as r: return r.read().decode("utf-8", "replace")
    except Exception as e: return None
out = {}
for t in want:
    got = None
    for pre in (t, "v" + t):
        for p in paths:
            txt = get("https://raw.githubusercontent.com/dmotz/trystero/%s/%s" % (pre, p))
            if txt: got = (pre, p, txt); break
        if got: break
    if not got: print(t, "no source found"); continue
    pre, p, txt = got
    m = re.search(r"(defaultRelayUrls|relayUrls|defaultRelays|relays)\s*=\s*\[(.*?)\]", txt, re.S)
    blk = m.group(2) if m else ""
    hosts = re.findall(r"['\"](?:wss://)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?)(?:/[^'\"]*)?['\"]", blk)
    out[t] = {"tag": pre, "path": p, "hosts": hosts}
    print(t, pre, p, len(hosts), hosts[:3])
json.dump(out, open("lists.json", "w"), indent=1)
