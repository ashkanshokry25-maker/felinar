// Scenario H: iframe navigation vs top URL mirroring, back/forward, reload, SPA pushState, hash.
import { withLab, openShell, frameOf, makeSnap, back, forward, sleep, saveResults } from './lib.mjs'

const engine = process.argv[2] || 'chromium'
const out = { engine, runs: [] }

await withLab(engine, async (lab, browser) => {
  for (const mirror of ['none', 'load', 'full']) {
    const { ctx, page } = await openShell(browser, lab, { mirror }, '/a.html')
    const snap = makeSnap(page)
    const rows = []
    rows.push(await snap('open /a.html'))
    const nav = async (sel, expectLoads) => {
      await frameOf(page).click(sel)
      await page.waitForFunction((n) => window.__mw.loads >= n, expectLoads, { timeout: 8000 }).catch(() => {})
      await sleep(250)
    }
    await nav('#to-b', 2); rows.push(await snap('click B'))
    await nav('#to-c', 3); rows.push(await snap('click C'))
    await back(page); await sleep(700); rows.push(await snap('Back #1 (expect frame B)'))
    await back(page); await sleep(700); rows.push(await snap('Back #2 (expect frame A)'))
    await forward(page); await sleep(700); rows.push(await snap('Forward #1 (expect frame B)'))
    // reload the top-level page now
    await page.reload({ waitUntil: 'load' }).catch(() => {})
    await page.waitForFunction(() => window.__mw && window.__mw.loads >= 1, null, { timeout: 15000 }).catch(() => {})
    await sleep(500)
    rows.push(await snap('top reload'))
    out.runs.push({ scenario: 'multipage-links', mirror, rows })
    await ctx.close()
  }

  for (const mirror of ['load', 'full']) {
    // SPA pushState inside the frame
    const { ctx, page } = await openShell(browser, lab, { mirror }, '/spa/one')
    const snap = makeSnap(page)
    const rows = [await snap('open /spa/one')]
    await frameOf(page).click('#r2'); await sleep(500); rows.push(await snap('click SPA route two (pushState in frame)'))
    await back(page); await sleep(700); rows.push(await snap('Back (frame popstate)'))
    await forward(page); await sleep(700); rows.push(await snap('Forward'))
    out.runs.push({ scenario: 'spa-pushState', mirror, rows })
    await ctx.close()
  }

  for (const mirror of ['load', 'full']) {
    const { ctx, page } = await openShell(browser, lab, { mirror }, '/hash.html')
    const snap = makeSnap(page)
    const rows = [await snap('open /hash.html')]
    await frameOf(page).click('#h1'); await sleep(400); rows.push(await snap('click #/one'))
    await frameOf(page).click('#h2'); await sleep(400); rows.push(await snap('click #/two'))
    await back(page); await sleep(700); rows.push(await snap('Back'))
    out.runs.push({ scenario: 'hash-router', mirror, rows })
    await ctx.close()
  }
})

const f = saveResults('history', engine, out)
for (const r of out.runs) {
  console.log(`\n### ${engine} / ${r.scenario} / mirror=${r.mirror}`)
  for (const row of r.rows) console.log(`${row.agree ? 'OK ' : 'XX '} ${row.step.padEnd(42)} top=${row.topUrl.padEnd(18)} frame=${row.frameUrl.padEnd(18)} hist=${row.hist} loads=${row.loads} mir=${row.mirrors} ev=[${row.events.join(' ')}]`)
}
console.log('\nsaved', f)
