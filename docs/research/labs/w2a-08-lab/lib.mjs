// shared helpers for the w2a-08 lab
import { chromium, firefox, webkit } from '../../../../node_modules/playwright/index.mjs'
import { startLab } from './server.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = path.dirname(fileURLToPath(import.meta.url))
export const engines = { chromium, webkit, firefox }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function withLab (engineName, fn, launchOpts = {}) {
  const lab = await startLab()
  const browser = await engines[engineName].launch({ headless: true, ...launchOpts })
  try { return await fn(lab, browser) } finally { await browser.close().catch(() => {}); lab.close() }
}

export function frameOf (page) { return page.frames().find((f) => f !== page.mainFrame()) || null }

// Opens the shell at `urlPath` with config `cfg` in a fresh context; resolves when the first frame load finished.
export async function openShell (browser, lab, cfg, urlPath = '/', ctxOpts = {}) {
  lab.setCfg(cfg || {})
  lab.clearLog()
  const ctx = await browser.newContext(ctxOpts)
  const page = await ctx.newPage()
  page.__console = []
  page.on('console', (m) => page.__console.push({ type: m.type(), text: m.text().slice(0, 300) }))
  page.__dialogs = []
  page.on('dialog', async (d) => { page.__dialogs.push({ type: d.type(), message: d.message().slice(0, 80) }); await d.accept().catch(() => {}) })
  page.__popups = []
  ctx.on('page', (p) => { p.__dialogs = []; p.on('dialog', async (d) => { p.__dialogs.push(d.type()); await d.accept().catch(() => {}) }); page.__popups.push(p) })
  page.__downloads = []
  page.on('download', (d) => page.__downloads.push(d))
  await page.goto(lab.origin + urlPath, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__mw && window.__mw.loads >= 1, null, { timeout: 20000 })
  return { ctx, page }
}

export function makeSnap (page) {
  let seen = 0
  return async function snap (label, extra = {}) {
    const st = await page.evaluate(() => {
      let fr = null
      try { const l = window.__mw.frame.contentWindow.location; fr = l.pathname + l.search + l.hash } catch (e) { fr = 'UNREADABLE:' + e.name }
      return { top: location.pathname + location.search + location.hash, frame: fr, hist: history.length, loads: window.__mw.loads, mirrors: window.__mw.mirrors, title: document.title, log: window.__mw.log.slice() }
    })
    const events = st.log.slice(seen).map((e) => e.type + (e.reason ? '(' + e.reason + ')' : '') + (e.persisted !== undefined ? '[persisted=' + e.persisted + ']' : '') + (e.to ? '->' + e.to : '') + (e.path ? '@' + e.path : ''))
    seen = st.log.length
    return Object.assign({ step: label, topUrl: st.top, frameUrl: st.frame, agree: st.top === st.frame, hist: st.hist, loads: st.loads, mirrors: st.mirrors, title: st.title, events }, extra)
  }
}

async function step (page, delta) {
  const name = page.context().browser().browserType().name()
  if (name === 'chromium') {
    // exact one-step traversal of the joint session history (what the Back/Forward buttons do), via CDP
    const cdp = await page.context().newCDPSession(page)
    try {
      const h = await cdp.send('Page.getNavigationHistory')
      const e = h.entries[h.currentIndex + delta]
      if (e) await cdp.send('Page.navigateToHistoryEntry', { entryId: e.id })
      return !!e
    } finally { await cdp.detach().catch(() => {}) }
  }
  const fn = delta < 0 ? () => page.goBack({ timeout: 2500, waitUntil: 'commit' }) : () => page.goForward({ timeout: 2500, waitUntil: 'commit' })
  await fn().catch(() => {})
  return true
}
export async function back (page) { return step(page, -1) }
export async function forward (page) { return step(page, +1) }

export function saveResults (name, engine, data) {
  const f = path.join(here, 'results', `${name}-${engine}.json`)
  fs.writeFileSync(f, JSON.stringify(data, null, 2))
  return f
}
