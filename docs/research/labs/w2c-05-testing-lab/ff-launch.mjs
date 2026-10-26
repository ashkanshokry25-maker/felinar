import { firefox } from '../../../../node_modules/playwright/index.mjs';
try { const b = await firefox.launch({ headless: true }); console.log('launched', b.version()); await b.close(); } catch (e) { console.log(String(e.message)); }
