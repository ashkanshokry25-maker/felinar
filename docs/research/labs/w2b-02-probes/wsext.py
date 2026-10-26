#!/usr/bin/python3
# READ-ONLY: WebSocket upgrade only (no REQ/EVENT): report negotiated extensions + server header (+ whether it asks for compression).
import sys, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "02-wss-trackers-probes"))
import wsprobe as W, socket, ssl, os, base64
def up(host):
    key = base64.b64encode(os.urandom(16)).decode()
    s = ssl.create_default_context().wrap_socket(socket.create_connection((host, 443), timeout=8), server_hostname=host); s.settimeout(8)
    s.sendall(("GET / HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\nOrigin: https://example.org\r\nUser-Agent: magnet-web-research-probe/1.0\r\n\r\n" % (host, key)).encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c: break
        buf += c
    s.close()
    hd = {}
    for l in buf.decode("latin-1").split("\r\n")[1:]:
        if ":" in l: k, v = l.split(":", 1); hd[k.strip().lower()] = v.strip()
    return {"host": host, "status": buf.decode("latin-1").split("\r\n")[0], "ext": hd.get("sec-websocket-extensions"), "server": hd.get("server")}
for h in sys.argv[1:]:
    try: print(json.dumps(up(h)))
    except Exception as e: print(json.dumps({"host": h, "err": repr(e)[:80]}))
