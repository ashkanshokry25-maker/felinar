// Unit tests for src/media/strip.js in Node (R 2.8.2, 2.9.3; MF-57; U-FI-5 for MP4, MOV and WebM):
// location boxes and Tags removed by box rewriting, every other byte kept, the result still parses,
// and the failure path throws E_MEDIA_STRIP. The JPEG half (canvas re-encoding) runs in Chromium in
// media-browser.test.mjs. Fixtures come from test/fixtures/media/make-fixtures.mjs (ffmpeg) in a
// temporary directory; without ffmpeg the fixture tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { stripMp4, stripWebm, jpegSegments, jpegHasExif, readVint, stripperFor, webmInfo, LOCATION_TEXT } from '../../src/media/strip.js';
import { readTopBoxes, parseBoxes, walk, mp4Info } from '../../src/media/faststart.js';
import { containerInfo, posterTime } from '../../src/media/poster.js';
import { sniff, mediaType } from '../../src/media/sniff.js';
import { makeFixtures, hasFfmpeg, exifGpsSegment } from '../fixtures/media/make-fixtures.mjs';

const FF = hasFfmpeg();
let fx = null;
let dir = null;
async function fixtures() {
  if (!fx) {
    dir = mkdtempSync(join(tmpdir(), 'mw-media-strip-'));
    fx = await makeFixtures(dir, { only: ['moovAtEnd', 'udtaLocation', 'udtaLocationMov', 'webmTags', 'gpsJpeg'] });
  }
  return fx;
}
test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const blobOf = (path, type) => new Blob([readFileSync(path)], { type });
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const has = (u8, s) => Buffer.from(u8).indexOf(typeof s === 'string' ? Buffer.from(s, 'latin1') : Buffer.from(s)) >= 0;

function probeTags(path) {
  try {
    return execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags', '-of', 'json', path], { encoding: 'utf8' });
  } catch (err) {
    return 'ERROR ' + err.message;
  }
}

async function boxPaths(blob) {
  const top = await readTopBoxes(blob);
  const paths = top.map((b) => b.type);
  const moovBox = top.find((b) => b.type === 'moov');
  const moov = new Uint8Array(await blob.slice(moovBox.start, moovBox.start + moovBox.size).arrayBuffer());
  walk(parseBoxes(moov, 0, moov.length), (b, p) => paths.push(p));
  return paths;
}

test('U-FI-5 MP4: moov/udta (©xyz, loci) and moov/meta (QuickTime location key) are removed; nothing else moves', { skip: !FF && 'ffmpeg not on PATH' }, async () => {
  const f = await fixtures();
  const input = blobOf(f.udtaLocation, 'video/mp4');
  const before = await bytesOf(input);
  assert.ok(has(before, [0xa9, 0x78, 0x79, 0x7a]) && has(before, 'loci') && has(before, 'com.apple.quicktime.location'), 'the fixture carries a location');
  assert.ok((await boxPaths(input)).includes('moov/udta'));
  const { blob, removed, location } = await stripMp4(input);
  const after = await bytesOf(blob);
  assert.equal(after.length, before.length, 'same length: removed boxes become free boxes');
  assert.deepEqual(Array.from(new Set(removed)).sort(), ['moov/meta', 'moov/udta'], 'ffmpeg\'s own udta (encoder) and the added udta and meta');
  assert.equal(location, true);
  for (const needle of [[0xa9, 0x78, 0x79, 0x7a], 'loci', 'com.apple.quicktime.location', '+48.8584']) assert.ok(!has(after, needle), 'gone: ' + needle);
  const paths = await boxPaths(blob);
  assert.ok(!paths.some((p) => /udta|meta/.test(p)), 'no udta or meta box left');
  // every byte outside the removed boxes is unchanged
  let diff = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) diff++;
  assert.ok(diff > 0 && diff < 600, 'only the removed boxes changed (' + diff + ' bytes)');
  const out = join(dir, 'stripped.mp4');
  writeFileSync(out, after);
  const tags = probeTags(out);
  assert.doesNotMatch(tags, /48\.8584|location/i);
  assert.match(tags, /"duration": "2\.0/, 'still a valid two-second file');
  assert.equal(LOCATION_TEXT, 'Location and camera details removed');
});

test('U-FI-5 MOV: the ©xyz entry ffmpeg writes in QuickTime files is removed', { skip: !FF && 'ffmpeg not on PATH' }, async () => {
  const f = await fixtures();
  const input = blobOf(f.udtaLocationMov, 'video/quicktime');
  assert.equal(sniff(await bytesOf(input)).mime, 'video/quicktime');
  const { blob, removed } = await stripMp4(input);
  assert.ok(removed.includes('moov/udta'));
  const after = await bytesOf(blob);
  assert.ok(!has(after, '+48.8584'));
  const out = join(dir, 'stripped.mov');
  writeFileSync(out, after);
  assert.doesNotMatch(probeTags(out), /48\.8584/);
});

test('U-FI-5 WebM: Tags elements and the SeekHead entry that points at them become Void elements', { skip: !FF && 'ffmpeg not on PATH' }, async () => {
  const f = await fixtures();
  const input = blobOf(f.webmTags, 'video/webm');
  const before = await bytesOf(input);
  assert.equal(mediaType(before).mime, 'video/webm');
  assert.ok(has(before, 'Secret place') && has(before, '+48.8584'));
  const { blob, removed } = await stripWebm(input);
  const after = await bytesOf(blob);
  assert.equal(after.length, before.length);
  assert.ok(removed.includes('Tags'));
  assert.ok(removed.includes('Info/Title'));
  assert.ok(!has(after, 'Secret place') && !has(after, '+48.8584'), 'title and location gone');
  assert.ok(!has(after, [0x12, 0x54, 0xc3, 0x67]), 'no Tags ID left anywhere');
  const out = join(dir, 'stripped.webm');
  writeFileSync(out, after);
  const tags = probeTags(out);
  assert.doesNotMatch(tags, /Secret|48\.8584/);
  assert.match(tags, /"duration": "2\.0/);
  const info = await webmInfo(blob);
  assert.equal(info.w, 160);
  assert.equal(info.h, 120);
  assert.ok(Math.abs(info.duration - 2) < 0.1);
});

test('U-FI-5 failure path: bytes that are not a parsable MP4 or WebM throw E_MEDIA_STRIP', async () => {
  const junk = new Blob([new Uint8Array([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 200, 1, 2, 3])]);
  await assert.rejects(stripMp4(junk), (e) => e.code === 'E_MEDIA_STRIP', 'a box overruns the file');
  const noMoov = new Blob([new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65])]);
  await assert.rejects(stripMp4(noMoov), (e) => e.code === 'E_MEDIA_STRIP', 'no moov');
  await assert.rejects(stripWebm(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])])), (e) => e.code === 'E_MEDIA_STRIP');
  const unknownSize = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x15, 0x49, 0xa9, 0x66, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  await assert.rejects(stripWebm(new Blob([unknownSize])), (e) => e.code === 'E_MEDIA_STRIP', 'an Info of unknown size');
});

test('a file without location metadata: location false, only the encoder udta goes, the length stays', { skip: !FF && 'ffmpeg not on PATH' }, async () => {
  const f = await fixtures();
  const input = blobOf(f.moovAtEnd, 'video/mp4');
  const { blob, removed, location } = await stripMp4(input);
  assert.equal(location, false);
  assert.deepEqual(removed, ['moov/udta']);
  assert.equal(blob.size, input.size);
  const plain = new Blob([new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76])]);
  const r = await stripMp4(plain);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(await bytesOf(r.blob), await bytesOf(plain), 'nothing to remove: the same bytes');
});

test('the GPS JPEG fixture: jpegSegments finds the APP1 Exif segment with the GPS IFD (stripped in Chromium)', { skip: !FF && 'ffmpeg not on PATH' }, async () => {
  const f = await fixtures();
  const u8 = new Uint8Array(readFileSync(f.gpsJpeg));
  const segs = jpegSegments(u8);
  assert.equal(segs[0].name, 'APP1');
  assert.equal(segs[0].ident, 'Exif');
  assert.ok(jpegHasExif(u8));
  assert.ok(has(u8, 'MagnetCam'));
  assert.ok(exifGpsSegment().length < 400);
  assert.equal(sniff(u8).mime, 'image/jpeg');
});

test('helpers: readVint, stripperFor, posterTime, containerInfo of the MP4 fixture', { skip: !FF && 'ffmpeg not on PATH' }, async () => {
  assert.deepEqual(readVint(new Uint8Array([0x81]), 0, false), { value: 1, length: 1, unknown: false });
  assert.deepEqual(readVint(new Uint8Array([0x40, 0x02]), 0, false), { value: 2, length: 2, unknown: false });
  assert.equal(readVint(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0, true).value, 0x1a45dfa3);
  assert.equal(readVint(new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0, false).unknown, true);
  assert.equal(stripperFor('video/mp4'), 'mp4');
  assert.equal(stripperFor('video/quicktime'), 'mp4');
  assert.equal(stripperFor('video/webm'), 'webm');
  assert.equal(stripperFor('image/jpeg'), 'image');
  assert.equal(stripperFor('image/svg+xml'), null);
  assert.equal(posterTime(4), 0.4);
  assert.equal(posterTime(30), 1);
  assert.equal(posterTime(NaN), 0);
  const f = await fixtures();
  const info = await containerInfo(blobOf(f.moovAtEnd, 'video/mp4'), 'video/mp4');
  assert.equal(info.w, 160);
  assert.equal(info.h, 120);
  assert.ok(Math.abs(info.duration - 2) < 0.05);
  assert.equal((await mp4Info(new Blob([new Uint8Array(4)]))), null);
});

// ------------------------------------------------------------------------------------------- code review v0.3

const u32s = (...ns) => {
  const b = Buffer.alloc(4 * ns.length);
  ns.forEach((n, i) => b.writeUInt32BE(n, 4 * i));
  return b;
};
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
const full = (type, ...parts) => box(type, Buffer.alloc(4), ...parts);

/** A track with one sample entry, its handler, and sample tables (one stsc run). */
function trak({ handler, entry, sizes, offsets, perChunk }) {
  const hdlr = full('hdlr', u32s(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('h\0', 'latin1'));
  const stsd = full('stsd', u32s(1), box(entry, Buffer.alloc(8)));
  const stbl = box('stbl', stsd, full('stts', u32s(1, sizes.length, 1)), full('stsc', u32s(1, 1, perChunk, 1)),
    full('stsz', u32s(0, sizes.length, ...sizes)), full('stco', u32s(offsets.length, ...offsets)));
  return box('trak', full('tkhd', Buffer.alloc(80)), box('mdia', full('mdhd', Buffer.alloc(20)), hdlr, box('minf', box('dinf'), stbl)));
}

/** ftyp, then mdat (two video samples, then two GoPro GPMF samples carrying GPS5), then moov. */
function goproLike({ mvex = false } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'latin1'));
  const video = Buffer.alloc(200, 0x11);
  const gps = Buffer.concat([Buffer.from('DEVC....GPS5 +48.8584 +2.2945', 'latin1'), Buffer.alloc(20, 0x22)]);
  const mdat = box('mdat', video, gps, gps);
  const at = ftyp.length + 8;
  const moov = box('moov', full('mvhd', Buffer.alloc(96)),
    trak({ handler: 'vide', entry: 'avc1', sizes: [100, 100], offsets: [at, at + 100], perChunk: 1 }),
    trak({ handler: 'meta', entry: 'gpmd', sizes: [gps.length, gps.length], offsets: [at + 200], perChunk: 2 }),
    mvex ? box('mvex', full('trex', Buffer.alloc(20))) : Buffer.alloc(0));
  return { bytes: Buffer.concat([ftyp, mdat, moov]), videoAt: at, gpsAt: at + 200, gpsLen: gps.length };
}

test('code review v0.3: a GoPro gpmd track loses its samples and its trak; video samples and offsets stay', async () => {
  const f = goproLike();
  assert.ok(has(f.bytes, 'GPS5'));
  const { blob, removed, location } = await stripMp4(new Blob([f.bytes], { type: 'video/mp4' }));
  const after = await bytesOf(blob);
  assert.equal(after.length, f.bytes.length, 'nothing moves');
  assert.ok(!has(after, 'GPS5') && !has(after, '+48.8584'), 'no GPS sample left');
  assert.ok(after.subarray(f.gpsAt, f.gpsAt + 2 * f.gpsLen).every((x) => x === 0), 'the samples are zeroed in mdat');
  assert.ok(after.subarray(f.videoAt, f.videoAt + 200).every((x) => x === 0x11), 'the video samples are intact');
  assert.ok(removed.includes('moov/trak(gpmd)'), JSON.stringify(removed));
  assert.equal(location, true);
  const paths = await boxPaths(blob);
  assert.equal(paths.filter((p) => p === 'moov/trak').length, 1, 'one trak left, the metadata one is a free box');
  assert.ok(paths.includes('moov/free'));
  // Subtitle tracks (drone telemetry) go the same way.
  const sub = goproLike();
  const s = Buffer.from(sub.bytes);
  const i = s.indexOf(Buffer.from('gpmd', 'latin1'));
  s.write('tx3g', i, 'latin1');
  s.write('sbtl', s.indexOf(Buffer.from('meta', 'latin1'), s.indexOf(Buffer.from('hdlr', 'latin1'), s.indexOf(Buffer.from('moov', 'latin1')) + 200)), 'latin1');
  const r2 = await stripMp4(new Blob([s]));
  assert.ok(!has(await bytesOf(r2.blob), 'GPS5'));
  assert.ok(r2.removed.includes('moov/trak(tx3g)'));
  // A fragmented file with such a track cannot be followed: E_MEDIA_STRIP (public refused, private asks first).
  await assert.rejects(stripMp4(new Blob([goproLike({ mvex: true }).bytes])), (e) => e.code === 'E_MEDIA_STRIP');
});

test('code review v0.3: metadata removal falls back to createImageBitmap without options, then an <img>, before "Upload anyway"', async () => {
  const { stripImage } = await import('../../src/media/strip.js');
  const exif = new Blob([Buffer.concat([Buffer.from([0xff, 0xd8]), exifGpsSegment(), Buffer.from([0xff, 0xd9])])], { type: 'image/jpeg' });
  assert.equal(jpegHasExif(await bytesOf(exif)), true);
  const clean = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const drawn = [];
  const makeCanvas = (w, h) => ({ getContext: () => ({ drawImage: (src) => drawn.push({ src, w, h }) }), convertToBlob: async ({ type }) => new Blob([clean], { type }) });
  const URLs = { createObjectURL: () => 'blob:test/1', revokeObjectURL() {} };
  // 1. An engine that refuses the 'from-image' member with a WebIDL TypeError but decodes without options.
  const calls = [];
  const cib = async (blob, opts) => {
    calls.push(opts);
    if (opts) throw new TypeError("The provided value 'from-image' is not a valid enum value of type ImageOrientation.");
    return { width: 40, height: 30, close() {} };
  };
  const r1 = await stripImage(exif, { createImageBitmap: cib, makeCanvas });
  assert.equal(calls.length, 2);
  assert.equal(jpegHasExif(await bytesOf(r1.blob)), false);
  assert.deepEqual([r1.w, r1.h], [40, 30]);
  // 2. createImageBitmap refuses the picture: an <img> from a blob: URL decodes it (the engine applies the orientation).
  class Img {
    set src(u) {
      this.u = u;
      this.naturalWidth = 300;
      this.naturalHeight = 400;
      setTimeout(() => this.onload(), 1);
    }
  }
  const r2 = await stripImage(exif, { createImageBitmap: async () => { throw new TypeError('no'); }, Image: Img, URL: URLs, makeCanvas });
  assert.equal(jpegHasExif(await bytesOf(r2.blob)), false);
  assert.deepEqual([r2.w, r2.h], [300, 400]);
  assert.ok(drawn[drawn.length - 1].src instanceof Img, 'drawn from the <img>');
  // 3. Over the 24-megapixel cap, and 4. every decoder failing: E_MEDIA_STRIP, and only then.
  class Huge {
    set src(u) {
      this.naturalWidth = 6000;
      this.naturalHeight = 5000;
      setTimeout(() => this.onload(), 1);
    }
  }
  class Broken {
    set src(u) {
      setTimeout(() => this.onerror(), 1);
    }
  }
  for (const Image of [Huge, Broken]) {
    await assert.rejects(stripImage(exif, { createImageBitmap: async () => { throw new Error('x'); }, Image, URL: URLs, makeCanvas }), (e) => e.code === 'E_MEDIA_STRIP');
  }
});

test('code review v0.3: a video poster plays the muted inline video (iOS loads nothing for one that does not play)', async () => {
  const { makePoster, VIDEO_TIMEOUT_MS } = await import('../../src/media/poster.js');
  assert.ok(VIDEO_TIMEOUT_MS < 15000, 'a shorter wait');
  const listeners = new Map();
  const state = { played: false, paused: false };
  const video = {
    duration: 4, videoWidth: 320, videoHeight: 180, t: 0,
    setAttribute() {}, removeAttribute() {}, load() {},
    addEventListener(n, fn) {
      if (!listeners.has(n)) listeners.set(n, new Set());
      listeners.get(n).add(fn);
    },
    removeEventListener(n, fn) {
      if (listeners.has(n)) listeners.get(n).delete(fn);
    },
    fire(n) {
      for (const fn of Array.from(listeners.get(n) || [])) fn();
    },
    set src(v) { this.s = v; }, // preload alone loads nothing, as WebKit on iOS
    play() {
      state.played = true;
      setTimeout(() => this.fire('loadeddata'), 5);
      return Promise.resolve();
    },
    pause() { state.paused = true; },
    set currentTime(v) {
      this.t = v;
      setTimeout(() => this.fire('seeked'), 1);
    },
    get currentTime() { return this.t; },
  };
  const env = {
    document: { createElement: () => video },
    URL: { createObjectURL: () => 'blob:test/v', revokeObjectURL() {} },
    makeCanvas: () => ({ getContext: () => ({ drawImage() {} }), convertToBlob: async ({ type }) => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }) }),
    timeoutMs: 1000,
  };
  const p = await makePoster(new Blob([new Uint8Array(64)]), { kind: 'video', mime: 'video/mp4' }, env);
  assert.equal(state.played, true);
  assert.equal(state.paused, true);
  assert.equal(p.mime, 'image/jpeg');
  assert.ok(p.blob && p.blob.size > 0);
  assert.deepEqual([p.w, p.h, p.duration], [320, 180, 4]);
  assert.equal(video.t, 0.4, 'seeked to a tenth of the duration');
});

test('integrator (Firefox F:E-MD-1): a seek that never ends makes the poster from a flat copy of the bytes, once', async () => {
  const { makePoster } = await import('../../src/media/poster.js');
  const made = [];
  const makeVideo = () => {
    const listeners = new Map();
    const v = {
      duration: 4, videoWidth: 320, videoHeight: 180, readyState: 4, t: 0, s: '',
      setAttribute() {}, removeAttribute() {}, load() {},
      addEventListener(n, fn) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(fn); },
      removeEventListener(n, fn) { if (listeners.has(n)) listeners.get(n).delete(fn); },
      fire(n) { for (const fn of Array.from(listeners.get(n) || [])) fn(); },
      set src(u) { this.s = u; },
      play() { setTimeout(() => this.fire('loadeddata'), 1); return Promise.resolve(); },
      pause() {},
      set currentTime(x) { this.t = x; if (this.s === 'blob:flat') setTimeout(() => this.fire('seeked'), 1); }, // the parted blob never seeks
      get currentTime() { return this.t; },
    };
    made.push(v);
    return v;
  };
  const parted = new Blob([new Uint8Array(32), new Blob([new Uint8Array(32)])], { type: 'video/mp4' });
  const urls = [];
  const env = {
    document: { createElement: makeVideo },
    URL: { createObjectURL: (b) => { const u = b === parted ? 'blob:parted' : 'blob:flat'; urls.push(u); return u; }, revokeObjectURL() {} },
    makeCanvas: () => ({ getContext: () => ({ drawImage() {} }), convertToBlob: async ({ type }) => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }) }),
    timeoutMs: 200,
  };
  const p = await makePoster(parted, { kind: 'video', mime: 'video/mp4' }, env);
  assert.deepEqual(urls, ['blob:parted', 'blob:flat'], 'one retry, from a flat copy');
  assert.equal(p.mime, 'image/jpeg');
  assert.equal(made[1].t, 0.4, 'the retry seeks to a tenth of the duration');
});
