// src/media/sniff.js: the type of uploaded or fetched bytes, from magic bytes only (R 2.8.2 step 1,
// 2.8.5 risk tiers, 2.9.2 formats, 2.9.3 step 1; MAL A4, A5). The declared name and type are never
// trusted. Pure; Node 22, browsers and workers.
//
//   sniff(bytes) -> { mime, ext, kind, tier, media, image, video }
//     kind: 'image' | 'video' | 'audio' | 'text' | 'html' | 'svg' | 'xml' | 'pdf' | 'document' |
//           'archive' | 'executable' | 'installer' | 'script' | 'macro' | 'unknown'
//     tier: 'confirm' for executables, installers, scripts, macro documents and archives (a second
//           confirmation before saving, R 2.8.5), else 'plain'
//     media: true for the private-media formats of R 2.9.2 (MP4, MOV as uploaded, WebM, JPEG, PNG,
//           WebP, GIF); HEIC is image but not media (it is converted where the browser decodes it)
//   SNIFF_BYTES  how many leading bytes sniff() looks at (4,096); an ISO 9660 or UDF image is told from its
//           volume descriptor at 0x8001 when the caller passes at least 0x8006 bytes (the files lane passes 64 KiB)
// Review round (MAL53-7, PRIV-5): TIFF and camera RAW (DNG, NEF, CR2, ARW, ORF, RW2, RAF, CR3) are images, so the
// image stripper runs and a public upload is refused when this browser cannot re-encode them; Windows shortcuts
// (LNK), CHM, OneNote, compiled AppleScript, CAB, VHD, VHDX and ISO images are told by magic and need confirmation.
//   mediaType(bytes) -> the sniff result when media, else throws E_MEDIA_TYPE

export const SNIFF_BYTES = 4096;

export const CONFIRM_KINDS = Object.freeze(['executable', 'installer', 'script', 'macro', 'archive']);
export const MEDIA_MIMES = Object.freeze(['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const ascii = (u8, at, len) => {
  let s = '';
  for (let i = at; i < at + len && i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
};

const starts = (u8, sig, at = 0) => {
  if (u8.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (u8[at + i] !== sig[i]) return false;
  return true;
};

function result(mime, ext, kind) {
  const media = MEDIA_MIMES.indexOf(mime) >= 0;
  return {
    mime,
    ext,
    kind,
    tier: CONFIRM_KINDS.indexOf(kind) >= 0 ? 'confirm' : 'plain',
    media,
    image: kind === 'image',
    video: kind === 'video',
  };
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

function isoBmff(u8) {
  // [size][ftyp][major brand][minor version][compatible brands...]
  const size = ((u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3]) >>> 0;
  const major = ascii(u8, 8, 4);
  const brands = [major];
  for (let o = 16; o + 4 <= Math.min(size, u8.length, 256); o += 4) brands.push(ascii(u8, o, 4));
  if (brands.some((b) => AVIF_BRANDS.has(b)) && AVIF_BRANDS.has(major)) return result('image/avif', 'avif', 'image');
  if (HEIF_BRANDS.has(major)) return result('image/heic', 'heic', 'image');
  if (major === 'crx ') return result('image/x-raw', 'cr3', 'image'); // Canon CR3 (camera RAW in ISO BMFF)
  if (major === 'qt  ') return result('video/quicktime', 'mov', 'video');
  if (major === 'M4A ' || major === 'M4B ' || major === 'M4P ') return result('audio/mp4', 'm4a', 'audio');
  if (major.indexOf('3g') === 0) return result('video/3gpp', '3gp', 'video');
  return result('video/mp4', 'mp4', 'video');
}

// EBML header: read the DocType string (element 0x4282) from the first bytes.
function ebmlDocType(u8) {
  const limit = Math.min(u8.length - 3, 64);
  for (let i = 4; i < limit; i++) {
    if (u8[i] === 0x42 && u8[i + 1] === 0x82) {
      const sizeByte = u8[i + 2];
      if (sizeByte & 0x80) {
        const len = sizeByte & 0x7f;
        return ascii(u8, i + 3, len);
      }
    }
  }
  return '';
}

function isUtf8Text(u8) {
  if (u8.length === 0) return true;
  let i = 0;
  const n = u8.length;
  while (i < n) {
    const b = u8[i];
    if (b === 0) return false;
    if (b < 0x80) {
      if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) return false;
      i++;
      continue;
    }
    let extra;
    if (b >= 0xc2 && b <= 0xdf) extra = 1;
    else if (b >= 0xe0 && b <= 0xef) extra = 2;
    else if (b >= 0xf0 && b <= 0xf4) extra = 3;
    else return false;
    if (i + extra >= n) return true; // a sequence cut by the sniff window
    for (let k = 1; k <= extra; k++) if ((u8[i + k] & 0xc0) !== 0x80) return false;
    i += extra + 1;
  }
  return true;
}

function markup(u8) {
  let i = 0;
  if (starts(u8, [0xef, 0xbb, 0xbf])) i = 3;
  while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x09 || u8[i] === 0x0a || u8[i] === 0x0d)) i++;
  const head = ascii(u8, i, 512).toLowerCase();
  if (head.indexOf('<!doctype html') === 0 || head.indexOf('<html') === 0 || head.indexOf('<head') === 0 ||
    head.indexOf('<body') === 0 || head.indexOf('<script') === 0 || head.indexOf('<iframe') === 0) return result('text/html', 'html', 'html');
  if (head.indexOf('<svg') === 0) return result('image/svg+xml', 'svg', 'svg');
  if (head.indexOf('<?xml') === 0 || head.indexOf('<!--') === 0) {
    if (head.indexOf('<svg') >= 0) return result('image/svg+xml', 'svg', 'svg');
    if (head.indexOf('<html') >= 0) return result('text/html', 'html', 'html');
    return result('application/xml', 'xml', 'xml');
  }
  return null;
}

/** sniff(bytes) -> the type from the first SNIFF_BYTES bytes (a Uint8Array or ArrayBuffer). */
export function sniff(bytes) {
  const all = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const u8 = all.subarray(0, SNIFF_BYTES);
  if (all.length >= 0x8006) {
    const vd = ascii(all, 0x8001, 5); // ISO 9660 primary volume descriptor or UDF's first descriptor
    if (vd === 'CD001' || vd === 'BEA01') return result('application/x-iso9660-image', 'iso', 'archive');
  }
  if (starts(u8, [0xff, 0xd8, 0xff])) return result('image/jpeg', 'jpg', 'image');
  // TIFF and the TIFF-based camera RAW formats (DNG, NEF, CR2, ARW, PEF, SRW), BigTIFF; other RAW containers
  if (starts(u8, [0x49, 0x49, 0x2a, 0x00]) || starts(u8, [0x4d, 0x4d, 0x00, 0x2a]) || starts(u8, [0x49, 0x49, 0x2b, 0x00]) ||
    starts(u8, [0x4d, 0x4d, 0x00, 0x2b])) return result('image/tiff', 'tif', 'image');
  if (ascii(u8, 0, 4) === 'IIRO' || ascii(u8, 0, 4) === 'IIRS' || ascii(u8, 0, 4) === 'MMOR' || starts(u8, [0x49, 0x49, 0x55, 0x00]) ||
    ascii(u8, 0, 15) === 'FUJIFILMCCD-RAW' || (starts(u8, [0x49, 0x49, 0x1a, 0x00]) && ascii(u8, 6, 8) === 'HEAPCCDR')) {
    return result('image/x-raw', 'raw', 'image');
  }
  // Windows shell link (header size 0x4C, then the CLSID 00021401-0000-0000-C000-000000000046)
  if (starts(u8, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46])) {
    return result('application/x-ms-shortcut', 'lnk', 'executable');
  }
  if (ascii(u8, 0, 4) === 'ITSF') return result('application/vnd.ms-htmlhelp', 'chm', 'executable');
  if (starts(u8, [0xe4, 0x52, 0x5c, 0x7b, 0x8c, 0xd8, 0xa7, 0x4d, 0xae, 0xb1, 0x53, 0x78, 0xd0, 0x29, 0x96, 0xd3])) return result('application/onenote', 'one', 'macro');
  if (ascii(u8, 0, 7) === 'FasdUAS') return result('application/x-applescript', 'scpt', 'script');
  if (ascii(u8, 0, 4) === 'MSCF' && starts(u8, [0, 0, 0, 0], 4)) return result('application/vnd.ms-cab-compressed', 'cab', 'archive');
  if (ascii(u8, 0, 8) === 'conectix') return result('application/x-vhd', 'vhd', 'archive');
  if (ascii(u8, 0, 8) === 'vhdxfile') return result('application/x-vhdx', 'vhdx', 'archive');
  if (starts(u8, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return result('image/png', 'png', 'image');
  const a6 = ascii(u8, 0, 6);
  if (a6 === 'GIF87a' || a6 === 'GIF89a') return result('image/gif', 'gif', 'image');
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WEBP') return result('image/webp', 'webp', 'image');
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WAVE') return result('audio/wav', 'wav', 'audio');
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'AVI ') return result('video/x-msvideo', 'avi', 'video');
  if (ascii(u8, 4, 4) === 'ftyp') return isoBmff(u8);
  if (starts(u8, [0x1a, 0x45, 0xdf, 0xa3])) {
    const doc = ebmlDocType(u8);
    if (doc === 'webm') return result('video/webm', 'webm', 'video');
    return result('video/x-matroska', 'mkv', 'video');
  }
  if (ascii(u8, 0, 4) === 'OggS') return result('audio/ogg', 'ogg', 'audio');
  if (ascii(u8, 0, 4) === 'fLaC') return result('audio/flac', 'flac', 'audio');
  if (ascii(u8, 0, 3) === 'ID3' || (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0 && u8.length > 2 && (u8[1] & 0x06) !== 0)) {
    return result('audio/mpeg', 'mp3', 'audio');
  }
  if (ascii(u8, 0, 5) === '%PDF-') return result('application/pdf', 'pdf', 'pdf');
  if (starts(u8, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return result('application/x-ole-storage', 'doc', 'macro'); // Office 97-2003, MSI
  if (ascii(u8, 0, 5) === '{\\rtf') return result('application/rtf', 'rtf', 'macro');
  if (starts(u8, [0x50, 0x4b, 0x03, 0x04]) || starts(u8, [0x50, 0x4b, 0x05, 0x06])) {
    const head = ascii(u8, 0, 512);
    if (head.indexOf('AndroidManifest.xml') >= 0 || head.indexOf('classes.dex') >= 0) return result('application/vnd.android.package-archive', 'apk', 'installer');
    if (head.indexOf('vbaProject.bin') >= 0) return result('application/zip', 'zip', 'macro');
    return result('application/zip', 'zip', 'archive');
  }
  if (starts(u8, [0x1f, 0x8b])) return result('application/gzip', 'gz', 'archive');
  if (ascii(u8, 0, 4) === 'Rar!') return result('application/vnd.rar', 'rar', 'archive');
  if (starts(u8, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return result('application/x-7z-compressed', '7z', 'archive');
  if (starts(u8, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return result('application/x-xz', 'xz', 'archive');
  if (starts(u8, [0x42, 0x5a, 0x68])) return result('application/x-bzip2', 'bz2', 'archive');
  if (ascii(u8, 257, 5) === 'ustar') return result('application/x-tar', 'tar', 'archive');
  if (ascii(u8, 0, 4) === 'xar!') return result('application/x-xar', 'pkg', 'installer');
  if (ascii(u8, 0, 8) === '!<arch>\n') return result('application/vnd.debian.binary-package', 'deb', 'installer');
  if (starts(u8, [0xed, 0xab, 0xee, 0xdb])) return result('application/x-rpm', 'rpm', 'installer');
  if (ascii(u8, 0, 2) === 'MZ') return result('application/x-msdownload', 'exe', 'executable');
  if (starts(u8, [0x7f, 0x45, 0x4c, 0x46])) return result('application/x-executable', 'elf', 'executable');
  if (starts(u8, [0xfe, 0xed, 0xfa, 0xce]) || starts(u8, [0xfe, 0xed, 0xfa, 0xcf]) || starts(u8, [0xce, 0xfa, 0xed, 0xfe]) ||
    starts(u8, [0xcf, 0xfa, 0xed, 0xfe]) || starts(u8, [0xca, 0xfe, 0xba, 0xbe])) return result('application/x-mach-binary', 'macho', 'executable');
  if (starts(u8, [0x00, 0x61, 0x73, 0x6d])) return result('application/wasm', 'wasm', 'executable');
  if (ascii(u8, 0, 2) === '#!') return result('text/x-script', 'sh', 'script');
  const m = markup(u8);
  if (m) return m;
  if (isUtf8Text(u8)) {
    const head = ascii(u8, 0, 256).toLowerCase();
    if (/^\s*(@echo off|powershell|set-executionpolicy|wscript|createobject\()/.test(head)) return result('text/x-script', 'bat', 'script');
    return result('text/plain', 'txt', 'text');
  }
  return result('application/octet-stream', 'bin', 'unknown');
}

/** mediaType(bytes) -> the sniff result of an R 2.9.2 format; throws E_MEDIA_TYPE for anything else. */
export function mediaType(bytes) {
  const s = sniff(bytes);
  if (!s.media) {
    const err = new Error('this format cannot be uploaded as private media (' + s.mime + ')');
    err.code = 'E_MEDIA_TYPE';
    throw err;
  }
  return s;
}
