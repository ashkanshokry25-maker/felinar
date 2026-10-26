import sys, base64, hashlib, subprocess
cid = sys.argv[1]; host = sys.argv[2]
raw = base64.b32decode(cid[1:].upper() + '=' * (-len(cid[1:]) % 8))   # strip multibase 'b'
ver, codec, mhcode, mhlen = raw[0], raw[1], raw[2], raw[3]
digest = raw[4:4+mhlen]
print(f'CID version={ver} codec=0x{codec:02x} multihash=0x{mhcode:02x} len={mhlen}')
body = subprocess.run(['curl','-sS','-m','20','-H','Accept: application/vnd.ipld.raw',f'https://{host}/ipfs/{cid}?format=raw'], capture_output=True).stdout
ok = hashlib.sha256(body).digest() == digest
print(f'{host}: block bytes={len(body)} sha256-matches-CID={ok}  head={body[:20]!r}')
