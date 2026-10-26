// Launch Chrome for Testing DIRECTLY (not through playwright.chromium.launch) and attach over CDP.
// Why: Playwright's default launch flags include --disable-features=ThirdPartyStoragePartitioning (and
// --disable-field-trial-config), which changed the HTTP-cache partitioning result in our first run (see psl-effects.mjs).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '../../../../../node_modules/playwright/index.mjs'

export async function launchChrome({ hostRules = '', args = [] } = {}) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-lab-'))
  const flags = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', ...args]
  if (hostRules) flags.push(`--host-resolver-rules=${hostRules}`)
  const child = spawn(chromium.executablePath(), [...flags, 'about:blank'], { stdio: 'ignore' })
  let port
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number(fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch { /* not yet */ }
    if (!port) await new Promise(r => setTimeout(r, 100))
  }
  if (!port) throw new Error('Chrome did not publish DevToolsActivePort')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  return {
    browser,
    async close() {
      await browser.close().catch(() => {})
      child.kill('SIGKILL')
      await new Promise(r => setTimeout(r, 500))
      fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    },
  }
}
