import { chromium, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
const root = process.argv[2];
setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 170000);
const rows = [];
for (const [bname, bt] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await bt.launch({ headless: true });
  for (const mode of ['range', 'norange']) {
    const server = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname, root, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise((res) => server.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) res(m[1]); }));
    const base = `http://localhost:${port}`;
    for (const file of ['v.mp4', 'v.webm']) {
      const ctx = await browser.newContext(); const page = await ctx.newPage(); page.setDefaultTimeout(15000);
      let result;
      try {
        await page.goto(base + '/?file=' + file);
        await page.waitForSelector('#site');
        const fr = await (await page.$('#site')).contentFrame();
        await fr.waitForFunction(() => window.__result, null, { timeout: 15000 });
        result = await fr.evaluate(() => window.__result);
      } catch (e) { result = { harnessError: String(e).slice(0, 160) }; }
      const log = await (await fetch(base + '/__getlog')).json();
      const ranges = log.filter((l) => l[0] === file).map((l) => l[1]);
      rows.push({ browser: bname + ' ' + browser.version(), swMode: mode, file, events: (result.events || []).join(' '), duration: result.duration, readyState: result.readyState, error: result.error || result.harnessError || null, currentTimeAfterSeek: result.currentTime, seekable: result.seekable, swSawRequests: ranges.length, distinctRangeHeaders: [...new Set(ranges)].slice(0, 6) });
      await ctx.close();
    }
    server.kill();
  }
  await browser.close();
}
for (const r of rows) console.log(JSON.stringify(r));
process.exit(0);
