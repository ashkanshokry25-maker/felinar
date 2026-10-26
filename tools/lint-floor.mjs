#!/usr/bin/env node
// tools/lint-floor.mjs: regex scan of src/ for APIs and syntax past the declared browser floor
// (ARCHITECTURE section 10 and 13, DESIGN-REVIEW item 16): Safari/iOS 15.4, Chromium 110,
// Firefox 115 ESR. npm test runs it before the unit tests.
//
//   node tools/lint-floor.mjs [path...] [--json]        (default path: src)
//
// What it reports (see RULES): Promise.withResolvers, Object.groupBy and Map.groupBy,
// Array.fromAsync, the Set methods (union, intersection, ...), URL.parse, AbortSignal.any,
// iterator helpers, the regex v flag, regex lookbehind (Safari 16.4), toSorted/toReversed/
// toSpliced (Safari 16), class static blocks, Uint8Array hex/base64 conversions (polyfilled by
// boot.js on windows only), ArrayBuffer transfer, isWellFormed, Promise.try, import maps, an
// unguarded structuredClone, and a few CSS features (:has, @container, color-mix, light-dark,
// subgrid). Top-level await in classic scripts is caught by build.mjs, because the iife
// bundles refuse it.
//
// Matching ignores comments and the contents of string and template literals (so an error
// message may name an API), except for rules that look inside regular expressions and
// RegExp() strings. A line that carries `lint-floor-ignore`, or follows a line that carries
// `lint-floor-ignore-next`, is skipped: use it only for a use that is guarded at run time.
//
// Code review v0.3: rules for the post-floor APIs v0.3 feature-detects (PublicKeyCredential.getClientCapabilities,
// WebAuthn PRF results, navigator.wakeLock, getDisplayMedia, BarcodeDetector, OffscreenCanvas, requestIdleCallback,
// getBattery, navigator.connection, Media Session actions beyond play and pause, createImageBitmap option values). Such a
// rule has `guard` names: a use passes when its line or the line before carries a run-time guard of one of them (typeof
// <...name>, 'name' in ..., <...name> && ..., <...>?.name) or opens a try block, so the next unguarded use is caught.

import { readFileSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';

import { parseCli, runMain, isMain, walkFiles, ROOT, out } from './lib.mjs';

const USAGE = `
Usage: node tools/lint-floor.mjs [path...] [--json]
Scans .js, .mjs, .cjs, .css and .html files (default: src) for APIs past the browser floor
(Safari/iOS 15.4, Chromium 110, Firefox 115). Exit 1 when anything is found.
`;

/**
 * RULES: { id, kind: 'api' | 'regex' | 'css' | 'html', re, why, fix, files?, exempt? }
 * 'api' rules match code with comments, strings and regex literals blanked; 'regex' rules match
 * the regular expression literals and RegExp(...) calls; 'css' rules match CSS with comments
 * removed; 'html' rules match markup with comments removed.
 */
export const RULES = [
  { id: 'Promise.withResolvers', kind: 'api', re: /\bPromise\s*\.\s*withResolvers\b/, why: 'Chrome 119, Safari 17.4, Firefox 121', fix: 'new Promise((resolve, reject) => { ... })' },
  { id: 'Object.groupBy / Map.groupBy', kind: 'api', re: /\b(?:Object|Map)\s*\.\s*groupBy\b/, why: 'Chrome 117, Safari 17.4, Firefox 119', fix: 'a loop that fills a Map or an object' },
  { id: 'Array.fromAsync', kind: 'api', re: /\bArray\s*\.\s*fromAsync\b/, why: 'Chrome 121, Safari 16.4, Firefox 115 only behind a flag', fix: 'for await (...) { out.push(...) }' },
  { id: 'Set methods', kind: 'api', re: /\.\s*(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/, why: 'Chrome 122, Safari 17, Firefox 127', fix: 'a loop over the smaller set' },
  { id: 'URL.parse', kind: 'api', re: /\bURL\s*\.\s*parse\b/, why: 'Chrome 126, Safari 18, Firefox 126', fix: 'try { new URL(x) } catch (_) { ... }' },
  { id: 'AbortSignal.any', kind: 'api', re: /\bAbortSignal\s*\.\s*any\b/, why: 'Chrome 116, Safari 17.4, Firefox 124', fix: 'one AbortController that listens to both signals' },
  { id: 'iterator helpers', kind: 'api', re: /\bIterator\s*\.\s*(?:from|prototype)\b|\.\s*(?:values|keys|entries)\s*\(\s*\)\s*\.\s*(?:map|filter|take|drop|flatMap|reduce|toArray|forEach|some|every|find)\s*\(/, why: 'Chrome 122, Safari 18.4, Firefox 131', fix: 'Array.from(x.values()).map(...) or a for...of loop' },
  { id: 'toSorted / toReversed / toSpliced', kind: 'api', re: /\.\s*(?:toSorted|toReversed|toSpliced)\s*\(/, why: 'Chrome 110, Firefox 115, but Safari 16', fix: 'x.slice().sort(...)' },
  { id: 'Uint8Array hex and base64', kind: 'api', re: /\bUint8Array\s*\.\s*(?:fromHex|fromBase64)\b|\.\s*(?:toHex|toBase64|setFromHex|setFromBase64)\s*\(/, why: 'Chrome 140, Safari 18.2, Firefox 133; boot.js polyfills them on windows only, not in workers', fix: 'hex.encode / b64url from src/chain/canonical.js', exempt: ['src/loader/boot.js'] },
  { id: 'ArrayBuffer transfer / resize', kind: 'api', re: /\.\s*(?:transfer|transferToFixedLength)\s*\(\s*\)|\bnew\s+ArrayBuffer\s*\([^)]*maxByteLength/, why: 'Chrome 114, Safari 17.4, Firefox 122', fix: 'copy into a new buffer' },
  { id: 'isWellFormed / toWellFormed', kind: 'api', re: /\.\s*(?:isWellFormed|toWellFormed)\s*\(/, why: 'Chrome 111, Safari 16.4, Firefox 119', fix: 'a TextEncoder round trip' },
  { id: 'Promise.try', kind: 'api', re: /\bPromise\s*\.\s*try\b/, why: 'Chrome 128, Safari 18.2, Firefox 134', fix: 'new Promise((resolve) => resolve(fn()))' },
  { id: 'class static block', kind: 'api', re: /\bstatic\s*\{/, why: 'Chrome 94, Firefox 93, but Safari 16.4', fix: 'a static method called after the class' },
  { id: 'structuredClone without a fallback', kind: 'api', re: /\bstructuredClone\s*\(/, why: 'old WebViews lack it; the floor browsers have it, so guard the call', fix: "typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x))", unlessFileMatches: /typeof\s+structuredClone/ },
  // Code review round 1: more APIs past the floor (each guarded use carries lint-floor-ignore).
  { id: 'DecompressionStream / CompressionStream', kind: 'api', re: /\b(?:Decompression|Compression)Stream\b/, why: 'Chrome 80, Firefox 113, but Safari 16.4', fix: 'src/common/inflate.js (gunzip, inflateRaw) when the constructor is missing' },
  { id: 'Response.json (static)', kind: 'api', re: /\bResponse\s*\.\s*json\s*\(/, why: 'Chrome 105, Firefox 115, but Safari 17', fix: "new Response(JSON.stringify(x), { headers: { 'Content-Type': 'application/json' } })" },
  { id: 'URL.canParse', kind: 'api', re: /\bURL\s*\.\s*canParse\b/, why: 'Chrome 120, Safari 17, Firefox 115', fix: 'try { new URL(x) } catch (_) { ... }' },
  { id: 'constructable stylesheets', kind: 'api', re: /\badoptedStyleSheets\b|\.\s*replaceSync\s*\(|\bnew\s+CSSStyleSheet\s*\(/, why: 'Chrome 73, Firefox 101, but Safari 16.4', fix: 'a <style> element' },
  { id: 'Response / Blob .bytes()', kind: 'api', re: /\.\s*bytes\s*\(\s*\)/, why: 'Chrome 132, Firefox 128, Safari 18', fix: 'new Uint8Array(await x.arrayBuffer())' },
  { id: 'for await over a stream', kind: 'api', re: /\bfor\s+await\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+[\w.$]*(?:body|stream|readable)\b/i, why: 'async iteration of ReadableStream: Chrome 124, Firefox 110, not Safari', fix: 'const reader = stream.getReader(); for (;;) { const { done, value } = await reader.read(); ... }' },
  { id: 'navigator.userActivation', kind: 'api', re: /\buserActivation\b/, why: 'Chrome 72, but Safari 16.4, Firefox 120', fix: 'act in the click handler itself (transient activation is implicit there)' },
  { id: 'popover', kind: 'api', re: /\.\s*(?:showPopover|hidePopover|togglePopover)\s*\(|\bpopovertarget\b/, why: 'Chrome 114, Safari 17, Firefox 125', fix: 'a positioned element shown and hidden by script' },
  { id: 'Intl.Segmenter', kind: 'api', re: /\bIntl\s*\.\s*Segmenter\b/, why: 'Chrome 87, Safari 14.1, but Firefox 125', fix: 'Array.from(string) for code points' },
  { id: 'Element.checkVisibility', kind: 'api', re: /\.\s*checkVisibility\s*\(/, why: 'Chrome 105, Firefox 106, but Safari 17.4', fix: 'getClientRects().length and getComputedStyle' },
  { id: 'Array.prototype.with', kind: 'api', re: /\.\s*with\s*\(\s*-?\d/, why: 'Chrome 110, Firefox 115, but Safari 16', fix: 'const copy = a.slice(); copy[i] = v' },
  { id: 'import.meta.resolve', kind: 'api', re: /\bimport\s*\.\s*meta\s*\.\s*resolve\s*\(/, why: 'Chrome 105, Firefox 106, but Safari 16.4', fix: 'new URL(path, import.meta.url).href' },
  // Code review v0.3: APIs v0.3 uses where they exist; each use needs a guard on its line or the line before (see the header).
  { id: 'PublicKeyCredential.getClientCapabilities', kind: 'api', re: /\bgetClientCapabilities\s*\(/, guard: ['getClientCapabilities'], why: 'Chrome 133, Safari 17.4, Firefox 135', fix: "typeof PublicKeyCredential.getClientCapabilities === 'function'" },
  { id: 'WebAuthn PRF results', kind: 'api', re: /\bprf\s*\.\s*(?:results|enabled)\b/, guard: ['prf'], why: 'the PRF extension: Chrome 116, Safari 18, Firefox 135', fix: 'ext && ext.prf && ext.prf.results (absent where PRF is not supported)' },
  { id: 'navigator.wakeLock', kind: 'api', re: /\bwakeLock\s*\.\s*request\s*\(/, guard: ['wakeLock', 'request'], why: 'Chrome 84, but Safari 16.4, Firefox 126', fix: "typeof navigator.wakeLock === 'object' && typeof navigator.wakeLock.request === 'function'" },
  { id: 'getDisplayMedia', kind: 'api', re: /\bgetDisplayMedia\s*\(/, guard: ['getDisplayMedia'], why: 'absent on iOS (15.4 and later phones) and on Android browsers', fix: "typeof navigator.mediaDevices.getDisplayMedia === 'function', else E_UNSUPPORTED" },
  { id: 'BarcodeDetector', kind: 'api', re: /\bnew\s+BarcodeDetector\b|\bBarcodeDetector\s*\.\s*getSupportedFormats\b/, guard: ['BarcodeDetector'], why: 'Chromium on Android and macOS only; not Safari, not Firefox', fix: "typeof BarcodeDetector === 'function', else the bundled decoder" },
  { id: 'OffscreenCanvas', kind: 'api', re: /\bnew\s+OffscreenCanvas\b/, guard: ['OffscreenCanvas'], why: 'Chrome 69, Firefox 105, but Safari 16.4', fix: "typeof OffscreenCanvas === 'function', else a <canvas> element" },
  { id: 'requestIdleCallback', kind: 'api', re: /\brequestIdleCallback\s*\(/, guard: ['requestIdleCallback'], why: 'Chrome 47, Firefox 55, but not Safari', fix: "typeof requestIdleCallback === 'function', else setTimeout" },
  { id: 'navigator.getBattery', kind: 'api', re: /\bgetBattery\s*\(/, guard: ['getBattery'], why: 'Chromium only', fix: "typeof navigator.getBattery === 'function'" },
  { id: 'navigator.connection', kind: 'api', re: /\b(?:navigator|nav)\s*\.\s*connection\b/, guard: ['connection'], why: 'Chromium only (Network Information API)', fix: "navigator.connection && typeof navigator.connection === 'object'" },
  { id: 'Media Session actions beyond play and pause', kind: 'api', re: /\bsetActionHandler\s*\(/, guard: ['setActionHandler'], unlessFollowedBy: /^\s*(['"])(?:play|pause)\1/, why: 'actions such as hangup, togglemicrophone and togglecamera are newer than the floor; an unknown action throws TypeError', fix: 'call setActionHandler inside try { } catch (_) { }' },
  { id: 'createImageBitmap option values', kind: 'api', re: /\b(?:imageOrientation|colorSpaceConversion|premultiplyAlpha)\s*:/, guard: ['createImageBitmap'], tryAhead: 1, why: 'these createImageBitmap options and their newer values are not in every floor browser; an unknown value throws TypeError', fix: 'leave the option out, or call createImageBitmap inside try { } catch (_) { }' },
  { id: 'regex v flag', kind: 'regex', test: (r) => r.kind === 'literal' && r.flags.indexOf('v') >= 0, why: 'Chrome 112, Safari 17, Firefox 116', fix: 'the u flag with explicit character classes' },
  { id: 'regex v flag (RegExp)', kind: 'regex', test: (r) => r.kind === 'constructor' && /^[a-z]*v[a-z]*$/.test(r.flags || ''), why: 'Chrome 112, Safari 17, Firefox 116', fix: 'the u flag' },
  { id: 'regex lookbehind', kind: 'regex', test: (r) => /\(\?<[=!]/.test(r.pattern), why: 'Chrome 62, Firefox 78, but Safari 16.4', fix: 'a capture group and a replace callback' },
  { id: 'import maps', kind: 'html', re: /<script\b[^>]*\btype\s*=\s*["']?importmap/i, why: 'Safari 16.4, Chrome 89, Firefox 108', fix: 'bundle the imports' },
  { id: 'CSS :has()', kind: 'css', re: /:has\s*\(/, why: 'Chrome 105, Safari 15.4, but Firefox 121 (the floor is 115)', fix: 'a class set from script, or restructure the selector' },
  { id: 'CSS container queries', kind: 'css', re: /@container\b|\bcontainer-type\s*:/, why: 'Chrome 105, Firefox 110, but Safari 16', fix: 'a media query' },
  { id: 'CSS color-mix / light-dark', kind: 'css', re: /\bcolor-mix\s*\(|\blight-dark\s*\(/, why: 'color-mix: Chrome 111, Safari 16.2; light-dark: Chrome 123, Safari 17.5, Firefox 120', fix: 'custom properties set in a prefers-color-scheme block' },
  { id: 'CSS subgrid', kind: 'css', re: /grid-template-(?:rows|columns)\s*:\s*subgrid\b/, why: 'Chrome 117, Safari 16, Firefox 71', fix: 'an explicit grid' },
];

const IGNORE_SAME = 'lint-floor-ignore';
const IGNORE_NEXT = 'lint-floor-ignore-next';

// ---------------------------------------------------------------------------------------------
// JavaScript scanner: comments, strings, template literals and regular expression literals
// ---------------------------------------------------------------------------------------------

const REGEX_PREV_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof']);

function blankRange(chars, from, to) {
  for (let i = from; i < to; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
}

/**
 * scanJs(text) → { code, regexes }
 * code: the text with comments, string and template contents and regular expression literals
 * replaced by spaces (newlines and offsets are kept, so line and column numbers stay exact).
 * regexes: [{ kind: 'literal'|'constructor', pattern, flags, index }] for /.../flags literals
 * and new RegExp('...', '...') / RegExp('...', '...') calls with string literal arguments.
 */
export function scanJs(text) {
  const src = String(text);
  const chars = src.split('');
  const regexes = [];
  const n = src.length;
  let i = 0;
  let prevSig = ''; // last significant character outside comments, strings and regexes
  let prevWord = ''; // last identifier or keyword, when prevSig ends one

  const noteToken = (ch) => {
    prevSig = ch;
    prevWord = '';
  };

  const readString = (quote) => {
    const start = i;
    i++;
    while (i < n && src[i] !== quote && src[i] !== '\n') {
      if (src[i] === '\\') i++;
      i++;
    }
    const end = Math.min(i + 1, n);
    blankRange(chars, start + 1, Math.max(start + 1, end - 1));
    i = end;
    noteToken(quote);
  };

  // Template literal starting at the backtick at `i`; ${ ... } sections are scanned as code.
  const readTemplate = () => {
    i++;
    let segStart = i;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        blankRange(chars, segStart, i);
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const c = src[i];
          if (c === '{') {
            depth++;
            i++;
          } else if (c === '}') {
            depth--;
            i++;
          } else if (c === '`') {
            readTemplate();
          } else if (c === '"' || c === "'") {
            readString(c);
          } else if (c === '/' && src[i + 1] === '/') {
            const e = src.indexOf('\n', i);
            const end = e < 0 ? n : e;
            blankRange(chars, i, end);
            i = end;
          } else if (c === '/' && src[i + 1] === '*') {
            const e = src.indexOf('*/', i + 2);
            const end = e < 0 ? n : e + 2;
            blankRange(chars, i, end);
            i = end;
          } else {
            i++;
          }
        }
        segStart = i;
        continue;
      }
      i++;
    }
    blankRange(chars, segStart, Math.min(i, n));
    i = Math.min(i + 1, n);
    noteToken('`');
  };

  const regexAllowedHere = () => {
    if (prevSig === '') return true;
    if (/[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig)) return true;
    return prevWord !== '' && REGEX_PREV_KEYWORDS.has(prevWord);
  };

  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blankRange(chars, i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blankRange(chars, i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      readString(c);
      continue;
    }
    if (c === '`') {
      readTemplate();
      continue;
    }
    if (c === '/' && regexAllowedHere()) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        const pattern = src.slice(start + 1, j);
        let k = j + 1;
        while (k < n && /[a-z]/.test(src[k])) k++;
        const flags = src.slice(j + 1, k);
        regexes.push({ kind: 'literal', pattern, flags, index: start });
        blankRange(chars, start, k);
        i = k;
        noteToken(')'); // a regex literal ends an operand: a following '/' is a division
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      prevSig = src[j - 1];
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
      prevSig = '0';
      prevWord = '';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) noteToken(c);
    i++;
  }

  // RegExp('pattern', 'flags') and new RegExp(...) with string literal arguments.
  const callRe = /\bRegExp\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1\s*(?:,\s*(["'`])([a-z]*)\3)?/g;
  let m;
  while ((m = callRe.exec(src)) !== null) {
    regexes.push({ kind: 'constructor', pattern: m[2], flags: m[4] || '', index: m.index });
  }
  return { code: chars.join(''), regexes };
}

// CSS and HTML: comments removed (offsets kept).
function blankComments(text, open, close) {
  const chars = text.split('');
  let from = 0;
  for (;;) {
    const a = text.indexOf(open, from);
    if (a < 0) break;
    const b = text.indexOf(close, a + open.length);
    const end = b < 0 ? text.length : b + close.length;
    blankRange(chars, a, end);
    from = end;
  }
  return chars.join('');
}

function lineAndColumn(text, index) {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) {
    line++;
    last = i;
  }
  return { line, column: index - last };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GUARD_CACHE = new Map();

// A run-time guard of one of `names` on a raw line: typeof <expr naming it>, 'name' in x, <expr naming it> && ..., x?.name,
// or a try block opening there.
function guardRe(names) {
  const key = names.join('|');
  let re = GUARD_CACHE.get(key);
  if (!re) {
    const n = '(?:' + names.map(escapeRe).join('|') + ')';
    re = new RegExp('\\btypeof\\s+[\\w$.\\[\\]\'"]*\\b' + n + '\\b|[\'"]' + n + '[\'"]\\s+in\\b|\\b' + n + '\\b[\\w$.]*\\s*&&|\\?\\.\\s*' + n + '\\b|\\btry\\s*\\{');
    GUARD_CACHE.set(key, re);
  }
  return re;
}

// tryAhead: options prepared on the line before the guarded call may also have the try block open on the next lines.
function guardedAt(lines, line, names, tryAhead = 0) {
  const re = guardRe(names);
  if (re.test(lines[line - 1] || '') || (line >= 2 && re.test(lines[line - 2] || ''))) return true;
  for (let k = 1; k <= tryAhead; k++) if (/\btry\s*\{/.test(lines[line - 1 + k] || '')) return true;
  return false;
}

function ignoredLines(text) {
  const lines = text.split('\n');
  const skip = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(IGNORE_NEXT) >= 0) skip.add(i + 2);
    else if (lines[i].indexOf(IGNORE_SAME) >= 0) skip.add(i + 1);
  }
  return skip;
}

/**
 * lintSource(text, file) → findings: [{ file, line, column, id, match, why, fix }]
 * `file` decides which scanner runs (by extension) and which rules are exempt (posix path
 * relative to the repository root).
 */
export function lintSource(text, file = 'input.js') {
  const ext = extname(file).toLowerCase();
  const posix = file.split('\\').join('/');
  const skip = ignoredLines(text);
  const findings = [];
  const add = (rule, index, match) => {
    const pos = lineAndColumn(text, index);
    if (skip.has(pos.line)) return;
    findings.push({ file: posix, line: pos.line, column: pos.column, id: rule.id, match, why: rule.why, fix: rule.fix });
  };
  const exempt = (rule) => Array.isArray(rule.exempt) && rule.exempt.some((p) => posix === p || posix.endsWith('/' + p));
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const { code, regexes } = scanJs(text);
    const rawLines = text.split('\n');
    for (const rule of RULES) {
      if (exempt(rule)) continue;
      if (rule.kind === 'api') {
        if (rule.unlessFileMatches && rule.unlessFileMatches.test(code)) continue;
        const re = new RegExp(rule.re.source, rule.re.flags.indexOf('g') >= 0 ? rule.re.flags : rule.re.flags + 'g');
        let m;
        while ((m = re.exec(code)) !== null) {
          const skipHere = (rule.unlessFollowedBy && rule.unlessFollowedBy.test(text.slice(m.index + m[0].length, m.index + m[0].length + 40))) ||
            (Array.isArray(rule.guard) && guardedAt(rawLines, lineAndColumn(text, m.index).line, rule.guard, rule.tryAhead || 0));
          if (!skipHere) add(rule, m.index, m[0]);
          if (m[0].length === 0) re.lastIndex++;
        }
      } else if (rule.kind === 'regex') {
        for (const r of regexes) if (rule.test(r)) add(rule, r.index, r.kind === 'literal' ? '/' + r.pattern + '/' + r.flags : 'RegExp(' + JSON.stringify(r.pattern) + ', ' + JSON.stringify(r.flags) + ')');
      }
    }
  } else if (ext === '.css') {
    const css = blankComments(text, '/*', '*/');
    for (const rule of RULES) {
      if (rule.kind !== 'css' || exempt(rule)) continue;
      const re = new RegExp(rule.re.source, 'g');
      let m;
      while ((m = re.exec(css)) !== null) add(rule, m.index, m[0]);
    }
  } else if (ext === '.html' || ext === '.htm') {
    const html = blankComments(text, '<!--', '-->');
    for (const rule of RULES) {
      if (rule.kind !== 'html' || exempt(rule)) continue;
      const re = new RegExp(rule.re.source, 'gi');
      let m;
      while ((m = re.exec(html)) !== null) add(rule, m.index, m[0]);
    }
  }
  return findings;
}

const SCANNED = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.htm']);

/** lintPaths(paths, { root }) → { findings, files }: scans files and directories (recursively). */
export function lintPaths(paths, { root = ROOT } = {}) {
  const findings = [];
  let files = 0;
  for (const p of paths) {
    const abs = resolve(root, p);
    let list;
    try {
      list = walkFiles(abs, { skip: (rel, isDir) => (isDir && (rel.split('/').pop() === 'node_modules' || rel.split('/').pop().startsWith('.')) ? 'skipped' : null) });
    } catch (_) {
      list = [{ path: '', abs }];
    }
    for (const f of list) {
      if (!SCANNED.has(extname(f.abs).toLowerCase())) continue;
      let text;
      try {
        text = readFileSync(f.abs, 'utf8');
      } catch (_) {
        continue;
      }
      files++;
      findings.push(...lintSource(text, relative(root, f.abs)));
    }
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column));
  return { findings, files };
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, { json: { type: 'boolean' } });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  const paths = positionals.length ? positionals : ['src'];
  const { findings, files } = lintPaths(paths, { root: positionals.length ? process.cwd() : ROOT });
  if (flags.json) {
    out(JSON.stringify({ files, findings }, null, 2));
    return findings.length ? 1 : 0;
  }
  for (const f of findings) {
    out(f.file + ':' + f.line + ':' + f.column + '  ' + f.id + '  (' + f.why + ')  use: ' + f.fix);
    out('    ' + f.match);
  }
  if (findings.length) {
    out('');
    out('lint-floor: ' + findings.length + ' use(s) of APIs or syntax past the browser floor in ' + files + ' files (Safari/iOS 15.4, Chromium 110, Firefox 115).');
    out('A use that is guarded at run time may carry the comment "lint-floor-ignore" on its line.');
    return 1;
  }
  out('lint-floor: ' + files + ' files, no APIs or syntax past the browser floor.');
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
