// Unit tests for src/media/faststart.js (R 2.9.3 step 3; U-MD-4): an MP4 whose moov sits after mdat is
// rewritten with moov first, and every sample of every track still starts where its tables say (the
// bytes of each sample, located through stsc, stsz and stco/co64, are identical before and after).
// Fixtures from test/fixtures/media/make-fixtures.mjs (ffmpeg) in a temporary directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { faststart, readTopBoxes, parseBoxes, walk, chunkOffsetTables, shiftChunkOffsets, mp4Info } from '../../src/media/faststart.js';
import { stripMp4 } from '../../src/media/strip.js';
import { makeFixtures, hasFfmpeg } from '../fixtures/media/make-fixtures.mjs';

const FF = hasFfmpeg();
let dir = null;
let fx = null;
async function fixtures() {
  if (!fx) {
    dir = mkdtempSync(join(tmpdir(), 'mw-faststart-'));
    fx = await makeFixtures(dir, { only: ['moovAtEnd', 'udtaLocation'] });
  }
  return fx;
}
test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const be32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;

/** samples(fileBytes) -> per track, the list of [offset, size] of every sample. */
async function samples(u8) {
  const blob = new Blob([u8]);
  const top = await readTopBoxes(blob);
  const mb = top.find((b) => b.type === 'moov');
  const moov = u8.subarray(mb.start, mb.start + mb.size);
  const tree = parseBoxes(moov, 0, moov.length);
  const tracks = [];
  walk(tree, (b) => {
    if (b.type !== 'stbl') return;
    const find = (t) => b.children.find((c) => c.type === t);
    const body = (x) => x.start + x.header;
    const stsz = find('stsz');
    const stsc = find('stsc');
    const co = find('stco') || find('co64');
    const fixed = be32(moov, body(stsz) + 4);
    const n = be32(moov, body(stsz) + 8);
    const sizes = [];
    for (let i = 0; i < n; i++) sizes.push(fixed || be32(moov, body(stsz) + 12 + 4 * i));
    const chunks = [];
    const cn = be32(moov, body(co) + 4);
    for (let i = 0; i < cn; i++) {
      chunks.push(co.type === 'stco' ? be32(moov, body(co) + 8 + 4 * i) : be32(moov, body(co) + 8 + 8 * i) * 4294967296 + be32(moov, body(co) + 12 + 8 * i));
    }
    const runs = [];
    const rn = be32(moov, body(stsc) + 4);
    for (let i = 0; i < rn; i++) runs.push({ first: be32(moov, body(stsc) + 8 + 12 * i), per: be32(moov, body(stsc) + 12 + 12 * i) });
    const out = [];
    let s = 0;
    for (let c = 0; c < chunks.length; c++) {
      let per = 0;
      for (const r of runs) if (r.first <= c + 1) per = r.per;
      let off = chunks[c];
      for (let k = 0; k < per && s < sizes.length; k++, s++) {
        out.push([off, sizes[s]]);
        off += sizes[s];
      }
    }
    assert.equal(out.length, sizes.length, 'every sample is in a chunk');
    tracks.push(out);
  });
  return tracks;
}

function sampleHashes(u8, tracks) {
  return tracks.map((list) => list.map(([o, n]) => createHash('sha1').update(u8.subarray(o, o + n)).digest('hex')));
}

function framemd5(path) {
  try {
    return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0', '-c', 'copy', '-f', 'framemd5', '-'], { encoding: 'utf8' })
      .split('\n').filter((l) => l && !l.startsWith('#')).join('\n');
  } catch (err) {
    return 'ERROR ' + err.message;
  }
}

test('U-MD-4 faststart: moov moves before mdat and every sample offset stays correct', { skip: !FF && 'ffmpeg not on PATH' }, async () => {
  const f = await fixtures();
  const before = new Uint8Array(readFileSync(f.moovAtEnd));
  const order = (await readTopBoxes(new Blob([before]))).map((b) => b.type);
  assert.ok(order.indexOf('moov') > order.indexOf('mdat'), 'the fixture has moov at the end');
  const { blob, moved } = await faststart(new Blob([before], { type: 'video/mp4' }));
  assert.equal(moved, true);
  const after = new Uint8Array(await blob.arrayBuffer());
  assert.equal(after.length, before.length);
  const order2 = (await readTopBoxes(blob)).map((b) => b.type);
  assert.ok(order2.indexOf('moov') < order2.indexOf('mdat'), 'moov first');
  const s1 = await samples(before);
  const s2 = await samples(after);
  assert.equal(s1.length, 2, 'video and audio tracks');
  assert.deepEqual(sampleHashes(after, s2), sampleHashes(before, s1), 'every sample has the same bytes at its new offset');
  assert.notDeepEqual(s2, s1, 'the offsets did move');
  const out = join(dir, 'fast.mp4');
  writeFileSync(out, after);
  assert.equal(framemd5(out), framemd5(f.moovAtEnd), 'ffmpeg reads the same packets');
  const info = await mp4Info(blob);
  assert.equal(info.w, 160);
  assert.ok(Math.abs(info.duration - 2) < 0.05);
});

test('faststart after stripping: the location fixture plays from the front without its udta', { skip: !FF && 'ffmpeg not on PATH' }, async () => {
  const f = await fixtures();
  const stripped = await stripMp4(new Blob([readFileSync(f.udtaLocation)], { type: 'video/mp4' }));
  const { blob, moved } = await faststart(stripped.blob);
  assert.equal(moved, true);
  const u8 = new Uint8Array(await blob.arrayBuffer());
  assert.equal(Buffer.from(u8).indexOf('+48.8584'), -1);
  const out = join(dir, 'fast-stripped.mp4');
  writeFileSync(out, u8);
  assert.equal(framemd5(out), framemd5(f.udtaLocation));
});

test('faststart leaves a moov-first file, a fragmented file and garbage alone (moved: false)', async () => {
  const ftyp = [0, 0, 0, 16, ...Buffer.from('ftypisom'), 0, 0, 2, 0];
  const moov = [0, 0, 0, 8, ...Buffer.from('moov')];
  const mdat = [0, 0, 0, 12, ...Buffer.from('mdat'), 1, 2, 3, 4];
  const first = new Blob([new Uint8Array([...ftyp, ...moov, ...mdat])]);
  assert.equal((await faststart(first)).moved, false);
  const moof = [0, 0, 0, 8, ...Buffer.from('moof')];
  assert.equal((await faststart(new Blob([new Uint8Array([...ftyp, ...mdat, ...moof, ...moov])]))).moved, false);
  const junk = new Blob([new Uint8Array([9, 9, 9])]);
  const r = await faststart(junk);
  assert.equal(r.moved, false);
  assert.equal(r.blob, junk);
});

test('shiftChunkOffsets: stco and co64 entries follow their box; an offset outside every box is refused', () => {
  // moov { trak { mdia { minf { stbl { stco [20], co64 [24] } } } } }
  const stco = [0, 0, 0, 20, ...Buffer.from('stco'), 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 20];
  const co64 = [0, 0, 0, 24, ...Buffer.from('co64'), 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 24];
  const wrap = (t, body) => [0, 0, 0, 8 + body.length, ...Buffer.from(t), ...body];
  const moov = new Uint8Array(wrap('moov', wrap('trak', wrap('mdia', wrap('minf', wrap('stbl', [...stco, ...co64]))))));
  assert.equal(chunkOffsetTables(moov).length, 2);
  const oldBoxes = [{ start: 0, size: 16 }, { start: 16, size: 100 }, { start: 116, size: moov.length }];
  const newStart = new Map([[0, 0], [16, 16 + moov.length], [116, 16]]);
  shiftChunkOffsets(moov, oldBoxes, newStart);
  const tables = chunkOffsetTables(moov);
  assert.equal(be32(moov, tables[0].at), 20 + moov.length);
  assert.equal(be32(moov, tables[1].at + 4), 24 + moov.length);
  const bad = new Uint8Array(wrap('moov', wrap('trak', wrap('mdia', wrap('minf', wrap('stbl', [0, 0, 0, 20, ...Buffer.from('stco'), 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 9, 0]))))));
  assert.throws(() => shiftChunkOffsets(bad, oldBoxes, newStart), (e) => e.code === 'E_MEDIA_STRIP');
});
