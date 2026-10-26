// test/e2e/scenarios-hardening.mjs: the v0.2.1 hardening that ships with v0.3, against a hostile peer in a real browser
// (V03-DESIGN-REVIEW 2.16.4, MF-73; Part 4.2 E-HD-1). Same rules as the rest of the suite: Chromium with the local-only
// flags, every URL on 127.0.0.1; the hostile page is served by the e2e gate (a 127.0.0.1 response, as PEER-11's).
//
//   E-HD-1   a peer in the ledger's rendezvous swarm sends mw_chain1 HELLO frames with d = Number.MAX_SAFE_INTEGER: the
//            visitor's tab does not freeze (event-loop lag measured in the page), the frames are refused by the codec's
//            bounds, and the site keeps working. (The other two halves of the row, one peer id on many wires and a
//            ut_metadata flood on the phone class, are unit-tested: harden-loader-wires, harden-chain-hello.)

import { waitUntil, sleep, StepError, Visitor, siteFrame } from './lib.mjs';
import { rendezvousInfoHash } from '../../src/loader/torrent.js';

export const HARDENING_ORDER = ['E-HD-1'];

// The hostile peer: the vendored WebTorrent bundle, the rendezvous infohash, and an mw_chain1 extension that answers the
// extended handshake with HELLO frames whose d is Number.MAX_SAFE_INTEGER (type byte 1, then the JSON of the frame).
function hostilePage() {
  return `<!doctype html><meta charset="utf-8"><title>hostile chain peer</title>
<script type="module">
import WebTorrent from '/_mw/webtorrent.min.js';
const q = new URLSearchParams(location.search);
window.__evil = { wires: 0, handshakes: 0, sent: 0, closed: 0, errors: [] };
const hello = { v: 1, site: q.get('site'), owner: null, n: 1, d: Number.MAX_SAFE_INTEGER, root: '0'.repeat(64), heads: [] };
const json = new TextEncoder().encode(JSON.stringify(hello));
const frame = new Uint8Array(json.length + 1);
frame[0] = 1;
frame.set(json, 1);
function Chain(wire) { this._wire = wire; }
Chain.prototype.name = 'mw_chain1';
Chain.prototype.onHandshake = function () {};
Chain.prototype.onMessage = function () {};
Chain.prototype.onExtendedHandshake = function (h) {
  window.__evil.handshakes++;
  if (!h || !h.m || !h.m.mw_chain1) return;
  for (let i = 0; i < 60; i++) {
    try { this._wire.extended('mw_chain1', frame); window.__evil.sent++; } catch (e) { window.__evil.errors.push(String(e && e.message || e)); break; }
  }
};
const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } }, dht: false, lsd: false, utPex: false, webSeeds: false });
client.on('error', (e) => window.__evil.errors.push(String(e && e.message || e)));
const t = client.add('magnet:?xt=urn:btih:' + q.get('ih'), { announce: [q.get('tr')] });
t.on('wire', (wire) => {
  window.__evil.wires++;
  wire.use(Chain);
  wire.once('close', () => { window.__evil.closed++; });
});
</script>`;
}

/** hardeningScenarios({ assert, run }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function hardeningScenarios({ assert, run }) {
  const S = {};

  S['E-HD-1'] = {
    title: 'a peer sending mw_chain1 HELLO frames with d = Number.MAX_SAFE_INTEGER does not freeze the tab; the codec refuses them and the site keeps working',
    async fn(ctx, step) {
      const { stack } = ctx;
      await ctx.closeAll();
      const html = hostilePage();
      stack.gate.setRoute((req, res) => {
        const url = new URL(req.url, 'http://gate.invalid');
        if (url.pathname !== '/e2e-hd1.html') return false;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return true;
      });
      try {
        const { page: victim } = await step('visitor HDV renders the site and shares it (the ledger\'s rendezvous swarm)', () => ctx.openSite('HDV'));
        const ih = await rendezvousInfoHash(ctx.ledgerId);
        await step('HDV announces the rendezvous swarm', () => waitUntil(() => ctx.visitors.get('HDV').announces.some((a) => a.btih === ih), { timeoutMs: 20000, label: 'rendezvous announce' }));
        await step('an event-loop lag meter runs in HDV\'s page', () => victim.evaluate(() => {
          window.__lag = { max: 0, ticks: 0 };
          let last = performance.now();
          setInterval(() => {
            const now = performance.now();
            window.__lag.max = Math.max(window.__lag.max, now - last - 50);
            window.__lag.ticks++;
            last = now;
          }, 50);
        }));
        const evil = await Visitor.open(ctx.browser, 'HD-EVIL', run, { serviceWorkers: 'block' });
        ctx.visitors.set('HD-EVIL', evil);
        const ep = await evil.newPage();
        const sent = await step('the hostile peer joins the rendezvous swarm and sends 60 HELLO frames with d = 2^53 - 1', async () => {
          await ep.goto(ctx.origin + 'e2e-hd1.html?ih=' + ih + '&site=' + encodeURIComponent(ctx.ledgerId) + '&tr=' + encodeURIComponent(stack.tracker.url), { waitUntil: 'load', timeout: 20000 });
          return waitUntil(async () => {
            const e = await ep.evaluate(() => window.__evil || null);
            if (e && e.errors && e.errors.length) throw new StepError('hostile peer: ' + e.errors[0]);
            return e && e.sent >= 60 ? e : null;
          }, { timeoutMs: 30000, label: 'HELLO frames sent' });
        });
        const lag = await step('3 s later: HDV\'s event loop never stalled (the codec refuses the frames before any work)', async () => {
          await sleep(3000);
          const l = await victim.evaluate(() => window.__lag);
          assert(l.ticks >= 40, 'the lag meter did not run: ' + JSON.stringify(l));
          assert(l.max < 1000, 'the tab stalled for ' + Math.round(l.max) + ' ms');
          return l;
        });
        await step('the site still answers: mw.ready() in the site frame', async () => {
          const info = await siteFrame(victim).evaluate(async () => (await import('/_mw/sdk.js')).default.ready());
          assert(info && info.siteId === ctx.ledgerId, 'ready() ' + JSON.stringify(info));
        });
        return sent.sent + ' HELLO frames on ' + sent.wires + ' wire(s); the longest event-loop stall in the visitor\'s tab was ' + Math.round(lag.max) + ' ms over ' + lag.ticks + ' ticks';
      } finally {
        stack.gate.setRoute(null);
        await ctx.closeVisitor('HD-EVIL');
      }
    },
  };

  return S;
}
