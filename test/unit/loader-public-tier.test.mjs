// Unit tests for what the public-tier test campaign of 2026-11-01 (seven lanes of isolated headless browsers against the example
// site, the identity page and a door on real hosts) changed in the loader's strings and status bar: the dates the loader prints
// are the visitor's own calendar dates, not UTC ones, and the door view's mode chip names the address, not the browser. The
// other fixes of that campaign are tested next to their code (loader-doors, deploy-rtc-worker, tools-check).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STRINGS, STRINGS_FR, STRING_HELPERS, stringsFor } from '../../src/loader/strings.js';
import { createUI } from '../../src/loader/ui.js';
import { FakeDocument, FakeNode } from './dropin-fake-dom.mjs';

test('isoDate: the visitor\'s own calendar date (it printed the UTC one: "key remembered since 2026-11-02" at 20:00 on 2026-11-01 in the Americas)', () => {
  const { isoDate } = STRING_HELPERS;
  const evening = new Date(2026, 10, 1, 21, 0, 0); // 21:00 local time on 2026-11-01, whatever the zone of the machine
  assert.equal(isoDate(evening), '2026-11-01');
  assert.equal(isoDate(evening.getTime()), '2026-11-01', 'milliseconds since the epoch');
  assert.equal(isoDate(Math.floor(evening.getTime() / 1000)), '2026-11-01', 'seconds since the epoch');
  assert.equal(isoDate(new Date(2026, 0, 5, 0, 30, 0)), '2026-01-05', 'zero-padded');
  assert.equal(isoDate('nope'), 'nope', 'not a date: printed as given');
  assert.match(STRINGS.pointerBadge({ source: 'meta', signed: true, pinnedSince: evening.getTime() }), /key remembered since 2026-11-01$/);
  assert.equal(STRINGS.pointerExpired(evening.getTime()), 'Pointer expired on 2026-11-01; showing the last known version.');
});

test('the door view\'s mode chip names the address, not the browser (the expanded bar said "no offline engine" at a door on 2026-11-01)', () => {
  class DomNode extends FakeNode {
    get classList () {
      const node = this;
      const list = () => String(node.className || '').split(/\s+/).filter(Boolean);
      const add = (...c) => { node.className = Array.from(new Set(list().concat(c))).join(' '); };
      const remove = (...c) => { node.className = list().filter((x) => c.indexOf(x) < 0).join(' '); };
      return { add, remove, toggle: (c, on) => { const has = list().indexOf(c) >= 0; const want = on === undefined ? !has : !!on; if (want !== has) { if (want) add(c); else remove(c); } return want; }, contains: (c) => list().indexOf(c) >= 0 };
    }
    get dataset () { if (!this._data) this._data = {}; return this._data; }
    querySelector (sel) {
      if (sel.startsWith('#')) return this.find((n) => n.getAttribute && n.getAttribute('id') === sel.slice(1)) || null;
      return this.find((n) => String(n.className || '').split(/\s+/).some((c) => sel.split(',').some((s) => s.trim() === '.' + c))) || null;
    }
  }
  class DomDocument extends FakeDocument { createElement (tag, attrs = null) { const el = new DomNode(tag, this); if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]); return el; } }
  const doc = new DomDocument();
  const win = { document: doc, navigator: { language: 'en-CA' }, matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem () {} }, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h), console };
  doc.defaultView = win;
  const root = doc.createElement('div');
  root.setAttribute('id', 'mw-root');
  doc.body.appendChild(root);
  const ui = createUI(root, STRINGS, { lang: 'en-CA' });
  const chip = root.find((n) => String(n.className || '').split(/\s+/).indexOf('mw-mode') >= 0);
  assert.ok(chip, 'the mode chip of the bar');
  ui.setMode({ degraded: true, door: true });
  assert.equal(chip.textContent, STRINGS.limitedDoor);
  assert.equal(chip.hidden, false);
  ui.setMode({ degraded: true });
  assert.equal(chip.textContent, STRINGS.limitedMode, 'limited mode elsewhere still names the missing engine');
  ui.setMode({ hostOnly: true });
  assert.equal(chip.textContent, STRINGS.hostOnlyBadge);
  ui.setMode({});
  assert.equal(chip.hidden, true);
  // the wording rules: plain ASCII, no dash, the sentence says what the address cannot do; French falls back to English for it
  assert.match(STRINGS.limitedDoor, /^[\x20-\x7e]+$/);
  assert.match(STRINGS.limitedDoor, /this address cannot store anything for the site/);
  assert.equal(stringsFor('fr').limitedDoor, STRINGS_FR.limitedDoor || STRINGS.limitedDoor);
});
