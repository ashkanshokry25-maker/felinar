// E-LOCK-1: leader hand-off timing with Web Locks across full navigations (MPA) in one and two tabs.
import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const which = process.argv[2] || 'chromium'
const lab = await startLab({ withTracker: false })
const browser = await openBrowser(which)
console.log(which, browser.version())
const ev = (id) => lab.reports.filter((r) => r.lock && r.id === id)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { browser: which + ' ' + browser.version(), singleTab: [], twoTabs: [] }
// single tab: page1 -> page2 -> page3 (full navigations)
for (let i = 0; i < 8; i++) {
  const id = 's' + i; const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${lab.origin}/lock.html?id=${id}&p=1`); await sleep(300)
  await page.goto(`${lab.origin}/lock.html?id=${id}&p=2`); await sleep(500)
  const e = ev(id); const hide1 = e.find((x) => x.page === '1' && x.ev === 'pagehide'); const lead2 = e.find((x) => x.page === '2' && x.ev === 'LEADER'); const load2 = e.find((x) => x.page === '2' && x.ev === 'loaded')
  out.singleTab.push({ pagehide_to_newLeader_ms: hide1 && lead2 ? lead2.t - hide1.t : null, load_to_leader_ms: load2 && lead2 ? lead2.t - load2.t : null })
  await ctx.close()
}
// two tabs same context: A leads, B waits; A navigates away; B should take over
for (let i = 0; i < 8; i++) {
  const ctx = await browser.newContext(); const A = await ctx.newPage(); const B = await ctx.newPage()
  const ida = 'a' + i, idb = 'b' + i
  await A.goto(`${lab.origin}/lock.html?id=${ida}&p=1`); await sleep(300)
  await B.goto(`${lab.origin}/lock.html?id=${idb}&p=1`); await sleep(300)
  const bBefore = ev(idb).some((x) => x.ev === 'LEADER')
  await A.goto(`${lab.origin}/lock.html?id=${ida}&p=2`); await sleep(500)
  const hideA = ev(ida).find((x) => x.page === '1' && x.ev === 'pagehide'); const leadB = ev(idb).find((x) => x.ev === 'LEADER'); const leadA2 = ev(ida).find((x) => x.page === '2' && x.ev === 'LEADER')
  out.twoTabs.push({ B_was_leader_before: bBefore, A_pagehide_to_B_leader_ms: hideA && leadB ? leadB.t - hideA.t : null, A2_became_leader: !!leadA2 })
  await ctx.close()
}
const med = (a) => { const s = a.filter((x) => x !== null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
out.summary = { single_pagehide_to_leader_med: med(out.singleTab.map((x) => x.pagehide_to_newLeader_ms)), single_load_to_leader_med: med(out.singleTab.map((x) => x.load_to_leader_ms)), two_pagehide_to_B_med: med(out.twoTabs.map((x) => x.A_pagehide_to_B_leader_ms)), two_B_leader_before: out.twoTabs.filter((x) => x.B_was_leader_before).length, two_A2_leader: out.twoTabs.filter((x) => x.A2_became_leader).length }
console.log(JSON.stringify(out.summary)); console.log(JSON.stringify(out.singleTab.slice(0, 3)), JSON.stringify(out.twoTabs.slice(0, 3)))
fs.writeFileSync(new URL('./results/locks-' + which + '.json', import.meta.url), JSON.stringify(out, null, 1))
await browser.close(); await lab.close()
