// test/e2e/scenarios-formats.mjs: the v0.2.1 format scenarios (DIGEST-AMENDMENTS A3, A4), run by
// test/e2e/run.mjs as FMT-SDK and FMT-WITHDRAW. Same rules as the rest of the suite
// (docs/DEV-NETWORK.md): Chromium with the local-only flags, every URL on 127.0.0.1.
//
//   FMT-SDK       the site-callable SDK in a real shell page: no identity.export, identity.import or
//                 consent.accept on window.mw (v0.3, R 2.11.1: identity has current, setName, backupStatus
//                 and openIdentity; ready() names a guest's identity null), raw Bridge requests for them are
//                 refused, and mw.consent.request() opens the loader's own card and resolves with the
//                 visitor's choice (A4)
//   FMT-WITHDRAW  publish --withdraw: a visitor who holds the site stops serving and seeding it, deletes
//                 every stored version and sees the publisher's reason; a new visitor fetches no site
//                 file and opens no socket (A3). The original pointer is restored afterwards.

import { join } from 'node:path';

import { waitUntil, waitForSite, shellState, storedSites, sleep, inFrame, acceptConsent } from './lib.mjs';
import { STRINGS } from '../../src/loader/strings.js';
import { withdraw } from '../../tools/withdraw.mjs';

/** formatScenarios({ assert }) → { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function formatScenarios({ assert }) {
  const S = {};

  S['FMT-SDK'] = {
    title: 'site-callable SDK (A4, R 2.11.1): no identity export/import or consent.accept; consent.request opens the loader card and returns the visitor\'s choice',
    async fn(ctx, step) {
      await ctx.closeAll();
      const v = await ctx.visitor('SDK');
      const page = await v.newPage();
      await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await waitForSite(page, { timeoutMs: 30000, label: 'SDK: the site renders before a choice' });
      await step('the site frame imports /_mw/sdk.js: identity has current, setName, backupStatus and openIdentity (no export, import or root), consent has request and state', async () => {
        const surface = await waitUntil(() => inFrame(page, async () => {
          const mw = (await import('/_mw/sdk.js')).default;
          const info = await mw.ready();
          return { identity: Object.keys(mw.identity).sort(), consent: Object.keys(mw.consent).sort(), auth: info.auth, id: info.identity, version: mw.version };
        }), { timeoutMs: 30000, label: 'SDK ready in the frame' });
        assert(JSON.stringify(surface.identity) === '["backupStatus","current","openIdentity","setName"]', 'identity ' + JSON.stringify(surface.identity));
        assert(JSON.stringify(surface.consent) === '["request","state"]', 'consent ' + JSON.stringify(surface.consent));
        // v0.3 (R 2.4.1): a visitor who has not signed in is a guest; there is no per-site key until the identity page gives one.
        assert(surface.auth === 'guest' && surface.id === null, 'a guest: auth ' + surface.auth + ', identity ' + JSON.stringify(surface.id));
        assert(surface.version === '0.3.0', 'SDK version ' + surface.version);
      });
      const state = await step('mw.consent.request() from the site: pending until the visitor clicks in the loader card, then accepted', async () => {
        await inFrame(page, () => { window.__req = null; import('/_mw/sdk.js').then((m) => m.default.consent.request()).then((s) => { window.__req = s; }, (e) => { window.__req = 'error ' + e.code; }); });
        await sleep(800);
        const early = await inFrame(page, () => window.__req);
        assert(early === null, 'the request settled before any click: ' + early);
        await acceptConsent(page, { timeoutMs: 15000 });
        const s = await waitUntil(() => inFrame(page, () => window.__req), { timeoutMs: 10000, label: 'request settled' });
        assert(s === 'accepted', 'request resolved with ' + s);
        const st = await shellState(page);
        assert(st && st.consent === 'accepted', 'shell consent ' + (st && st.consent));
        return s;
      });
      // Last: a raw hello makes the Bridge adopt a new port, so the SDK's own port is not used after it.
      await step('raw port requests for every loader-only method (identity.export, identity.import, identity.root, consent.accept, link.accept, keys.export, media.key) are refused (E_BAD_REQUEST)', async () => {
        const codes = await inFrame(page, async () => {
          const ask = (method, params) => new Promise((resolve) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = (e) => { if (e.data && e.data.id === 'raw') { resolve(e.data.ok ? 'ok' : e.data.error.code); ch.port1.close(); } };
            window.parent.postMessage({ mw: 'hello', proto: 1 }, window.origin, [ch.port2]);
            ch.port1.postMessage({ id: 'raw', method, params });
            setTimeout(() => resolve('timeout'), 5000);
          });
          return [await ask('identity.export', { passphrase: 'long enough' }), await ask('identity.import', { blob: 'x', passphrase: 'y' }), await ask('consent.accept', {}),
            await ask('identity.root', {}), await ask('link.accept', {}), await ask('keys.export', {}), await ask('media.key', { id: 'x' })];
        });
        assert(codes.every((c) => c === 'E_BAD_REQUEST'), 'codes ' + JSON.stringify(codes));
      });
      await ctx.closeVisitor('SDK');
      return 'surface has no export/import/accept; raw requests E_BAD_REQUEST; consent.request resolved ' + state + ' only after the visitor\'s click';
    },
  };

  S['FMT-WITHDRAW'] = {
    title: 'publish --withdraw (A3): the holder deletes every stored version, stops sharing and shows the reason; a new visitor fetches nothing',
    async fn(ctx, step) {
      const { stack } = ctx;
      await ctx.closeAll();
      const oldBtih = ctx.btih;
      const v = await ctx.visitor('WD');
      const { page } = await step('visitor WD renders the site and stores it', async () => {
        const r = await ctx.openSite('WD');
        await waitUntil(async () => ((await storedSites(r.page)).indexOf(oldBtih) >= 0 ? true : null), { timeoutMs: 20000, label: 'site stored' });
        return r;
      });
      let restored = false;
      try {
        const wd = await step('publish --withdraw (why=copyright, seq + 100) and switch the page tag to it', async () => {
          const res = await withdraw({
            scope: '127.0.0.1', key: stack.owner.file, out: join(stack.runDir, 'withdraw'), why: 'copyright', ct: 'mailto:abuse@example.com',
            seq: Number(stack.pub.record.seq) + 100, exp: 30, quiet: true,
          });
          stack.dev.setPointer(res.pointer);
          return res;
        });
        const reloadAt = Date.now();
        const held = await step('WD reloads: "' + STRINGS.withdrawnTitle + '" with the reason, no frame, no stored version', async () => {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
          await waitUntil(() => page.evaluate((t) => document.body.textContent.indexOf(t) >= 0, STRINGS.withdrawnTitle), { timeoutMs: 15000, label: 'withdrawal notice' });
          const text = await page.evaluate(() => document.body.textContent);
          assert(text.indexOf('The publisher wrote (not checked): "copyright"') >= 0, 'the reason is not shown (quoted as the publisher\'s, PTR-12)');
          const st = await shellState(page);
          assert(st && st.withdrawn && st.withdrawn.why === 'copyright' && st.withdrawn.ct === 'mailto:abuse@example.com', 'inspect ' + JSON.stringify(st && st.withdrawn));
          assert(st.withdrawn.deleted >= 1, 'deleted ' + st.withdrawn.deleted);
          assert(!st.mounted, 'the site frame was mounted');
          await waitUntil(async () => ((await storedSites(page)).length === 0 ? true : null), { timeoutMs: 10000, label: 'IndexedDB holds no version' });
          return st.withdrawn.deleted;
        });
        await step('3 s later: WD sent no announce after the reload', async () => {
          await sleep(3000);
          const late = v.announces.filter((a) => a.t >= reloadAt + 500 && a.event !== 'stopped');
          assert(!late.length, 'announces after the withdrawal: ' + JSON.stringify(late.slice(0, 3)));
        });
        await step('WD reloads again: the cached withdrawal applies at boot (never a frame, no socket)', async () => {
          const before = v.sockets.length;
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
          await waitUntil(() => page.evaluate((t) => document.body.textContent.indexOf(t) >= 0, STRINGS.withdrawnTitle), { timeoutMs: 15000, label: 'withdrawal notice at boot' });
          await sleep(1000);
          const st = await shellState(page);
          assert(st && st.withdrawn && !st.mounted, 'state ' + JSON.stringify(st && { withdrawn: st.withdrawn, mounted: st.mounted }));
          assert(v.sockets.length === before, 'a WebSocket opened after the withdrawal');
        });
        await step('a new visitor: the notice, no site file or .torrent requested, no WebSocket', async () => {
          const x = await ctx.visitor('WX');
          const p = await x.newPage();
          const fetched = [];
          p.on('request', (req) => { const u = req.url(); if (u.indexOf(stack.siteFilesPrefix) >= 0 || /\.torrent(\?|$)/.test(u)) fetched.push(u); });
          await p.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await waitUntil(() => p.evaluate((t) => document.body.textContent.indexOf(t) >= 0, STRINGS.withdrawnTitle), { timeoutMs: 15000, label: 'withdrawal notice (new visitor)' });
          await sleep(1500);
          assert(!fetched.length, 'site files requested: ' + fetched.slice(0, 3).join(', '));
          assert(!x.sockets.length, 'WebSocket: ' + x.sockets.map((s) => s.url).join(', '));
        });
        stack.dev.setPointer(stack.pub.pointer);
        restored = true;
        await ctx.closeAll();
        return 'withdrawal of ' + wd.budget.bytes + ' bytes: WD deleted ' + held + ' stored version(s), shows the reason, announced nothing after it; a new visitor fetched nothing and opened no socket';
      } finally {
        if (!restored) stack.dev.setPointer(stack.pub.pointer);
      }
    },
  };

  return S;
}

export const FORMAT_ORDER = ['FMT-SDK', 'FMT-WITHDRAW'];
