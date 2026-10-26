#!/usr/bin/python3
# usage: python3 -I wsprobe.py [--origin=https://example.org] wss://host[:port][/path] ...
# Stdlib-only RFC 6455 client. Per URL: TLS+cert info, WS upgrade, 1 scrape (4 demo hashes), 1 announce (random infohash), close.
# Research date 2026-10-14. Also imported as a library by the other scripts in this folder.
# Minimal, stdlib-only WebSocket tracker prober (RFC 6455 client, text frames).
# Sends: (1) one scrape for 4 well-known demo infohashes, (2) one announce for a random infohash, then closes.
import socket, ssl, os, base64, struct, json, sys, time, random, datetime

DEMO = {
    "Sintel": "08ada5a7a6183aae1e09d831df6748d566095a10",
    "BigBuckBunny": "dd8255ecdc7ca55fb0bbf81323d87062db2f4ea1",
    "TearsOfSteel": "209c8226b299b308beaf2b9cd3fb49212dbd13ec",
    "CosmosLaundromat": "c9e15763f722f23e98a29decdfae341b98d53056",
}

def hex2bin(h):
    return bytes.fromhex(h).decode("latin-1")

class WS:
    def __init__(self, host, port, path, timeout=8.0, origin=None):
        self.host, self.port, self.path, self.timeout, self.origin = host, port, path, timeout, origin
        self.sock = None
        self.buf = b""
        self.info = {}
        self.subprotocol = None

    def connect(self):
        t0 = time.time()
        raw = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.info["tcp_ms"] = round((time.time() - t0) * 1000)
        self.info["peer_ip"] = raw.getpeername()[0]
        ctx = ssl.create_default_context()
        t1 = time.time()
        self.sock = ctx.wrap_socket(raw, server_hostname=self.host)
        self.sock.settimeout(self.timeout)
        self.info["tls_ms"] = round((time.time() - t1) * 1000)
        self.info["tls_version"] = self.sock.version()
        self.info["alpn"] = self.sock.selected_alpn_protocol()
        cert = self.sock.getpeercert()
        self.info["cert_notBefore"] = cert.get("notBefore")
        self.info["cert_notAfter"] = cert.get("notAfter")
        self.info["cert_issuer"] = " / ".join("=".join(x) for rdn in cert.get("issuer", ()) for x in rdn)
        self.info["cert_san"] = [v for k, v in cert.get("subjectAltName", ()) if k == "DNS"][:6]
        key = base64.b64encode(os.urandom(16)).decode()
        hosthdr = self.host if self.port == 443 else "%s:%d" % (self.host, self.port)
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n" % (self.path, hosthdr, key))
        if self.origin:
            req += "Origin: %s\r\n" % self.origin
        if self.subprotocol:
            req += "Sec-WebSocket-Protocol: %s\r\n" % self.subprotocol
        req += "User-Agent: magnet-web-research-probe/1.0 (single protocol check)\r\n\r\n"
        t2 = time.time()
        self.sock.sendall(req.encode())
        while b"\r\n\r\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            self.buf += chunk
        head, _, rest = self.buf.partition(b"\r\n\r\n")
        self.buf = rest
        lines = head.decode("latin-1").split("\r\n")
        self.info["http_status"] = lines[0]
        self.info["upgrade_ms"] = round((time.time() - t2) * 1000)
        hdrs = {}
        for l in lines[1:]:
            if ":" in l:
                k, v = l.split(":", 1)
                hdrs[k.strip().lower()] = v.strip()
        self.info["resp_headers"] = {k: hdrs[k] for k in hdrs if k in ("server", "via", "cf-ray", "x-powered-by", "sec-websocket-extensions", "alt-svc", "x-served-by", "content-type", "sec-websocket-protocol")}
        return self.info["http_status"].startswith("HTTP/1.1 101")

    def send_text(self, s):
        payload = s.encode("utf-8")
        hdr = bytearray([0x81])
        n = len(payload)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(hdr) + masked)

    def send_binary(self, payload):
        hdr = bytearray([0x82])
        n = len(payload)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(hdr) + masked)

    def recv_raw(self, timeout=8.0):
        """Like recv_msg but returns ('binary', bytes) for opcode 2 and ('text', str) for opcode 1."""
        self.sock.settimeout(timeout)
        msg = b""; first_op = None
        while True:
            b0, b1 = self._read(2)
            fin, op = b0 & 0x80, b0 & 0x0F
            ln = b1 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._read(8))[0]
            data = self._read(ln) if not (b1 & 0x80) else None
            if data is None:
                mk = self._read(4)
                data = bytes(b ^ mk[i % 4] for i, b in enumerate(self._read(ln)))
            if op == 0x9:
                self.sock.sendall(bytes([0x8A, 0x80 | len(data)]) + b"\x00\x00\x00\x00" + data)
                continue
            if op == 0x8:
                code = struct.unpack(">H", data[:2])[0] if len(data) >= 2 else None
                return ("close", code, data[2:].decode("utf-8", "replace"))
            if op in (0x1, 0x2):
                first_op = op
            if op in (0x1, 0x2, 0x0):
                msg += data
                if fin:
                    return ("binary", msg) if first_op == 0x2 else ("text", msg.decode("utf-8", "replace"))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_msg(self, timeout=8.0):
        self.sock.settimeout(timeout)
        msg = b""
        while True:
            b0, b1 = self._read(2)
            fin, op = b0 & 0x80, b0 & 0x0F
            ln = b1 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._read(8))[0]
            if b1 & 0x80:
                mk = self._read(4)
                data = bytes(b ^ mk[i % 4] for i, b in enumerate(self._read(ln)))
            else:
                data = self._read(ln)
            if op == 0x9:  # ping -> pong
                self.sock.sendall(bytes([0x8A, 0x80 | len(data)]) + b"\x00\x00\x00\x00" + data)
                continue
            if op == 0x8:
                code = struct.unpack(">H", data[:2])[0] if len(data) >= 2 else None
                return ("close", code, data[2:].decode("utf-8", "replace"))
            if op in (0x1, 0x2, 0x0):
                msg += data
                if fin:
                    return ("text", msg.decode("utf-8", "replace"))

    def close(self):
        try:
            self.sock.sendall(bytes([0x88, 0x80]) + b"\x00\x00\x00\x00")
            self.sock.close()
        except Exception:
            pass

def probe(url, origin=None, do_announce=True):
    u = url.split("://", 1)[1]
    hostport, _, path = u.partition("/")
    path = "/" + path
    host, _, port = hostport.partition(":")
    port = int(port) if port else 443
    res = {"url": url, "origin_sent": origin}
    ws = WS(host, port, path, origin=origin)
    try:
        ok = ws.connect()
        res.update(ws.info)
        res["ws_upgrade_ok"] = ok
        if not ok:
            return res
        # 1) scrape (read-only, does not register a peer)
        t = time.time()
        ws.send_text(json.dumps({"action": "scrape", "info_hash": [hex2bin(h) for h in DEMO.values()]}, ensure_ascii=False))
        try:
            r = ws.recv_msg(8)
            res["scrape_ms"] = round((time.time() - t) * 1000)
            if r[0] == "text":
                try:
                    j = json.loads(r[1])
                    files = {}
                    names = {hex2bin(h): n for n, h in DEMO.items()}
                    for k, v in (j.get("files") or {}).items():
                        files[names.get(k, k.encode("latin-1").hex())] = v
                    res["scrape"] = {"action": j.get("action"), "files": files, "flags": j.get("flags"), "failure": j.get("failure reason")}
                except Exception as e:
                    res["scrape_raw"] = r[1][:300]
            else:
                res["scrape_close"] = r
        except Exception as e:
            res["scrape_error"] = repr(e)
        # 2) announce for a random infohash (what any browser does when opening a new torrent), then close
        if do_announce:
            ih = "".join(chr(random.randint(0, 255)) for _ in range(20))
            pid = "-MW0001-" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))
            t = time.time()
            ws.send_text(json.dumps({"action": "announce", "info_hash": ih, "peer_id": pid, "uploaded": 0, "downloaded": 0, "left": 1, "event": "started", "numwant": 0, "offers": []}, ensure_ascii=False))
            try:
                r = ws.recv_msg(8)
                res["announce_ms"] = round((time.time() - t) * 1000)
                if r[0] == "text":
                    j = json.loads(r[1])
                    j.pop("info_hash", None)
                    res["announce"] = j
                else:
                    res["announce_close"] = r
            except Exception as e:
                res["announce_error"] = repr(e)
    except Exception as e:
        res["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        ws.close()
    return res

if __name__ == "__main__":
    origin = None
    args = sys.argv[1:]
    if args and args[0].startswith("--origin="):
        origin = args[0].split("=", 1)[1]
        args = args[1:]
    out = []
    for url in args:
        out.append(probe(url, origin=origin))
        time.sleep(1.0)
    print(json.dumps(out, indent=1))
