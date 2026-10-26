// args: <url> [chromium|firefox|webkit]. Uses the project's playwright via absolute import.
import { chromium, firefox, webkit } from '../../../../node_modules/playwright/index.mjs';
const url = process.argv[2]; const which = process.argv[3] || 'chromium';
const browser = await ({ chromium, firefox, webkit }[which]).launch({ headless: true });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.error('console.error', m.text()); });
page.on('pageerror', e => console.error('pageerror', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__RESULT, null, { timeout: 280000 });
const r = await page.evaluate(() => window.__RESULT);
console.log(JSON.stringify(r));
await browser.close();
