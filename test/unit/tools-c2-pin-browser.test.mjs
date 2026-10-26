// Real-browser check of the pin bridge (tools/pin.mjs attachPinBridge; code review v0.3, security lens finding 12), opt-in like the
// other *-browser tests:
//   MW_BROWSER=1 node --test test/unit/tools-c2-pin-browser.test.mjs      (npm run test:browser sets it)
// Chromium only, launched with chromiumArgs() (local-only), on a page built with setContent: nothing is fetched, no port is opened.
// A same-origin child frame (the shell's site frame is one) reaches the top frame's binding through window.top.__mwPinCall and
// Playwright reports the top frame for that call, so the frame check is no boundary: the test shows that what the child can ask
// for gets it nothing (an unsigned or forged request naming the owner is refused, nothing is queued or pinned), that its own
// binding is refused, and that a request the owner key signed, from the top frame, is pinned at once (--auto-accept owner).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPinHost, attachPinBridge } from '../../tools/pin.mjs';
import { makePinRequest } from '../../src/pin/frames.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { chromiumArgs } from '../e2e/browser-args.mjs';

const ENABLED = process.env.MW_BROWSER === '1';
let chromium = null;
if (ENABLED) {
  try {
    const pw = await import('playwright');
    chromium = pw.chromium || (pw.default && pw.default.chromium);
  } catch (_) {
    chromium = null;
  }
}
const skip = !ENABLED ? 'set MW_BROWSER=1 to run the browser checks' : !chromium ? 'Playwright Chromium is not installed' : false;

const work = mkdtempSync(join(tmpdir(), 'mw-pin-bridge-'));
after(() => rmSync(work, { recursive: true, force: true }));
const LEDGER = 'mw1:pinBridgeBrowserLedger0000';
const IH = (k) => String(k).padStart(2, '0').repeat(20).slice(0, 40);

async function key() {
  const kp = await generateKeyPair();
  return { pub: await exportPublicKey(kp.publicKey), privateKey: kp.privateKey };
}

class FakeSeeder {
  constructor() {
    this.started = [];
  }

  async start(meta) {
    this.started.push(meta.ih);
    return 'ok';
  }

  async stop() {
    return 'ok';
  }
}

test('a same-origin child frame that calls top.__mwPinCall gets nothing: unsigned or forged requests are refused; its own binding is refused; the owner\'s signed request pins', { skip, timeout: 120000 }, async () => {
  const owner = await key();
  const stranger = await key();
  const seeder = new FakeSeeder();
  const host = createPinHost({ profileDir: join(work, 'profile'), files: true, autoAccept: 'owner', seeder, log: () => {} });
  await host.setSite({ ledgerId: LEDGER, owner: owner.pub });
  const browser = await chromium.launch({ headless: true, args: chromiumArgs({ allowRemote: false }) });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const remote = [];
    page.on('request', (r) => { if (!/^(data:|about:|blob:)/.test(r.url())) remote.push(r.url()); });
    await attachPinBridge(context, host, { page });
    await page.setContent('<!doctype html><title>pinned page</title><iframe id="site" srcdoc="<p>site code</p>"></iframe>');
    const child = page.frames().find((f) => f !== page.mainFrame());
    assert.ok(child, 'the site frame');
    assert.equal(await child.evaluate(() => window.top.document.title), 'pinned page', 'the child is same-origin with the top frame');
    // The child names the owner as the author of a request it did not sign.
    const unsigned = await child.evaluate((a) => window.top.__mwPinCall('file.request', { ih: a.ih, size: 10, author: a.owner }), { ih: IH(1), owner: owner.pub });
    assert.deepEqual(unsigned, { queued: false, reason: 'unsigned' }, 'refused: the frame check let it through, the signature check does not');
    // ... or signs one with its own key and claims the owner.
    const forged = await makePinRequest({ site: LEDGER, ih: IH(2), size: 10, author: stranger.pub, at: Date.now() }, stranger.privateKey);
    forged.author = owner.pub;
    assert.deepEqual(await child.evaluate((r) => window.top.__mwPinCall('file.request', r), forged), { queued: false, reason: 'bad-signature' });
    // Its own binding is refused outright.
    const own = await child.evaluate((a) => window.__mwPinCall('stats', {}).then(() => 'answered', (e) => String(e && e.message)), null);
    assert.match(own, /top frame/);
    assert.deepEqual(host.files.queue(), []);
    assert.deepEqual(host.files.pinned(), []);
    assert.deepEqual(seeder.started, []);
    // The owner's own signed request (it would come from the owner's browser through the page) is pinned at once.
    const good = await makePinRequest({ site: LEDGER, ih: IH(3), size: 10, author: owner.pub, at: Date.now() }, owner.privateKey);
    const res = await page.evaluate((r) => window.__mwPinCall('file.request', r), good);
    assert.deepEqual(res, { queued: true, accepted: true, seeding: true });
    assert.deepEqual(seeder.started, [IH(3)]);
    assert.deepEqual(remote, [], 'nothing was fetched');
  } finally {
    await browser.close();
  }
});
