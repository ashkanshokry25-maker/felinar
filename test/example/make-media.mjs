#!/usr/bin/env node
// Regenerates examples/peer-guestbook/media/clip.mp4, the short MP4 that exercises HTTP Range from the loader's
// Service Worker (ARCHITECTURE section 11, DESIGN-REVIEW S11). The clip is committed, so this script is
// only needed to change it. It needs an ffmpeg build with libx264 on PATH (Homebrew's has it); nothing
// is installed by this repository. Output with ffmpeg 9.0.2 / x264 core 165 (2026-10-17):
//   18833 bytes, sha256 recorded in the test file, H.264 Constrained Baseline level 3.0, 320x180,
//   12 fps, 48 frames, 4.000 s, a keyframe every second, moov before mdat ("faststart"), no audio,
//   no SEI user data (so no encoder banner or URL inside the file).
// The picture is ffmpeg's built-in "testsrc" pattern, whose counter shows the current second, which
// makes a seek easy to check by eye on a phone.
//
// Usage: node test/example/make-media.mjs [--out <file>] [--check]
//   --check  verify the existing clip with ffprobe and a full decode instead of writing it.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'peer-guestbook');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx !== -1 ? resolve(argv[outIdx + 1]) : resolve(SITE, 'media/clip.mp4');

export const FFMPEG_ARGS = (out) => [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=12:duration=4',
  '-an',
  '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '3.0', '-preset', 'slow', '-refs', '3', '-crf', '32',
  '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-threads', '1',
  '-bsf:v', 'filter_units=remove_types=6',
  '-movflags', '+faststart', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
  out,
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw new Error(cmd + ' is not available: ' + r.error.message);
  if (r.status !== 0) throw new Error(cmd + ' failed (' + r.status + '): ' + r.stderr);
  return r.stdout;
}

function describe(file) {
  const bytes = readFileSync(file);
  const probe = run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_name,profile,level,width,height,nb_frames:format=duration', '-of', 'json', file]);
  run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']); // full decode, throws on any error
  return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), probe: JSON.parse(probe) };
}

if (import.meta.url === 'file://' + process.argv[1] || fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  if (!argv.includes('--check')) {
    mkdirSync(dirname(OUT), { recursive: true });
    run('ffmpeg', FFMPEG_ARGS(OUT));
  }
  console.log(JSON.stringify(describe(OUT), null, 2));
}
