// The v0.3 code review found documents that described things as built which were not (the wording rules of DESIGN-REVIEW
// section 4 bind documents too). Each test reads a document and the code it describes, so the claim and the code cannot drift
// apart again: the rights table of PRIVACY.md, the background tasks of the Service Worker, the open-writing protections of
// MF-54, the record-key limit, and the pass counts of the R 4.2 table against the e2e scenarios' own headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../../tools/lib.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const flat = (t) => t.replace(/\s+/g, ' ');
/** tableAfter(text, heading) -> the rows (arrays of trimmed cells) of the first Markdown table after the heading line. */
function tableAfter(text, heading) {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.trim() === heading);
  assert.ok(i >= 0, 'no heading ' + heading);
  while (i < lines.length && !lines[i].startsWith('|')) i++;
  const rows = [];
  for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  assert.ok(rows.length > 2, 'no table after ' + heading);
  return { head: rows[0], rows: rows.slice(2) };
}

test('PRIVACY.md "Your rights": every action names the method, card or tool that does it, or is marked (proposed)', () => {
  const { head, rows } = tableAfter(read('docs/PRIVACY.md'), '### Your rights, and what removal reaches');
  const where = head.indexOf('Where it is');
  assert.ok(where > 0, 'the table has a "Where it is" column');
  const sdk = read('src/sdk/sdk.js');
  const labels = read('src/loader/strings.js') + read('src/idp/strings.js');
  const problems = [];
  for (const r of rows) {
    const action = r[0], cell = r[where];
    if (/\(proposed\)/.test(cell)) continue;
    let evidence = 0;
    for (const m of cell.matchAll(/`mw\.([a-z]+\.[a-zA-Z]+)\(/g)) { evidence++; if (!sdk.includes("'" + m[1] + "'")) problems.push(action + ': no SDK method ' + m[1]); }
    for (const m of cell.matchAll(/"([^"]+)"/g)) { evidence++; if (!labels.includes("'" + m[1] + "'")) problems.push(action + ': no card or button labelled "' + m[1] + '"'); }
    for (const m of cell.matchAll(/`node (tools\/[a-z-]+\.mjs) ([a-z-]+)`/g)) {
      evidence++;
      if (!existsSync(join(ROOT, m[1])) || !read(m[1]).includes("'" + m[2] + "'")) problems.push(action + ': no command ' + m[1] + ' ' + m[2]);
    }
    if (!evidence) problems.push(action + ': names no method, card or tool and is not marked (proposed)');
  }
  assert.deepEqual(problems, []);
  // "Leave this site" (R 2.15) has no method yet: the row says so, and so does the notice template.
  const leave = rows.find((r) => r[0] === 'Leave this site');
  assert.ok(leave && /\(proposed\)/.test(leave[where]), 'Leave this site is not built: its row is marked (proposed)');
  assert.doesNotMatch(flat(read('docs/PRIVACY.md')), /"Leave this site" in Settings/);
});

// Background Sync, Periodic Sync, Background Fetch and Web Push are P3 (SZ section 2). A document may say the loader does one of them
// only when the Service Worker has the handler.
const BACKGROUND = [
  { name: 'Background Sync', handler: /addEventListener\(\s*['"]sync['"]/ },
  { name: 'Periodic Sync', handler: /addEventListener\(\s*['"]periodicsync['"]/ },
  { name: 'Background Fetch', handler: /addEventListener\(\s*['"]backgroundfetch/ },
  { name: 'Web Push', handler: /addEventListener\(\s*['"]push['"]/ },
];

test('the Service Worker\'s background tasks: COMPATIBILITY and ARCHITECTURE 8.1.8 say "(proposed" for each one src/sw does not handle', () => {
  const sw = readdirSync(join(ROOT, 'src', 'sw')).filter((n) => n.endsWith('.js')).map((n) => read('src/sw/' + n)).join('\n');
  const { head, rows } = tableAfter(read('docs/COMPATIBILITY.md'), '### Capabilities the C2 features use');
  const does = head.indexOf('What the loader does');
  assert.ok(does > 0);
  const arch = flat(read('docs/ARCHITECTURE.md'));
  const p818 = arch.slice(arch.indexOf('**8.1.8 When the tab is gone.**'), arch.indexOf('**8.1.9'));
  assert.ok(p818.length > 100, 'ARCHITECTURE 8.1.8 found');
  const problems = [];
  for (const b of BACKGROUND) {
    if (b.handler.test(sw)) continue; // built: nothing to check
    const row = rows.find((r) => r[0] === b.name);
    if (row && !/\(proposed/.test(row[does])) problems.push('COMPATIBILITY ' + b.name + ': "' + row[does] + '" but src/sw has no handler');
    if (p818.includes(b.name) && !/\(proposed/.test(p818)) problems.push('ARCHITECTURE 8.1.8 names ' + b.name + ' as built');
  }
  assert.deepEqual(problems, []);
  assert.ok(rows.some((r) => r[0] === 'Periodic Sync'), 'the rows are still there');
});

test('MF-54: the documents claim no open-writing warning and no per-author byte quota that the code does not have', () => {
  const tool = read('tools/ledger-admin.mjs');
  const chain = read('src/chain/node.js') + read('src/chain/state.js');
  const warns = /warn\([^)]*open/i.test(tool);
  const quota = /per-?author[^\n]{0,40}byte|authorQuota|maxAuthorBytes|perAuthorBytes/i.test(chain);
  const ops = flat(read('docs/OPERATIONS.md'));
  if (!warns) assert.doesNotMatch(ops, /`ledger-admin` warns when a policy opens writing/);
  if (!quota) {
    assert.doesNotMatch(ops, /a per-author byte quota applies/);
    const row = read('docs/THREAT-MODEL.md').split('\n').find((l) => l.startsWith('| MAL A12 '));
    assert.ok(row, 'THREAT-MODEL has the MAL A12 row');
    assert.ok(!/per-author quotas/.test(row) || /\(proposed\)/.test(row), 'MAL A12 lists per-author quotas as built: ' + row);
  }
});

test('the record-key limit: no document says a removed record key can never come back (docs/deviations/idp.md item 18)', () => {
  for (const f of ['docs/PRIVACY.md', 'docs/FAQ.md', 'docs/SDK.md']) assert.doesNotMatch(flat(read(f)), /cannot be recovered, by the person or by anyone/i, f);
  const privacy = flat(read('docs/PRIVACY.md'));
  const at = privacy.indexOf('A removed record key cannot be recovered');
  assert.ok(at > 0 && /backup file/.test(privacy.slice(at, at + 600)), 'PRIVACY.md states what still holds the key');
});

// The R 4.2 table: "pass" means the row as the review writes it ran. A row is not "pass" when every scenario it names calls itself
// PARTIAL in its file's header (the convention of test/e2e/scenarios-*.mjs).
function partialScenarios() {
  const out = new Map(); // id (upper case) -> true when the header calls it PARTIAL
  for (const name of readdirSync(join(ROOT, 'test', 'e2e')).filter((n) => n.endsWith('.mjs'))) {
    const lines = read('test/e2e/' + name).split('\n');
    let id = null;
    for (const line of lines) {
      if (!line.startsWith('//')) { id = null; continue; }
      const m = /^\/\/\s{2,}(E-[A-Z]{2}-\d+[A-Za-z]*|W-[A-Z0-9]+)\s/.exec(line);
      if (m) { id = m[1].toUpperCase(); if (!out.has(id)) out.set(id, false); }
      else if (!/^\/\/\s{4,}\S/.test(line)) id = null;
      if (id && /PARTIAL/.test(line)) out.set(id, true);
    }
  }
  return out;
}

test('the R 4.2 table of deviations/integration-v03.md: a "pass" row names a scenario that does not call itself PARTIAL, and the counts add up', () => {
  const text = read('docs/deviations/integration-v03.md');
  const headLine = text.split('\n').find((l) => l.startsWith('| Row | Status | Where |'));
  assert.ok(headLine, 'the R 4.2 table');
  const { rows } = tableAfter(text, headLine.trim());
  const partial = partialScenarios();
  assert.ok(partial.size > 20, 'scenario headers found: ' + partial.size);
  const problems = [];
  const count = { pass: 0, 'pass, partial': 0, open: 0 };
  for (const r of rows) {
    if (!/^E-/.test(r[0])) continue;
    count[r[1]] = (count[r[1]] || 0) + 1;
    if (r[1] !== 'pass') continue;
    const ids = [...r[2].matchAll(/\b(E-[A-Z]{2}-\d+[A-Za-z]*|W-[A-Z]+)\b/g)].map((m) => m[1].toUpperCase());
    if (!ids.length) continue; // a row that names a unit or browser test, not an e2e scenario
    if (ids.every((id) => partial.get(id) === true)) problems.push(r[0] + ' is "pass" but ' + ids.join(', ') + ' call themselves PARTIAL');
    for (const id of ids) if (!partial.has(id)) problems.push(r[0] + ' names ' + id + ', which no scenario header lists');
  }
  assert.deepEqual(problems, []);
  const total = count.pass + count['pass, partial'];
  const line = flat(text).match(/In all: (\d+) rows, (\d+) that ran and passed \((\d+) as written, (\d+) in part\) and (\d+) open\./);
  assert.ok(line, 'the "In all" line');
  assert.deepEqual(line.slice(1).map(Number), [count.pass + count['pass, partial'] + count.open, total, count.pass, count['pass, partial'], count.open]);
  const status = flat(read('docs/INTEGRATION-STATUS.md'));
  assert.ok(status.includes(total + ' ran and passed (' + count.pass + ' as written, ' + count['pass, partial'] + ' in part)'), 'INTEGRATION-STATUS.md repeats the counts');
});
