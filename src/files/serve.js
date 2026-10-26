// src/files/serve.js: response headers for shared files and private media (R 2.8.5, 2.9.6; MF-48;
// ARCHITECTURE 15.7). Pure; used by the Service Worker routes (src/sw/media-route.js) and by the
// Blob fallback of the lanes. Never consults the site extension map (src/sw/lib.js mimeFor): the type
// of a file download is always application/octet-stream, and the type of a media answer comes from
// the sniffed allow-list only.
//
//   contentDisposition(name) -> "attachment; filename*=UTF-8''<percent-encoded safe name>"
//   fileHeaders({ name, size, range }) -> plain object of headers for GET /_mw/f/<ref>
//   mediaHeaders({ mime, size, range }) -> plain object of headers for GET /_mw/media/<sid>
//   contentRange(range, size) / unsatisfiedRange(size)
//   OCTET, MEDIA_TYPES, ROUTE_CSP

import { cleanName } from './names.js';

export const OCTET = 'application/octet-stream';
export const ROUTE_CSP = "sandbox; default-src 'none'";
/** Media answers carry one of these types, never anything taken from a name or a manifest without checking. */
export const MEDIA_TYPES = Object.freeze(['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// RFC 8187 attr-char: ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
const ATTR_CHAR = /[A-Za-z0-9!#$&+.^_`|~-]/;

function rfc8187(s) {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = String.fromCharCode(bytes[i]);
    if (bytes[i] < 0x80 && ATTR_CHAR.test(c)) out += c;
    else out += '%' + (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16).toUpperCase();
  }
  return out;
}

/** contentDisposition(name) -> the attachment header with a cleaned, percent-encoded UTF-8 file name. */
export function contentDisposition(name) {
  const clean = cleanName(name) || 'file';
  return "attachment; filename*=UTF-8''" + rfc8187(clean);
}

/** contentRange({ start, end }, size) -> 'bytes start-end/size' */
export function contentRange(range, size) {
  return 'bytes ' + range.start + '-' + range.end + '/' + size;
}

/** unsatisfiedRange(size) -> 'bytes * /size' (without the space) for a 416 answer */
export function unsatisfiedRange(size) {
  return 'bytes */' + size;
}

function common(h) {
  h['X-Content-Type-Options'] = 'nosniff';
  h['Content-Security-Policy'] = ROUTE_CSP;
  h['Cross-Origin-Resource-Policy'] = 'same-origin';
  h['Cache-Control'] = 'no-store';
  h['Accept-Ranges'] = 'bytes';
  h['Referrer-Policy'] = 'no-referrer';
  return h;
}

/**
 * fileHeaders({ name, size, range }) -> headers for a file download. range: null for the whole body,
 * { start, end } for a 206. Content-Type is always application/octet-stream.
 */
export function fileHeaders({ name, size, range = null }) {
  const h = common({ 'Content-Type': OCTET, 'Content-Disposition': contentDisposition(name) });
  if (range) {
    h['Content-Range'] = contentRange(range, size);
    h['Content-Length'] = String(range.end - range.start + 1);
  } else if (Number.isSafeInteger(size)) {
    h['Content-Length'] = String(size);
  }
  return h;
}

/** mediaHeaders({ mime, size, range }) -> headers for a media answer; a type outside MEDIA_TYPES becomes octet-stream. */
export function mediaHeaders({ mime, size, range = null }) {
  const type = MEDIA_TYPES.indexOf(mime) >= 0 ? mime : OCTET;
  const h = common({ 'Content-Type': type });
  if (range) {
    h['Content-Range'] = contentRange(range, size);
    h['Content-Length'] = String(range.end - range.start + 1);
  } else if (Number.isSafeInteger(size)) {
    h['Content-Length'] = String(size);
  }
  return h;
}
