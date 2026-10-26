#!/usr/bin/python3
# usage: python3 -I mqttprobe.py   (MQTT 3.1.1 over wss round trip against 4 public brokers; edit targets in __main__)
# MQTT 3.1.1 over secure WebSocket round trip: CONNECT -> SUBSCRIBE -> PUBLISH(QoS0) -> receive own message.
import sys, os, json, time, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wsprobe as W

def enc_len(n):
    out = bytearray()
    while True:
        b = n % 128; n //= 128
        if n: b |= 0x80
        out.append(b)
        if not n: break
    return bytes(out)

def s(x):
    b = x.encode(); return struct.pack(">H", len(b)) + b

def connect_pkt(cid, user=None, pw=None):
    flags = 0x02
    payload = s(cid)
    if user is not None:
        flags |= 0x80; payload += s(user)
        if pw is not None:
            flags |= 0x40; payload += s(pw)
    vh = s("MQTT") + bytes([4, flags]) + struct.pack(">H", 60)
    body = vh + payload
    return bytes([0x10]) + enc_len(len(body)) + body

def subscribe_pkt(pid, topic):
    body = struct.pack(">H", pid) + s(topic) + bytes([0])
    return bytes([0x82]) + enc_len(len(body)) + body

def publish_pkt(topic, payload):
    body = s(topic) + payload
    return bytes([0x30]) + enc_len(len(body)) + body

def parse_pkts(buf):
    out = []
    i = 0
    while i < len(buf):
        t = buf[i]; i += 1
        mult = 1; ln = 0
        while True:
            b = buf[i]; i += 1
            ln += (b & 0x7F) * mult; mult *= 128
            if not (b & 0x80): break
        out.append((t, buf[i:i + ln])); i += ln
    return out

def run(label, host, port, path, user=None, pw=None):
    res = {"broker": label}
    ws = W.WS(host, port, path, timeout=8.0, origin="https://example.org")
    ws.subprotocol = "mqtt"
    try:
        t0 = time.time()
        ok = ws.connect()
        res["upgrade"] = ws.info.get("http_status"); res["subprotocol"] = ws.info.get("resp_headers", {}).get("sec-websocket-protocol")
        res["connect_ms"] = round((time.time() - t0) * 1000)
        if not ok:
            return res
        cid = "mw-probe-" + os.urandom(4).hex()
        topic = "magnet-web-probe/" + os.urandom(6).hex()
        ws.send_binary(connect_pkt(cid, user, pw))
        r = ws.recv_raw(8)
        if r[0] != "binary":
            res["connect_reply"] = r; return res
        pk = parse_pkts(r[1])
        connack = [p for p in pk if p[0] >> 4 == 2]
        if not connack:
            res["connect_reply_unexpected"] = [p[0] for p in pk]; return res
        res["connack_rc"] = connack[0][1][1] if len(connack[0][1]) > 1 else None
        if res["connack_rc"] != 0:
            return res
        ws.send_binary(subscribe_pkt(1, topic))
        t1 = time.time()
        r = ws.recv_raw(8)
        suback = parse_pkts(r[1]) if r[0] == "binary" else []
        res["suback"] = [list(p[1]) for p in suback if p[0] >> 4 == 9]
        ws.send_binary(publish_pkt(topic, b"magnet-web research ping"))
        t2 = time.time()
        deadline = time.time() + 6
        while time.time() < deadline:
            r = ws.recv_raw(max(0.5, deadline - time.time()))
            if r[0] != "binary":
                res["recv"] = r; break
            if any(p[0] >> 4 == 3 for p in parse_pkts(r[1])):
                res["echo_ms"] = round((time.time() - t2) * 1000); break
    except Exception as e:
        res["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        ws.close()
    return res

if __name__ == "__main__":
    targets = [
        ("broker.emqx.io:8084/mqtt", "broker.emqx.io", 8084, "/mqtt", None, None),
        ("broker.hivemq.com:8884/mqtt", "broker.hivemq.com", 8884, "/mqtt", None, None),
        ("test.mosquitto.org:8081", "test.mosquitto.org", 8081, "/", None, None),
        ("public.cloud.shiftr.io (public:public)", "public.cloud.shiftr.io", 443, "/", "public", "public"),
    ]
    for t in targets:
        print(json.dumps(run(*t))); sys.stdout.flush(); time.sleep(1.0)
