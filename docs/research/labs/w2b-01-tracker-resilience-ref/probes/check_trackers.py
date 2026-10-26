#!/usr/bin/python3
# usage: python3 -I check_trackers.py [--min-ok N] [--relay] [--heartbeat URL] [--origin https://example.org] wss://a wss://b ...
# Cron / CI health check for WebSocket trackers (stdlib only; reuses ../../02-wss-trackers-probes/wsprobe.py and relaytest.py).
# Per tracker: DNS + TCP + TLS + WebSocket upgrade + one announce (numwant 0, random infohash; NOT scrape - openwebtorrent closes on scrape)
# and optionally a 2-peer offer->answer relay. Exit code 0 when at least --min-ok trackers pass (default: all), else 1.
# If --heartbeat is given, GETs that URL when the check passes (dead-man's-switch monitors: UptimeRobot / Better Stack / Healthchecks.io
# alert when the heartbeat STOPS arriving, which also catches "the checker itself died").
import sys, os, json, time, random, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "02-wss-trackers-probes"))
import wsprobe as W
import relaytest as R

def parse(argv):
    o = {"min_ok": None, "relay": False, "heartbeat": None, "origin": "https://example.org", "urls": []}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--min-ok": o["min_ok"] = int(argv[i + 1]); i += 2
        elif a == "--relay": o["relay"] = True; i += 1
        elif a == "--heartbeat": o["heartbeat"] = argv[i + 1]; i += 2
        elif a == "--origin": o["origin"] = argv[i + 1]; i += 2
        else: o["urls"].append(a); i += 1
    return o

def check(url, origin, relay):
    r = {"url": url, "ok": False}
    t = time.time()
    p = W.probe(url, origin=origin, do_announce=False)
    if not p.get("ws_upgrade_ok"):
        r["error"] = p.get("error") or p.get("http_status") or "no upgrade"
        return r
    r.update({k: p.get(k) for k in ("tcp_ms", "tls_ms", "upgrade_ms", "cert_notAfter")})
    u = url.split("://", 1)[1]
    hostport, _, path = u.partition("/"); path = "/" + path
    h, _, port = hostport.partition(":"); port = int(port) if port else 443
    ws = W.WS(h, port, path, timeout=8.0, origin=origin)
    try:
        ws.connect()
        ih = "".join(chr(random.randint(0, 255)) for _ in range(20))
        pid = "-MW0001-" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))
        t1 = time.time()
        ws.send_text(json.dumps({"action": "announce", "info_hash": ih, "peer_id": pid, "uploaded": 0, "downloaded": 0, "left": 1, "event": "started", "numwant": 0, "offers": []}, ensure_ascii=False))
        m = ws.recv_msg(8)
        r["announce_ms"] = round((time.time() - t1) * 1000)
        j = json.loads(m[1]) if m[0] == "text" else {}
        r["interval"] = j.get("interval"); r["failure"] = j.get("failure reason")
        r["ok"] = bool(j.get("interval")) and not j.get("failure reason")
    except Exception as e:
        r["error"] = repr(e)[:120]
    finally:
        ws.close()
    if r["ok"] and relay:
        rr = R.run(url)
        r["relay_ok"] = bool(rr.get("offer_forwarded_to_A") and rr.get("answer_forwarded_to_B"))
        r["ok"] = r["ok"] and r["relay_ok"]
    r["total_ms"] = round((time.time() - t) * 1000)
    return r

if __name__ == "__main__":
    o = parse(sys.argv[1:])
    if not o["urls"]:
        print(__doc__); sys.exit(2)
    res = [check(u, o["origin"], o["relay"]) for u in o["urls"]]
    need = o["min_ok"] if o["min_ok"] is not None else len(res)
    ok = sum(1 for r in res if r["ok"])
    out = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "ok": ok, "total": len(res), "need": need, "pass": ok >= need, "results": res}
    print(json.dumps(out))
    if out["pass"] and o["heartbeat"]:
        try:
            urllib.request.urlopen(o["heartbeat"], timeout=10).read()
        except Exception as e:
            print(json.dumps({"heartbeat_error": repr(e)[:100]}), file=sys.stderr)
    sys.exit(0 if out["pass"] else 1)
