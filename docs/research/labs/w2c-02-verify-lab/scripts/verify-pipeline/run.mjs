// args: <url> <chromium|webkit|firefox>
import { chromium, firefox, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
const [,, url, which = 'chromium'] = process.argv;
const browser = await ({ chromium, firefox, webkit }[which]).launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.error('pageerror', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('console.error', m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.__RESULT, null, { timeout: 560000 });
console.log(JSON.stringify(await page.evaluate(() => window.__RESULT)));
console.log('browserVersion', browser.version());
await browser.close();
