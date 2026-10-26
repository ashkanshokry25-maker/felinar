// src/media/strip.js: metadata removal at upload (R 2.8.2 step 2, 2.9.3 step 2; MF-57; STALK A8, UX
// M18). stripMp4 and stripWebm are pure over Blob (Node 22, browsers, workers); stripImage needs a
// browser (createImageBitmap and a canvas).
//
//   stripImage(blob, { maxSide?, type?, quality? }) -> { blob, removed, w, h, mime }
//       re-encodes through a canvas to JPEG (photos) or WebP (pictures that may have transparency;
//       PNG where the browser has no WebP encoder), which drops EXIF, ICC profiles and thumbnails;
//       decodeImage() tries createImageBitmap with and without the orientation option, then an <img>
//   stripMp4(blob) -> { blob, removed }    MP4 and MOV: an allow-list (review round, STALK-10): at the top level
//       only ftyp, moov, mdat, moof, mfra, styp, sidx, ssix and prft stay, under moov only the boxes a player reads;
//       every other box (udta and meta, where QuickTime and ISO files keep ©xyz, loci and the
//       com.apple.quicktime.location keys, any uuid, free, skip, vendor boxes) becomes a free box of the same length
//       with zeroed contents, so no chunk offset moves; mvhd, tkhd and mdhd creation and modification times become 0;
//       timed metadata and subtitle tracks (gpmd, camm, mett, mebx, tx3g, ...) have their samples zeroed
//       in mdat and their trak freed the same way (removed: 'moov/trak(gpmd)')
//   stripWebm(blob) -> { blob, removed }   WebM: every Tags, Attachments and Chapters element, the SeekHead entries
//       that point at one, and Info's Title, DateUTC, MuxingApp and WritingApp become EBML Void elements of the same length
//   stripMp3(blob) -> { blob, removed }    MP3: leading ID3v2 tags and a trailing ID3v1 or APEv2 tag are dropped
//   stripRiff(blob) -> { blob, removed }   AVI and WAV: every chunk but the stream headers, the media data and its index
//       (LIST INFO, IDIT, bext, iXML, ...) becomes a JUNK chunk of the same length with zeroed contents
//   jpegSegments(u8) -> [{ marker, name, start, length, ident }]   (tests and reports)
// A file that cannot be parsed throws E_MEDIA_STRIP: the lanes refuse a public upload and ask before a
// private one ("Upload anyway (may include your location)").

import { readTopBoxes, parseBoxes } from './faststart.js';
import { canvasBlob, makeCanvas, fitWithin, PIXEL_CAP } from '../files/preview.js';

export const LOCATION_TEXT = 'Location and camera details removed';

function stripError(message) {
  const err = new Error(message);
  err.code = 'E_MEDIA_STRIP';
  return err;
}

const be32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
const XMP_UUID = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];

async function bytesAt(blob, start, len) {
  return new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
}

function contains(u8, needle, from = 0, to = u8.length) {
  outer: for (let i = from; i + needle.length <= to; i++) {
    for (let k = 0; k < needle.length; k++) if (u8[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

const ASCII = (s) => Array.from(s).map((c) => c.charCodeAt(0));
const LOCATION_NEEDLES = [[0xa9, 0x78, 0x79, 0x7a], ASCII('loci'), ASCII('location'), ASCII('GPS')];

// A free box of the same length: keeps the header layout (8 or 16 bytes), zeroes the contents.
function freeBox(size, header) {
  const out = new Uint8Array(size);
  if (header === 16) {
    out.set([0, 0, 0, 1], 0);
    out.set(ASCII('free'), 4);
    const hi = Math.floor(size / 4294967296);
    out.set([hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255], 8);
  } else {
    out.set([size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255], 0);
    out.set(ASCII('free'), 4);
  }
  return out;
}

// Timed metadata and subtitle tracks (code review v0.3): GoPro gpmd (GPMF, GPS5), camm, mett, mebx and the subtitle
// tracks drones write keep their samples in mdat, so freeing moov/udta is not enough. Such a track's samples are
// zeroed in place (found through its stsc, stsz or stz2, and stco or co64 tables) and its trak becomes a free box of
// the same length; nothing else moves. A layout this cannot follow (a fragmented file) throws E_MEDIA_STRIP.
const META_HANDLERS = new Set(['meta', 'text', 'sbtl', 'subt', 'clcp']);
const META_ENTRIES = new Set(['gpmd', 'camm', 'mett', 'mebx', 'metx', 'urim', 'tx3g', 'text', 'wvtt', 'stpp', 'c608']);
const GPS_ENTRIES = new Set(['gpmd', 'camm', 'mett', 'mebx', 'metx', 'urim']);
const SAMPLES_MAX = 2000000;
const ZERO_MAX = 256 * 1024 * 1024;
const type4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

function childOf(box, type) {
  return box && box.children ? box.children.find((c) => c.type === type) || null : null;
}

function pathOf(box, types) {
  let b = box;
  for (const t of types) b = childOf(b, t);
  return b;
}

/** The handler type (mdia/hdlr) and the first sample entry type (stbl/stsd) of a trak. */
function trakKind(moov, trak) {
  const hdlr = pathOf(trak, ['mdia', 'hdlr']);
  const stsd = pathOf(trak, ['mdia', 'minf', 'stbl', 'stsd']);
  return {
    handler: hdlr && hdlr.size >= hdlr.header + 12 ? type4(moov, hdlr.start + hdlr.header + 8) : '',
    entry: stsd && stsd.size >= stsd.header + 16 ? type4(moov, stsd.start + stsd.header + 12) : '',
  };
}

/** sampleRanges(moov, stbl) -> [[start, end)] file ranges of every sample of a track (non-fragmented files). */
export function sampleRanges(moov, stbl) {
  const stsz = childOf(stbl, 'stsz');
  const stz2 = childOf(stbl, 'stz2');
  const stsc = childOf(stbl, 'stsc');
  const co = childOf(stbl, 'stco') || childOf(stbl, 'co64');
  if (!stsc || !co || !(stsz || stz2)) throw stripError('mp4: a metadata track without its sample tables');
  const within = (box, end) => {
    if (end > box.start + box.size) throw stripError('mp4: ' + box.type + ' overruns its box');
  };
  let count;
  let sizeOf;
  if (stsz) {
    const o = stsz.start + stsz.header + 4;
    within(stsz, o + 8);
    const fixed = be32(moov, o);
    count = be32(moov, o + 4);
    if (!fixed) within(stsz, o + 8 + 4 * count);
    sizeOf = fixed ? () => fixed : (i) => be32(moov, o + 8 + 4 * i);
  } else {
    const o = stz2.start + stz2.header + 4;
    within(stz2, o + 8);
    const field = moov[o + 3];
    count = be32(moov, o + 4);
    if (field !== 4 && field !== 8 && field !== 16) throw stripError('mp4: stz2 field size');
    within(stz2, o + 8 + Math.ceil((count * field) / 8));
    sizeOf = (i) => {
      if (field === 16) return (moov[o + 8 + 2 * i] << 8) | moov[o + 9 + 2 * i];
      if (field === 8) return moov[o + 8 + i];
      const b = moov[o + 8 + (i >> 1)];
      return i & 1 ? b & 15 : b >> 4;
    };
  }
  if (count > SAMPLES_MAX) throw stripError('mp4: too many samples in a metadata track');
  const ob = co.start + co.header + 4;
  within(co, ob + 4);
  const chunks = be32(moov, ob);
  const width = co.type === 'stco' ? 4 : 8;
  within(co, ob + 4 + width * chunks);
  const offsetOf = (c) => (width === 4 ? be32(moov, ob + 4 + 4 * c) : be32(moov, ob + 4 + 8 * c) * 4294967296 + be32(moov, ob + 8 + 8 * c));
  const sb = stsc.start + stsc.header + 4;
  within(stsc, sb + 4);
  const runs = be32(moov, sb);
  within(stsc, sb + 4 + 12 * runs);
  const out = [];
  let sample = 0;
  for (let k = 0; k < runs && sample < count; k++) {
    const first = be32(moov, sb + 4 + 12 * k) - 1;
    const per = be32(moov, sb + 8 + 12 * k);
    const next = k + 1 < runs ? be32(moov, sb + 4 + 12 * (k + 1)) - 1 : chunks;
    if (first < 0 || next > chunks || next < first) throw stripError('mp4: stsc runs do not fit the chunk table');
    for (let c = first; c < next && sample < count; c++) {
      let off = offsetOf(c);
      for (let s = 0; s < per && sample < count; s++) {
        const size = sizeOf(sample++);
        if (size > 0) out.push([off, off + size]);
        off += size;
      }
    }
  }
  return out;
}

/** The parts of blob[start, end) with every range of `zero` (sorted, merged) replaced by zero bytes. */
function zeroed(blob, start, end, zero) {
  const out = [];
  let o = start;
  for (const [a, b] of zero) {
    if (b <= start || a >= end) continue;
    if (a > o) out.push(blob.slice(o, a));
    out.push(new Uint8Array(b - a));
    o = b;
  }
  if (o < end) out.push(blob.slice(o, end));
  return out;
}

// The boxes kept (review round, STALK-10): at the top level the media structure only; under moov, per parent, what a
// player reads. Anything else is freed. stsd sample entries, dref, tref and gmhd are kept whole (codec setup).
const TOP_KEEP = new Set(['ftyp', 'moov', 'mdat', 'moof', 'mfra', 'styp', 'sidx', 'ssix', 'prft']);
const MOOV_ALLOW = {
  moov: new Set(['mvhd', 'trak', 'mvex', 'iods']),
  trak: new Set(['tkhd', 'edts', 'mdia', 'tref', 'tapt']),
  edts: new Set(['elst']),
  mdia: new Set(['mdhd', 'hdlr', 'minf', 'elng']),
  minf: new Set(['vmhd', 'smhd', 'hmhd', 'nmhd', 'sthd', 'gmhd', 'dinf', 'stbl', 'hdlr']),
  dinf: new Set(['dref']),
  stbl: new Set(['stsd', 'stts', 'ctts', 'cslg', 'stss', 'stps', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'sdtp', 'sbgp', 'sgpd', 'subs', 'saiz', 'saio', 'padb', 'stsh']),
  mvex: new Set(['mehd', 'trex', 'leva']),
};
const TIMED_HEADERS = new Set(['mvhd', 'tkhd', 'mdhd']);

function hasData(u8, from, to) {
  for (let i = from; i < to; i++) if (u8[i]) return true;
  return false;
}

/**
 * stripMp4(blob) -> { blob, removed: [path], location: boolean }. `location` is true when a removed box
 * carried a location key (©xyz, loci or a QuickTime location key) or a removed track was timed metadata.
 */
export async function stripMp4(blob) {
  let boxes;
  try {
    boxes = await readTopBoxes(blob);
  } catch (err) {
    throw stripError(err.message);
  }
  const top0 = boxes.find((b) => b.type === 'moov');
  if (!top0) throw stripError('mp4: no moov box');
  if (boxes.filter((b) => b.type === 'moov').length > 1) throw stripError('mp4: more than one moov box');
  const removed = [];
  let location = false;
  let moov = null;
  const zero = [];
  {
    const top = top0;
    if (top.size > 64 * 1024 * 1024) throw stripError('mp4: moov is too large');
    moov = await bytesAt(blob, top.start, top.size);
    let tree;
    try {
      tree = parseBoxes(moov, 0, moov.length);
    } catch (err) {
      throw stripError(err.message);
    }
    const moovBox = tree.find((b) => b.type === 'moov');
    const freed = [];
    const fragmented = boxes.some((b) => b.type === 'moof') || Boolean(childOf(moovBox, 'mvex'));
    for (const trak of moovBox && moovBox.children ? moovBox.children.filter((b) => b.type === 'trak') : []) {
      const kind = trakKind(moov, trak);
      if (!META_HANDLERS.has(kind.handler) && !META_ENTRIES.has(kind.entry)) continue;
      if (fragmented) throw stripError('mp4: a timed metadata or subtitle track in a fragmented file');
      const stbl = pathOf(trak, ['mdia', 'minf', 'stbl']);
      if (!stbl) throw stripError('mp4: a metadata track without its sample tables');
      for (const r of sampleRanges(moov, stbl)) zero.push(r);
      if (GPS_ENTRIES.has(kind.entry) || kind.handler === 'meta') location = true;
      for (const needle of LOCATION_NEEDLES) if (contains(moov, needle, trak.start, trak.start + trak.size)) location = true;
      moov.set(freeBox(trak.size, trak.header), trak.start);
      freed.push(trak);
      removed.push('moov/trak(' + (kind.entry || kind.handler) + ')');
    }
    const inside = (b, list) => list.some((t) => b.start >= t.start && b.start < t.start + t.size);
    // Review round (STALK-10, MAL53-9): an allow-list, not a deny-list. Under moov only the boxes a player needs stay;
    // every other box (udta, meta, any uuid, free, skip, a vendor box) becomes a zeroed free box of the same length,
    // and the creation and modification times of mvhd, tkhd and mdhd become 0. Nothing moves.
    const targets = [];
    let times = false;
    const zeroTimes = (b) => {
      const o = b.start + b.header;
      const n = moov[o] === 1 ? 16 : 8;
      if (b.size < b.header + 4 + n) return;
      for (let k = o + 4; k < o + 4 + n; k++) {
        if (moov[k]) times = true;
        moov[k] = 0;
      }
    };
    const visit = (list, parent, path) => {
      const allow = MOOV_ALLOW[parent];
      for (const b of list) {
        const p = path + '/' + b.type;
        if (inside(b, freed)) continue;
        if (allow && !allow.has(b.type)) {
          targets.push({ box: b, path: p });
          continue;
        }
        if (TIMED_HEADERS.has(b.type)) zeroTimes(b);
        if (b.children && MOOV_ALLOW[b.type]) visit(b.children, b.type, p);
      }
    };
    if (moovBox && moovBox.children) visit(moovBox.children, 'moov', 'moov');
    for (const t of targets) {
      for (const needle of LOCATION_NEEDLES) if (contains(moov, needle, t.box.start, t.box.start + t.box.size)) location = true;
      const filler = t.box.type === 'free' || t.box.type === 'skip';
      const data = hasData(moov, t.box.start + t.box.header, t.box.start + t.box.size);
      moov.set(freeBox(t.box.size, t.box.header), t.box.start);
      if (!filler || data) removed.push(t.path);
    }
    if (times) removed.push('moov/times');
  }
  // The samples of removed tracks: merged, and each inside one top-level box other than moov.
  zero.sort((a, b) => a[0] - b[0]);
  const merged = [];
  let zeroBytes = 0;
  for (const r of zero) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  for (const [a, b] of merged) {
    const home = boxes.find((x) => a >= x.start + x.header && b <= x.start + x.size);
    if (!home || home.type === 'moov') throw stripError('mp4: a metadata sample outside the media data');
    zeroBytes += b - a;
  }
  if (zeroBytes > ZERO_MAX) throw stripError('mp4: too much timed metadata');
  const parts = [];
  for (const top of boxes) {
    if (top.type === 'moov') {
      parts.push(moov);
      continue;
    }
    if (!TOP_KEEP.has(top.type)) {
      // every top-level box but the media structure (review round, STALK-10): any uuid (XMP or a vendor's), udta, meta,
      // free, skip, wide and unknown boxes become zeroed free boxes of the same length
      const head = await bytesAt(blob, top.start, Math.min(top.size, top.header + 16));
      const body = await bytesAt(blob, top.start, Math.min(top.size, 1024 * 1024));
      for (const needle of LOCATION_NEEDLES) if (contains(body, needle)) location = true;
      const filler = top.type === 'free' || top.type === 'skip' || top.type === 'wide';
      parts.push(freeBox(top.size, top.header));
      if (top.type === 'uuid') removed.push(XMP_UUID.every((v, k) => head[top.header + k] === v) ? 'xmp' : 'uuid');
      else if (!filler || hasData(body, top.header, body.length) || top.size > body.length) removed.push(top.type);
      continue;
    }
    for (const p of zeroed(blob, top.start, top.start + top.size, merged)) parts.push(p);
  }
  return { blob: new Blob(parts, { type: blob.type || 'video/mp4' }), removed, location };
}

// ---------------------------------------------------------------------------------------------- WebM

export const EBML = Object.freeze({
  header: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  info: 0x1549a966,
  tracks: 0x1654ae6b,
  tags: 0x1254c367,
  cluster: 0x1f43b675,
  cues: 0x1c53bb6b,
  chapters: 0x1043a770,
  attachments: 0x1941a469,
  void: 0xec,
  title: 0x7ba9,
  dateUtc: 0x4461,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  trackEntry: 0xae,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
});
const INFO_VOID = { [EBML.title]: 'Title', [EBML.dateUtc]: 'DateUTC', [EBML.muxingApp]: 'MuxingApp', [EBML.writingApp]: 'WritingApp' };
const SEEK_VOID = { [EBML.tags]: 'Tags', [EBML.attachments]: 'Attachments', [EBML.chapters]: 'Chapters' };
const SEGMENT_LEVEL = new Set([EBML.seekHead, EBML.info, EBML.tracks, EBML.tags, EBML.cluster, EBML.cues, EBML.chapters, EBML.attachments, EBML.void]);

/** readVint(u8, o, keepMarker) -> { value, length, unknown } or null when the bytes run out. */
export function readVint(u8, o, keepMarker) {
  if (o >= u8.length) return null;
  const first = u8[o];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || o + length > u8.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === (0xff >> length);
  for (let k = 1; k < length; k++) {
    value = value * 256 + u8[o + k];
    if (u8[o + k] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

async function headerAt(blob, o) {
  const h = await bytesAt(blob, o, 12);
  const id = readVint(h, 0, true);
  if (!id || id.length > 4) return null;
  const size = readVint(h, id.length, false);
  if (!size) return null;
  return { id: id.value, idLength: id.length, header: id.length + size.length, size: size.unknown ? -1 : size.value };
}

function voidElement(total) {
  const out = new Uint8Array(total);
  out[0] = EBML.void;
  const s = total >= 9 ? 8 : total - 1;
  const payload = total - 1 - s;
  // size as an s-byte vint: the marker bit, then the value big-endian
  let v = payload;
  for (let k = s; k >= 1; k--) {
    out[k] = v & 255;
    v = Math.floor(v / 256);
  }
  out[1] |= 0x80 >> (s - 1);
  return out;
}

// Walks Segment-level elements: { id, start, header, size } (size measured for unknown-size clusters).
async function segmentChildren(blob, from, to) {
  const out = [];
  let o = from;
  while (o < to) {
    if (to - o < 2) break;
    const h = await headerAt(blob, o);
    if (!h) throw stripError('webm: unreadable element header');
    let size = h.size;
    if (size < 0) {
      if (h.id !== EBML.cluster) throw stripError('webm: an element of unknown size');
      // an unknown-size cluster ends where the next Segment-level element starts
      let p = o + h.header;
      for (;;) {
        if (p >= to) break;
        const c = await headerAt(blob, p);
        if (!c || SEGMENT_LEVEL.has(c.id) || c.size < 0) break;
        p += c.header + c.size;
      }
      size = p - o - h.header;
    }
    if (o + h.header + size > to) throw stripError('webm: element overruns the segment');
    out.push({ id: h.id, start: o, header: h.header, size: h.header + size });
    o += h.header + size;
    if (out.length > 1000000) throw stripError('webm: too many elements');
  }
  return out;
}

/** stripWebm(blob) -> { blob, removed: ['Tags' | 'Attachments' | 'Chapters' | 'Info/<name>' | 'SeekHead/Seek(<name>)'] }. */
export async function stripWebm(blob) {
  const first = await headerAt(blob, 0);
  if (!first || first.id !== EBML.header || first.size < 0) throw stripError('webm: no EBML header');
  const segStart = first.header + first.size;
  const seg = await headerAt(blob, segStart);
  if (!seg || seg.id !== EBML.segment) throw stripError('webm: no Segment');
  const segEnd = seg.size < 0 ? blob.size : Math.min(blob.size, segStart + seg.header + seg.size);
  const children = await segmentChildren(blob, segStart + seg.header, segEnd);
  const removed = [];
  const replace = new Map(); // start -> Uint8Array of the same length
  for (const c of children) {
    if (c.id === EBML.tags || c.id === EBML.attachments || c.id === EBML.chapters) {
      // Tags; and (review round, STALK-10) Attachments (cover pictures, fonts, any file) and Chapters (free-text titles)
      replace.set(c.start, voidElement(c.size));
      removed.push(c.id === EBML.tags ? 'Tags' : c.id === EBML.attachments ? 'Attachments' : 'Chapters');
    } else if (c.id === EBML.info && c.size <= 1024 * 1024) {
      // Info/Title is free text a camera or an app may fill; DateUTC is the recording time to the nanosecond, MuxingApp
      // and WritingApp name the device's software (review round, STALK-10): each becomes a Void as well
      const bytes = await bytesAt(blob, c.start, c.size);
      let changed = false;
      let p = c.header;
      while (p < bytes.length) {
        const id = readVint(bytes, p, true);
        const sz = id && readVint(bytes, p + id.length, false);
        if (!id || !sz || sz.unknown) break;
        const total = id.length + sz.length + sz.value;
        const named = INFO_VOID[id.value];
        if (named) {
          bytes.set(voidElement(total), p);
          removed.push('Info/' + named);
          changed = true;
        }
        p += total;
      }
      if (changed) replace.set(c.start, bytes);
    } else if (c.id === EBML.seekHead) {
      if (c.size > 1024 * 1024) continue;
      const bytes = await bytesAt(blob, c.start, c.size);
      let p = c.header;
      let changed = false;
      while (p < bytes.length) {
        const id = readVint(bytes, p, true);
        const sz = id && readVint(bytes, p + id.length, false);
        if (!id || !sz || sz.unknown) break;
        const total = id.length + sz.length + sz.value;
        if (id.value === EBML.seek) {
          const body = bytes.subarray(p + id.length + sz.length, p + total);
          // SeekID 0x53AB, size 4, then the 4-byte ID of the target
          for (let q = 0; q + 7 <= body.length; q++) {
            if (body[q] !== 0x53 || body[q + 1] !== 0xab || body[q + 2] !== 0x84) continue;
            const target = ((body[q + 3] << 24) | (body[q + 4] << 16) | (body[q + 5] << 8) | body[q + 6]) >>> 0;
            const named = SEEK_VOID[target];
            if (named) {
              bytes.set(voidElement(total), p);
              removed.push('SeekHead/Seek(' + named + ')');
              changed = true;
              break;
            }
          }
        }
        p += total;
      }
      if (changed) replace.set(c.start, bytes);
    }
  }
  if (replace.size === 0) return { blob, removed };
  const parts = [];
  let o = 0;
  const starts = Array.from(replace.keys()).sort((a, b) => a - b);
  for (const s of starts) {
    if (s > o) parts.push(blob.slice(o, s));
    const bytes = replace.get(s);
    parts.push(bytes);
    o = s + bytes.length;
  }
  if (o < blob.size) parts.push(blob.slice(o));
  return { blob: new Blob(parts, { type: blob.type || 'video/webm' }), removed };
}

/** webmInfo(blob) -> { duration, w, h } from Info (TimecodeScale, Duration) and the first video track, or null. */
export async function webmInfo(blob) {
  try {
    const first = await headerAt(blob, 0);
    const segStart = first.header + first.size;
    const seg = await headerAt(blob, segStart);
    const segEnd = seg.size < 0 ? blob.size : Math.min(blob.size, segStart + seg.header + seg.size);
    const info = { duration: 0, w: 0, h: 0 };
    let o = segStart + seg.header;
    let seen = 0;
    while (o < segEnd && seen < 64) {
      const h = await headerAt(blob, o);
      if (!h || h.size < 0) break;
      seen++;
      if (h.id === EBML.info || h.id === EBML.tracks) {
        const u8 = await bytesAt(blob, o, Math.min(h.header + h.size, 1024 * 1024));
        if (h.id === EBML.info) readInfo(u8, h.header, info);
        else readTracks(u8, h.header, info);
      }
      if (h.id === EBML.cluster) break;
      o += h.header + h.size;
    }
    return info;
  } catch (_) {
    return null;
  }
}

function children(u8, from, to, fn) {
  let p = from;
  while (p < to) {
    const id = readVint(u8, p, true);
    const sz = id && readVint(u8, p + id.length, false);
    if (!id || !sz || sz.unknown) return;
    const body = p + id.length + sz.length;
    fn(id.value, body, Math.min(to, body + sz.value));
    p = body + sz.value;
  }
}

function uint(u8, from, to) {
  let v = 0;
  for (let k = from; k < to; k++) v = v * 256 + u8[k];
  return v;
}

function float(u8, from, to) {
  const dv = new DataView(u8.buffer, u8.byteOffset + from, to - from);
  return to - from === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
}

function readInfo(u8, from, info) {
  let scale = 1000000;
  let dur = 0;
  children(u8, from, u8.length, (id, a, b) => {
    if (id === EBML.timecodeScale) scale = uint(u8, a, b);
    else if (id === EBML.duration && (b - a === 4 || b - a === 8)) dur = float(u8, a, b);
  });
  info.duration = dur * scale / 1e9;
}

function readTracks(u8, from, info) {
  children(u8, from, u8.length, (id, a, b) => {
    if (id !== EBML.trackEntry || info.w) return;
    children(u8, a, b, (id2, c, d) => {
      if (id2 !== EBML.video) return;
      children(u8, c, d, (id3, e, f) => {
        if (id3 === EBML.pixelWidth) info.w = uint(u8, e, f);
        else if (id3 === EBML.pixelHeight) info.h = uint(u8, e, f);
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------- images

const JPEG_NAMES = { 0xe0: 'APP0', 0xe1: 'APP1', 0xe2: 'APP2', 0xed: 'APP13', 0xee: 'APP14', 0xfe: 'COM', 0xdb: 'DQT', 0xc4: 'DHT', 0xc0: 'SOF0', 0xc2: 'SOF2', 0xda: 'SOS' };

/** jpegSegments(u8) -> the marker segments before the scan: [{ marker, name, start, length, ident }] */
export function jpegSegments(u8) {
  const out = [];
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return out;
  let o = 2;
  while (o + 4 <= u8.length) {
    if (u8[o] !== 0xff) break;
    const marker = u8[o + 1];
    if (marker === 0xff) {
      o++;
      continue;
    }
    const length = (u8[o + 2] << 8) | u8[o + 3];
    let ident = '';
    for (let k = o + 4; k < Math.min(o + 4 + 12, u8.length) && u8[k] !== 0; k++) ident += String.fromCharCode(u8[k]);
    out.push({ marker, name: JPEG_NAMES[marker] || ('0x' + marker.toString(16)), start: o, length, ident });
    if (marker === 0xda) break;
    o += 2 + length;
  }
  return out;
}

/** jpegHasExif(u8) -> true when an APP1 Exif segment is present (tests). */
export function jpegHasExif(u8) {
  return jpegSegments(u8).some((s) => s.marker === 0xe1 && s.ident.indexOf('Exif') === 0);
}

const PHOTO_TYPES = new Set(['image/jpeg', 'image/heic', 'image/avif']);

/** <img> from a blob: URL (applies the EXIF orientation by default since Safari 13.1, Chromium 81, Firefox 77). */
function decodeWithImg(blob, opts) {
  const urlApi = opts.URL || globalThis.URL;
  const Img = opts.Image || globalThis.Image;
  const doc = opts.document || globalThis.document;
  if (!urlApi || typeof urlApi.createObjectURL !== 'function' || (typeof Img !== 'function' && !(doc && typeof doc.createElement === 'function'))) {
    return Promise.reject(stripError('no image decoder'));
  }
  const img = typeof Img === 'function' ? new Img() : doc.createElement('img');
  const url = urlApi.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(stripError('the picture does not decode'));
    img.src = url;
  }).then(() => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw stripError('the picture has no size');
    if (w * h > PIXEL_CAP) throw stripError('the picture has more than 24 megapixels');
    return { drawable: img, width: w, height: h, close() {} };
  }).finally(() => {
    try {
      urlApi.revokeObjectURL(url);
    } catch (_) { /* revoked */ }
  });
}

/**
 * decodeImage(blob, opts) -> { drawable, width, height, close() }: createImageBitmap with the EXIF orientation
 * applied, then createImageBitmap without options (a floor engine may refuse the 'from-image' member, WebIDL
 * TypeError), then an <img> under the 24-megapixel cap (R 2.13). E_MEDIA_STRIP only when every decoder failed, so
 * "Upload anyway (may include your location)" is offered only then (MF-57; code review v0.3).
 */
export async function decodeImage(blob, opts = {}) {
  const cib = opts.createImageBitmap || globalThis.createImageBitmap;
  if (typeof cib === 'function') {
    for (const args of [[{ imageOrientation: 'from-image' }], []]) {
      try {
        const b = await cib(blob, ...args);
        return { drawable: b, width: b.width, height: b.height, close: () => { if (typeof b.close === 'function') b.close(); } };
      } catch (_) { /* the next decoder */ }
    }
  }
  try {
    return await decodeWithImg(blob, opts);
  } catch (err) {
    if (err && /megapixels/.test(err.message)) throw err;
    throw stripError(typeof cib === 'function' ? 'this browser cannot decode the picture' : 'this browser cannot re-encode images');
  }
}

/**
 * stripImage(blob, { maxSide, type, quality, createImageBitmap, makeCanvas, Image, URL, document }) ->
 * { blob, removed, w, h, mime }. Browser only. The first frame of a GIF is kept (createImageBitmap decodes the
 * first frame).
 */
export async function stripImage(blob, opts = {}) {
  const bitmap = await decodeImage(blob, opts);
  const size = fitWithin(bitmap.width, bitmap.height, opts.maxSide || Math.max(bitmap.width, bitmap.height));
  const canvas = (opts.makeCanvas || makeCanvas)(size.w, size.h);
  canvas.getContext('2d').drawImage(bitmap.drawable, 0, 0, size.w, size.h);
  bitmap.close();
  const want = opts.type || (PHOTO_TYPES.has(blob.type) ? 'image/jpeg' : 'image/webp');
  let out = await canvasBlob(canvas, want, opts.quality === undefined ? 0.9 : opts.quality);
  if (!out) throw stripError('the picture could not be re-encoded');
  if (want === 'image/webp' && out.type !== 'image/webp') out = await canvasBlob(canvas, 'image/png');
  return { blob: out, removed: ['exif', 'icc', 'thumbnail'], w: size.w, h: size.h, mime: out.type || want };
}

// ---------------------------------------------------------------------------------------------- MP3, AVI, WAV
// Review round (PRIV-5): these were published as they came. MP3 tags sit outside the audio frames and are dropped;
// RIFF chunks a player does not need become JUNK chunks of the same length, so no index offset moves.

const ascii = (u8, at, len) => String.fromCharCode.apply(null, Array.from(u8.subarray(at, at + len)));
const le32 = (u8, o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;

/** stripMp3(blob) -> { blob, removed: ['ID3v2' | 'ID3v1' | 'ID3v1+' | 'APEv2'] }: the audio frames only. */
export async function stripMp3(blob) {
  const removed = [];
  let start = 0;
  let end = blob.size;
  for (let k = 0; k < 8; k++) {
    const h = await bytesAt(blob, start, 10);
    if (h.length < 10 || ascii(h, 0, 3) !== 'ID3') break;
    if ((h[6] | h[7] | h[8] | h[9]) & 0x80) throw stripError('mp3: an ID3v2 tag with a broken size');
    const next = start + 10 + ((h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9]) + (h[5] & 0x10 ? 10 : 0);
    if (next > end) throw stripError('mp3: an ID3v2 tag overruns the file');
    start = next;
    removed.push('ID3v2');
  }
  for (let k = 0; k < 8; k++) {
    if (end - start >= 128 && ascii(await bytesAt(blob, end - 128, 3), 0, 3) === 'TAG') {
      end -= 128;
      removed.push('ID3v1');
      if (end - start >= 227 && ascii(await bytesAt(blob, end - 227, 4), 0, 4) === 'TAG+') {
        end -= 227;
        removed.push('ID3v1+');
      }
      continue;
    }
    if (end - start >= 32) {
      const f = await bytesAt(blob, end - 32, 32);
      if (ascii(f, 0, 8) === 'APETAGEX') {
        const size = le32(f, 12) + (le32(f, 20) & 0x80000000 ? 32 : 0);
        if (size < 32 || end - size < start) throw stripError('mp3: an APE tag overruns the file');
        end -= size;
        removed.push('APEv2');
        continue;
      }
    }
    break;
  }
  if (!removed.length) return { blob, removed };
  return { blob: blob.slice(start, end, blob.type || 'audio/mpeg'), removed };
}

function junkChunk(total) {
  const out = new Uint8Array(total);
  const size = total - 8; // the same length on disk: an odd chunk and its pad byte become one even JUNK chunk
  out.set([0x4a, 0x55, 0x4e, 0x4b, size & 255, (size >>> 8) & 255, (size >>> 16) & 255, (size >>> 24) & 255], 0);
  return out;
}

// What a player reads, per RIFF form and LIST type; every other chunk becomes JUNK.
const RIFF_KEEP = {
  'AVI ': new Set(['LIST:hdrl', 'LIST:movi', 'idx1', 'JUNK']),
  WAVE: new Set(['fmt ', 'data', 'fact', 'JUNK']),
  hdrl: new Set(['avih', 'LIST:strl', 'LIST:odml', 'JUNK']),
  strl: new Set(['strh', 'strf', 'strd', 'indx', 'vprp', 'JUNK']),
  odml: new Set(['dmlh', 'JUNK']),
};

/** riffChunks(u8, from, to) -> [{ id, key, start, total }] (key: 'LIST:<type>' for a LIST). */
function riffChunks(u8, from, to) {
  const out = [];
  let o = from;
  while (o + 8 <= to) {
    const id = ascii(u8, o, 4);
    const size = le32(u8, o + 4);
    const total = 8 + size + (size % 2);
    if (o + 8 + size > to) throw stripError('riff: chunk ' + JSON.stringify(id) + ' overruns its parent');
    out.push({ id, key: id === 'LIST' && size >= 4 ? 'LIST:' + ascii(u8, o + 8, 4) : id, start: o, total: Math.min(total, to - o) });
    o += total;
  }
  return out;
}

/** In place: chunks of u8[from, to) outside RIFF_KEEP[form] become JUNK; their paths go to removed. */
function junkInside(u8, from, to, form, path, removed) {
  for (const c of riffChunks(u8, from, to)) {
    const keep = RIFF_KEEP[form];
    if (!keep.has(c.key)) {
      u8.set(junkChunk(c.total), c.start);
      removed.push(path + c.key);
    } else if (c.id === 'LIST' && RIFF_KEEP[c.key.slice(5)]) {
      junkInside(u8, c.start + 12, c.start + c.total, c.key.slice(5), path + c.key + '/', removed);
    }
  }
}

/** stripRiff(blob) -> { blob, removed }: AVI and WAV with LIST INFO, IDIT, bext, iXML and every other extra chunk as JUNK. */
export async function stripRiff(blob) {
  const head = await bytesAt(blob, 0, 12);
  if (head.length < 12 || ascii(head, 0, 4) !== 'RIFF') throw stripError('riff: no RIFF header');
  const form = ascii(head, 8, 4);
  if (!RIFF_KEEP[form]) throw stripError('riff: not AVI or WAV');
  const end = Math.min(blob.size, 8 + le32(head, 4));
  const parts = [head];
  const removed = [];
  let o = 12;
  while (o + 8 <= end) {
    const h = await bytesAt(blob, o, 12);
    const id = ascii(h, 0, 4);
    const size = le32(h, 4);
    const total = Math.min(8 + size + (size % 2), end - o);
    if (o + 8 + size > end) throw stripError('riff: chunk ' + JSON.stringify(id) + ' overruns the file');
    const key = id === 'LIST' ? 'LIST:' + ascii(h, 8, 4) : id;
    if (!RIFF_KEEP[form].has(key)) {
      parts.push(junkChunk(total));
      removed.push(key);
    } else if (key === 'LIST:hdrl') {
      if (total > 1024 * 1024) throw stripError('riff: hdrl is too large');
      const u8 = await bytesAt(blob, o, total);
      junkInside(u8, 12, total, 'hdrl', 'hdrl/', removed);
      parts.push(u8);
    } else {
      parts.push(blob.slice(o, o + total));
    }
    o += total;
  }
  if (o < end) throw stripError('riff: trailing bytes inside the RIFF chunk');
  if (end < blob.size) {
    // OpenDML AVI continues in RIFF AVIX chunks of media data; anything else after the RIFF chunk is refused
    const next = await bytesAt(blob, end, 12);
    if (ascii(next, 0, 4) !== 'RIFF' || ascii(next, 8, 4) !== 'AVIX') throw stripError('riff: bytes after the RIFF chunk');
    parts.push(blob.slice(end));
  }
  return { blob: new Blob(parts, { type: blob.type || (form === 'WAVE' ? 'audio/wav' : 'video/x-msvideo') }), removed };
}

/** stripperFor(mime) -> 'image' | 'mp4' | 'webm' | 'mp3' | 'riff' | null: which stripper a sniffed type needs. */
export function stripperFor(mime) {
  if (mime === 'video/mp4' || mime === 'video/quicktime' || mime === 'video/3gpp' || mime === 'audio/mp4') return 'mp4';
  if (mime === 'video/webm' || mime === 'video/x-matroska') return 'webm';
  if (mime === 'audio/mpeg') return 'mp3';
  if (mime === 'video/x-msvideo' || mime === 'audio/wav') return 'riff';
  if (typeof mime === 'string' && mime.indexOf('image/') === 0 && mime !== 'image/svg+xml') return 'image';
  return null;
}

/** be32 for tests */
export { be32 };
