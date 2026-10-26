// Scenario S: sandbox tokens vs real-world behaviours inside the same-origin iframe shell.
import { withLab, openShell, frameOf, sleep, saveResults } from './lib.mjs'

const engine = process.argv[2] || 'chromium'
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation'
const VARIANTS = {
  'spec-7.2': BASE,                                                           // ARCHITECTURE 7.2 as written (no allow-modals)
  'plus-modals': BASE + ' allow-modals',                                      // = render.js v0.1 token list
  'plus-modals+escape': BASE + ' allow-modals allow-popups-to-escape-sandbox',
  'no-sandbox': null
}
const only = process.argv[3] ? process.argv[3].split(',') : null
const out = { engine, variants: {} }
const rel = (u) => String(u).replace(/^http:\/\/127\.0\.0\.1:\d+/, '').replace(/:\d+\//, ':PORT/')

async function run (browser, lab, variant, sandbox, name, body, cfgExtra = {}, path = '/behaviors.html') {
  const { ctx, page } = await openShell(browser, lab, { sandbox, mirror: 'full', ...cfgExtra }, path)
  try {
    const frame = () => frameOf(page)
    const R = () => frame().evaluate(() => window.__res).catch(() => null)
    const res = await body({ page, ctx, frame, R, lab })
    return Object.assign({ test: name }, res, { console: page.__console.filter((m) => /sandbox|blocked|ignored|refused|denied|not allowed|Unsafe/i.test(m.text)).map((m) => m.text.slice(0, 160)).slice(0, 4) })
  } catch (err) {
    return { test: name, error: String(err).slice(0, 200) }
  } finally { await ctx.close().catch(() => {}) }
}

const tests = {
  async dialogs ({ page, frame, R }) {
    await frame().click('#b-alert'); await frame().click('#b-confirm'); await frame().click('#b-prompt'); await sleep(300)
    return { dialogs: page.__dialogs.map((d) => d.type), res: await R() }
  },
  async print ({ page, frame, R }) {
    await frame().click('#b-print'); await sleep(600)
    return { res: await R() }
  },
  async beforeunload ({ page, frame }) {
    await frame().click('#b-unload'); await sleep(100)
    await frame().click('#a-home'); await sleep(1200)
    const types = page.__dialogs.map((d) => d.type)
    return { dialogs: types, frameNowAt: rel(frame().url()) }
  },
  async popups ({ page, frame, R }) {
    const out = {}
    for (const id of ['#b-open', '#a-blank', '#b-open-ext', '#a-blank-ext', '#a-blank-opener']) {
      const before = page.__popups.length
      await frame().click(id).catch(() => {}); await sleep(900)
      const pp = page.__popups[before]
      if (!pp) { out[id] = 'NO POPUP'; continue }
      await pp.waitForLoadState('load', { timeout: 5000 }).catch(() => {})
      await sleep(200)
      out[id] = { url: rel(pp.url()), title: (await pp.title().catch(() => '?')).slice(0, 160), dialogs: pp.__dialogs }
      await pp.close().catch(() => {})
    }
    return { out, res: await R() }
  },
  async downloads ({ page, frame, R }) {
    const out = {}
    for (const id of ['#a-dl', '#a-attach', '#b-blobdl']) {
      const before = page.__downloads.length
      await frame().click(id).catch(() => {}); await sleep(900)
      out[id] = page.__downloads.length > before ? page.__downloads[before].suggestedFilename() : 'NO DOWNLOAD'
    }
    return { out, frameStill: rel(frame().url()) }
  },
  async customProtocols ({ page, frame }) {
    const out = {}
    for (const id of ['#a-mailto', '#a-tel']) { await frame().click(id).catch(() => {}); await sleep(500); out[id] = rel(frame().url()) }
    return { out }
  },
  async targetTop ({ page, frame }) {
    const t0 = await page.evaluate(() => performance.timeOrigin)
    await frame().click('#a-top').catch(() => {}); await sleep(2500)
    const t1 = await page.evaluate(() => performance.timeOrigin).catch(() => null)
    return { topUrl: rel(page.url()), topReloaded: t1 !== t0, frameUrl: rel(frameOf(page) && frameOf(page).url()) }
  },
  async api ({ page, frame, R }) {
    await frame().click('#b-share'); await frame().click('#b-fs'); await sleep(700)
    await frame().click('#b-clipw').catch(() => {}); await sleep(300)
    return { res: await R() }
  },
  async ownServiceWorker ({ page, frame, R }) {
    await frame().click('#b-sw'); await sleep(2500)
    const regs = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), active: r.active && r.active.scriptURL.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), waiting: r.waiting && r.waiting.scriptURL.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), installing: r.installing && r.installing.scriptURL.replace(/^http:\/\/127\.0\.0\.1:\d+/, '') })))
    return { res: await R(), regs }
  }
}

await withLab(engine, async (lab, browser) => {
  for (const [variant, sandbox] of Object.entries(VARIANTS)) {
    if (only && !only.includes(variant)) continue
    out.variants[variant] = { sandbox, results: [] }
    for (const [name, body] of Object.entries(tests)) {
      const r = await run(browser, lab, variant, sandbox, name, body)
      out.variants[variant].results.push(r)
      console.log(`[${engine}] ${variant.padEnd(20)} ${name.padEnd(18)} ${JSON.stringify(r).slice(0, 520)}`)
    }
  }
})
console.log('saved', saveResults('sandbox', engine, out))
