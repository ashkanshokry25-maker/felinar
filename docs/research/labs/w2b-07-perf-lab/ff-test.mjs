import { firefox } from '../../../../node_modules/playwright/index.mjs';
try { const b = await firefox.launch({ headless: true }); console.log('ok', b.version()); await b.close(); } catch (e) { console.log(e.message.slice(0, 1500)); }
