// Engine selection for the lab scripts. ENGINE=chromium (default) | webkit | firefox.
// PW_WEBKIT_EXE / PW_FIREFOX_EXE can point at a Playwright WebKit (pw_run.sh) or Firefox binary downloaded elsewhere;
// otherwise Playwright's own installed browsers are used (npx playwright install webkit firefox).
import { chromium, webkit, firefox } from '../../../../node_modules/playwright/index.mjs';
export const ENGINE = process.env.ENGINE || 'chromium';
export async function launchEngine (extraChromiumArgs = []) {
  if (ENGINE === 'webkit') return webkit.launch({ headless: true, executablePath: process.env.PW_WEBKIT_EXE || undefined });
  if (ENGINE === 'firefox') return firefox.launch({ headless: true, executablePath: process.env.PW_FIREFOX_EXE || undefined });
  return chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--js-flags=--expose-gc', ...extraChromiumArgs] });
}
