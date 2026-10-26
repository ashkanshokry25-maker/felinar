// Unified launcher: chromium (channel 'chromium' = new headless, full browser), webkit (persistent contexts, one process each).
import { chromium, webkit } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
export async function openBrowser (which = 'chromium', chromiumOpts = {}) {
  if (which === 'webkit') {
    const ctxs = []
    const base = fs.mkdtempSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'prof-wk-'))
    let n = 0
    const first = await webkit.launchPersistentContext(path.join(base, 'p' + n++), { headless: true })
    const version = first.browser()?.version() ?? 'webkit'
    await first.close()
    return {
      kind: 'webkit', version: () => version,
      async newContext (opts = {}) { const c = await webkit.launchPersistentContext(path.join(base, 'p' + n++), { headless: true, ...opts }); ctxs.push(c); return c },
      async close () { for (const c of ctxs) await c.close().catch(() => {}); fs.rmSync(base, { recursive: true, force: true }) }
    }
  }
  const b = await chromium.launch({ channel: process.env.CHROMIUM_CHANNEL === 'shell' ? undefined : 'chromium', headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'], ...chromiumOpts })
  return { kind: 'chromium', version: () => b.version(), newContext: (o) => b.newContext(o), close: () => b.close() }
}
