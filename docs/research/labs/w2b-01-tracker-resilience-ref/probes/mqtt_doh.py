#!/usr/bin/python3
# usage: python3 -I mqtt_doh.py   - MQTT-over-wss round trip against the Trystero default brokers, resolving names through
# Cloudflare DoH so that a local sinkholing resolver (e.g. broker.hivemq.com -> 0.0.0.0) cannot cause a false "down".
import socket, json, sys, os, time, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "02-wss-trackers-probes"))
import mqttprobe as M

def doh(name):
    req = urllib.request.Request("https://cloudflare-dns.com/dns-query?name=%s&type=A" % name, headers={"accept": "application/dns-json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return [a["data"] for a in json.load(r).get("Answer", []) if a["type"] == 1]

overrides = {}
orig = socket.create_connection
def cc(addr, *a, **k):
    host, port = addr
    return orig((overrides.get(host, host), port), *a, **k)
socket.create_connection = cc

targets = [
    ("broker.emqx.io:8084/mqtt", "broker.emqx.io", 8084, "/mqtt", None, None),
    ("broker.hivemq.com:8884/mqtt", "broker.hivemq.com", 8884, "/mqtt", None, None),
    ("test.mosquitto.org:8081", "test.mosquitto.org", 8081, "/", None, None),
    ("public.cloud.shiftr.io (public:public)", "public.cloud.shiftr.io", 443, "/", "public", "public"),
]
for t in targets:
    ips = doh(t[1])
    overrides[t[1]] = ips[0] if ips else t[1]
    res = M.run(*t)
    res["resolved_via_doh"] = overrides[t[1]]
    print(json.dumps(res)); sys.stdout.flush(); time.sleep(1.0)
