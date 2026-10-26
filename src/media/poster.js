// src/media/poster.js: the poster or thumbnail, made on the device (R 2.9.3 step 4; ARCHITECTURE 15.7).
// containerInfo() and the arithmetic are pure (Node 22); makePoster() needs a browser and runs in the
// loader, never in site code.
//
// Images are resized to at most 640 px on the longest side and re-encoded (src/media/strip.js). Videos
// are loaded into an off-screen, muted, inline <video> in the loader and played (iOS loads media data only for
// an element that plays), paused at the first frame, seeked to the smaller of 1 s and a tenth of the
// duration, drawn to a canvas and encoded as JPEG; without a frame the item keeps the container's size and
// says "No preview" (makePoster returns blob: null). Duration, width and height come from the container
// (mvhd and tkhd for MP4 and MOV, Info and Tracks for WebM). The poster is encrypted into the same
// torrent as the media; nothing about it is in the clear.
//
//   POSTER_MAX = 640
//   posterTime(duration) -> seconds
//   containerInfo(blob, mime) -> { duration, w, h } | null
//   makePoster(blob, sniffed, env?) -> { blob, mime, w, h, duration? }

import { mp4Info } from './faststart.js';
import { webmInfo, stripImage } from './strip.js';
import { canvasBlob, makeCanvas, fitWithin } from '../files/preview.js';

export const POSTER_MAX = 640;
export const VIDEO_TIMEOUT_MS = 8000;
// Firefox 157 plays a Blob made of parts (the stripped and fast-started upload: new Blob([moov, file.slice(...)])) but never
// finishes a seek in it; a flat copy of the same bytes seeks at once (integrator, docs/deviations/review-round-integration.md,
// lane Firefox F:E-MD-1). A seek gets SEEK_TIMEOUT_MS, then the poster is made again from a flat copy when the item is at
// most FLAT_RETRY_MAX bytes, or from the frame already decoded.
export const SEEK_TIMEOUT_MS = 3000;
export const FLAT_RETRY_MAX = 128 * 1024 * 1024;
export const NO_PREVIEW_TEXT = 'No preview';

/** posterTime(duration) -> min(1 s, duration / 10); 0 for an unknown duration. */
export function posterTime(duration) {
  if (!(typeof duration === 'number' && Number.isFinite(duration) && duration > 0)) return 0;
  return Math.min(1, duration / 10);
}

/** containerInfo(blob, mime) -> { duration, w, h } read from the container, or null. */
export async function containerInfo(blob, mime) {
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    const i = await mp4Info(blob);
    return i ? { duration: i.duration, w: i.w, h: i.h } : null;
  }
  if (mime === 'video/webm') return webmInfo(blob);
  return null;
}

function posterError(message) {
  const err = new Error(message);
  err.code = 'E_MEDIA_UNPLAYABLE';
  return err;
}

function once(target, name, timeoutMs, setTimeoutFn, clearTimeoutFn = (h) => clearTimeout(h)) {
  return new Promise((resolve, reject) => {
    const timer = setTimeoutFn(() => {
      cleanup();
      reject(posterError('the video did not load in time'));
    }, timeoutMs);
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(posterError('this video format does not play in this browser'));
    };
    function cleanup() {
      clearTimeoutFn(timer);
      target.removeEventListener(name, ok);
      target.removeEventListener('error', fail);
    }
    target.addEventListener(name, ok);
    target.addEventListener('error', fail);
  });
}

/**
 * The first frame of a video that plays: 'loadeddata', 'playing' or a requestVideoFrameCallback frame, whichever
 * comes first. WebKit on iOS loads media data only for an element that plays (preload does not start it), so the
 * caller plays the muted inline video (code review v0.3).
 */
function firstFrame(video, timeoutMs, setT, clearT) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearT(timer);
      video.removeEventListener('loadeddata', ok);
      video.removeEventListener('playing', ok);
      video.removeEventListener('error', fail);
      if (err) reject(err);
      else resolve();
    };
    const ok = () => finish(null);
    const fail = () => finish(posterError('this video format does not play in this browser'));
    timer = setT(() => finish(posterError('the video did not load in time')), timeoutMs);
    video.addEventListener('loadeddata', ok);
    video.addEventListener('playing', ok);
    video.addEventListener('error', fail);
    if (typeof video.requestVideoFrameCallback === 'function') {
      try {
        video.requestVideoFrameCallback(() => finish(null));
      } catch (_) { /* the events above still come */ }
    }
  });
}

/**
 * videoPoster(blob, { document, URL, timeoutMs, setTimeout, clearTimeout }) -> { blob, mime, w, h, duration }.
 * Browser only: an off-screen, muted, inline <video> that is never attached to the page. It is played (a muted
 * inline video may play without a gesture), paused at its first frame, seeked to posterTime() and drawn.
 */
export async function videoPoster(blob, env = {}) {
  try {
    return await videoPosterOnce(blob, env, true);
  } catch (err) {
    if (!err || !err.seekStuck) throw err;
    const flat = new Blob([await blob.arrayBuffer()], { type: blob.type || '' });
    return videoPosterOnce(flat, env, false);
  }
}

async function videoPosterOnce(blob, env, mayRetry) {
  const doc = env.document || globalThis.document;
  const urlApi = env.URL || globalThis.URL;
  const timeoutMs = env.timeoutMs || VIDEO_TIMEOUT_MS;
  const setT = env.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = env.clearTimeout || ((h) => clearTimeout(h));
  const video = doc.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
  } catch (_) { /* properties are enough where attributes are not there */ }
  const url = urlApi.createObjectURL(blob);
  let played = false;
  try {
    const ready = firstFrame(video, timeoutMs, setT, clearT);
    video.src = url;
    try {
      const p = video.play();
      played = true;
      if (p && typeof p.catch === 'function') p.catch(() => {}); // refused: 'loadeddata' may still come
    } catch (_) { /* no play(): wait for 'loadeddata' */ }
    await ready;
    if (played && typeof video.pause === 'function') {
      try {
        video.pause();
      } catch (_) { /* already paused */ }
    }
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const at = posterTime(duration);
    if (at > 0) {
      const seeked = once(video, 'seeked', Math.min(timeoutMs, SEEK_TIMEOUT_MS), setT, clearT);
      video.currentTime = at;
      try {
        await seeked;
      } catch (err) {
        const flatOk = mayRetry && typeof blob.arrayBuffer === 'function' && blob.size <= FLAT_RETRY_MAX;
        if (flatOk) throw Object.assign(err, { seekStuck: true });
        if (!(video.videoWidth && video.videoHeight && video.readyState >= 2)) throw err;
        // no seek: the frame already decoded is the poster
      }
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw posterError('the video has no picture');
    const size = fitWithin(w, h, POSTER_MAX);
    const canvas = (env.makeCanvas || makeCanvas)(size.w, size.h);
    canvas.getContext('2d').drawImage(video, 0, 0, size.w, size.h);
    const out = await canvasBlob(canvas, 'image/jpeg', 0.8);
    return { blob: out, mime: 'image/jpeg', w, h, duration };
  } finally {
    try {
      video.removeAttribute('src');
      video.load();
    } catch (_) { /* nothing to release */ }
    urlApi.revokeObjectURL(url);
  }
}

/**
 * makePoster(blob, sniffed, env?) -> { blob, mime, w, h, duration? }: w and h are the item's own
 * dimensions (the container's where it states them); the poster is at most 640 px on its longest side.
 */
export async function makePoster(blob, sniffed, env = {}) {
  if (sniffed.kind === 'image') {
    const full = await stripImage(blob, { createImageBitmap: env.createImageBitmap, makeCanvas: env.makeCanvas });
    const small = await stripImage(full.blob, { maxSide: POSTER_MAX, type: 'image/jpeg', quality: 0.8, createImageBitmap: env.createImageBitmap, makeCanvas: env.makeCanvas });
    return { blob: small.blob, mime: small.mime, w: full.w, h: full.h };
  }
  const info = await containerInfo(blob, sniffed.mime);
  let p;
  try {
    p = await videoPoster(blob, env);
  } catch (err) {
    // No frame on this device: the item keeps the container's size and duration and says "No preview".
    if (!info || !info.w || !info.h) throw err;
    return { blob: null, mime: '', w: info.w, h: info.h, duration: info.duration, note: NO_PREVIEW_TEXT };
  }
  return {
    blob: p.blob,
    mime: p.mime,
    w: (info && info.w) || p.w,
    h: (info && info.h) || p.h,
    duration: (info && info.duration) || p.duration,
  };
}
