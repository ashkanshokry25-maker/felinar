#!/usr/bin/python3
# usage: /usr/bin/python3 -I seedertest.py wss://tracker.example.com ...
# Research 2026-10-17 (topic 12). Stdlib-only. Re-uses the WS client from ../02-wss-trackers-probes/wsprobe.py.
# Question: does a WebSocket tracker introduce two peers that both announce as SEEDERS (left=0) to each other?
# A metadata-less WebTorrent torrent (infohash-only magnet) sends left=NaN -> JSON null, which the reference tracker
# parses with Number(null) = 0, i.e. as a seeder; a rendezvous swarm only works if seeder<->seeder pairing works.
# Two fake peers per scenario, private random infohash, mock SDP strings, closed right away (same method as 02/relaytest.py).
import sys, os, json, time, random
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, '..', '02-wss-trackers-probes'))
import wsprobe as W

def rnd_bin(n=20):
    return "".join(chr(random.randint(0, 255)) for _ in range(n))

def pid():
    return "-MW0001-" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))

def wait_for(ws, pred, timeout):
    end = time.time() + timeout
    while time.time() < end:
        try:
            r = ws.recv_msg(max(0.3, end - time.time()))
        except Exception:
            return None
        if r[0] != "text":
            return None
        try:
            m = json.loads(r[1])
        except Exception:
            continue
        if pred(m):
            return m
    return None

# left modes: 'zero' -> 0 ; 'one' -> 1 ; 'omit' -> key absent ; 'null' -> JSON null
def ann(ih, p, left_mode, extra):
    d = {"action": "announce", "info_hash": ih, "peer_id": p, "uploaded": 0, "downloaded": 0, "event": "started"}
    if left_mode == 'zero': d["left"] = 0
    elif left_mode == 'one': d["left"] = 1
    elif left_mode == 'null': d["left"] = None
    d.update(extra)
    return json.dumps(d, ensure_ascii=False)

def scenario(host, port, path, name, a_mode, b_mode):
    a = W.WS(host, port, path, timeout=10.0, origin="https://example.org")
    b = W.WS(host, port, path, timeout=10.0, origin="https://example.org")
    res = {"scenario": name, "A_left": a_mode, "B_left": b_mode}
    try:
        if not (a.connect() and b.connect()):
            res["upgrade"] = (a.info.get("http_status"), b.info.get("http_status")); return res
        ih = rnd_bin(); pa, pb = pid(), pid(); oid = rnd_bin()
        a.send_text(ann(ih, pa, a_mode, {"numwant": 0, "offers": []}))
        m = wait_for(a, lambda m: m.get("action") == "announce" and "interval" in m, 6)
        res["A_announce_ok"] = bool(m)
        if m: res["A_interval"] = m.get("interval")
        t0 = time.time()
        b.send_text(ann(ih, pb, b_mode, {"numwant": 1, "offers": [{"offer_id": oid, "offer": {"type": "offer", "sdp": "v=0 mock-offer"}}]}))
        m = wait_for(a, lambda m: "offer" in m and m.get("offer_id") == oid, 6)
        res["offer_B_to_A_forwarded"] = bool(m)
        if m: res["offer_ms"] = round((time.time() - t0) * 1000)
    except Exception as e:
        res["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        a.close(); b.close()
    return res

SCEN = [
    ("S1 seeder+seeder", 'zero', 'zero'),
    ("S2 seeder(A)+leecher(B offers)", 'zero', 'one'),
    ("S3 leecher(A)+seeder(B offers)", 'one', 'zero'),
    ("S4 left omitted both (Trystero-style)", 'omit', 'omit'),
    ("S5 left null both (WebTorrent metadata-less)", 'null', 'null'),
]

def run(url):
    u = url.split("://", 1)[1]
    hostport, _, path = u.partition("/"); path = "/" + path
    host, _, port = hostport.partition(":"); port = int(port) if port else 443
    out = []
    for name, am, bm in SCEN:
        out.append(scenario(host, port, path, name, am, bm))
        time.sleep(1.0)
    return {"url": url, "results": out}

if __name__ == "__main__":
    for url in sys.argv[1:]:
        print(json.dumps(run(url))); sys.stdout.flush(); time.sleep(1.0)
