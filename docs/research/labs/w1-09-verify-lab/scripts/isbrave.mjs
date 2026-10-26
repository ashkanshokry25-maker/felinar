import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const ctx = await chromium.launchPersistentContext(process.argv[2], { executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true, args: ['--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync'] })
const p = ctx.pages()[0] || await ctx.newPage()
await p.goto('data:text/html,<title>x</title>')
console.log(JSON.stringify(await p.evaluate(async () => ({ hasBrave: !!navigator.brave, isBrave: navigator.brave ? await navigator.brave.isBrave() : null }))))
await ctx.close()
