// src/files/preview.js: the only render path for shared files (R 2.8.5, MF-48, MF-51; DS F17, PEER B10).
// The planning half is pure (Node 22, browsers, workers); render() needs a browser.
//
// A preview runs in the loader and accepts only PNG, JPEG, GIF (first frame), WebP and plain UTF-8
// text, sniffed from the bytes. Dimensions are read from the header before anything is decoded and a
// picture above 24 megapixels (chosen) is refused, so a decode bomb never reaches the decoder. SVG,
// PDF and HTML never preview. The decoded picture is drawn at a bounded size and re-encoded by the
// loader, so the URL a site gets points at bytes the loader made, never at the shared bytes.
//
//   PIXEL_CAP, TEXT_PREVIEW_BYTES
//   imageSize(bytes, mime) -> { w, h } | null                PNG, GIF (screen grown to the first frame), WebP, JPEG (SOFn)
//   previewPlan(bytes) -> { kind: 'image', mime, w, h, scale } | { kind: 'text' } | { kind: 'none', reason }
//   riskTier(sniffed, blockedTiers?) -> { tier: 'plain' | 'confirm' | 'blocked', kind, warning? }
//   render(blob, plan, { createImageBitmap?, makeCanvas?, maxSide = 1024 }) -> { kind, url?, text?, w?, h? }

import { sniff } from '../media/sniff.js';

export const PIXEL_CAP = 24000000;
export const TEXT_PREVIEW_BYTES = 65536;
export const PREVIEW_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const RISK_WARNING = 'This file could harm your device. felinar cannot check what it does.';
export const VERIFIED_TEXT = 'The bytes match what the sender listed. This does not mean the file is safe.';

const be16 = (u8, o) => (u8[o] << 8) | u8[o + 1];
const be32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
const le16 = (u8, o) => u8[o] | (u8[o + 1] << 8);
const le24 = (u8, o) => u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16);

function jpegSize(u8) {
  let o = 2;
  while (o + 9 < u8.length) {
    if (u8[o] !== 0xff) return null;
    const marker = u8[o + 1];
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    const len = be16(u8, o + 2);
    if (len < 2) return null;
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { w: be16(u8, o + 7), h: be16(u8, o + 5) };
    }
    if (marker === 0xda) return null; // scan data before a frame header
    o += 2 + len;
  }
  return null;
}

function webpSize(u8) {
  const chunk = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
  if (chunk === 'VP8 ' && u8.length >= 30) return { w: le16(u8, 26) & 0x3fff, h: le16(u8, 28) & 0x3fff };
  if (chunk === 'VP8L' && u8.length >= 25) {
    const b = u8.subarray(21, 25);
    const w = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    const h = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
    return { w, h };
  }
  if (chunk === 'VP8X' && u8.length >= 30) return { w: 1 + le24(u8, 24), h: 1 + le24(u8, 27) };
  return null;
}

/**
 * gifSize(u8) -> the size a decoder gives the first frame: Chromium and Gecko grow the logical screen to the first
 * frame's extent, so a GIF with a 1x1 screen and an 8000x8000 first frame decodes at 8000x8000 (review round,
 * MAL53-2). The blocks are walked to the first Image Descriptor (past the global colour table and every extension
 * block); null when it is not inside the given head.
 */
function gifSize(u8) {
  if (u8.length < 13) return null;
  const sw = le16(u8, 6);
  const sh = le16(u8, 8);
  let o = 13;
  if (u8[10] & 0x80) o += 3 * (1 << ((u8[10] & 7) + 1)); // global colour table
  for (let blocks = 0; o < u8.length && blocks < 4096; blocks++) {
    const b = u8[o];
    if (b === 0x2c) {
      if (o + 10 > u8.length) return null;
      const left = le16(u8, o + 1);
      const top = le16(u8, o + 3);
      const w = le16(u8, o + 5);
      const h = le16(u8, o + 7);
      return { w: Math.max(sw, left + w), h: Math.max(sh, top + h) };
    }
    if (b !== 0x21 || o + 2 > u8.length) return null; // a trailer (0x3b) or garbage before any frame
    o += 2; // extension introducer and label, then data sub-blocks up to a zero length
    for (;;) {
      if (o >= u8.length) return null;
      const n = u8[o];
      o += 1 + n;
      if (n === 0) break;
    }
  }
  return null;
}

/** imageSize(bytes, mime) -> { w, h } from the header only, or null when the header cannot be read. */
export function imageSize(bytes, mime) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (mime === 'image/png') {
    if (u8.length < 24 || String.fromCharCode(u8[12], u8[13], u8[14], u8[15]) !== 'IHDR') return null;
    return { w: be32(u8, 16), h: be32(u8, 20) };
  }
  if (mime === 'image/gif') return gifSize(u8);
  if (mime === 'image/webp') return webpSize(u8);
  if (mime === 'image/jpeg') return jpegSize(u8);
  return null;
}

function validUtf8(u8) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(u8);
    return true;
  } catch (_) {
    // a multi-byte sequence cut at the end of the window is still text
    for (let cut = 1; cut <= 3 && cut < u8.length; cut++) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(0, u8.length - cut));
        return true;
      } catch (__) { /* try a shorter prefix */ }
    }
    return false;
  }
}

/**
 * previewPlan(bytes) -> what a preview would show, decided from the leading bytes (pass at least the
 * first 64 KiB; JPEG frame headers can follow large EXIF segments).
 */
export function previewPlan(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const s = sniff(u8);
  if (s.kind === 'image') {
    if (PREVIEW_MIMES.indexOf(s.mime) < 0) return { kind: 'none', reason: 'format', mime: s.mime };
    const size = imageSize(u8, s.mime);
    if (!size || !size.w || !size.h) return { kind: 'none', reason: 'header', mime: s.mime };
    if (size.w * size.h > PIXEL_CAP) return { kind: 'none', reason: 'too-large', mime: s.mime, w: size.w, h: size.h };
    return { kind: 'image', mime: s.mime, w: size.w, h: size.h };
  }
  if (s.kind === 'text' && s.mime === 'text/plain') {
    return validUtf8(u8.subarray(0, TEXT_PREVIEW_BYTES)) ? { kind: 'text', mime: 'text/plain' } : { kind: 'none', reason: 'encoding', mime: s.mime };
  }
  return { kind: 'none', reason: 'format', mime: s.mime };
}

/**
 * Kinds that need the second confirmation besides the sniff tier (review round, MAL53-7): a binary no signature
 * names ('unknown': the ISO, DMG and vendor formats a 4 KiB window cannot tell), and documents that run code when
 * opened from the disk (HTML, SVG, XML, PDF). The tier is the owner-independent default; R 2.8.5's five kinds stay.
 */
export const CONFIRM_ALSO = Object.freeze(['unknown', 'html', 'svg', 'xml', 'pdf']);

/**
 * riskTier(sniffed, blockedTiers?) -> { tier, kind, warning? }. 'confirm' kinds (executables,
 * installers, scripts, macro documents, archives, and CONFIRM_ALSO) need a second confirmation with
 * RISK_WARNING; an owner may block kinds through _mw.cfg.files (blockedTiers, e.g. ['executable']).
 */
export function riskTier(sniffed, blockedTiers) {
  const kind = sniffed && sniffed.kind ? sniffed.kind : 'unknown';
  if (Array.isArray(blockedTiers) && blockedTiers.indexOf(kind) >= 0) return { tier: 'blocked', kind };
  if ((sniffed && sniffed.tier === 'confirm') || CONFIRM_ALSO.indexOf(kind) >= 0) return { tier: 'confirm', kind, warning: RISK_WARNING };
  return { tier: 'plain', kind };
}

/** fitWithin(w, h, max) -> { w, h } scaled down (never up) so the longer side is at most max. */
export function fitWithin(w, h, max) {
  const side = Math.max(w, h);
  if (side <= max) return { w, h };
  const k = max / side;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * render(blob, plan, opts) -> { kind: 'image', url, w, h } | { kind: 'text', text } | { kind: 'none' }.
 * Browser only. Images decode through createImageBitmap with resizeWidth/resizeHeight (the browser
 * decodes off the main thread) and are drawn to a canvas and re-encoded as PNG; text is returned as a
 * string for textContent, never as markup.
 */
export async function render(blob, plan, opts = {}) {
  if (!plan || plan.kind === 'none') return { kind: 'none' };
  if (plan.kind === 'text') {
    const head = new Uint8Array(await blob.slice(0, TEXT_PREVIEW_BYTES).arrayBuffer());
    return { kind: 'text', text: new TextDecoder('utf-8').decode(head) };
  }
  const cib = opts.createImageBitmap || globalThis.createImageBitmap;
  if (typeof cib !== 'function') return { kind: 'none' };
  const size = fitWithin(plan.w, plan.h, opts.maxSide || 1024);
  const typed = new Blob([blob], { type: plan.mime });
  const bitmap = await cib(typed, { resizeWidth: size.w, resizeHeight: size.h, resizeQuality: 'medium' });
  const canvas = opts.makeCanvas ? opts.makeCanvas(size.w, size.h) : makeCanvas(size.w, size.h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, size.w, size.h);
  if (typeof bitmap.close === 'function') bitmap.close();
  const out = await canvasBlob(canvas, 'image/png');
  const url = (opts.URL || globalThis.URL).createObjectURL(out);
  return { kind: 'image', url, w: size.w, h: size.h };
}

/** makeCanvas(w, h) -> an OffscreenCanvas where available, else a detached <canvas>. */
export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** canvasBlob(canvas, type, quality?) -> Blob from an OffscreenCanvas or a <canvas>. */
export function canvasBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas could not encode ' + type))), type, quality);
  });
}
