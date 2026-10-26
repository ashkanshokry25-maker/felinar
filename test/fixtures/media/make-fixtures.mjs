#!/usr/bin/env node
// test/fixtures/media/make-fixtures.mjs: generates the media fixtures of the v0.3 test plan (R 4.1
// U-FI-5, U-MD-4; R 4.2 E-MD-1, E-MD-10, E-FI-5) into a directory the caller names. Nothing large is
// committed: tests call this with a temporary directory. Needs ffmpeg on PATH (fixtures only; the
// product never runs it).
//
//   node test/fixtures/media/make-fixtures.mjs <dir> [--only name,name]
//   import { makeFixtures } from './make-fixtures.mjs'; await makeFixtures(dir, { only: ['moovAtEnd'] })
//
// Fixtures (file names in <dir>):
//   reference        reference.mp4 (exactly 20,971,520 bytes, H.264 + AAC, moov first) and
//                    reference-poster.jpg (exactly 49,152 bytes): the R 2.9.5 worked example, E-MD-1
//   moovAtEnd        moov-at-end.mp4: ffmpeg's default layout, moov after mdat (U-MD-4, E-MD-10)
//   udtaLocation     udta-location.mp4: moov after mdat; moov/udta with a ©xyz and a loci entry and a
//                    moov/meta keys entry com.apple.quicktime.location.ISO6709 (U-FI-5)
//   udtaLocationMov  udta-location.mov: QuickTime layout written by ffmpeg with ©xyz (U-FI-5)
//   webmTags         tags.webm: VP9 + Opus with a Tags element (title and a location tag; U-FI-5)
//   gpsJpeg          gps.jpg: a JPEG with a hand-built APP1 Exif segment (Make, GPS latitude and
//                    longitude) and an APP2 ICC segment with a marker text (U-FI-5 in a browser)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REFERENCE_BYTES = 20971520;
export const POSTER_BYTES = 49152;
export const LOCATION = '+48.8584+002.2945/';

export function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function ff(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

const be32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const box = (type, ...payload) => {
  const body = Buffer.concat(payload);
  return Buffer.concat([be32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};

function topBoxes(buf) {
  const out = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(o + 8));
    if (size === 0) size = buf.length - o;
    out.push({ type, start: o, size });
    o += size;
  }
  return out;
}

/**
 * addUdtaLocation(mp4) -> a copy whose moov (which must be the last top-level box, so no chunk offset
 * moves) gains udta { ©xyz, loci } and meta { hdlr mdta, keys, ilst } with a QuickTime location key.
 */
export function addUdtaLocation(mp4) {
  const boxes = topBoxes(mp4);
  const moov = boxes[boxes.length - 1];
  if (!moov || moov.type !== 'moov') throw new Error('addUdtaLocation: moov must be the last box');
  const text = Buffer.from(LOCATION, 'latin1');
  const xyz = Buffer.concat([be32(12 + text.length), Buffer.from([0xa9, 0x78, 0x79, 0x7a]), Buffer.from([0, text.length, 0x15, 0xc7]), text]);
  // 3GPP loci: FullBox, language, name, role, longitude, latitude, altitude (16.16), body, notes
  const loci = box('loci', Buffer.from([0, 0, 0, 0, 0x15, 0xc7]), Buffer.from('Home\0', 'latin1'), Buffer.from([0]),
    be32(Math.round(2.2945 * 65536)), be32(Math.round(48.8584 * 65536)), be32(0), Buffer.from('Earth\0\0', 'latin1'));
  const udta = box('udta', xyz, loci);
  const key = Buffer.from('com.apple.quicktime.location.ISO6709', 'latin1');
  const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from('mdta', 'latin1'), Buffer.alloc(13));
  const keys = box('keys', Buffer.alloc(4), be32(1), be32(8 + key.length), Buffer.from('mdta', 'latin1'), key);
  const data = box('data', be32(1), be32(0), text);
  const ilst = box('ilst', box('\0\0\0\x01', data));
  const meta = box('meta', hdlr, keys, ilst);
  const body = Buffer.concat([mp4.subarray(moov.start + 8, moov.start + moov.size), udta, meta]);
  return Buffer.concat([mp4.subarray(0, moov.start), be32(8 + body.length), Buffer.from('moov', 'latin1'), body]);
}

/** exifGpsSegment() -> an APP1 Exif segment (big-endian TIFF) with Make and a GPS IFD. */
export function exifGpsSegment() {
  // Layout (offsets from the TIFF header): IFD0 at 8 with 2 entries (Make, GPSInfo), then the Make
  // string, then the GPS IFD with 4 entries, then the six rationals.
  const make = Buffer.from('MagnetCam\0', 'latin1');
  const ifd0At = 8;
  const ifd0Len = 2 + 2 * 12 + 4;
  const makeAt = ifd0At + ifd0Len;
  const gpsAt = makeAt + make.length;
  const gpsLen = 2 + 4 * 12 + 4;
  const latAt = gpsAt + gpsLen;
  const lonAt = latAt + 24;
  const entry = (tag, type, count, value) => {
    const e = Buffer.alloc(12);
    e.writeUInt16BE(tag, 0);
    e.writeUInt16BE(type, 2);
    e.writeUInt32BE(count, 4);
    if (Buffer.isBuffer(value)) value.copy(e, 8);
    else e.writeUInt32BE(value, 8);
    return e;
  };
  const rationals = (vals) => Buffer.concat(vals.map(([n, d]) => Buffer.concat([be32(n), be32(d)])));
  const tiff = Buffer.concat([
    Buffer.from('MM\0*', 'latin1'), be32(ifd0At),
    Buffer.from([0, 2]), entry(0x010f, 2, make.length, makeAt), entry(0x8825, 4, 1, gpsAt), be32(0),
    make,
    Buffer.from([0, 4]),
    entry(0x0001, 2, 2, Buffer.from('N\0\0\0', 'latin1')), entry(0x0002, 5, 3, latAt),
    entry(0x0003, 2, 2, Buffer.from('E\0\0\0', 'latin1')), entry(0x0004, 5, 3, lonAt), be32(0),
    rationals([[48, 1], [51, 1], [3024, 100]]),
    rationals([[2, 1], [17, 1], [4020, 100]]),
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]);
}

/** iccSegment() -> an APP2 ICC_PROFILE segment whose (not decodable) profile carries a marker text. */
export function iccSegment() {
  const payload = Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), Buffer.from('MagnetCamProfile serial 0042', 'latin1')]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, 0xe2]), len, payload]);
}

/** withExif(jpeg) -> the JPEG with the Exif GPS segment and an ICC segment right after SOI. */
export function withExif(jpeg) {
  return Buffer.concat([jpeg.subarray(0, 2), exifGpsSegment(), iccSegment(), jpeg.subarray(2)]);
}

/** padJpeg(jpeg, size) -> the JPEG grown to exactly `size` bytes with COM segments after SOI. */
export function padJpeg(jpeg, size) {
  let missing = size - jpeg.length;
  if (missing < 0) throw new Error('padJpeg: the JPEG is already larger than ' + size);
  const segs = [];
  while (missing > 0) {
    if (missing < 4) throw new Error('padJpeg: cannot pad by fewer than 4 bytes');
    let n = Math.min(missing, 65537);
    if (missing - n > 0 && missing - n < 4) n -= 4;
    const seg = Buffer.alloc(n);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg.writeUInt16BE(n - 2, 2);
    segs.push(seg);
    missing -= n;
  }
  return Buffer.concat([jpeg.subarray(0, 2), ...segs, jpeg.subarray(2)]);
}

/** padMp4(mp4, size) -> the file grown to exactly `size` bytes with a trailing free box. */
export function padMp4(mp4, size) {
  const missing = size - mp4.length;
  if (missing === 0) return mp4;
  if (missing < 8) throw new Error('padMp4: cannot pad by fewer than 8 bytes');
  return Buffer.concat([mp4, be32(missing), Buffer.from('free', 'latin1'), Buffer.alloc(missing - 8)]);
}

const SMALL_VIDEO = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2'];

const MAKERS = {
  moovAtEnd(dir) {
    const out = join(dir, 'moov-at-end.mp4');
    ff([...SMALL_VIDEO, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', out]);
    return { moovAtEnd: out };
  },
  udtaLocation(dir) {
    const tmp = join(dir, 'udta-base.mp4');
    ff([...SMALL_VIDEO, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', tmp]);
    const out = join(dir, 'udta-location.mp4');
    writeFileSync(out, addUdtaLocation(readFileSync(tmp)));
    return { udtaLocation: out };
  },
  udtaLocationMov(dir) {
    const out = join(dir, 'udta-location.mov');
    ff([...SMALL_VIDEO, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', 'location=' + LOCATION, '-f', 'mov', out]);
    return { udtaLocationMov: out };
  },
  webmTags(dir) {
    const out = join(dir, 'tags.webm');
    ff([...SMALL_VIDEO, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-metadata', 'title=Secret place', '-metadata', 'location=' + LOCATION, '-f', 'webm', out]);
    return { webmTags: out };
  },
  gpsJpeg(dir) {
    const base = join(dir, 'gps-base.jpg');
    ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1', '-frames:v', '1', '-q:v', '3', '-f', 'image2', base]);
    const out = join(dir, 'gps.jpg');
    writeFileSync(out, withExif(readFileSync(base)));
    return { gpsJpeg: out };
  },
  reference(dir) {
    const out = join(dir, 'reference.mp4');
    const raw = join(dir, 'reference-raw.mp4');
    let rate = 15;
    for (let attempt = 0; attempt < 6; attempt++) {
      ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30,noise=alls=60:allf=t', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
        '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', rate + 'M', '-maxrate', rate + 'M', '-bufsize', (2 * rate) + 'M',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', raw]);
      const size = statSync(raw).size;
      if (size <= REFERENCE_BYTES - 8 && size > REFERENCE_BYTES * 0.6) break;
      rate = Math.max(1, Math.floor(rate * (REFERENCE_BYTES * 0.9) / size));
    }
    writeFileSync(out, padMp4(readFileSync(raw), REFERENCE_BYTES));
    const poster = join(dir, 'reference-poster.jpg');
    const rawPoster = join(dir, 'reference-poster-raw.jpg');
    let q = 2;
    for (;;) {
      ff(['-ss', '1', '-i', out, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', String(q), '-f', 'image2', rawPoster]);
      if (statSync(rawPoster).size <= POSTER_BYTES - 4 || q >= 31) break;
      q += 3;
    }
    writeFileSync(poster, padJpeg(readFileSync(rawPoster), POSTER_BYTES));
    return { reference: out, referencePoster: poster };
  },
};

export const FIXTURES = Object.freeze(Object.keys(MAKERS));

/** makeFixtures(dir, { only }) -> { name: absolute path } for every fixture made. */
export async function makeFixtures(dir, { only = null } = {}) {
  if (!hasFfmpeg()) throw new Error('make-fixtures: ffmpeg is not on PATH');
  mkdirSync(dir, { recursive: true });
  const out = {};
  for (const name of only || FIXTURES) {
    if (!MAKERS[name]) throw new Error('make-fixtures: unknown fixture ' + name);
    Object.assign(out, MAKERS[name](dir));
  }
  return out;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const onlyAt = args.indexOf('--only');
  if (!dir) {
    process.stderr.write('Usage: node test/fixtures/media/make-fixtures.mjs <dir> [--only ' + FIXTURES.join(',') + ']\n');
    process.exit(2);
  }
  const only = onlyAt >= 0 && args[onlyAt + 1] ? args[onlyAt + 1].split(',') : null;
  const made = await makeFixtures(resolve(dir), { only });
  process.stdout.write(JSON.stringify(made, null, 2) + '\n');
  void existsSync;
}
