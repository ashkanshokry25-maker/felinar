#!/usr/bin/python3
# usage: python3 -I offercap.py 14 wss://tracker.example.com ...   (N receivers + 1 offerer sending N mock offers)
# Measure how many offers per announce a tracker actually forwards: N receivers + 1 offerer sending N mock offers.
import sys, os, json, time, random, select
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wsprobe as W

N = int(sys.argv[1])
def rnd_bin(n=20): return "".join(chr(random.randint(0, 255)) for _ in range(n))
def pid(): return "-MW0001-" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))

def run(url):
    u = url.split("://", 1)[1]
    hostport, _, path = u.partition("/"); path = "/" + path
    host, _, port = hostport.partition(":"); port = int(port) if port else 443
    res = {"url": url, "receivers_target": N}
    recs = []; off = None
    try:
        ih = rnd_bin()
        for i in range(N):
            w = W.WS(host, port, path, timeout=10.0, origin="https://example.org")
            if not w.connect():
                res["connect_fail_at"] = i; res["http"] = w.info.get("http_status"); break
            p = pid()
            w.send_text(json.dumps({"action": "announce", "info_hash": ih, "peer_id": p, "uploaded": 0, "downloaded": 0, "left": 1, "event": "started", "numwant": 0, "offers": []}, ensure_ascii=False))
            recs.append((w, p))
            time.sleep(0.05)
        res["receivers_connected"] = len(recs)
        # drain announce responses
        time.sleep(1.0)
        for w, p in recs:
            w.sock.setblocking(False)
            try:
                while True:
                    r = w.recv_msg(0.05)
            except Exception:
                pass
        off = W.WS(host, port, path, timeout=10.0, origin="https://example.org")
        off.connect()
        pb = pid()
        offers = [{"offer_id": rnd_bin(), "offer": {"type": "offer", "sdp": "v=0 mock %d" % i}} for i in range(N)]
        off.send_text(json.dumps({"action": "announce", "info_hash": ih, "peer_id": pb, "uploaded": 0, "downloaded": 0, "left": 1, "event": "started", "numwant": N, "offers": offers}, ensure_ascii=False))
        msg_size = len(json.dumps({"offers": offers}))
        res["message_bytes_approx"] = msg_size + 200
        time.sleep(2.0)
        got = 0; failures = []
        for w, p in recs:
            w.sock.setblocking(True)
            try:
                while True:
                    r = w.recv_msg(0.3)
                    if r[0] == "text":
                        m = json.loads(r[1])
                        if "offer" in m: got += 1
                    else:
                        break
            except Exception:
                pass
        res["offers_forwarded"] = got
        # what did the offerer see?
        try:
            off.sock.settimeout(0.5)
            r = off.recv_msg(0.5)
            res["offerer_first_reply"] = (r[1][:120] if r[0] == "text" else str(r)[:80])
        except Exception as e:
            res["offerer_reply_exc"] = repr(e)[:60]
    except Exception as e:
        res["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        for w, _ in recs: w.close()
        if off: off.close()
    return res

for url in sys.argv[2:]:
    print(json.dumps(run(url))); sys.stdout.flush(); time.sleep(1.5)
