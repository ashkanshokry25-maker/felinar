#!/usr/bin/python3
# usage: python3 -I nostrprobe.py nos.lol relay.example.com ...   (ephemeral kind 20000-29999 event round trip, BIP-340 signed, stdlib only)
# One ephemeral-event round trip per relay (what Trystero's Nostr strategy does): REQ -> EVENT -> OK + echo.
import sys, os, json, time, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wsprobe as W

p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

def point_add(P1, P2):
    if P1 is None: return P2
    if P2 is None: return P1
    if P1[0] == P2[0] and P1[1] != P2[1]: return None
    if P1 == P2:
        lam = (3 * P1[0] * P1[0] * pow(2 * P1[1], p - 2, p)) % p
    else:
        lam = ((P2[1] - P1[1]) * pow(P2[0] - P1[0], p - 2, p)) % p
    x3 = (lam * lam - P1[0] - P2[0]) % p
    return (x3, (lam * (P1[0] - x3) - P1[1]) % p)

def point_mul(P, k):
    R = None
    for i in range(256):
        if (k >> i) & 1: R = point_add(R, P)
        P = point_add(P, P)
    return R

def tagged_hash(tag, msg):
    th = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(th + th + msg).digest()

def schnorr_sign(msg, seckey, aux):
    d0 = int.from_bytes(seckey, "big")
    P = point_mul(G, d0)
    d = d0 if P[1] % 2 == 0 else n - d0
    t = (d ^ int.from_bytes(tagged_hash("BIP0340/aux", aux), "big")).to_bytes(32, "big")
    k0 = int.from_bytes(tagged_hash("BIP0340/nonce", t + P[0].to_bytes(32, "big") + msg), "big") % n
    R = point_mul(G, k0)
    k = k0 if R[1] % 2 == 0 else n - k0
    e = int.from_bytes(tagged_hash("BIP0340/challenge", R[0].to_bytes(32, "big") + P[0].to_bytes(32, "big") + msg), "big") % n
    return R[0].to_bytes(32, "big") + ((k + e * d) % n).to_bytes(32, "big"), P[0].to_bytes(32, "big")

def make_event(sk, kind, topic):
    created = int(time.time())
    content = "magnet-web research ping (ephemeral)"
    tags = [["x", topic]]
    # pubkey first needs sk -> derive via a dummy sign to get P.x
    _, pub = schnorr_sign(b"\x00" * 32, sk, b"\x00" * 32)
    pub_hex = pub.hex()
    ser = json.dumps([0, pub_hex, created, kind, tags, content], separators=(",", ":"), ensure_ascii=False)
    eid = hashlib.sha256(ser.encode()).digest()
    sig, _ = schnorr_sign(eid, sk, os.urandom(32))
    return {"id": eid.hex(), "pubkey": pub_hex, "created_at": created, "kind": kind, "tags": tags, "content": content, "sig": sig.hex()}

def run(host):
    res = {"relay": host}
    port = 443
    h = host
    if ":" in host:
        h, pp = host.split(":"); port = int(pp)
    ws = W.WS(h, port, "/", timeout=8.0, origin="https://example.org")
    try:
        t0 = time.time()
        ok = ws.connect()
        res["upgrade"] = ws.info.get("http_status")
        res["connect_ms"] = round((time.time() - t0) * 1000)
        if not ok:
            return res
        sk = os.urandom(32)
        sk = (int.from_bytes(sk, "big") % (n - 1) + 1).to_bytes(32, "big")
        topic = os.urandom(8).hex()
        kind = 20000 + int(os.urandom(2).hex(), 16) % 10000
        ev = make_event(sk, kind, topic)
        ws.send_text(json.dumps(["REQ", "sub1", {"kinds": [kind], "#x": [topic], "since": int(time.time()) - 5}]))
        t1 = time.time()
        got_ok = got_echo = None
        sent = False
        deadline = time.time() + 8
        while time.time() < deadline and not (got_ok is not None and got_echo is not None):
            try:
                r = ws.recv_msg(max(0.5, deadline - time.time()))
            except Exception as e:
                res["recv_exc"] = repr(e); break
            if r[0] != "text":
                res["close"] = r; break
            try:
                m = json.loads(r[1])
            except Exception:
                res.setdefault("nonjson", r[1][:100]); continue
            if m[0] == "EOSE" and not sent:
                ws.send_text(json.dumps(["EVENT", ev])); sent = True; t1 = time.time()
            elif m[0] == "OK":
                got_ok = {"accepted": m[2], "msg": (m[3] if len(m) > 3 else "")[:140], "ms": round((time.time() - t1) * 1000)}
            elif m[0] == "EVENT" and m[2].get("id") == ev["id"]:
                got_echo = {"ms": round((time.time() - t1) * 1000)}
            elif m[0] in ("NOTICE", "CLOSED", "AUTH"):
                res.setdefault("notices", []).append(r[1][:160])
                if m[0] == "AUTH" and not sent:
                    pass
            if not sent and time.time() - t1 > 2.0:
                ws.send_text(json.dumps(["EVENT", ev])); sent = True; t1 = time.time()
        res["event_ok"] = got_ok
        res["echo_to_subscriber"] = got_echo
    except Exception as e:
        res["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        ws.close()
    return res

if __name__ == "__main__":
    for h in sys.argv[1:]:
        print(json.dumps(run(h)))
        sys.stdout.flush()
        time.sleep(1.0)
