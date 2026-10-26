# Extract the files of a CARv1 (dag-pb/UnixFS) into a directory. stdlib only.
# Usage: python3 -I extract-car.py <file.car> <empty-out-dir>
import os, sys
sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, 'readcar-lib.py'), encoding='utf-8').read())
car, out = sys.argv[1], sys.argv[2]
header, blocks, order = read_car(car)
linked = set()
for cid, (codec, data) in blocks.items():
    if codec == 0x70:
        try:
            for name, h, ts in parse_pbnode(data)[0]: linked.add(h)
        except Exception: pass
roots = [c for c in order if c not in linked]
files = walk(blocks, roots[0])
for p, data in sorted(files.items()):
    rel = p.lstrip('/')
    if not rel or '..' in rel.split('/'): continue      # never write outside out
    dst = os.path.join(out, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(dst, 'wb').write(data)
    print('%-55s %7d' % (rel, len(data)))
