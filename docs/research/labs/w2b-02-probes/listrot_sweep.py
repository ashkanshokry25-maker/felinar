#!/usr/bin/python3
# READ-ONLY liveness sweep: per unique host -> NIP-11 GET (HTTPS) + WebSocket upgrade (no REQ/EVENT sent). Then per-list survival.
import os, sys, json, time, ssl, socket, urllib.request, datetime
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "02-wss-trackers-probes"))
import wsprobe as W
lists = json.load(open("lists.json"))
npm = json.load(urllib.request.urlopen("https://registry.npmjs.org/trystero", timeout=30))
times = npm["time"]
hosts = sorted({h for v in lists.values() for h in v["hosts"]})
print("unique hosts:", len(hosts))
ctx = ssl.create_default_context()
def check(h):
    r = {"host": h}
    hh, _, pp = h.partition(":"); port = int(pp) if pp else 443
    # NIP-11
    try:
        base = "https://%s/" % h
        req = urllib.request.Request(base, headers={"Accept": "application/nostr+json", "User-Agent": "magnet-web-research-probe/1.0 (liveness)"})
        with urllib.request.urlopen(req, timeout=8, context=ctx) as resp:
            body = resp.read(200000)
            try: json.loads(body.decode("utf-8", "replace")); r["nip11"] = "ok"
            except Exception: r["nip11"] = "http%d-nonjson" % resp.status
    except Exception as e: r["nip11"] = "err:" + type(e).__name__
    # WS upgrade only
    try:
        ws = W.WS(hh, port, "/", timeout=8.0, origin="https://example.org")
        ok = ws.connect(); r["ws"] = "101" if ok else ws.info.get("http_status", "?")[:20]
        ws.close()
    except Exception as e: r["ws"] = "err:" + type(e).__name__
    return r
with ThreadPoolExecutor(8) as ex: res = {r["host"]: r for r in ex.map(check, hosts)}
json.dump(res, open("sweep.json", "w"))
print("%-8s %-10s %5s  %-22s %-22s %-22s" % ("version", "released", "n", "WS 101 today", "NIP-11 ok today", "WS101 or NIP-11"))
for v, d in lists.items():
    rel = (times.get(v) or "")[:10]
    hs = d["hosts"]; n = len(hs)
    ws = sum(res[h]["ws"] == "101" for h in hs); n11 = sum(res[h]["nip11"] == "ok" for h in hs); either = sum(res[h]["ws"] == "101" or res[h]["nip11"] == "ok" for h in hs)
    print("%-8s %-10s %5d  %3d (%3.0f%%)             %3d (%3.0f%%)             %3d (%3.0f%%)" % (v, rel, n, ws, 100 * ws / n, n11, 100 * n11 / n, either, 100 * either / n))
