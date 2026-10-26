// src/files/names.js: file names shown and saved (R 2.8.2 step 3, 2.8.5; MF-51, MF-57; PEER B10,
// STALK A8). Pure; Node 22, browsers and workers.
//
// A shared name is data from a stranger: control and bidi characters are stripped (a right-to-left
// override turns "invoice_txt.exe" into "invoice_exe.txt" on screen), the result is NFC, path and
// reserved characters become "_", and the extension is shown last and separately, next to the type
// the bytes have. Uploads get a random display name by default ("photo-7f3k.jpg").
//
//   cleanName(name, { max = 96 }) -> string ('' when nothing is left)
//   splitName(name) -> { base, ext }                     ext lowercase, without the dot
//   displayParts(name, sniffed) -> { base, ext, claimed, sniffedExt, sniffedMime, mismatch }
//   randomName(kind, ext, random?) -> 'photo-7f3k.jpg'
//   downloadName(name, sniffed) -> a cleaned name that never ends in an extension the bytes contradict

export const MAX_NAME = 96;

// C0 and C1 controls, DEL, bidi embeddings, overrides and isolates (U+202A-202E, U+2066-2069), the
// marks U+200E, U+200F, U+061C, zero-width characters and BOM, line and paragraph separators.
const STRIP = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff\\ufff9-\\ufffb]', 'g');
// Review round (MAL53-12): the rest of Unicode's Default_Ignorable_Code_Point set (soft hyphen, combining grapheme joiner,
// Hangul fillers, Khmer vowel inherents, Mongolian selectors, variation selectors, tag characters) and the blanks that
// render as nothing (Braille pattern blank U+2800): a run of them pushes the real extension out of a label.
const IGNORABLE = /[\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\ufff0-\ufff8\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;
// Windows device names: "CON.txt" or "nul" cannot be saved as such (and some tools open the device instead).
const DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i;
const RESERVED = /[/\\:*?"<>|]/g;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function codePoints(s) {
  return Array.from(s);
}

/** cleanName(name, { max }) -> the name without control, bidi or path characters, NFC, at most max code points. */
export function cleanName(name, { max = MAX_NAME } = {}) {
  if (typeof name !== 'string') return '';
  let s = name.normalize('NFC').replace(STRIP, '').replace(IGNORABLE, '').replace(RESERVED, '_');
  s = s.replace(/\s+/g, ' ').trim();
  while (s.charAt(0) === '.') s = s.slice(1); // no hidden files, never '.' or '..'
  s = s.replace(/[. ]+$/, ''); // Windows drops trailing dots and spaces: "setup.exe." is saved as setup.exe
  s = s.trim();
  if (DEVICE.test(s)) s = '_' + s;
  const cps = codePoints(s);
  if (cps.length > max) {
    const { ext } = splitName(s);
    const keep = ext && ext.length < 16 ? ext.length + 1 : 0;
    s = cps.slice(0, max - keep).join('').trim() + (keep ? '.' + ext : '');
  }
  return s.normalize('NFC').replace(/[. ]+$/, '');
}

/** splitName(name) -> { base, ext }: ext is the lowercase text after the last dot of a non-leading position. */
export function splitName(name) {
  const s = typeof name === 'string' ? name : '';
  const dot = s.lastIndexOf('.');
  if (dot <= 0 || dot === s.length - 1) return { base: s, ext: '' };
  const ext = s.slice(dot + 1);
  if (!/^[A-Za-z0-9]{1,15}$/.test(ext)) return { base: s, ext: '' };
  return { base: s.slice(0, dot), ext: ext.toLowerCase() };
}

const SAME_EXT = { tif: ['tif', 'tiff', 'dng', 'nef', 'cr2', 'arw', 'pef', 'srw', 'nrw', 'iiq', '3fr', 'erf', 'mos', 'kdc', 'dcr'], raw: ['orf', 'rw2', 'raf', 'crw', 'raw', 'rwl'], jpg: ['jpg', 'jpeg', 'jpe', 'jfif'], mp4: ['mp4', 'm4v'], mov: ['mov', 'qt'], txt: ['txt', 'text', 'md', 'csv', 'log', 'json'], html: ['html', 'htm', 'xhtml'], doc: ['doc', 'xls', 'ppt', 'msi', 'msg'], zip: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'jar', 'epub'], exe: ['exe', 'dll', 'scr', 'com', 'sys'], sh: ['sh', 'bash', 'zsh', 'py', 'pl', 'rb', 'command'], bat: ['bat', 'cmd', 'ps1', 'vbs'], heic: ['heic', 'heif'], gz: ['gz', 'tgz'], macho: ['dylib', 'bundle', 'app', ''], elf: ['', 'so', 'bin', 'run'] };

/** sameType(claimedExt, sniffedExt) -> true when the claimed extension agrees with the sniffed type. */
export function sameType(claimed, sniffedExt) {
  if (!sniffedExt || sniffedExt === 'bin') return true;
  if (claimed === sniffedExt) return true;
  const list = SAME_EXT[sniffedExt];
  return Boolean(list && list.indexOf(claimed) >= 0);
}

/**
 * displayParts(name, sniffed) -> { base, ext, claimed, sniffedExt, sniffedMime, mismatch }: what the
 * loader shows (the base, then the extension last and separately, then the sniffed type).
 */
export function displayParts(name, sniffed) {
  const clean = cleanName(name);
  const { base, ext } = splitName(clean);
  const sniffedExt = sniffed && sniffed.ext ? sniffed.ext : '';
  return {
    base,
    ext,
    claimed: clean,
    sniffedExt,
    sniffedMime: sniffed && sniffed.mime ? sniffed.mime : 'application/octet-stream',
    mismatch: !sameType(ext, sniffedExt),
  };
}

function randomChars(n, random) {
  const bytes = typeof random === 'function' ? random(n) : globalThis.crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < n; i++) s += BASE32[bytes[i] & 31];
  return s;
}

const PREFIX = { image: 'photo', video: 'video', audio: 'audio', text: 'note' };

/** randomName(kind, ext, random?) -> e.g. 'photo-7f3k.jpg' (4 random base32 characters). */
export function randomName(kind, ext, random) {
  const prefix = PREFIX[kind] || 'file';
  const e = typeof ext === 'string' && /^[a-z0-9]{1,15}$/.test(ext) ? '.' + ext : '';
  return prefix + '-' + randomChars(4, random) + e;
}

/**
 * downloadName(name, sniffed) -> a cleaned name for Content-Disposition and a[download]. When the
 * claimed extension contradicts the bytes, the sniffed extension is appended, so a renamed
 * executable is never saved as "photo.jpg".
 */
export function downloadName(name, sniffed) {
  const p = displayParts(name, sniffed);
  let out = p.claimed || 'file';
  if (p.mismatch && p.sniffedExt) out = cleanName(out + '.' + p.sniffedExt);
  return out || 'file';
}
