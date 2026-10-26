#!/usr/bin/python3
# usage: python3 -I relaytest.py wss://tracker.example.com ...   (2 fake peers, private random swarm: offer -> answer relay)
# End-to-end signaling relay test with two fake peers in a private random swarm:
#   B announces with 1 mock offer -> tracker must forward it to A -> A answers -> tracker must forward the answer to B.
import sys, os, json, time, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wsprobe as W

def rnd_bin(n=20):
    return "".join(chr(random.randint(0, 255)) for _ in range(n))

def pid():
    return "-MW0001-" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))

def wait_for(ws, pred, timeout):
    end = time.time() + timeout
    seen = []
    while time.time() < end:
        try:
            r = ws.recv_msg(max(0.3, end - time.time()))
        except Exception as e:
            seen.append("EXC " + repr(e)[:60]); return None, seen
        if r[0] != "text":
            seen.append(str(r)[:60]); return None, seen
        try:
            m = json.loads(r[1])
        except Exception:
            seen.append("nonjson"); continue
        seen.append({k: (v if k in ("action", "failure reason", "interval") else "...") for k, v in m.items() if k in ("action", "failure reason", "interval", "offer", "answer")})
        if pred(m):
            return m, seen
    return None, seen

def run(url):
    u = url.split("://", 1)[1]
    hostport, _, path = u.partition("/"); path = "/" + path
    host, _, port = hostport.partition(":"); port = int(port) if port else 443
    res = {"url": url}
    a = W.WS(host, port, path, timeout=10.0, origin="https://example.org")
    b = W.WS(host, port, path, timeout=10.0, origin="https://example.org")
    try:
        if not (a.connect() and b.connect()):
            res["upgrade"] = (a.info.get("http_status"), b.info.get("http_status")); return res
        ih = rnd_bin(); pa, pb = pid(), pid(); oid = rnd_bin()
        ann = lambda p, extra: json.dumps(dict({"action": "announce", "info_hash": ih, "peer_id": p, "uploaded": 0, "downloaded": 0, "left": 1, "event": "started"}, **extra), ensure_ascii=False)
        a.send_text(ann(pa, {"numwant": 0, "offers": []}))
        m, _ = wait_for(a, lambda m: m.get("action") == "announce" and "interval" in m, 6)
        res["A_announce_ok"] = bool(m)
        t0 = time.time()
        b.send_text(ann(pb, {"numwant": 1, "offers": [{"offer_id": oid, "offer": {"type": "offer", "sdp": "v=0 mock-offer"}}]}))
        m, seen = wait_for(a, lambda m: "offer" in m and m.get("offer_id") == oid, 6)
        res["offer_forwarded_to_A"] = bool(m)
        if m:
            res["offer_forward_ms"] = round((time.time() - t0) * 1000)
            res["offer_from_peer_is_B"] = (m.get("peer_id") == pb)
            t1 = time.time()
            a.send_text(json.dumps({"action": "announce", "info_hash": ih, "peer_id": pa, "to_peer_id": pb, "offer_id": oid, "answer": {"type": "answer", "sdp": "v=0 mock-answer"}}, ensure_ascii=False))
            m2, seen2 = wait_for(b, lambda m: "answer" in m and m.get("offer_id") == oid, 6)
            res["answer_forwarded_to_B"] = bool(m2)
            if m2:
                res["answer_forward_ms"] = round((time.time() - t1) * 1000)
            else:
                res["B_seen"] = seen2
        else:
            res["A_seen"] = seen
    except Exception as e:
        res["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        a.close(); b.close()
    return res

if __name__ == "__main__":
    for url in sys.argv[1:]:
        print(json.dumps(run(url))); sys.stdout.flush(); time.sleep(1.0)
