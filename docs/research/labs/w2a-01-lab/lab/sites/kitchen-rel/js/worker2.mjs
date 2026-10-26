// module worker created via new URL('./worker2.mjs', import.meta.url)
import { dep } from './dep.mjs';
const out = { loc: self.location.pathname, dep };
try { out.fetchAbs = await (await fetch('/data/abs.json')).json(); } catch (e) { out.fetchAbs = 'ERR ' + e.message; }
postMessage(out);
