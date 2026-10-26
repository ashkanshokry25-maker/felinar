// src/media/faststart.js: ISO base media (MP4, MOV) box helpers and the faststart rewrite (R 2.9.3
// step 3; ARCHITECTURE 15.7; INTERFACES "v0.3 (proposed)" src/media/*). Pure over Blob; Node 22,
// browsers and workers.
//
// When an MP4's moov box sits after mdat, playback must first fetch the end of the file. faststart()
// moves moov to the front by box rewriting, without re-encoding: every top-level box keeps its bytes,
// and each chunk offset of every stco and co64 table is moved by the shift of the top-level box it
// points into, so every sample stays where its table says. The output Blob is built from slices of
// the input; only moov is read into memory.
//
//   readTopBoxes(blob) -> [{ type, start, size, header }]
//   parseBoxes(u8, start, end, base?) -> [{ type, start, size, header, children? }]   (in-memory tree)
//   chunkOffsetTables(moovBytes) -> [{ type: 'stco' | 'co64', at, count }]  (at: offset of the first entry in moov)
//   faststart(blob) -> { blob, moved }
//   mp4Info(blob) -> { duration, w, h, timescale } | null

export const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'udta']);

const be32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
const type4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
const be64 = (u8, o) => be32(u8, o) * 4294967296 + be32(u8, o + 4);

function boxError(message) {
  const err = new Error('mp4: ' + message);
  err.code = 'E_MEDIA_STRIP';
  return err;
}

async function bytesAt(blob, start, len) {
  return new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
}

/** readTopBoxes(blob) -> the top-level boxes, read from 16-byte headers only. Throws E_MEDIA_STRIP on a broken layout. */
export async function readTopBoxes(blob) {
  const out = [];
  let o = 0;
  const n = blob.size;
  while (o < n) {
    if (n - o < 8) throw boxError('trailing bytes after the last box');
    const h = await bytesAt(blob, o, 16);
    let size = be32(h, 0);
    const type = type4(h, 4);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) throw boxError('truncated large size');
      size = be64(h, 8);
      header = 16;
    } else if (size === 0) {
      size = n - o;
    }
    if (!Number.isSafeInteger(size) || size < header || o + size > n) throw boxError('box ' + JSON.stringify(type) + ' has an invalid size');
    if (!/^[\x20-\x7e\xa9]{4}$/.test(type)) throw boxError('not an ISO base media file');
    out.push({ type, start: o, size, header });
    o += size;
    if (out.length > 100000) throw boxError('too many boxes');
  }
  return out;
}

/** parseBoxes(u8, start, end, depth?) -> boxes of u8[start, end) with children for container types. */
export function parseBoxes(u8, start, end, depth = 0) {
  const out = [];
  let o = start;
  if (depth > 16) throw boxError('boxes nested too deep');
  while (o < end) {
    if (end - o < 8) {
      // QuickTime allows a 4-byte zero terminator inside udta
      if (end - o === 4 && be32(u8, o) === 0) break;
      throw boxError('truncated box header');
    }
    let size = be32(u8, o);
    const type = type4(u8, o + 4);
    let header = 8;
    if (size === 1) {
      if (end - o < 16) throw boxError('truncated large size');
      size = be64(u8, o + 8);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) throw boxError('box ' + JSON.stringify(type) + ' overruns its parent');
    const box = { type, start: o, size, header };
    if (CONTAINERS.has(type) && type !== 'udta') box.children = parseBoxes(u8, o + header, o + size, depth + 1);
    out.push(box);
    o += size;
  }
  return out;
}

/** walk(boxes, fn, path?) calls fn(box, path) for every box of the tree. */
export function walk(boxes, fn, path = '') {
  for (const b of boxes) {
    const p = path ? path + '/' + b.type : b.type;
    fn(b, p);
    if (b.children) walk(b.children, fn, p);
  }
}

/** chunkOffsetTables(moov) -> [{ type, at, count }] for every stco and co64 under the moov bytes. */
export function chunkOffsetTables(moov) {
  const tree = parseBoxes(moov, 0, moov.length);
  const out = [];
  walk(tree, (b) => {
    if (b.type !== 'stco' && b.type !== 'co64') return;
    const body = b.start + b.header;
    const count = be32(moov, body + 4);
    const width = b.type === 'stco' ? 4 : 8;
    if (body + 8 + count * width > b.start + b.size) throw boxError(b.type + ' entry count overruns the box');
    out.push({ type: b.type, at: body + 8, count });
  });
  return out;
}

function writeBe32(u8, o, v) {
  u8[o] = (v >>> 24) & 255;
  u8[o + 1] = (v >>> 16) & 255;
  u8[o + 2] = (v >>> 8) & 255;
  u8[o + 3] = v & 255;
}

function writeBe64(u8, o, v) {
  writeBe32(u8, o, Math.floor(v / 4294967296));
  writeBe32(u8, o + 4, v >>> 0);
}

/**
 * shiftChunkOffsets(moov, oldBoxes, newStart) rewrites, in place, every chunk offset of the moov bytes
 * by the move of the old top-level box that holds it. newStart: Map(oldStart -> newStart). Throws
 * E_MEDIA_STRIP when an offset points outside every box or a 32-bit entry would overflow.
 */
export function shiftChunkOffsets(moov, oldBoxes, newStart) {
  const find = (off) => {
    let lo = 0;
    let hi = oldBoxes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = oldBoxes[mid];
      if (off < b.start) hi = mid - 1;
      else if (off >= b.start + b.size) lo = mid + 1;
      else return b;
    }
    return null;
  };
  for (const t of chunkOffsetTables(moov)) {
    const width = t.type === 'stco' ? 4 : 8;
    for (let k = 0; k < t.count; k++) {
      const at = t.at + k * width;
      const off = width === 4 ? be32(moov, at) : be64(moov, at);
      const box = find(off);
      if (!box) throw boxError('a chunk offset points outside the file');
      const next = off + (newStart.get(box.start) - box.start);
      if (width === 4) {
        if (next > 0xffffffff) throw boxError('a 32-bit chunk offset would overflow');
        writeBe32(moov, at, next);
      } else {
        writeBe64(moov, at, next);
      }
    }
  }
}

/**
 * faststart(blob) -> { blob, moved }. moved is false (and the input is returned) when moov already
 * precedes mdat, when the file is fragmented (moof), or when the rewrite cannot be done safely.
 */
export async function faststart(blob) {
  let boxes;
  try {
    boxes = await readTopBoxes(blob);
  } catch (_) {
    return { blob, moved: false };
  }
  const moovIdx = boxes.findIndex((b) => b.type === 'moov');
  const mdatIdx = boxes.findIndex((b) => b.type === 'mdat');
  if (moovIdx < 0 || mdatIdx < 0 || moovIdx < mdatIdx) return { blob, moved: false };
  if (boxes.some((b) => b.type === 'moof')) return { blob, moved: false };
  const moovBox = boxes[moovIdx];
  const moov = await bytesAt(blob, moovBox.start, moovBox.size);
  const order = [];
  for (let i = 0; i < mdatIdx; i++) order.push(boxes[i]);
  order.push(moovBox);
  for (let i = mdatIdx; i < boxes.length; i++) if (i !== moovIdx) order.push(boxes[i]);
  const newStart = new Map();
  let o = 0;
  for (const b of order) {
    newStart.set(b.start, o);
    o += b.size;
  }
  try {
    shiftChunkOffsets(moov, boxes, newStart);
  } catch (_) {
    return { blob, moved: false };
  }
  const parts = order.map((b) => (b === moovBox ? moov : blob.slice(b.start, b.start + b.size)));
  return { blob: new Blob(parts, { type: blob.type || 'video/mp4' }), moved: true };
}

/** mp4Info(blob) -> { duration (seconds), w, h, timescale } from mvhd and the first video track, or null. */
export async function mp4Info(blob) {
  let boxes;
  try {
    boxes = await readTopBoxes(blob);
  } catch (_) {
    return null;
  }
  const moovBox = boxes.find((b) => b.type === 'moov');
  if (!moovBox || moovBox.size > 64 * 1024 * 1024) return null;
  const moov = await bytesAt(blob, moovBox.start, moovBox.size);
  let tree;
  try {
    tree = parseBoxes(moov, 0, moov.length);
  } catch (_) {
    return null;
  }
  const info = { duration: 0, w: 0, h: 0, timescale: 0 };
  const top = tree[0] && tree[0].children ? tree[0].children : [];
  const mvhd = top.find((b) => b.type === 'mvhd');
  if (mvhd) {
    const p = mvhd.start + mvhd.header;
    const v = moov[p];
    const ts = v === 1 ? be32(moov, p + 20) : be32(moov, p + 12);
    const dur = v === 1 ? be64(moov, p + 24) : be32(moov, p + 16);
    if (ts > 0) {
      info.timescale = ts;
      info.duration = dur / ts;
    }
  }
  for (const trak of top.filter((b) => b.type === 'trak')) {
    let isVideo = false;
    walk(trak.children || [], (b) => {
      if (b.type === 'hdlr' && type4(moov, b.start + b.header + 8) === 'vide') isVideo = true;
    });
    if (!isVideo) continue;
    const tkhd = (trak.children || []).find((b) => b.type === 'tkhd');
    if (tkhd) {
      const p = tkhd.start + tkhd.header;
      const v = moov[p];
      const wAt = p + (v === 1 ? 88 : 76);
      info.w = be32(moov, wAt) >>> 16;
      info.h = be32(moov, wAt + 4) >>> 16;
    }
    break;
  }
  return info;
}
