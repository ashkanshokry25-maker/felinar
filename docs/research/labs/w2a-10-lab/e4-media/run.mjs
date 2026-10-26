// Runs the SW Range matrix in Playwright Chromium and WebKit (Firefox cannot launch in this environment).
import { chromium, webkit, firefox } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from './serve.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))
const { server, port } = await start(path.join(here, 'www'))
const FILES = (process.env.FILES || 'clip-faststart.mp4,clip-moovend.mp4,clip-frag.mp4,clip.webm,tone.m4a,tone.mp3').split(',')
const VARIANTS = (process.env.VARIANTS || 'net,ignore,ar200,full206,cap206,slow206,nocl206').split(',')
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',')
const types = { chromium, webkit, firefox }
const out = []
for (const name of ENGINES) {
  let browser
  try { browser = await types[name].launch({ headless: true }) } catch (e) { console.log(name, 'LAUNCH FAILED', String(e).split('\n')[0]); continue }
  console.log('engine', name, browser.version())
  for (const file of FILES) for (const variant of VARIANTS) {
    const ctx = await browser.newContext(); const page = await ctx.newPage()
    const tag = /\.(m4a|mp3)$/.test(file) ? 'audio' : 'video'
    let r
    try {
      await page.goto(`http://127.0.0.1:${port}/t.html?variant=${variant}&file=${file}&el=${tag}&w=${process.env.W || 5000}`, { timeout: 15000 })
      await page.waitForFunction('window.__done === true', null, { timeout: 40000 })
      r = await page.evaluate('window.__result')
    } catch (e) { r = { variant, file, harnessError: String(e).slice(0, 200) } }
    r.engine = name; r.engineVersion = browser.version()
    const ranges = (r.swlog || []).filter(x => !x.cancel).map(x => `${x.range || '-'}=>${x.status}${x.served ? '(' + x.served + ')' : ''}`)
    const cancels = (r.swlog || []).filter(x => x.cancel).length
    console.log(`${name.padEnd(8)} ${file.padEnd(18)} ${variant.padEnd(8)} meta=${r.metadata} play=${r.playing} adv=${r.advanced} s60=${r['seek0.6'] ? r['seek0.6'].seeked + '/' + r['seek0.6'].resumedAdvance : '-'} s20=${r['seek0.2'] ? r['seek0.2'].seeked + '/' + r['seek0.2'].resumedAdvance : '-'} err=${r.error ? r.error.code : '-'} reqs=${ranges.length} cancels=${cancels} first=${ranges.slice(0, 3).join(' | ')}${r.harnessError ? ' HARNESS ' + r.harnessError : ''}`)
    // timing summary from the page's event log
    const ev = r.events || []; const tOf = t => { const e = ev.find(x => x.type === t); return e ? e.t : null }
    r.tMeta = tOf('loadedmetadata'); r.tPlaying = tOf('playing')
    const seekPairs = []; let lastSeeking = null
    for (const e of ev) { if (e.type === 'seeking') lastSeeking = e.t; if (e.type === 'seeked' && lastSeeking !== null) { seekPairs.push(e.t - lastSeeking); lastSeeking = null } }
    r.seekMs = seekPairs
    const delivered = (r.swlog || []).filter(x => x.cancel).map(x => x.deliveredBytes)
    console.log(`           timing: meta=${r.tMeta}ms playing=${r.tPlaying}ms seekMs=${JSON.stringify(seekPairs)} waiting=${ev.filter(x => x.type === 'waiting').length} cancelsDelivered(MB)=${JSON.stringify(delivered.map(d => +(d / 1048576).toFixed(1)))}`)
    out.push(r); await ctx.close()
  }
  await browser.close()
}
fs.writeFileSync(path.join(here, 'results', process.env.OUT || 'e4-matrix.json'), JSON.stringify({ at: new Date().toISOString(), out }, null, 1))
server.close(); process.exit(0)
