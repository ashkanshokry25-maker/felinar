// The documents of the usage reports (docs/OBSERVABILITY.md, PRIVACY.md and APPS.md) say two things the code makes true or false: what a visitor is told, word for
// word, and which events a page can raise with which fields. Each test reads a document and the code it describes, so the claim and the code cannot drift apart:
//
//   1. PRIVACY.md quotes the sentences of the first-run card, the gate, Settings, the door's price card and the identity page, and APPS.md the price card's line,
//      exactly as the strings tables hold them.
//   2. Every event name the code raises through a report call (a string literal as the first argument, with the 'apps.' and 'link.' prefixes added where the
//      apps' own files add them) is a row of the tables of OBSERVABILITY.md, and every row is raised somewhere. The identity page has its own table.
//   3. The fields of a row are the keys of the object each call site passes, together.
//   4. No other file raises an event: a new call site of a report seam has to be added to this scan, and so to the tables.
//
// The scan reads the source text (no code runs), so it holds the tables to the calls as they are written. The extractor has its own tests at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../../tools/lib.mjs';
import { STRINGS, UI_TEXT, APPS_TEXT } from '../../src/loader/strings.js';
import { STRINGS as IDP_STRINGS } from '../../src/idp/strings.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const flat = (t) => t.replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------------------------------------------------
// 1. What a visitor is told

test('PRIVACY.md quotes the sentences of the usage reports card, gate, Settings, price card and identity page word for word', () => {
  const privacy = flat(read('docs/PRIVACY.md'));
  const quoted = {
    'STRINGS.consentReports': STRINGS.consentReports,
    'STRINGS.gateReports': STRINGS.gateReports,
    'UI_TEXT.en.settingsReportsLabel': UI_TEXT.en.settingsReportsLabel,
    'UI_TEXT.en.settingsReportsNote': UI_TEXT.en.settingsReportsNote,
    "APPS_TEXT.en['apps.price.reports']": APPS_TEXT.en['apps.price.reports'],
    'idp STRINGS.en.obsDisclosure': IDP_STRINGS.en.obsDisclosure,
  };
  for (const [key, text] of Object.entries(quoted)) assert.ok(typeof text === 'string' && text.length > 20, key + ' is a sentence');
  const missing = Object.entries(quoted).filter(([, text]) => !privacy.includes(flat(text))).map(([key]) => key);
  assert.deepEqual(missing, [], 'docs/PRIVACY.md no longer quotes these exactly as the code holds them');
});

test('APPS.md quotes the price card line of the door word for word', () => {
  const apps = flat(read('docs/APPS.md'));
  assert.ok(apps.includes(flat(APPS_TEXT.en['apps.price.reports'])), 'docs/APPS.md does not quote apps.price.reports as the code holds it');
});

// ---------------------------------------------------------------------------------------------------------------------
// The scan of the code. A rule names a file, the call that raises an event there, and the prefix the page adds to the names of that file.

const NAME = "'([a-z][a-z0-9.-]*)'";
const LOADER_RULES = [
  { file: 'src/loader/app.js', callee: 'rep|repThrottled', first: 'A, ', skip: { repThrottled: 1 } },
  { file: 'src/loader/app.js', callee: 'A\\.report', idle: true }, // the page's own seam, called with a literal name by nobody today: a first one is read the day it is written
  { file: 'src/loader/ui.js', callee: 'rep' },
  { file: 'src/loader/api.js', callee: '_rep' },
  { file: 'src/loader/torrent.js', callee: '_rep' },
  { file: 'src/loader/apps.js', callee: '_rep', prefix: 'apps.' },
  { file: 'src/loader/apps-ui.js', callee: 'rep', prefix: 'apps.' },
  { file: 'src/loader/apps-link.js', callee: '_rep', prefix: 'link.' },
  { file: 'src/loader/obs.js', callee: 'emit|event' },
];
const IDP_RULES = [
  { file: 'src/idp/idp.js', callee: 'report' },
  { file: 'src/idp/obs-client.js', callee: 'report|say' },
];

/**
 * topKeys(src, start) -> the top-level keys of the object literal that opens at src[start], or the word '...spread' for a spread element, or null when the text
 * is not an object literal. Strings, template literals and comments are skipped over, so a comma or a brace inside them counts for nothing.
 */
function topKeys(src, start) {
  if (src[start] !== '{') return null;
  const keys = [];
  let depth = 0;
  let cur = '';
  const close = () => {
    const seg = cur.trim();
    cur = '';
    if (!seg) return;
    if (seg.startsWith('...')) { keys.push('...spread'); return; }
    const m = /^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][A-Za-z0-9_$]*))\s*(?::|$|\()/.exec(seg);
    keys.push(m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '?');
  };
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      cur += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++;
      if (depth > 1) cur += c;
    } else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) { close(); return keys; }
      cur += c;
    } else if (c === ',' && depth === 1) {
      close();
    } else {
      cur += c;
    }
  }
  return null;
}

/** skipArgument(src, i) -> the index after the argument that starts at i and the comma that ends it, or -1 when the call ends first. */
function skipArgument(src, i) {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return -1;
      depth--;
    } else if (c === ',' && depth === 0) {
      return i + 1 + /^\s*/.exec(src.slice(i + 1))[0].length;
    }
  }
  return -1;
}

/**
 * callsOf(rule, text) -> [{ name, keys }]: one entry per call that raises an event in the rule's file. keys is the list of top-level keys of the fields object
 * when the call passes an object literal, [] when it passes none, and null when it passes something else (a variable, a call): then the fields are not known
 * from the text. rule.skip[callee] is the number of arguments between the name and the fields (the interval of repThrottled). A name that ends in a dot is the
 * first half of a name the page builds ('apps.' + name) and is not an event.
 */
function callsOf(rule, text = read(rule.file)) {
  const re = new RegExp('\\b(' + rule.callee + ')\\(' + (rule.first ? rule.first : '') + NAME, 'g');
  const out = [];
  for (const m of text.matchAll(re)) {
    if (m[2].endsWith('.')) continue;
    const name = (rule.prefix || '') + m[2];
    let i = m.index + m[0].length;
    const comma = /^\s*,\s*/.exec(text.slice(i));
    if (!comma) {
      out.push({ name, keys: [] }); // no second argument: no fields
      continue;
    }
    i += comma[0].length;
    for (let s = 0; s < ((rule.skip && rule.skip[m[1]]) || 0) && i >= 0; s++) i = skipArgument(text, i);
    out.push({ name, keys: i >= 0 ? topKeys(text, i) : null });
  }
  return out;
}

/** eventsOf(rules) -> Map name -> { keys: Set of every key seen, unknown: true when a call passes fields the text does not show }. */
function eventsOf(rules, readText = read) {
  const events = new Map();
  for (const rule of rules) {
    for (const { name, keys } of callsOf(rule, readText(rule.file))) {
      const ev = events.get(name) || { keys: new Set(), unknown: false };
      if (keys === null) ev.unknown = true;
      else for (const k of keys) { if (k === '...spread' || k === '?') ev.unknown = true; else ev.keys.add(k); }
      events.set(name, ev);
    }
  }
  return events;
}

/**
 * tablesOf(doc) -> { loader: Map name -> Set of fields, idp: Map name -> Set of fields }: the rows of the tables between "## The events" and "## Turning it on".
 * The table under "### The identity page" is the identity page's; every other table is the loader's, the apps' and the pair socket's.
 */
function tablesOf(doc) {
  const a = doc.indexOf('\n## The events');
  const b = doc.indexOf('\n## Turning it on');
  assert.ok(a >= 0 && b > a, 'docs/OBSERVABILITY.md has "## The events" followed by "## Turning it on"');
  const out = { loader: new Map(), idp: new Map() };
  let group = null;
  for (const line of doc.slice(a, b).split('\n')) {
    const h = /^### (.*)$/.exec(line);
    if (h) { group = h[1].trim() === 'The identity page' ? out.idp : out.loader; continue; }
    const row = /^\| `([a-z][a-z0-9.-]+)` \| ([^|]*)\|/.exec(line);
    if (row && group) {
      assert.ok(!group.has(row[1]), 'the event ' + row[1] + ' has two rows in docs/OBSERVABILITY.md');
      group.set(row[1], new Set(Array.from(row[2].matchAll(/`([A-Za-z0-9_]+)`/g), (x) => x[1])));
    }
  }
  return out;
}

const tables = () => tablesOf(read('docs/OBSERVABILITY.md'));
const sorted = (xs) => Array.from(xs).sort();

// ---------------------------------------------------------------------------------------------------------------------
// 2. Which events

test('every event the loader raises is a row of docs/OBSERVABILITY.md, and every row of its tables is raised', () => {
  const code = eventsOf(LOADER_RULES);
  code.set('ui.click', code.get('ui.click') || { keys: new Set(), unknown: true }); // reporter.click names it through describeTarget, not through a literal call
  const rows = tables().loader;
  assert.ok(code.size >= 60, 'the scan found the loader\'s events (' + code.size + ')');
  assert.deepEqual(sorted(code.keys()).filter((n) => !rows.has(n)), [], 'raised in the code, with no row in docs/OBSERVABILITY.md');
  assert.deepEqual(sorted(rows.keys()).filter((n) => !code.has(n)), [], 'a row in docs/OBSERVABILITY.md that nothing raises');
});

test('every event the identity page raises is a row of its table of docs/OBSERVABILITY.md, and every row of it is raised', () => {
  const code = eventsOf(IDP_RULES);
  const rows = tables().idp;
  assert.deepEqual(sorted(code.keys()), sorted(rows.keys()), 'the identity page\'s events and the rows of "The identity page"');
});

test('the events name only what the grammar of the Worker allows: lower case words with dots and dashes', () => {
  const names = [...eventsOf(LOADER_RULES).keys(), ...eventsOf(IDP_RULES).keys()];
  for (const name of names) assert.match(name, /^[a-z][a-z0-9.-]{1,48}$/, name);
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Which fields

function compareFields(code, rows) {
  const problems = [];
  for (const [name, ev] of code) {
    const row = rows.get(name);
    if (!row) continue; // a missing row is the job of the tests above
    const codeOnly = sorted(ev.keys).filter((k) => !row.has(k));
    const docOnly = ev.unknown ? [] : sorted(row).filter((k) => !ev.keys.has(k));
    if (codeOnly.length || docOnly.length) problems.push(name + ': in the code only [' + codeOnly.join(', ') + '], in the table only [' + docOnly.join(', ') + ']');
  }
  return problems;
}

test('the fields of each row of docs/OBSERVABILITY.md are the keys the code passes, no more and no fewer', () => {
  const t = tables();
  assert.deepEqual(compareFields(eventsOf(LOADER_RULES), t.loader), []);
  assert.deepEqual(compareFields(eventsOf(IDP_RULES), t.idp), []);
});

test('the check of fields compares: it has real call sites to read, and it is not satisfied by an empty row', () => {
  const code = eventsOf(LOADER_RULES);
  const known = Array.from(code.values()).filter((ev) => !ev.unknown).length;
  assert.ok(known >= 40, 'the field lists of at least 40 events are read from the text of their calls (' + known + ')');
  assert.deepEqual(Array.from(code.get('site.fetch').keys).sort(), ['ms', 'step']);
  assert.deepEqual(Array.from(code.get('apps.msg').keys).sort(), ['conv', 'count', 'status'], 'the count of messages is named count: the reporter drops a field named n');
  assert.deepEqual(Array.from(code.get('link.reply').keys).sort(), ['action', 'ms', 'ok', 'reason']);
  const rows = tables().loader;
  assert.deepEqual(sorted(rows.get('gate.shown')), ['host', 'kind']);
  const spoiled = new Map(rows);
  spoiled.set('site.fetch', new Set(['step']));
  assert.match(compareFields(code, spoiled).join('\n'), /site\.fetch: in the code only \[ms\]/);
  spoiled.set('site.fetch', new Set(['step', 'ms', 'url']));
  assert.match(compareFields(code, spoiled).join('\n'), /site\.fetch: .*in the table only \[url\]/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. No other file raises an event

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    const rel = dir + '/' + name;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.js$/.test(name)) out.push(rel);
  }
  return out;
}

test('only the files of this scan raise usage-report events: a new call site has to be added to the scan, and so to the tables', () => {
  const scanned = new Set([...LOADER_RULES, ...IDP_RULES].map((r) => r.file));
  // The seams of the reports: the page's rep(A, 'name', ...) and repThrottled(A, 'name', ...), the helpers rep('name', ...) and _rep('name', ...) of the modules that
  // take a report option, and the identity page's report('name', ...) and say('name', ...). Other modules have emit('name') of their own, which are not reports.
  const seam = /\b(?:_rep|rep|repThrottled)\((?:A, )?'[a-z][a-z0-9.-]*'|\b(?:report|say)\('[a-z][a-z0-9.-]*'|\bA\.report\('[a-z][a-z0-9.-]*'|\.event\('[a-z][a-z0-9.-]*'/;
  const strays = [...sourceFiles('src/loader'), ...sourceFiles('src/idp')].filter((f) => !scanned.has(f) && seam.test(read(f)));
  assert.deepEqual(strays, [], 'these files raise a report event the scan does not read');
  for (const rule of [...LOADER_RULES, ...IDP_RULES].filter((r) => !r.idle)) assert.ok(callsOf(rule).length > 0, rule.file + ' raises events and the scan reads them');
});

// ---------------------------------------------------------------------------------------------------------------------
// The extractor

test('topKeys reads the top-level keys of an object literal and nothing inside a string, a comment or a nested value', () => {
  assert.deepEqual(topKeys("{ a: 1, 'b': 2, \"c\": 3, d }", 0), ['a', 'b', 'c', 'd']);
  assert.deepEqual(topKeys("{ a: { x: 1, y: [1, 2, { z: 3 }] }, b: f(1, 2), c: 'p, q: r', d: `t ${x}, ${y}` }", 0), ['a', 'b', 'c', 'd']);
  assert.deepEqual(topKeys('{ a: 1, // it\'s, a: comment\n  b: 2, /* c: 3, */ d: 4 }', 0), ['a', 'b', 'd']);
  assert.deepEqual(topKeys('{ ...rest, a: 1 }', 0), ['...spread', 'a']);
  assert.deepEqual(topKeys('{}', 0), []);
  assert.deepEqual(topKeys('{ a: 1 } trailing, text', 0), ['a']);
  assert.equal(topKeys('variable', 0), null);
  assert.equal(topKeys('{ a: 1', 0), null);
});

test('callsOf reads the name, the prefix and the fields of a call, and leaves out a name the page builds', () => {
  const text = [
    "rep(A, 'one', { a: 1, b })",
    "rep(A, 'apps.' + n, { skipped: 1 })",
    "repThrottled(A, 'two', everyMs || 10000, { c, d: 2 })",
    "rep(A, 'three', fields)",
    "rep(A, 'four')",
    "something.rep(A, 'five', {})",
  ].join('\n');
  const rule = { file: 'x', callee: 'rep|repThrottled', first: 'A, ', skip: { repThrottled: 1 }, prefix: 'p.' };
  const got = callsOf(rule, text).map((c) => [c.name, c.keys && c.keys.slice().sort()]);
  assert.deepEqual(got, [['p.one', ['a', 'b']], ['p.two', ['c', 'd']], ['p.three', null], ['p.four', []], ['p.five', []]]);
  const events = eventsOf([rule], () => text);
  assert.equal(events.get('p.three').unknown, true);
  assert.deepEqual(sorted(events.get('p.one').keys), ['a', 'b']);
});

test('tablesOf separates the identity page\'s table from the others and refuses a row that appears twice', () => {
  const doc = '\n## The events\n\n### The loader\n\n| Event | Fields | Raised when |\n|---|---|---|\n| `one` | `a`, `b` | x |\n| `two` | | y |\n\n### The identity page\n\n| `one` | `c` | z |\n\n## Turning it on\n';
  const t = tablesOf(doc);
  assert.deepEqual(sorted(t.loader.keys()), ['one', 'two']);
  assert.deepEqual(sorted(t.loader.get('one')), ['a', 'b']);
  assert.deepEqual(sorted(t.idp.get('one')), ['c']);
  assert.throws(() => tablesOf(doc.replace('| `two` | | y |', '| `one` | `a` | y |')), /two rows/);
});
