# Minimal CARv1 + dag-pb + UnixFS reader (stdlib only). Usage: python3 -I readcar.py file.car [--dump-redirects]
import sys, json

def varint(b, i):
    n = 0; shift = 0
    while True:
        c = b[i]; i += 1
        n |= (c & 0x7f) << shift
        if not (c & 0x80): return n, i
        shift += 7

def parse_cid(b, i):
    start = i
    if b[i] == 0x12 and b[i+1] == 0x20:           # CIDv0
        return bytes(b[i:i+34]), 0x70, i + 34
    ver, i = varint(b, i)
    codec, i = varint(b, i)
    mh, i = varint(b, i)
    ln, i = varint(b, i)
    i += ln
    return bytes(b[start:i]), codec, i

def read_car(path):
    b = open(path, 'rb').read()
    hl, i = varint(b, 0)
    header = b[i:i+hl]; i += hl
    blocks = {}
    order = []
    while i < len(b):
        sl, i = varint(b, i)
        end = i + sl
        cid, codec, j = parse_cid(b, i)
        blocks[cid] = (codec, b[j:end]); order.append(cid)
        i = end
    return header, blocks, order

def pb_fields(data):
    i = 0; out = []
    while i < len(data):
        key, i = varint(data, i)
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, i = varint(data, i); out.append((fn, v))
        elif wt == 2:
            l, i = varint(data, i); out.append((fn, bytes(data[i:i+l]))); i += l
        else:
            raise ValueError('wiretype %d' % wt)
    return out

def parse_pbnode(data):
    links = []; d = b''
    for fn, v in pb_fields(data):
        if fn == 1: d = v
        elif fn == 2:
            h = name = None; ts = 0
            for f2, v2 in pb_fields(v):
                if f2 == 1: h = v2
                elif f2 == 2: name = v2.decode('utf-8', 'surrogateescape')
                elif f2 == 3: ts = v2
            links.append((name, h, ts))
    return links, d

def parse_unixfs(d):
    t = None; payload = b''
    for fn, v in pb_fields(d):
        if fn == 1: t = v
        elif fn == 2: payload = v
    return t, payload

def read_file(blocks, cid):
    codec, data = blocks[cid]
    if codec == 0x55: return data
    links, d = parse_pbnode(data)
    t, payload = parse_unixfs(d)
    out = payload
    for name, h, ts in links:
        out += read_file(blocks, h)
    return out

def walk(blocks, cid, prefix='', depth=0, files=None):
    if files is None: files = {}
    codec, data = blocks[cid]
    if codec == 0x55:
        files[prefix or '/'] = data; return files
    links, d = parse_pbnode(data)
    t, payload = parse_unixfs(d)
    if t in (1, 5):   # dir / hamt
        for name, h, ts in links:
            walk(blocks, h, prefix + '/' + name, depth + 1, files)
    else:
        files[prefix or '/'] = read_file(blocks, cid)
    return files

