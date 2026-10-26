import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { firefox } = require('playwright');
try { const c = await firefox.launchPersistentContext(process.argv[2], { headless: true }); console.log('firefox persistent ok', c.browser()?.version()); await c.close(); }
catch (e) { console.log(String(e).slice(0, 900)); }
