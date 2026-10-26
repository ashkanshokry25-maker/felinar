#!/usr/bin/env python3
"""Loopback-only fake STUN/TURN servers for connectivity experiments (research harness).

Listens ONLY on 127.0.0.1. Writes one JSON line per STUN/TURN message to the log file.
  STUN A  udp 34780  reflexive = (203.0.113.7, <src port>)          -> "easy NAT" mapping
  STUN B  udp 34781  reflexive = (203.0.113.7, <src port> + 1000)   -> mapping varies by destination (hard NAT)
  STUN C  udp 34782  reflexive = (203.0.113.7, <src port>)          -> same as A
  TURN    udp+tcp 34790  Allocate: 401 challenge then success (relay 203.0.113.50:40000+n); password for any user = 'p'
  BLACKHOLE udp+tcp 34791  accepts/reads, never replies
  (34792 deliberately left closed -> ICMP unreachable / TCP RST)
"""
import hashlib, hmac, json, socket, struct, sys, threading, time

MAGIC = 0x2112A442
LOGF = open(sys.argv[1], 'a', buffering=1)
LOCK = threading.Lock()
RELAY_N = [0]


def log(**kw):
    kw['t'] = round(time.time(), 4)
    with LOCK:
        LOGF.write(json.dumps(kw) + '\n')


def parse(msg):
    if len(msg) < 20:
        return None
    mtype, mlen, cookie = struct.unpack('!HHI', msg[:8])
    if cookie != MAGIC:
        return None
    txn = msg[8:20]
    attrs = {}
    i, end = 20, min(20 + mlen, len(msg))
    while i + 4 <= end:
        atype, alen = struct.unpack('!HH', msg[i:i + 4])
        attrs.setdefault(atype, msg[i + 4:i + 4 + alen])
        i += 4 + ((alen + 3) & ~3)
    return mtype, txn, attrs


def attr(atype, val):
    return struct.pack('!HH', atype, len(val)) + val + b'\0' * ((-len(val)) % 4)


def xor_addr(ip, port):
    xp = port ^ (MAGIC >> 16)
    xi = struct.pack('!I', struct.unpack('!I', socket.inet_aton(ip))[0] ^ MAGIC)
    return struct.pack('!BBH', 0, 1, xp) + xi


def header(mtype, txn, bodylen):
    return struct.pack('!HHI', mtype, bodylen, MAGIC) + txn


def signed(mtype, txn, body, key):
    hdr = header(mtype, txn, len(body) + 24)
    mac = hmac.new(key, hdr + body, hashlib.sha1).digest()
    return hdr + body + struct.pack('!HH', 0x0008, 20) + mac


def err_attr(code, reason):
    return attr(0x0009, struct.pack('!HBB', 0, code // 100, code % 100) + reason.encode())


NAMES = {0x0001: 'binding', 0x0003: 'allocate', 0x0004: 'refresh', 0x0008: 'createpermission',
         0x0009: 'channelbind', 0x0016: 'send-ind', 0x0017: 'data-ind'}
REALM, NONCE = b'fake.realm', b'0123456789abcdef'


def handle(msg, src, port, proto):
    """returns reply bytes or None"""
    p = parse(msg)
    if not p:
        log(ev='nonstun', proto=proto, port=port, src=src[1], n=len(msg))
        return None
    mtype, txn, attrs = p
    name = NAMES.get(mtype, hex(mtype))
    has_mi = 0x0008 in attrs
    user = attrs.get(0x0006, b'').decode(errors='replace')
    log(ev='msg', proto=proto, port=port, src=src[1], type=name, auth=has_mi, user=user,
        transport=attrs.get(0x0019, b'')[:1].hex())
    if mtype == 0x0001:  # binding
        off = {34780: 0, 34781: 1000, 34782: 0, 34790: 0}.get(port, 0)
        rp = src[1] + off
        if rp > 65535:
            rp -= 2 * off
        body = attr(0x0020, xor_addr('203.0.113.7', rp))
        return header(0x0101, txn, len(body)) + body
    if port != 34790:
        return None
    key = hashlib.md5(f'{user}:{REALM.decode()}:p'.encode()).digest()
    if mtype in (0x0003, 0x0004, 0x0008, 0x0009):
        if not has_mi:
            body = err_attr(401, 'Unauthorized') + attr(0x0014, REALM) + attr(0x0015, NONCE)
            return header(mtype | 0x0110, txn, len(body)) + body
        if mtype == 0x0003:
            RELAY_N[0] += 1
            body = (attr(0x0016, xor_addr('203.0.113.50', 40000 + RELAY_N[0])) +
                    attr(0x000D, struct.pack('!I', 600)) +
                    attr(0x0020, xor_addr('203.0.113.7', src[1])))
            return signed(0x0103, txn, body, key)
        if mtype == 0x0004:
            return signed(0x0104, txn, attr(0x000D, struct.pack('!I', 600)), key)
        return signed(mtype | 0x0100, txn, b'', key)
    return None


def udp_server(port, blackhole=False):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', port))
    while True:
        data, src = s.recvfrom(65535)
        if blackhole:
            log(ev='blackhole-udp', port=port, src=src[1], n=len(data))
            continue
        r = handle(data, src, port, 'udp')
        if r:
            s.sendto(r, src)


def tcp_conn(c, src, port, blackhole):
    buf = b''
    try:
        while True:
            d = c.recv(65535)
            if not d:
                break
            if blackhole:
                log(ev='blackhole-tcp', port=port, src=src[1], n=len(d))
                continue
            buf += d
            while len(buf) >= 20:
                mlen = struct.unpack('!H', buf[2:4])[0]
                total = 20 + mlen
                if len(buf) < total:
                    break
                msg, buf = buf[:total], buf[total:]
                r = handle(msg, src, port, 'tcp')
                if r:
                    c.sendall(r)
    except OSError:
        pass
    finally:
        c.close()


def tcp_server(port, blackhole=False):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', port))
    s.listen(256)
    while True:
        c, src = s.accept()
        log(ev='tcp-accept', port=port, src=src[1], blackhole=blackhole)
        threading.Thread(target=tcp_conn, args=(c, src, port, blackhole), daemon=True).start()


for target, args in [(udp_server, (34780,)), (udp_server, (34781,)), (udp_server, (34782,)),
                     (udp_server, (34790,)), (tcp_server, (34790,)),
                     (udp_server, (34791, True)), (tcp_server, (34791, True))]:
    threading.Thread(target=target, args=args, daemon=True).start()
log(ev='ready')
while True:
    time.sleep(3600)
