import http from 'node:http'
import fs from 'node:fs'
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>i</title>i') })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP hub.test 127.0.0.1'] })
const page = await (await browser.newContext()).newPage()
await page.goto(`http://hub.test:${port}/`)
const r = await page.evaluate(() => ({ origin: location.origin, isSecureContext, typeofRegister: typeof navigator.registerProtocolHandler, inNavigator: 'registerProtocolHandler' in navigator }))
console.log(JSON.stringify(r))
await browser.close(); server.close()
