// test/e2e/scenarios-firefox.mjs: the Firefox lane (2026-10-22, docs/deviations/firefox.md). Playwright Firefox runs the
// scenarios the --webkit flag covers, plus the scenarios of other groups that Firefox can run, without copying them:
//
//   F-*      the WebKit scenarios (W7, W-SI, W-MD, E-CL-1W, DOOR-GUEST-W) run unchanged inside withEngine('firefox'),
//            so their launchWebkit() starts Firefox. Their labels and messages say "WebKit" in the source; the wrapper
//            prints "Firefox" instead, and every version it reports comes from the Firefox browser object.
//   F:<id>   a Chromium scenario run against a second scenario context whose browser is Firefox (makeCtx from run.mjs):
//            its own visitors and shared state, the run's servers. Only the ids in FIREFOX_CONTEXT_ORDER, the ones that
//            pass in Firefox; docs/deviations/firefox.md says why each other one cannot run.
//
// Network policy (docs/DEV-NETWORK.md): launchFirefox() in ./lib.mjs launches with firefoxLaunchOptions() from
// ./browser-args.mjs: the loopback proxy (every non-loopback request fails at 127.0.0.1:9, without a DNS query) and the
// prefs that turn Firefox's background services off. Every visitor is a lib.mjs Visitor, so the run's request guard
// and the ICE-server stripping init script apply as in Chromium.

import { launchFirefox, withEngine, withTimeout } from './lib.mjs';

/** The F-* variants of the --webkit scenarios: F-* id -> the WebKit scenario it runs. */
export const FIREFOX_FROM_WEBKIT = { F7: 'W7', 'F-SI': 'W-SI', 'F-MD': 'W-MD', 'E-CL-1F': 'E-CL-1W', 'DOOR-GUEST-F': 'DOOR-GUEST-W' };

/**
 * F-* ids that --firefox registers but leaves out of its default run, each with the reason (docs/deviations/firefox.md).
 * --only <id> still runs one, which is how a fix is checked.
 */
export const FIREFOX_HELD = Object.freeze({
  // E-CL-1F was held until the integrator of R 5.3 wrapped the closed-connection reads of callPcs (scenarios-calls.mjs); it
  // passed alone in Firefox 157.0 on 2026-10-24, so nothing is held now.
});

/**
 * Chromium scenarios that also run in a Firefox context, in run order (F:<id>): the identity sign-in, chat, files, media and
 * doors scenarios that pass in Playwright Firefox. docs/deviations/firefox.md lists every other one with the reason.
 */
export const FIREFOX_CONTEXT_SOURCES = [
  'E-SI-1', 'E-SI-2', 'E-SI-3', 'E-SI-4', 'E-SI-5', 'E-CH-6M', 'E-MD-1', 'E-MD-10', 'E-MD-8', 'E-FI-3',
  'E-SI-1W', 'E-SI-5W', 'E-CH-R',
  // R 5.3 integrator: E-MD-1 (the poster from a parted Blob, src/media/poster.js) and the identity and social rows that waited
  // on the 3000 ms click of test/e2e/idp-driver.mjs pass in Firefox 157.0 since those fixes. F:E-SO-2 is not listed: its
  // "Follow by link" click timed out in Firefox (docs/deviations/review-round-integration.md).
  'E-SO-1', 'E-SO-11', 'E-ID-2', 'E-ID-2B', 'E-ID-4',
  'E-ID-5', 'E-ID-6', 'E-ID-10', 'E-ID-7',
  'E-CH-1', 'E-CH-8', 'E-CH-6', 'E-FI-1', 'E-FI-2', 'E-MD-4', 'E-MD-3', 'E-MD-5',
  'DOOR-DOWN', 'DOOR-HASH', 'DOOR-GUEST',
];
// MW_E2E_FIREFOX_TRY=E-ID-2,E-CH-1 adds F:<id> for other scenarios, to find out whether Firefox can run them.
for (const id of String(process.env.MW_E2E_FIREFOX_TRY || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)) {
  if (!FIREFOX_CONTEXT_SOURCES.includes(id)) FIREFOX_CONTEXT_SOURCES.push(id);
}

export const FIREFOX_ORDER = Object.keys(FIREFOX_FROM_WEBKIT).concat(FIREFOX_CONTEXT_SOURCES.map((id) => 'F:' + id));

const named = (s) => (typeof s === 'string' ? s.replace(/WebKit/g, 'Firefox') : s);

/**
 * firefoxScenarios({ SCENARIOS, makeCtx, out, headed, selected }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. Call
 * it after every other group is registered: it wraps their entries. selected() gives the ids this run will run, in order.
 */
export function firefoxScenarios({ SCENARIOS, makeCtx, out = () => {}, headed = false, selected = () => [] }) {
  const S = {};
  const wrap = (fn) => async (ctx, step) => {
    const fstep = (label, f, ms) => step(named(label), f, ms);
    try {
      return named(await fn(ctx, fstep));
    } catch (err) {
      if (err && typeof err.message === 'string') err.message = named(err.message);
      throw err;
    }
  };

  for (const [id, from] of Object.entries(FIREFOX_FROM_WEBKIT)) {
    const src = SCENARIOS[from];
    if (!src) continue;
    S[id] = {
      title: named(src.title) + ' [' + from + ' in Firefox]',
      fn: wrap((ctx, step) => withEngine('firefox', () => src.fn(ctx, step))),
    };
  }

  // One Firefox browser and one Firefox scenario context per run, made on first use and closed with the run.
  async function firefoxCtx(ctx) {
    if (ctx.shared.firefoxCtx) return ctx.shared.firefoxCtx;
    const browser = await withTimeout(launchFirefox({ headless: !headed }), 60000, 'Firefox launch');
    if (!browser) throw new Error('Playwright Firefox is not installed (npx playwright install firefox)');
    const fctx = makeCtx(ctx.stack, browser);
    fctx.firefox = browser;
    // Counts the visitors a scenario opens here, so an F:<id> that never used the Firefox browser cannot pass.
    fctx.opened = 0;
    const visitor = fctx.visitor;
    fctx.visitor = (name, opts) => {
      fctx.opened++;
      return visitor(name, opts);
    };
    let closed = false;
    fctx.close = async () => {
      if (closed) return;
      closed = true;
      if (ctx.shared.firefoxCtx === fctx) ctx.shared.firefoxCtx = null;
      for (const fn of fctx.closers.reverse()) await withTimeout(Promise.resolve().then(fn), 10000, 'closer').catch(() => {});
      await fctx.closeAll().catch(() => {});
      await browser.close().catch(() => {});
    };
    ctx.closers.push(() => fctx.close());
    ctx.shared.firefoxCtx = fctx;
    return fctx;
  }

  // The Firefox visitors share the run's tracker and sites, so they must not outlive the last F:<id>: an open Firefox tab
  // still announces the site, and scenario 13 counts every announce of the old version (run.mjs, SCENARIOS[13]).
  async function closeAfterLast(ctx, id) {
    const run = selected();
    const later = run.slice(run.indexOf(id) + 1).some((x) => typeof x === 'string' && x.startsWith('F:'));
    if (!later && ctx.shared.firefoxCtx) await ctx.shared.firefoxCtx.close();
  }

  for (const from of FIREFOX_CONTEXT_SOURCES) {
    const src = SCENARIOS[from];
    if (!src) continue;
    S['F:' + from] = {
      title: src.title + ' [Firefox context]',
      fn: wrap(async (ctx, step) => {
        const fctx = await firefoxCtx(ctx);
        const opened = fctx.opened;
        try {
          const detail = await src.fn(fctx, step);
          if (fctx.opened === opened && !fctx.visitors.size) throw new Error(from + ' opened no visitor in the Firefox context, so it did not run in Firefox');
          return 'Firefox ' + fctx.firefox.version() + (detail ? ': ' + detail : '');
        } catch (err) {
          for (const v of fctx.visitors.values()) {
            if (v.closed) continue;
            try {
              out(await withTimeout(v.report(), 15000, 'report ' + v.name));
            } catch (e) {
              out('--- ' + v.name + ': no report (' + e.message + ')');
            }
          }
          throw err;
        } finally {
          await closeAfterLast(ctx, 'F:' + from);
        }
      }),
    };
  }
  return S;
}

